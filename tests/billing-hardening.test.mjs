// Tests for the corrections made after the independent review of the billing enforcement layer:
//   queue starvation by quota-blocked jobs, waking parked mail after a plain re-verification, entitlement lookup failures during a
//   reservation, real timeouts and time budgets for the billing steps, parked-job visibility, transient database failures and deadlocks,
//   the split between historical usage and reservations, and plan changes while emails are in flight.
//
// Run: node --test tests/billing-hardening.test.mjs
//
// The pure tests run anywhere. The database tests WRITE rows, so they only run when DATABASE_URL (set in the environment) names an isolated
// kw_*test* database with the migrations applied; otherwise they are skipped and say so. Nothing here calls Shopify or any billing
// service: the verifier and the session source are stubs, and no mail is sent.
import "./helpers/resolve-extensionless.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const dbUrl = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const dbTest = (name, fn) => test(name, { skip }, fn);
const prisma = skip ? null : new PrismaClient();

process.env.SHOPIFY_API_KEY ||= "dummy-key";
process.env.SHOPIFY_API_SECRET ||= "dummy-secret-for-tests-only";
process.env.SHOPIFY_APP_URL ||= "https://app.example.invalid";
const { getEntitlements, resolveEntitlements, restockEmailUsage } = await import("../app/models/entitlements.server.js");
const { claimNext, queueSnapshot, recoverExpiredLeases } = await import("../app/models/email-delivery.server.js");
const { QUOTA_BLOCKED, reserveForSend } = await import("../app/models/email-quota.server.js");
const { TRANSIENT_RETRIES, isTransientDbError, withTransientRetry } = await import("../app/models/db-retry.server.js");
const V = await import("../app/models/subscription-verification.server.js");
const R = await import("../app/models/plan-recommendation.server.js");
const { runBillingJobs } = await import("../app/worker/billing-jobs.server.js");
const W = skip ? null : await import("../app/models/wishlist.server.js");
const appPrisma = skip ? null : (await import("../app/db.server.js")).default;

const NOW = new Date("2026-11-11T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RUN = Date.now().toString(36);
const domains = [];
let seq = 7700000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { log() {}, error() {} };
const newShop = async (tag) => {
  const domain = `kw-bh-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});

const PERIOD_START = new Date(NOW.getTime() - 10 * DAY);
const PERIOD_END = new Date(NOW.getTime() + 20 * DAY);
const due = new Date(NOW.getTime() - MIN);
const paidSubscription = (shop, over = {}) =>
  prisma.shopSubscription.create({
    data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date(NOW.getTime() - HOUR), currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END, ...over },
  });
async function seedEmails(shop, count, { status = "SENT", planAtSend = null, sentAt = null, reservedAt = null, nextAttemptAt = null, errorCode = null, outbound = false } = {}) {
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
  const variants = Array.from({ length: count }, () => `gid://shopify/ProductVariant/${(seq += 1)}`);
  await prisma.notifySubscription.createMany({ data: variants.map((variantGid, i) => ({ shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid, email: `n${i}@example.invalid`, consentedAt: NOW, consentSource: "test" })) });
  const subs = await prisma.notifySubscription.findMany({ where: { shopId: shop.id, actorId: actor.id }, select: { id: true, variantGid: true } });
  await prisma.emailDelivery.createMany({
    data: subs.map((sub) => ({
      shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid: sub.variantGid, status, planAtSend, sentAt, reservedAt, nextAttemptAt, errorCode,
      ...(outbound ? { outboundMessageId: `<${sub.id}@example.invalid>`, leaseExpiresAt: new Date(NOW.getTime() - MIN) } : {}),
    })),
  });
  return (await prisma.emailDelivery.findMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } }, select: { id: true } })).map((row) => row.id);
}
const delivery = (id) => prisma.emailDelivery.findUnique({ where: { id } });
const usageFor = async (shop, now = NOW) => restockEmailUsage(shop.id, await getEntitlements(shop.id, { now }));
const claim = (shop, extra = {}) => claimNext({ now: NOW, shopIds: [shop.id], enforce: true, ...extra });

// A database handle whose entitlement reads (inside the claim transaction) fail, like an infrastructure error.
const failingEntitlementDb = () => ({
  emailDelivery: prisma.emailDelivery,
  shopSubscription: prisma.shopSubscription,
  $transaction: (fn, options) =>
    prisma.$transaction(
      (tx) =>
        fn(
          new Proxy(tx, {
            get: (target, property) => {
              if (property === "shopSubscription") return { findUnique: async () => { throw Object.assign(new Error("connection lost"), { code: "P1001" }); } };
              const value = target[property];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      options,
    ),
});
// A handle whose transactions fail with `error` for the first `failures` calls and then really run.
const flakyTransactions = (failures, error) => {
  const handle = {
    calls: 0,
    emailDelivery: prisma?.emailDelivery,
    shopSubscription: prisma?.shopSubscription,
    $transaction(fn, options) {
      handle.calls += 1;
      if (handle.calls <= failures) return Promise.reject(error());
      return prisma.$transaction(fn, options);
    },
  };
  return handle;
};
const deadlock = () => Object.assign(new Error("Raw query failed. Code: `1213`. Message: `Deadlock found when trying to get lock; try restarting transaction`"), { code: "P2010", meta: { code: "1213" } });

// ======================= pure: transient database errors =======================
test("only deadlocks and lock-wait timeouts count as transient database errors", () => {
  assert.equal(isTransientDbError(Object.assign(new Error("x"), { code: "P2034" })), true);
  assert.equal(isTransientDbError(deadlock()), true);
  assert.equal(isTransientDbError(Object.assign(new Error("x"), { code: "P2010", meta: { code: "1205" } })), true, "lock wait timeout");
  assert.equal(isTransientDbError(new Error("Deadlock found when trying to get lock; try restarting transaction")), true);
  for (const other of [null, undefined, new Error("boom"), Object.assign(new Error("x"), { code: "P2002" }), Object.assign(new Error("x"), { code: "P2010", meta: { code: "1064" } }), Object.assign(new Error("x"), { code: "P1001" })]) {
    assert.equal(isTransientDbError(other), false, String(other?.code ?? other));
  }
});

test("a transient failure is retried a bounded number of times, everything else is thrown at once", async () => {
  const waits = [];
  const wait = async (ms) => waits.push(ms);
  let calls = 0;
  assert.equal(await withTransientRetry(async () => { calls += 1; if (calls < 3) throw deadlock(); return "done"; }, { wait }), "done");
  assert.equal(calls, TRANSIENT_RETRIES + 1, "two retries after the first failure");
  assert.ok(waits.length === 2 && waits.every((ms) => ms >= 15 && ms < 120), "a short pause before each retry");

  calls = 0;
  await assert.rejects(withTransientRetry(async () => { calls += 1; throw deadlock(); }, { wait }), (error) => error.code === "P2010");
  assert.equal(calls, 3, "a failure that keeps coming back is thrown after the allowed attempts, never retried indefinitely");

  calls = 0;
  await assert.rejects(withTransientRetry(async () => { calls += 1; throw new Error("syntax error"); }, { wait }), /syntax error/);
  assert.equal(calls, 1, "an ordinary error is not retried");
});

// ======================= H1: a blocked shop cannot starve the queue =======================
dbTest("more than 10 quota-blocked jobs of one shop do not stop an eligible job of another shop in the same call", async () => {
  const blocked = await newShop("starve-blocked");
  const other = await newShop("starve-other");
  await seedEmails(blocked, 50, { planAtSend: "BASIC", sentAt: NOW }); // Basic's 50 are used up
  const blockedIds = await seedEmails(blocked, 25, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() - HOUR) }); // older: first in the queue
  const [eligibleId] = await seedEmails(other, 1, { status: "PENDING", nextAttemptAt: due });
  const job = await claimNext({ now: NOW, enforce: true, shopIds: [blocked.id, other.id] });
  assert.equal(job.id, eligibleId, "the eligible job behind 25 blocked ones is claimed by ONE call");
  const parked = await prisma.emailDelivery.findMany({ where: { id: { in: blockedIds } } });
  assert.ok(parked.every((row) => row.status === "PENDING" && row.errorCode === QUOTA_BLOCKED && row.nextAttemptAt === null && row.leaseExpiresAt === null && row.attempts === 0), "all 25 parked in one step: still PENDING, no lease, no attempt used");
  // not selected again: a second call has nothing to touch and changes no row
  const before = (await prisma.emailDelivery.findMany({ where: { id: { in: blockedIds } }, select: { id: true, updatedAt: true } })).map((row) => row.updatedAt.getTime());
  assert.equal(await claimNext({ now: NOW, enforce: true, shopIds: [blocked.id, other.id] }), null);
  const after2 = (await prisma.emailDelivery.findMany({ where: { id: { in: blockedIds } }, select: { id: true, updatedAt: true } })).map((row) => row.updatedAt.getTime());
  assert.deepEqual(after2, before, "the parked rows were not selected or rewritten again");
});

dbTest("many blocked shops in front of an eligible one: the search goes on batch after batch, and stays bounded", async () => {
  const shops = [];
  for (let i = 0; i < 12; i += 1) {
    const shop = await newShop(`starve-many-${i}`);
    await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: NOW });
    await seedEmails(shop, 2, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() - HOUR - i * MIN) });
    shops.push(shop);
  }
  const other = await newShop("starve-many-other");
  const [eligibleId] = await seedEmails(other, 1, { status: "PENDING", nextAttemptAt: due });
  const job = await claimNext({ now: NOW, enforce: true, shopIds: [...shops.map((shop) => shop.id), other.id] });
  assert.equal(job.id, eligibleId, "past the first batch of ten");
  for (const shop of shops) {
    const rows = await prisma.emailDelivery.findMany({ where: { shopId: shop.id } });
    assert.ok(rows.filter((row) => row.status === "PENDING").every((row) => row.errorCode === QUOTA_BLOCKED), "every blocked shop was parked once");
  }
  const second = await newShop("starve-many-two");
  await seedEmails(second, 1, { status: "PENDING", nextAttemptAt: due });
  const next = await claimNext({ now: NOW, enforce: true, shopIds: [...shops.map((shop) => shop.id), second.id] });
  assert.ok(next, "and the next call finds the next eligible job straight away");
});

// ======================= H2: parked mail is woken by a plain re-verification =======================
const activeAnswer = (over = {}) => ({ outcome: "active", plan: "ADVANCE", periodStart: PERIOD_START, periodEnd: PERIOD_END, source: "app_pricing", ...over });
const runVerify = (shop, verify, now = NOW, extra = {}) => V.runSubscriptionVerification({ verify, now: () => now, shopIds: [shop.id], log: quiet, ...extra });

dbTest("a stale paid subscription parks its mail under Basic, and verifying it again with the same plan and period brings the mail back", async () => {
  const shop = await newShop("wake-same");
  await paidSubscription(shop, { verifiedAt: new Date(NOW.getTime() - 30 * HOUR), nextVerificationAt: due }); // stale: Basic until verified again
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: NOW }); // Basic's lifetime allowance is used up
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  const unknownIds = await seedEmails(shop, 1, { status: "UNKNOWN", planAtSend: "ADVANCE", reservedAt: new Date(NOW.getTime() - 2 * DAY), outbound: true });
  assert.equal((await getEntitlements(shop.id, { now: NOW })).reason, "verification_stale");
  assert.equal(await claim(shop), null);
  assert.deepEqual([(await delivery(id)).status, (await delivery(id)).errorCode, (await delivery(id)).nextAttemptAt], ["PENDING", QUOTA_BLOCKED, null], "parked under Basic, with no date");

  const summary = await runVerify(shop, async () => activeAnswer()); // the SAME plan and the SAME period
  assert.equal(summary.active, 1);
  const woken = await delivery(id);
  assert.equal(woken.nextAttemptAt.getTime(), NOW.getTime(), "set due again");
  const job = await claim(shop);
  assert.deepEqual([job.id, job.planAtSend, job.status], [id, "ADVANCE", "SENDING"], "re-evaluated under the verified plan, and eligible");
  assert.equal((await delivery(unknownIds[0])).status, "UNKNOWN", "an UNKNOWN delivery is untouched and never resent");
});

dbTest("waking is one re-evaluation, not a loop: if the quota is still used up the jobs are parked again, once", async () => {
  const shop = await newShop("wake-exhausted");
  await paidSubscription(shop, { verifiedAt: new Date(NOW.getTime() - 30 * HOUR), nextVerificationAt: due });
  await seedEmails(shop, 1500, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - DAY) }); // the Advance quota of this period is used up too
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: new Date(NOW.getTime() - 200 * DAY) });
  const ids = await seedEmails(shop, 3, { status: "PENDING", nextAttemptAt: due });
  assert.equal(await claim(shop), null);
  await runVerify(shop, async () => activeAnswer());
  assert.ok((await prisma.emailDelivery.findMany({ where: { id: { in: ids } } })).every((row) => row.nextAttemptAt.getTime() === NOW.getTime()), "woken");
  assert.equal(await claim(shop), null, "still no quota under the verified plan");
  const rows = await prisma.emailDelivery.findMany({ where: { id: { in: ids } } });
  assert.ok(rows.every((row) => row.status === "PENDING" && row.errorCode === QUOTA_BLOCKED && row.nextAttemptAt.getTime() === PERIOD_END.getTime() && row.attempts === 0), "parked again until the verified period ends");
  const touched = rows.map((row) => row.updatedAt.getTime());
  assert.equal(await claim(shop), null);
  assert.deepEqual((await prisma.emailDelivery.findMany({ where: { id: { in: ids } } })).map((row) => row.updatedAt.getTime()), touched, "and left alone until then");
});

// ======================= H3: a failed entitlement lookup claims and stamps nothing =======================
dbTest("an entitlement lookup failure aborts the claim: nothing is claimed, stamped or reserved, and the job stays eligible", async () => {
  const shop = await newShop("lookup");
  await paidSubscription(shop, { plan: "ENTERPRISE" });
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  const usageBefore = await usageFor(shop);
  const result = await reserveForSend(id, { now: NOW, leaseMs: 5 * MIN, enforce: true, db: failingEntitlementDb() });
  assert.deepEqual(result, { aborted: "entitlement_lookup_failed" });
  const row = await delivery(id);
  assert.deepEqual([row.status, row.planAtSend, row.reservedAt, row.leaseExpiresAt, row.attempts, row.errorCode, row.nextAttemptAt.getTime()], ["PENDING", null, null, null, 0, null, due.getTime()], "untouched");
  assert.deepEqual(await usageFor(shop), usageBefore, "no quota was reserved");
  assert.equal((await prisma.shopSubscription.findUnique({ where: { shopId: shop.id } })).plan, "ENTERPRISE", "and the stored subscription is not treated as cancelled");
  // enforcement off must not change that: the stamp is a decision too
  assert.deepEqual(await reserveForSend(id, { now: NOW, leaseMs: 5 * MIN, enforce: false, db: failingEntitlementDb() }), { aborted: "entitlement_lookup_failed" });
  // a genuine lookup that works still gives the right answer afterwards
  const job = await claim(shop);
  assert.deepEqual([job.id, job.planAtSend], [id, "ENTERPRISE"]);
});

dbTest("when every claim fails the worker is told, instead of seeing an empty queue", async () => {
  const shop = await newShop("lookup-all");
  const ids = await seedEmails(shop, 3, { status: "PENDING", nextAttemptAt: due });
  await assert.rejects(claimNext({ now: NOW, shopIds: [shop.id], enforce: true, db: { ...failingEntitlementDb(), emailDelivery: prisma.emailDelivery } }), (error) => error.code === "entitlement_lookup_failed");
  assert.ok((await prisma.emailDelivery.findMany({ where: { id: { in: ids } } })).every((row) => row.status === "PENDING" && row.planAtSend === null && row.attempts === 0));
});

dbTest("a missing or stale subscription (the lookup itself worked) is still Basic, and is stamped Basic", async () => {
  const missing = await newShop("lookup-missing");
  const stale = await newShop("lookup-stale");
  await paidSubscription(stale, { verifiedAt: new Date(NOW.getTime() - 3 * DAY) });
  const [a] = await seedEmails(missing, 1, { status: "PENDING", nextAttemptAt: due });
  const [b] = await seedEmails(stale, 1, { status: "PENDING", nextAttemptAt: due });
  assert.deepEqual([(await claim(missing)).planAtSend, (await claim(stale)).planAtSend], ["BASIC", "BASIC"]);
  assert.deepEqual([(await delivery(a)).status, (await delivery(b)).status], ["SENDING", "SENDING"]);
});

// ======================= H5 / H4: real timeouts and time budgets =======================
const recRow = (shop) => prisma.planRecommendation.findUnique({ where: { shopId: shop.id } });
const period = { periodStart: new Date(NOW.getTime() - 30 * DAY), periodEnd: NOW };
const runRec = (shop, fetchSessions, extra = {}) => R.runPlanRecommendations({ fetchSessions, now: () => NOW, shopIds: [shop.id], log: quiet, ...extra });

dbTest("a source that never answers and ignores the abort signal is cut off: a timeout failure, never a zero, and a late answer is ignored", async () => {
  const hung = await newShop("rec-hung");
  await R.ensurePlanRecommendation(hung.id, { now: due });
  const started = Date.now();
  const summary = await runRec(hung, () => new Promise(() => {}), { fetchTimeoutMs: 40 }); // never resolves, never looks at the signal
  assert.ok(Date.now() - started < 3000, "the worker did not wait forever");
  assert.equal(summary.failed, 1);
  const row = await recRow(hung);
  assert.deepEqual([row.status, row.errorCode, row.sessions30d, row.recommendedPlan, row.attempts, row.leaseExpiresAt, row.nextAttemptAt.getTime() - NOW.getTime()], ["FAILED", "timeout", null, null, 1, null, MIN], "the normal retry rules apply");

  const late = await newShop("rec-late");
  await R.ensurePlanRecommendation(late.id, { now: due });
  await runRec(late, () => new Promise((resolve) => setTimeout(() => resolve({ sessions: 999999, ...period }), 250)), { fetchTimeoutMs: 40 });
  await sleep(450); // the abandoned call answers now
  const lateRow = await recRow(late);
  assert.deepEqual([lateRow.status, lateRow.sessions30d, lateRow.recommendedPlan, lateRow.errorCode], ["FAILED", null, null, "timeout"], "its answer is never stored");

  const rejecting = await newShop("rec-late-reject");
  await R.ensurePlanRecommendation(rejecting.id, { now: due });
  await runRec(rejecting, () => new Promise((_, reject) => setTimeout(() => reject(new Error("too late")), 150)), { fetchTimeoutMs: 40 });
  await sleep(300); // a late rejection must not crash the process (this test would not finish if it did)
  assert.equal((await recRow(rejecting)).errorCode, "timeout");
});

dbTest("the recommendation step stops claiming when its time budget is used up", async () => {
  const shops = [];
  for (let i = 0; i < 6; i += 1) {
    const shop = await newShop(`rec-budget-${i}`);
    await R.ensurePlanRecommendation(shop.id, { now: due });
    shops.push(shop);
  }
  const started = Date.now();
  const summary = await R.runPlanRecommendations({ fetchSessions: () => new Promise(() => {}), now: () => NOW, shopIds: shops.map((s) => s.id), log: quiet, fetchTimeoutMs: 60, budgetMs: 150 });
  assert.ok(Date.now() - started < 2500);
  assert.equal(summary.budgetExhausted, true);
  assert.ok(summary.claimed >= 1 && summary.claimed < 6, `claimed ${summary.claimed}`);
  const rows = await Promise.all(shops.map(recRow));
  assert.equal(rows.filter((row) => row.status === "PENDING").length, 6 - summary.claimed, "the rest stay PENDING for the next run, unclaimed and unleased");
  assert.ok(rows.filter((row) => row.status === "FAILED").every((row) => row.errorCode === "timeout" && row.sessions30d === null));
});

const dueSubscription = (shop) => prisma.shopSubscription.create({ data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date(NOW.getTime() - 13 * HOUR), currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END, nextVerificationAt: due } });

dbTest("the verification step stops claiming when its time budget is used up, and each hung request is a transient failure", async () => {
  const shops = [];
  for (let i = 0; i < 6; i += 1) {
    const shop = await newShop(`ver-budget-${i}`);
    await dueSubscription(shop);
    shops.push(shop);
  }
  const started = Date.now();
  const summary = await V.runSubscriptionVerification({ verify: () => new Promise(() => {}), now: () => NOW, shopIds: shops.map((s) => s.id), log: quiet, timeoutMs: 60, budgetMs: 150 });
  assert.ok(Date.now() - started < 2500);
  assert.equal(summary.budgetExhausted, true);
  assert.ok(summary.claimed >= 1 && summary.claimed < 6, `claimed ${summary.claimed}`);
  const rows = await Promise.all(shops.map((shop) => prisma.shopSubscription.findUnique({ where: { shopId: shop.id } })));
  const handled = rows.filter((row) => row.verificationFailures === 1);
  assert.equal(handled.length, summary.claimed);
  assert.ok(handled.every((row) => row.lastVerificationError === "timeout" && row.status === "ACTIVE" && row.plan === "ADVANCE"), "a timeout never cancels");
  assert.ok(rows.filter((row) => row.verificationFailures === 0).every((row) => row.verificationLeaseExpiresAt === null), "unclaimed rows hold no lease");
});

dbTest("a billing step that does not return is abandoned at the hard limit, and the worker goes on to the emails", async () => {
  const shop = await newShop("hard-limit");
  await dueSubscription(shop);
  const [emailId] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  const started = Date.now();
  const result = await runBillingJobs({
    services: { verify: () => new Promise(() => {}), fetchSessions: null },
    shopIds: [shop.id],
    verifyBudgetMs: 50,
    verifyTimeoutMs: 700, // longer than the hard limit: only the hard limit can end the wait
    hardLimitMs: 150,
    log: quiet,
  });
  assert.ok(Date.now() - started < 1500, "returned at the hard limit, not after the request's own timeout");
  assert.deepEqual(result.verification, { timedOut: true });
  assert.equal(result.recommendations.skipped, "no_session_source", "the other step still ran");
  const job = await claim(shop); // what the worker does next: the emails
  assert.equal(job.id, emailId, "email processing is unaffected");
  await sleep(900); // the abandoned step finishes in the background; its write is conditional on its own lease
  const row = await prisma.shopSubscription.findUnique({ where: { shopId: shop.id } });
  assert.deepEqual([row.plan, row.status], ["ADVANCE", "ACTIVE"]);
  const failed = await runBillingJobs({ services: { verify: async () => { throw new Error("x"); }, fetchSessions: null }, shopIds: [shop.id], hardLimitMs: 500, log: quiet });
  assert.ok(failed.verification && failed.recommendations, "a failing step is isolated");
});

// ======================= M2: parked jobs are visible, without double counting =======================
dbTest("quota-blocked jobs are reported in their own count, with or without a retry date, and are not also 'scheduled'", async () => {
  const shop = await newShop("snapshot");
  await seedEmails(shop, 3, { status: "PENDING", nextAttemptAt: null, errorCode: QUOTA_BLOCKED }); // Basic: no date
  await seedEmails(shop, 2, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() + 10 * DAY), errorCode: QUOTA_BLOCKED }); // paid: until the period ends
  await seedEmails(shop, 4, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() + HOUR), errorCode: "smtp_ETIMEDOUT" }); // an ordinary scheduled retry
  await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() + 2 * HOUR), errorCode: null });
  await seedEmails(shop, 5, { status: "PENDING", nextAttemptAt: due }); // due now: in no category
  await seedEmails(shop, 2, { status: "UNKNOWN", planAtSend: "BASIC", reservedAt: NOW });
  const snapshot = await queueSnapshot({ now: NOW, shopIds: [shop.id] });
  assert.deepEqual([snapshot.quotaBlocked, snapshot.scheduled, snapshot.unknown], [5, 5, 2]);
  assert.equal(snapshot.nextAttemptAt.getTime(), NOW.getTime() + HOUR, "the next retry date ignores quota-blocked jobs");
});

// ======================= M3: transient database failures =======================
dbTest("a deadlock during the claim reruns the whole claim; a persistent one is thrown after the allowed attempts; an ordinary error is not retried", async () => {
  const shop = await newShop("claim-retry");
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  const once = flakyTransactions(1, deadlock);
  const result = await reserveForSend(id, { now: NOW, leaseMs: 5 * MIN, enforce: true, db: once, retry: { wait: async () => {} } });
  assert.deepEqual([result.job.id, once.calls], [id, 2], "claimed on the second attempt, as a completely new transaction");
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id, status: "SENDING" } }), 1, "one reservation, not two");

  const other = await newShop("claim-retry-2");
  const [id2] = await seedEmails(other, 1, { status: "PENDING", nextAttemptAt: due });
  const always = flakyTransactions(99, deadlock);
  await assert.rejects(reserveForSend(id2, { now: NOW, leaseMs: 5 * MIN, enforce: true, db: always, retry: { wait: async () => {} } }), (error) => error.code === "P2010");
  assert.equal(always.calls, TRANSIENT_RETRIES + 1, "bounded");
  const broken = flakyTransactions(99, () => new Error("table missing"));
  await assert.rejects(reserveForSend(id2, { now: NOW, leaseMs: 5 * MIN, enforce: true, db: broken, retry: { wait: async () => {} } }), /table missing/);
  assert.equal(broken.calls, 1, "not retried");
  const row = await delivery(id2);
  assert.deepEqual([row.status, row.planAtSend, row.attempts], ["PENDING", null, 0], "a failed claim leaves no reservation");
});

dbTest("one job that cannot be claimed does not end the search: the next candidate is claimed, and the failed one stays eligible", async () => {
  const a = await newShop("claim-skip-a");
  const b = await newShop("claim-skip-b");
  const [aId] = await seedEmails(a, 1, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() - HOUR) });
  const [bId] = await seedEmails(b, 1, { status: "PENDING", nextAttemptAt: due });
  const handle = flakyTransactions(1, () => new Error("one bad row"));
  handle.emailDelivery = prisma.emailDelivery;
  const job = await claimNext({ now: NOW, shopIds: [a.id, b.id], enforce: true, db: handle });
  assert.equal(job.id, bId);
  assert.deepEqual([(await delivery(aId)).status, (await delivery(aId)).attempts, (await delivery(aId)).planAtSend], ["PENDING", 0, null]);
});

const deadlockOnce = async (failures, error, fn) => {
  const original = appPrisma.$transaction;
  let calls = 0;
  appPrisma.$transaction = function patched(...args) {
    calls += 1;
    if (calls <= failures) return Promise.reject(error());
    return original.apply(appPrisma, args);
  };
  try {
    return { result: await fn(), calls };
  } catch (error2) {
    return { error: error2, calls };
  } finally {
    appPrisma.$transaction = original;
  }
};
const identityOf = (shop, n) => ({ shopDomain: shop.domain, customerGid: `gid://shopify/Customer/${n}` });
const product = (n) => ({ productGid: `gid://shopify/Product/${n}`, variantGid: `gid://shopify/ProductVariant/${n}`, title: "Item", handle: "item" });
const items = (shop) => prisma.wishlistItem.count({ where: { shopId: shop.id } });
const enforced = async (fn) => {
  const before = process.env.BILLING_ENFORCEMENT;
  process.env.BILLING_ENFORCEMENT = "on";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = before;
  }
};

dbTest("a wishlist addition that hits a deadlock is rerun from the start (bounded); other errors are not retried; nothing is left half-written", () =>
  enforced(async () => {
    const shop = await newShop("wl-retry");
    const once = await deadlockOnce(1, deadlock, () => W.addToWishlist(identityOf(shop, 1), product(1)));
    assert.deepEqual([once.result?.saved, once.calls], [true, 2]);
    assert.equal(await items(shop), 1);

    const always = await deadlockOnce(99, deadlock, () => W.addToWishlist(identityOf(shop, 2), product(2)));
    assert.equal(always.error?.code, "P2010");
    assert.equal(always.calls, 3, "three attempts and no more");
    assert.equal(await items(shop), 1, "nothing was added by the failed attempts");

    const ordinary = await deadlockOnce(99, () => new Error("table missing"), () => W.addToWishlist(identityOf(shop, 3), product(3)));
    assert.match(ordinary.error.message, /table missing/);
    assert.equal(ordinary.calls, 1, "not retried");
    assert.equal(await prisma.actor.count({ where: { shopId: shop.id, customerGid: "gid://shopify/Customer/3" } }), 0, "no customer row was left behind either");
  }));

dbTest("the store-wide cap still holds under concurrency when some transactions are retried after a deadlock", () =>
  enforced(async () => {
    const shop = await newShop("wl-retry-cap");
    const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: "gid://shopify/Customer/777" } });
    await prisma.wishlistItem.createMany({ data: Array.from({ length: 46 }, (_, i) => ({ shopId: shop.id, actorId: actor.id, productGid: `gid://shopify/Product/${i + 1}`, variantGid: `gid://shopify/ProductVariant/${i + 1}`, productTitle: "I", productHandle: "i" })) });
    const original = appPrisma.$transaction;
    let calls = 0;
    appPrisma.$transaction = function patched(...args) {
      calls += 1;
      if (calls % 3 === 0) return Promise.reject(deadlock()); // every third transaction "deadlocks" and is rerun
      return original.apply(appPrisma, args);
    };
    let outcomes;
    try {
      outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => W.addToWishlist(identityOf(shop, 100 + i), product(500 + i)).then(() => "ok", (error) => error.code)));
    } finally {
      appPrisma.$transaction = original;
    }
    assert.equal(outcomes.filter((outcome) => outcome === "ok").length, 4, "exactly the four that fit");
    assert.equal(outcomes.filter((outcome) => outcome === "shop_wishlist_limit_reached").length, 8);
    assert.equal(await items(shop), 50);
  }));

// ======================= legacy rule: historical usage vs reservations =======================
dbTest("historical SENT usage and reservations are counted separately; legacy SENDING / UNKNOWN stay reserved against Basic as a duplicate-send guard", async () => {
  const shop = await newShop("legacy");
  await seedEmails(shop, 3, { status: "SENT", planAtSend: null, sentAt: new Date(NOW.getTime() - 500 * DAY) }); // legacy history
  await seedEmails(shop, 2, { status: "SENT", planAtSend: "BASIC", sentAt: NOW });
  const legacyUnknown = await seedEmails(shop, 2, { status: "UNKNOWN", planAtSend: null, reservedAt: null, outbound: true }); // legacy, maybe delivered
  await seedEmails(shop, 1, { status: "SENDING", planAtSend: null });
  await seedEmails(shop, 1, { status: "UNKNOWN", planAtSend: "BASIC", reservedAt: NOW });
  await seedEmails(shop, 9, { status: "SENT", planAtSend: "ADVANCE", sentAt: NOW }); // paid history: never Basic
  await seedEmails(shop, 4, { status: "UNKNOWN", planAtSend: "ADVANCE", reservedAt: NOW }); // paid reservation: never Basic
  await seedEmails(shop, 6, { status: "PENDING", nextAttemptAt: due });
  await seedEmails(shop, 6, { status: "SKIPPED" });
  let usage = await usageFor(shop);
  assert.deepEqual([usage.sent, usage.reserved, usage.used, usage.remaining], [5, 4, 9, 41], "history: 3 legacy + 2 Basic; reservations: 2 legacy UNKNOWN + 1 legacy SENDING + 1 Basic UNKNOWN");
  assert.equal(usage.used, usage.sent + usage.reserved);
  // a reserved row that turns out to have been delivered moves from reservations to history, never into both
  await prisma.emailDelivery.update({ where: { id: legacyUnknown[0] }, data: { status: "SENT", sentAt: NOW } });
  usage = await usageFor(shop);
  assert.deepEqual([usage.sent, usage.reserved, usage.used], [6, 3, 9], "the total is unchanged by the move");
  // and it is still protected from a resend: neither claimed nor released by an expired lease
  await claim(shop); // an ordinary PENDING job is claimed; the remaining UNKNOWN delivery is not a candidate
  assert.equal((await delivery(legacyUnknown[1])).status, "UNKNOWN");
  assert.equal(await prisma.emailDelivery.count({ where: { id: { in: legacyUnknown }, status: "SENDING" } }), 0);
});

// ======================= plan changes while emails are in flight =======================
dbTest("an Advance reservation followed by a downgrade is not double-counted and cannot lend Advance quota to Basic", async () => {
  const shop = await newShop("downgrade");
  await paidSubscription(shop);
  const [first] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  const reserved = await claim(shop);
  assert.deepEqual([reserved.id, reserved.planAtSend], [first, "ADVANCE"]);
  assert.deepEqual([(await usageFor(shop)).reserved, (await usageFor(shop)).sent], [1, 0], "counted once under Advance");

  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { status: "CANCELLED" } }); // downgraded before it was sent
  const basic = await usageFor(shop);
  assert.deepEqual([basic.reserved, basic.sent, basic.used], [0, 0, 0], "the Advance reservation does not consume Basic");
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: NOW });
  const [second] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  assert.equal(await claim(shop), null, "Basic's quota is used up, whatever Advance had in flight");
  assert.equal((await delivery(second)).errorCode, QUOTA_BLOCKED);

  await prisma.emailDelivery.update({ where: { id: first }, data: { status: "SENT", sentAt: NOW } }); // the send completes
  assert.equal((await delivery(first)).planAtSend, "ADVANCE", "still attributed to the plan it was reserved under");
  assert.equal((await usageFor(shop)).used, 50, "Basic usage is unchanged by it");
});

dbTest("a reservation can never borrow the quota of a plan that is not verified", async () => {
  const shop = await newShop("unverified");
  await paidSubscription(shop, { plan: "ENTERPRISE", verifiedAt: new Date(NOW.getTime() - 2 * DAY) }); // stale
  await seedEmails(shop, 10, { status: "SENDING", planAtSend: "ENTERPRISE", reservedAt: NOW }); // earlier reservations under a verified plan
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: NOW });
  await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  assert.equal(await claim(shop), null, "the stale plan's room is not available; Basic is used up");
  assert.equal((await usageFor(shop)).used, 50, "and the Enterprise reservations are not Basic usage");
});

dbTest("a reservation that crosses a billing-period boundary counts in the period it was made in until it is sent, then in the period it was sent in", async () => {
  const shop = await newShop("boundary");
  const oldPeriod = { start: PERIOD_START, end: PERIOD_END };
  const newPeriod = { start: PERIOD_END, end: new Date(PERIOD_END.getTime() + 30 * DAY) };
  const view = (p, at) => resolveEntitlements({ plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: at, currentPeriodStart: p.start, currentPeriodEnd: p.end }, at);
  await paidSubscription(shop);
  const [id] = await seedEmails(shop, 1, { status: "SENDING", planAtSend: "ADVANCE", reservedAt: new Date(PERIOD_END.getTime() - MIN) });
  const inOld = async () => (await restockEmailUsage(shop.id, view(oldPeriod, NOW))).used;
  const inNew = async () => (await restockEmailUsage(shop.id, view(newPeriod, new Date(PERIOD_END.getTime() + HOUR)))).used;
  assert.deepEqual([await inOld(), await inNew()], [1, 0], "reserved just before the boundary: the old period holds it");
  await prisma.emailDelivery.update({ where: { id }, data: { status: "SENT", sentAt: new Date(PERIOD_END.getTime() + MIN) } });
  assert.deepEqual([await inOld(), await inNew()], [0, 1], "sent just after it: the new period, and only the new one");
});

dbTest("an UNKNOWN delivery stays protected after a downgrade: never claimed, never released, still reserved under its own plan", async () => {
  const shop = await newShop("unknown-downgrade");
  await paidSubscription(shop, { status: "CANCELLED" });
  const [id] = await seedEmails(shop, 1, { status: "UNKNOWN", planAtSend: "ADVANCE", reservedAt: new Date(NOW.getTime() - 40 * DAY), outbound: true });
  assert.equal(await claim(shop), null);
  await recoverExpiredLeases({ now: new Date(NOW.getTime() + 30 * DAY), shopIds: [shop.id] });
  const row = await delivery(id);
  assert.deepEqual([row.status, row.planAtSend], ["UNKNOWN", "ADVANCE"]);
  assert.equal((await usageFor(shop)).used, 0, "it is not Basic usage");
});

dbTest("a verification whose lease expired while its worker was still running cannot overwrite the worker that took over", async () => {
  const shop = await newShop("lease-expiry");
  await prisma.shopSubscription.create({ data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date("2020-01-01"), currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END, nextVerificationAt: new Date("2020-01-01") } });
  const real = () => new Date();
  const slow = V.runSubscriptionVerification({ verify: async () => { await sleep(350); return { outcome: "none" }; }, now: real, leaseMs: 80, timeoutMs: 3000, shopIds: [shop.id], log: quiet });
  await sleep(180); // worker A's lease has run out while it is still waiting for its answer
  const takeover = await V.runSubscriptionVerification({ verify: async () => activeAnswer(), now: real, shopIds: [shop.id], log: quiet });
  assert.equal(takeover.active, 1, "worker B took the row over");
  const first = await slow;
  assert.equal(first.stale, 1, "worker A's late answer found it no longer held the row");
  const row = await prisma.shopSubscription.findUnique({ where: { shopId: shop.id } });
  assert.deepEqual([row.status, row.plan, row.verificationFailures, row.verificationLeaseExpiresAt], ["ACTIVE", "ADVANCE", 0, null], "B's result stands; A's cancellation was discarded");
});
