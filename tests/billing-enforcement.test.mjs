// Tests for the billing enforcement layer: restock-email quota accounting and reservation (email-quota.server.js, entitlements.server.js,
// email-delivery.server.js claimNext), the store-wide wishlist cap (wishlist.server.js), subscription verification
// (subscription-verification.server.js) and the plan-recommendation job life cycle (plan-recommendation.server.js).
//
// Run: node --test tests/billing-enforcement.test.mjs
//
// Every test here WRITES rows, so they only run when DATABASE_URL (set in the environment) names an isolated kw_*test* database with the
// migrations applied; otherwise they are skipped and say so. Nothing here calls Shopify or any billing service: the verifier and the
// session source are stubs, and no mail is sent.
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

// Dynamic imports: the extensionless-import hook above must be active before the app modules are linked.
process.env.SHOPIFY_API_KEY ||= "dummy-key";
process.env.SHOPIFY_API_SECRET ||= "dummy-secret-for-tests-only";
process.env.SHOPIFY_APP_URL ||= "https://app.example.invalid";
const { billingEnforced } = await import("../app/models/plans.server.js");
const { getEntitlements, resolveEntitlements, restockEmailUsage, quotaRetryAt } = await import("../app/models/entitlements.server.js");
const { claimNext, recoverExpiredLeases } = await import("../app/models/email-delivery.server.js");
const { QUOTA_BLOCKED, wakeQuotaBlocked } = await import("../app/models/email-quota.server.js");
const V = await import("../app/models/subscription-verification.server.js");
const R = await import("../app/models/plan-recommendation.server.js");
const { runBillingJobs } = await import("../app/worker/billing-jobs.server.js");
const W = skip ? null : await import("../app/models/wishlist.server.js");

const NOW = new Date("2026-11-11T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RUN = Date.now().toString(36);
const domains = [];
let seq = 8800000000;
const newShop = async (tag) => {
  const domain = `kw-be-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});

// ---------- fixtures ----------
const PERIOD_START = new Date(NOW.getTime() - 10 * DAY);
const PERIOD_END = new Date(NOW.getTime() + 20 * DAY);
const paidSubscription = (shop, over = {}) =>
  prisma.shopSubscription.create({
    data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date(NOW.getTime() - HOUR), currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END, ...over },
  });

// The wishlist path (addToWishlist -> getEntitlements) reads the REAL clock and has no way to be given the fixed NOW, unlike the email path, which is
// handed `now`. A subscription meant to be "verified an hour ago" for that path must therefore be dated from the same real clock it will be judged by;
// with the fixed NOW it silently turned stale (24 h freshness rule) a day after NOW and the shop resolved to Basic. The 24 h rule itself is untouched.
const paidSubscriptionOnRealClock = (shop, over = {}) => {
  const now = Date.now();
  return paidSubscription(shop, { verifiedAt: new Date(now - HOUR), currentPeriodStart: new Date(now - 10 * DAY), currentPeriodEnd: new Date(now + 20 * DAY), ...over });
};

// `count` deliveries in the given state, each with its own subscription (one row per delivery, like the real queue).
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
const usageOf = async (shop, now = NOW) => (await restockEmailUsage(shop.id, await getEntitlements(shop.id, { now }))).used;
const delivery = (id) => prisma.emailDelivery.findUnique({ where: { id } });
const due = new Date(NOW.getTime() - MIN);

// ======================= email quota: attribution and accounting =======================
dbTest("Basic lifetime usage counts Basic-attributed and legacy unattributed sends, and not emails sent under a paid plan", async () => {
  const shop = await newShop("basic-count");
  await seedEmails(shop, 4, { planAtSend: "BASIC", sentAt: NOW });
  await seedEmails(shop, 3, { planAtSend: null, sentAt: new Date(NOW.getTime() - 400 * DAY) }); // legacy: no attribution
  await seedEmails(shop, 5, { planAtSend: "ADVANCE", sentAt: NOW }); // sent while on a paid plan
  await seedEmails(shop, 2, { planAtSend: "ENTERPRISE", sentAt: new Date(NOW.getTime() - 90 * DAY) });
  const usage = await restockEmailUsage(shop.id, await getEntitlements(shop.id, { now: NOW }));
  assert.deepEqual([usage.quota, usage.used, usage.remaining, usage.period], [50, 7, 43, "lifetime"], "4 Basic + 3 legacy; the 7 paid-era emails do not count");
});

dbTest("only emails that hold or used the quota count: SENT, SENDING and UNKNOWN; not PENDING, FAILED or SKIPPED", async () => {
  const shop = await newShop("states");
  await seedEmails(shop, 2, { status: "SENT", planAtSend: "BASIC", sentAt: NOW });
  await seedEmails(shop, 3, { status: "SENDING", planAtSend: "BASIC", reservedAt: NOW });
  await seedEmails(shop, 4, { status: "UNKNOWN", planAtSend: "BASIC", reservedAt: NOW });
  await seedEmails(shop, 5, { status: "PENDING", nextAttemptAt: due });
  await seedEmails(shop, 6, { status: "FAILED" });
  await seedEmails(shop, 7, { status: "SKIPPED" });
  assert.equal(await usageOf(shop), 9);
});

dbTest("Basic -> Advance -> Basic: each period of paid use is separate, and Basic's lifetime count only grows with Basic-era sends", async () => {
  const shop = await newShop("cycles");
  await seedEmails(shop, 10, { planAtSend: "BASIC", sentAt: new Date(NOW.getTime() - 100 * DAY) }); // first Basic stretch
  await seedEmails(shop, 400, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - 60 * DAY) }); // an Advance month
  await seedEmails(shop, 25, { planAtSend: "BASIC", sentAt: new Date(NOW.getTime() - 5 * DAY) }); // back on Basic
  assert.equal(await usageOf(shop), 35, "10 + 25 Basic-era emails, the 400 Advance ones never count");
  // upgrade again: a new verified period starts with its own empty count
  await paidSubscription(shop);
  const advance = await restockEmailUsage(shop.id, await getEntitlements(shop.id, { now: NOW }));
  assert.deepEqual([advance.quota, advance.used], [1500, 0], "the Advance mail of two months ago is outside this period, and Basic mail is never Advance usage");
  await seedEmails(shop, 6, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - DAY) });
  assert.equal(await usageOf(shop), 6);
  // downgrade again (cancelled): Basic usage is still 35, not 41
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { status: "CANCELLED" } });
  assert.equal(await usageOf(shop), 35);
});

dbTest("paid usage is attributed to ITS plan and to the verified period: start included, end excluded, legacy and Basic never count", async () => {
  const shop = await newShop("period");
  await paidSubscription(shop, { plan: "ADVANCE" });
  const at = (date) => seedEmails(shop, 1, { planAtSend: "ADVANCE", sentAt: date });
  await at(new Date(PERIOD_START.getTime() - 1)); // the instant before: outside
  await at(PERIOD_START); // the first instant: inside
  await at(new Date(NOW.getTime() - DAY));
  await at(new Date(PERIOD_END.getTime() - 1)); // the last instant: inside
  await at(PERIOD_END); // the first instant of the NEXT period: outside
  await seedEmails(shop, 3, { planAtSend: null, sentAt: NOW }); // legacy
  await seedEmails(shop, 2, { planAtSend: "BASIC", sentAt: NOW });
  await seedEmails(shop, 2, { planAtSend: "ENTERPRISE", sentAt: NOW }); // another plan's attribution
  await seedEmails(shop, 2, { status: "SENDING", planAtSend: "ADVANCE", reservedAt: NOW }); // a reservation is dated by reservedAt
  await seedEmails(shop, 1, { status: "UNKNOWN", planAtSend: "ADVANCE", reservedAt: PERIOD_END });
  const usage = await restockEmailUsage(shop.id, await getEntitlements(shop.id, { now: NOW }));
  assert.deepEqual([usage.quota, usage.used], [1500, 5], "start, middle, last instant, and two reservations; not before, not at the end, not other plans");
  assert.deepEqual([usage.period.start.getTime(), usage.period.end.getTime()], [PERIOD_START.getTime(), PERIOD_END.getTime()]);

  // Enterprise has its own attribution and its own quota over the same period
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { plan: "ENTERPRISE" } });
  const enterprise = await restockEmailUsage(shop.id, await getEntitlements(shop.id, { now: NOW }));
  assert.deepEqual([enterprise.quota, enterprise.used], [3000, 2]);
});

// ======================= email quota: reservation, concurrency, exhaustion =======================
dbTest("claiming a job reserves quota under the effective plan and records when; SENT keeps the attribution", async () => {
  const basicShop = await newShop("claim-basic");
  const paidShop = await newShop("claim-paid");
  await paidSubscription(paidShop, { plan: "ENTERPRISE" });
  const [basicId] = await seedEmails(basicShop, 1, { status: "PENDING", nextAttemptAt: due });
  const [paidId] = await seedEmails(paidShop, 1, { status: "PENDING", nextAttemptAt: due });
  const basicJob = await claimNext({ now: NOW, shopIds: [basicShop.id], enforce: true });
  const paidJob = await claimNext({ now: NOW, shopIds: [paidShop.id], enforce: true });
  assert.deepEqual([basicJob.id, basicJob.status, basicJob.planAtSend, basicJob.reservedAt.getTime(), basicJob.attempts], [basicId, "SENDING", "BASIC", NOW.getTime(), 1]);
  assert.deepEqual([paidJob.id, paidJob.planAtSend], [paidId, "ENTERPRISE"], "the plan in force when it was claimed, not inferred later");
  assert.equal(await usageOf(basicShop), 1, "the reservation counts at once");
  // the plan changing afterwards does not re-attribute a reserved email
  await prisma.shopSubscription.update({ where: { shopId: paidShop.id }, data: { status: "CANCELLED" } });
  assert.equal((await delivery(paidId)).planAtSend, "ENTERPRISE");
});

dbTest("concurrent workers can never reserve more than the quota that is left", async () => {
  const shop = await newShop("race");
  await seedEmails(shop, 47, { planAtSend: "BASIC", sentAt: NOW }); // Basic allows 50: three left
  await seedEmails(shop, 10, { status: "PENDING", nextAttemptAt: due });
  const results = await Promise.all(Array.from({ length: 12 }, () => claimNext({ now: NOW, shopIds: [shop.id], enforce: true })));
  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 3, "exactly the three that fit");
  assert.equal(new Set(claimed.map((job) => job.id)).size, 3, "each job claimed once");
  assert.equal(await usageOf(shop), 50);
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id, status: "SENDING" } }), 3);
});

dbTest("a retry of the same delivery never holds two reservations, and a released reservation is not counted", async () => {
  const shop = await newShop("retry");
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  const first = await claimNext({ now: NOW, shopIds: [shop.id], enforce: true });
  assert.equal(await usageOf(shop), 1);
  // what processJob does after a transient failure: nothing was sent, the row goes back to PENDING
  await prisma.emailDelivery.update({ where: { id }, data: { status: "PENDING", errorCode: "smtp_ETIMEDOUT", nextAttemptAt: due, leaseExpiresAt: null } });
  assert.equal(await usageOf(shop), 0, "released: nothing was sent");
  const second = await claimNext({ now: NOW, shopIds: [shop.id], enforce: true });
  assert.deepEqual([second.id, second.attempts, await usageOf(shop)], [first.id, 2, 1], "the same row, one reservation");
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id } }), 1);
});

dbTest("SENDING and UNKNOWN stay reserved; an UNKNOWN delivery is never claimed or resent, and an expired lease never releases it", async () => {
  const shop = await newShop("unknown");
  const [unknownId] = await seedEmails(shop, 1, { status: "UNKNOWN", planAtSend: "BASIC", reservedAt: new Date(NOW.getTime() - 30 * DAY), outbound: true });
  assert.equal(await claimNext({ now: NOW, shopIds: [shop.id], enforce: true }), null, "an UNKNOWN row is not a candidate, however old");
  const [stuckId] = await seedEmails(shop, 1, { status: "SENDING", planAtSend: "BASIC", reservedAt: new Date(NOW.getTime() - HOUR), outbound: true }); // died after the SMTP boundary
  const [safeId] = await seedEmails(shop, 1, { status: "SENDING", planAtSend: "BASIC", reservedAt: new Date(NOW.getTime() - HOUR) });
  await prisma.emailDelivery.update({ where: { id: safeId }, data: { leaseExpiresAt: new Date(NOW.getTime() - MIN) } }); // died BEFORE the SMTP call
  assert.equal(await usageOf(shop), 3);
  await recoverExpiredLeases({ now: NOW, shopIds: [shop.id] });
  assert.equal((await delivery(stuckId)).status, "UNKNOWN", "the outcome is unknown, so it stays reserved");
  assert.equal((await delivery(safeId)).status, "PENDING", "provably nothing was sent: released");
  assert.equal((await delivery(unknownId)).status, "UNKNOWN");
  assert.equal(await usageOf(shop), 2, "the two UNKNOWN rows still hold their quota");
});

dbTest("when the quota is used up the job stays PENDING with no lease, is parked without a date for Basic, and other jobs still run", async () => {
  const full = await newShop("full");
  const other = await newShop("other");
  await seedEmails(full, 50, { planAtSend: "BASIC", sentAt: NOW });
  const [blockedId] = await seedEmails(full, 1, { status: "PENDING", nextAttemptAt: due });
  const [freeId] = await seedEmails(other, 1, { status: "PENDING", nextAttemptAt: due });
  const claimed = await claimNext({ now: NOW, enforce: true, shopIds: [full.id, other.id] });
  assert.equal(claimed.id, freeId, "the unrelated shop's job is not held up by the blocked one");
  const blocked = await delivery(blockedId);
  assert.deepEqual([blocked.status, blocked.leaseExpiresAt, blocked.errorCode, blocked.nextAttemptAt, blocked.attempts], ["PENDING", null, QUOTA_BLOCKED, null, 0], "Basic's lifetime quota has no reset date, so none is invented");
  assert.equal(await claimNext({ now: new Date(NOW.getTime() + 30 * DAY), enforce: true, shopIds: [full.id] }), null, "not retried on a timer, not even a month later");
  assert.equal((await delivery(blockedId)).status, "PENDING", "still eligible, never skipped or failed");
});

dbTest("a paid job blocked by quota waits for the next verified period and then runs", async () => {
  const shop = await newShop("renew");
  await paidSubscription(shop, { plan: "ADVANCE" });
  await seedEmails(shop, 1500, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - DAY) });
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  assert.equal(await claimNext({ now: NOW, shopIds: [shop.id], enforce: true }), null);
  const parked = await delivery(id);
  assert.deepEqual([parked.status, parked.errorCode, parked.nextAttemptAt.getTime()], ["PENDING", QUOTA_BLOCKED, PERIOD_END.getTime()], "due again when the verified period ends");
  assert.equal(await claimNext({ now: new Date(PERIOD_END.getTime() - 1), shopIds: [shop.id], enforce: true }), null, "not before");

  // the renewal is verified: a new period, Advance mail of the old period no longer counts
  const later = new Date(PERIOD_END.getTime() + HOUR);
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { verifiedAt: later, currentPeriodStart: PERIOD_END, currentPeriodEnd: new Date(PERIOD_END.getTime() + 30 * DAY) } });
  const job = await claimNext({ now: later, shopIds: [shop.id], enforce: true });
  assert.deepEqual([job.id, job.planAtSend, job.errorCode], [id, "ADVANCE", null]);
});

dbTest("without a known billing period nothing is guessed: the work stays pending with no invented reset date", async () => {
  const shop = await newShop("noperiod");
  await paidSubscription(shop, { plan: "ADVANCE", currentPeriodStart: null, currentPeriodEnd: null }); // cannot be trusted as paid: Basic
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: NOW });
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  assert.equal(await claimNext({ now: NOW, shopIds: [shop.id], enforce: true }), null);
  const row = await delivery(id);
  assert.deepEqual([row.status, row.nextAttemptAt, row.errorCode], ["PENDING", null, QUOTA_BLOCKED]);
  assert.equal(quotaRetryAt(resolveEntitlements(await prisma.shopSubscription.findUnique({ where: { shopId: shop.id } }), NOW), NOW), null);
});

dbTest("with enforcement off the attribution is still recorded but nothing is blocked", async () => {
  assert.equal(billingEnforced({}), false);
  assert.equal(billingEnforced({ BILLING_ENFORCEMENT: "on" }), true);
  assert.equal(billingEnforced({ BILLING_ENFORCEMENT: "1" }), false, "only the explicit value switches it on");
  const shop = await newShop("off");
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: NOW });
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  const job = await claimNext({ now: NOW, shopIds: [shop.id], enforce: false });
  assert.deepEqual([job.id, job.planAtSend], [id, "BASIC"]);
});

// ======================= subscription verification =======================
const activeAnswer = (over = {}) => ({ outcome: "active", plan: "ADVANCE", periodStart: PERIOD_START, periodEnd: PERIOD_END, source: "app_pricing", shopifySubscriptionGid: "gid://shopify/AppSubscription/1", planHandle: "advance", ...over });
const verifyWith = (answer) => async () => (typeof answer === "function" ? answer() : answer);
const runVerify = (shop, verify, now = NOW, extra = {}) => V.runSubscriptionVerification({ verify, now: () => now, shopIds: [shop.id], log: { log() {}, error() {} }, ...extra });
const dueRow = (shop, over = {}) => prisma.shopSubscription.create({ data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date(NOW.getTime() - 13 * HOUR), currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END, nextVerificationAt: due, ...over } });
const subRow = (shop) => prisma.shopSubscription.findUnique({ where: { shopId: shop.id } });

dbTest("a successful verification grants the paid plan, resets the retry counters and schedules the next check before the 24-hour deadline", async () => {
  const shop = await newShop("v-ok");
  await dueRow(shop, { plan: "BASIC", status: "ACTIVE", verifiedAt: null, verificationSource: null, currentPeriodStart: null, currentPeriodEnd: null, verificationFailures: 3, lastVerificationError: "transient_timeout" });
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC");
  const summary = await runVerify(shop, verifyWith(activeAnswer()));
  assert.equal(summary.active, 1);
  const row = await subRow(shop);
  assert.deepEqual([row.plan, row.status, row.verificationSource, row.verifiedAt.getTime(), row.verificationFailures, row.lastVerificationError, row.verificationLeaseExpiresAt, row.shopifySubscriptionGid, row.planHandle], ["ADVANCE", "ACTIVE", "app_pricing", NOW.getTime(), 0, null, null, "gid://shopify/AppSubscription/1", "advance"]);
  assert.equal(row.nextVerificationAt.getTime(), NOW.getTime() + 12 * HOUR, "about 12 hours after a successful check");
  const view = await getEntitlements(shop.id, { now: NOW });
  assert.deepEqual([view.plan.key, view.state], ["ADVANCE", "verified"]);
});

dbTest("a check is scheduled at the billing-period boundary so a renewal is picked up at once", async () => {
  const shop = await newShop("v-boundary");
  const end = new Date(NOW.getTime() + 2 * HOUR);
  await dueRow(shop);
  await runVerify(shop, verifyWith(activeAnswer({ periodEnd: end })));
  assert.equal((await subRow(shop)).nextVerificationAt.getTime(), end.getTime(), "the period ends sooner than 12 hours: check then");
  // at the boundary the verifier reports the renewed period
  const atBoundary = new Date(end.getTime() + MIN);
  await prisma.emailDelivery.deleteMany({ where: { shopId: shop.id } });
  const [parkedId] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: null, errorCode: QUOTA_BLOCKED });
  const next = { periodStart: end, periodEnd: new Date(end.getTime() + 30 * DAY) };
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: end } });
  await runVerify(shop, verifyWith(activeAnswer(next)), atBoundary);
  const row = await subRow(shop);
  assert.deepEqual([row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime()], [next.periodStart.getTime(), next.periodEnd.getTime()]);
  assert.equal((await getEntitlements(shop.id, { now: atBoundary })).state, "verified", "no Basic gap at the renewal");
  assert.equal((await delivery(parkedId)).nextAttemptAt.getTime(), atBoundary.getTime(), "parked mail is woken by the new period");
  // a verifier that still reports the ended period is checked again soon, not in 12 hours
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: due } });
  await runVerify(shop, verifyWith(activeAnswer({ periodEnd: new Date(NOW.getTime() - HOUR) })));
  assert.equal((await subRow(shop)).nextVerificationAt.getTime(), NOW.getTime() + 5 * MIN);
});

dbTest("a transient failure keeps the subscription data, falls back to Basic once stale, and retries with bounded backoff", async () => {
  const shop = await newShop("v-transient");
  const before = await dueRow(shop); // verified 13 hours ago
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "ADVANCE", "still fresh: 24 hours have not passed");
  const delays = [];
  let at = NOW;
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: at } });
    await runVerify(shop, verifyWith(() => { throw Object.assign(new Error("boom"), { code: "ETIMEDOUT" }); }), at);
    const row = await subRow(shop);
    delays.push((row.nextVerificationAt.getTime() - at.getTime()) / MIN);
    assert.deepEqual([row.plan, row.status, row.verificationSource, row.verifiedAt.getTime(), row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime()], ["ADVANCE", "ACTIVE", "app_pricing", before.verifiedAt.getTime(), PERIOD_START.getTime(), PERIOD_END.getTime()], "nothing about the subscription is erased or changed by a failure");
    assert.equal(row.verificationFailures, attempt);
    assert.equal(row.lastVerificationError, "ETIMEDOUT", "a transient failure keeps the plain code; permission and config errors are prefixed");
    assert.equal(row.verificationLeaseExpiresAt, null);
    at = row.nextVerificationAt;
  }
  assert.deepEqual(delays, [1, 2, 4, 8, 16, 32, 64, 120, 120], "1, 2, 4 ... minutes, capped at 2 hours: no tight loop");
  const stale = await getEntitlements(shop.id, { now: new Date(NOW.getTime() + 12 * HOUR) });
  assert.deepEqual([stale.plan.key, stale.reason], ["BASIC", "verification_stale"], "Basic while it cannot be verified");
  assert.equal((await subRow(shop)).status, "ACTIVE", "and never marked cancelled");
});

dbTest("a successful check after failures restores the paid plan and clears the retry state", async () => {
  const shop = await newShop("v-recover");
  await dueRow(shop, { verificationFailures: 6, lastVerificationError: "transient_timeout", verifiedAt: new Date(NOW.getTime() - 30 * HOUR) });
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC");
  await runVerify(shop, verifyWith(activeAnswer()));
  const row = await subRow(shop);
  assert.deepEqual([row.verificationFailures, row.lastVerificationError], [0, null]);
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "ADVANCE");
});

dbTest("permission and configuration errors are recorded under their own code, wait long, and never cancel", async () => {
  const shop = await newShop("v-perm");
  await dueRow(shop);
  await runVerify(shop, verifyWith({ outcome: "error", kind: "permission", code: "access_denied" }));
  let row = await subRow(shop);
  assert.deepEqual([row.lastVerificationError, row.verificationFailures, row.status, (row.nextVerificationAt.getTime() - NOW.getTime()) / HOUR], ["permission_access_denied", 1, "ACTIVE", 6]);
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: due } });
  await runVerify(shop, verifyWith({ outcome: "error", kind: "config", code: "no_credentials" }));
  row = await subRow(shop);
  assert.deepEqual([row.lastVerificationError, row.status, row.plan], ["config_no_credentials", "ACTIVE", "ADVANCE"], "a missing credential is not a cancellation");
});

dbTest("an unusable answer is a transient failure, never a cancellation or a grant", async () => {
  const shop = await newShop("v-garbage");
  await dueRow(shop, { plan: "BASIC", verifiedAt: null, verificationSource: null, currentPeriodStart: null, currentPeriodEnd: null });
  for (const bad of [undefined, null, "active", {}, { outcome: "active" }, { outcome: "active", plan: "BASIC", periodStart: PERIOD_START, periodEnd: PERIOD_END, source: "app_pricing" }, { outcome: "active", plan: "ADVANCE", periodStart: PERIOD_END, periodEnd: PERIOD_START, source: "app_pricing" }, { outcome: "active", plan: "ADVANCE", periodStart: PERIOD_START, periodEnd: PERIOD_END }, { outcome: "inactive", status: "ACTIVE" }]) {
    await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: due } });
    await runVerify(shop, verifyWith(bad));
    const row = await subRow(shop);
    assert.deepEqual([row.plan, row.status, row.verifiedAt], ["BASIC", "ACTIVE", null], JSON.stringify(bad));
    assert.equal(row.lastVerificationError, "invalid_response");
  }
});

dbTest("only authoritative evidence cancels: 'none' and 'inactive' move a paid row to an inactive state and Basic entitlements", async () => {
  const gone = await newShop("v-none");
  await dueRow(gone);
  await runVerify(gone, verifyWith({ outcome: "none" }));
  let row = await subRow(gone);
  assert.deepEqual([row.status, row.plan, row.currentPeriodEnd.getTime(), row.verificationFailures], ["CANCELLED", "ADVANCE", PERIOD_END.getTime(), 0], "the history stays, the status changes");
  assert.deepEqual([(await getEntitlements(gone.id, { now: NOW })).plan.key, (await getEntitlements(gone.id, { now: NOW })).reason], ["BASIC", "subscription_cancelled"]);
  assert.equal((row.nextVerificationAt.getTime() - NOW.getTime()) / HOUR, 24, "rechecked daily in case the merchant subscribes again");
  const frozen = await newShop("v-frozen");
  await dueRow(frozen);
  await runVerify(frozen, verifyWith({ outcome: "inactive", status: "FROZEN" }));
  assert.equal((await subRow(frozen)).status, "FROZEN");
  const free = await newShop("v-free");
  await dueRow(free, { plan: "BASIC" });
  await runVerify(free, verifyWith({ outcome: "none" }));
  row = await subRow(free);
  assert.deepEqual([row.plan, row.status], ["BASIC", "ACTIVE"], "a free shop with no subscription simply stays free");
});

dbTest("no verifier configured: the step does nothing and touches no row", async () => {
  const shop = await newShop("v-none-configured");
  const created = await dueRow(shop);
  const summary = await runVerify(shop, undefined);
  assert.equal(summary.skipped, "no_verifier");
  const row = await subRow(shop);
  assert.deepEqual([row.updatedAt.getTime(), row.verificationFailures, row.status], [created.updatedAt.getTime(), 0, "ACTIVE"]);
  const jobs = await runBillingJobs({ services: {}, log: { log() {}, error() {} } });
  assert.deepEqual([jobs.verification.skipped, jobs.recommendations.skipped], ["no_verifier", "no_session_source"]);
  const isolated = await runBillingJobs({ services: { verify: async () => { throw new Error("x"); }, fetchSessions: null }, shouldStop: () => true, log: { log() {}, error() {} } });
  assert.equal(isolated.recommendations.skipped, "no_session_source", "one step never stops the other");
});

dbTest("a verifier that never answers is cut off and counted as a transient failure", async () => {
  const shop = await newShop("v-timeout");
  await dueRow(shop);
  const started = Date.now();
  await runVerify(shop, () => new Promise(() => {}), NOW, { timeoutMs: 40 });
  assert.ok(Date.now() - started < 3000);
  const row = await subRow(shop);
  assert.deepEqual([row.lastVerificationError, row.verificationFailures, row.status], ["timeout", 1, "ACTIVE"]);
});

dbTest("two workers cannot claim the same verification; a claimed row is skipped until its lease expires; a stale worker cannot overwrite", async () => {
  const shop = await newShop("v-claim");
  await dueRow(shop);
  const claims = await Promise.all([V.claimDueVerification({ now: NOW, shopIds: [shop.id] }), V.claimDueVerification({ now: NOW, shopIds: [shop.id] }), V.claimDueVerification({ now: NOW, shopIds: [shop.id] })]);
  assert.equal(claims.filter(Boolean).length, 1, "exactly one winner");
  const a = claims.find(Boolean);
  assert.equal(await V.claimDueVerification({ now: new Date(NOW.getTime() + MIN), shopIds: [shop.id] }), null, "leased: nobody else may take it");
  // worker A died: after the lease has run out another worker takes the row over
  const later = new Date(NOW.getTime() + 10 * MIN);
  const b = await V.claimDueVerification({ now: later, shopIds: [shop.id] });
  assert.ok(b, "an expired lease is recovered");
  assert.notEqual(a.lease.getTime(), b.lease.getTime());
  // the slow worker A finishes: its lease is gone, so it changes nothing
  const stale = await V.applyVerification(a.row, a.lease, { outcome: "none" }, { now: later });
  assert.equal(stale.applied, false);
  assert.equal((await subRow(shop)).status, "ACTIVE");
  const fresh = await V.applyVerification(b.row, b.lease, V.normalizeVerification(activeAnswer()), { now: later });
  assert.equal(fresh.applied, true);
  assert.equal((await subRow(shop)).verifiedAt.getTime(), later.getTime());
});

dbTest("shops that are not due, are free, or are uninstalled are not claimed", async () => {
  const notDue = await newShop("v-notdue");
  await dueRow(notDue, { nextVerificationAt: new Date(NOW.getTime() + HOUR) });
  const gone = await newShop("v-uninstalled");
  await dueRow(gone);
  await prisma.shop.update({ where: { id: gone.id }, data: { status: "UNINSTALLED" } });
  const free = await newShop("v-freerow");
  await prisma.shopSubscription.create({ data: { shopId: free.id } }); // free Basic, nothing scheduled
  assert.equal(await V.claimDueVerification({ now: NOW, shopIds: [notDue.id, gone.id, free.id] }), null);
  const unscheduledPaid = await newShop("v-unscheduled");
  await dueRow(unscheduledPaid, { nextVerificationAt: null });
  assert.ok(await V.claimDueVerification({ now: NOW, shopIds: [unscheduledPaid.id] }), "a paid row nobody scheduled is picked up, not forgotten");
});

dbTest("on-demand verification uses the same claim and respects backoff and recent checks", async () => {
  const shop = await newShop("v-demand");
  const stub = (answer) => { const fn = async () => answer; fn.calls = 0; return fn; };
  let calls = 0;
  const verify = async () => { calls += 1; return activeAnswer(); };
  const unavailable = await V.verifyShopOnDemand(shop.id, { verify: undefined, now: () => NOW });
  assert.deepEqual([unavailable.status, unavailable.entitlements.plan.key], ["unavailable", "BASIC"]);
  assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id } }), 0, "nothing is created when there is nothing to ask");
  const first = await V.verifyShopOnDemand(shop.id, { verify, now: () => NOW });
  assert.deepEqual([first.status, first.entitlements.plan.key, calls], ["active", "ADVANCE", 1]);
  const again = await V.verifyShopOnDemand(shop.id, { verify, now: () => new Date(NOW.getTime() + 10 * 1000) });
  assert.deepEqual([again.status, calls], ["fresh", 1], "no second API call within a minute");
  // a lease held by a worker: not bypassed
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { verifiedAt: new Date(NOW.getTime() - HOUR), verificationLeaseExpiresAt: new Date(NOW.getTime() + 4 * MIN) } });
  const busy = await V.verifyShopOnDemand(shop.id, { verify, now: () => NOW });
  assert.deepEqual([busy.status, calls], ["in_progress", 1]);
  // backoff after a failure: not asked early
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { verificationLeaseExpiresAt: null, verificationFailures: 2, nextVerificationAt: new Date(NOW.getTime() + 30 * MIN) } });
  const waiting = await V.verifyShopOnDemand(shop.id, { verify, now: () => NOW });
  assert.deepEqual([waiting.status, calls], ["backoff", 1]);
  void stub;
});

dbTest("upgrading wakes parked mail; a recommendation never grants an entitlement", async () => {
  const shop = await newShop("v-wake");
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: NOW });
  const [id] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: due });
  await prisma.shopSubscription.create({ data: { shopId: shop.id } });
  assert.equal(await claimNext({ now: NOW, shopIds: [shop.id], enforce: true }), null);
  assert.equal((await delivery(id)).nextAttemptAt, null);
  // advice alone changes nothing
  await R.ensurePlanRecommendation(shop.id, { now: NOW });
  const claim = await R.claimDueRecommendation({ now: NOW, shopIds: [shop.id] });
  await R.recordSessionResult(shop.id, { sessions: 500000, periodStart: new Date(NOW.getTime() - 30 * DAY), periodEnd: NOW }, { lease: claim.lease, now: NOW });
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC", "ENTERPRISE advice, still Basic");
  assert.equal((await subRow(shop)).plan, "BASIC");
  // a verified upgrade wakes the parked mail
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: due } });
  await runVerify(shop, verifyWith(activeAnswer({ plan: "ENTERPRISE" })));
  assert.equal((await delivery(id)).nextAttemptAt.getTime(), NOW.getTime());
  const job = await claimNext({ now: NOW, shopIds: [shop.id], enforce: true });
  assert.deepEqual([job.id, job.planAtSend], [id, "ENTERPRISE"]);
  assert.equal((await wakeQuotaBlocked(shop.id, { now: NOW })).count, 0, "nothing left to wake");
});

// ======================= wishlist: store-wide cap =======================
const identityOf = (shop, n) => ({ shopDomain: shop.domain, customerGid: `gid://shopify/Customer/${n}` });
const product = (n) => ({ productGid: `gid://shopify/Product/${n}`, variantGid: `gid://shopify/ProductVariant/${n}`, title: "Item", handle: "item" });
const seedItems = async (shop, total, perCustomer = 100) => {
  const customers = Math.ceil(total / perCustomer);
  for (let c = 0; c < customers; c += 1) {
    const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${9000000 + (seq += 1)}` } });
    const here = Math.min(perCustomer, total - c * perCustomer);
    await prisma.wishlistItem.createMany({ data: Array.from({ length: here }, (_, i) => ({ shopId: shop.id, actorId: actor.id, productGid: `gid://shopify/Product/${i + 1}`, variantGid: `gid://shopify/ProductVariant/${i + 1}`, productTitle: "Item", productHandle: "item" })) });
  }
};
const items = (shop) => prisma.wishlistItem.count({ where: { shopId: shop.id } });
const withEnforcement = async (value, fn) => {
  const before = process.env.BILLING_ENFORCEMENT;
  if (value === undefined) delete process.env.BILLING_ENFORCEMENT;
  else process.env.BILLING_ENFORCEMENT = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = before;
  }
};
const refusal = (promise) => promise.then(() => null, (error) => error);

dbTest("the Basic cap of 50 counts every customer of the shop together and refuses the 51st with a stable error", () =>
  withEnforcement("on", async () => {
    const shop = await newShop("wl-basic");
    await seedItems(shop, 49, 7); // seven customers, 49 items: nobody is near the per-customer cap
    assert.equal((await W.addToWishlist(identityOf(shop, 1), product(900))).saved, true);
    assert.equal(await items(shop), 50);
    const error = await refusal(W.addToWishlist(identityOf(shop, 2), product(901)));
    assert.ok(error instanceof W.WishlistError);
    assert.deepEqual([error.code, error.status, error.code === W.SHOP_WISHLIST_LIMIT], ["shop_wishlist_limit_reached", 409, true]);
    assert.equal(await items(shop), 50);
    const repeat = await W.addToWishlist(identityOf(shop, 1), product(900));
    assert.equal(repeat.changed, false, "saving something already saved is still a quiet no-op at the limit");
  }));

dbTest("one shop's items never count against another shop's cap", () =>
  withEnforcement("on", async () => {
    const full = await newShop("wl-iso-full");
    const empty = await newShop("wl-iso-empty");
    await seedItems(full, 50);
    assert.equal((await refusal(W.addToWishlist(identityOf(full, 1), product(1))))?.code, "shop_wishlist_limit_reached");
    assert.equal((await W.addToWishlist(identityOf(empty, 1), product(1))).saved, true);
  }));

dbTest("concurrent additions from many customers can never exceed the cap", () =>
  withEnforcement("on", async () => {
    const shop = await newShop("wl-race");
    await seedItems(shop, 45, 9);
    const attempts = await Promise.all(Array.from({ length: 14 }, (_, i) => refusal(W.addToWishlist(identityOf(shop, 100 + i), product(500 + i)))));
    assert.equal(attempts.filter((error) => error === null).length, 5, "exactly the five that fit");
    assert.equal(attempts.filter((error) => error?.code === "shop_wishlist_limit_reached").length, 9);
    assert.equal(await items(shop), 50);
  }));

dbTest("a refused addition leaves nothing behind, and removals and reads keep working at and over the limit", () =>
  withEnforcement("on", async () => {
    const shop = await newShop("wl-over");
    await seedItems(shop, 80, 40); // already over Basic's 50 (the limit applied later)
    const actorsBefore = await prisma.actor.count({ where: { shopId: shop.id } });
    const sessionsBefore = await prisma.browsingSession.count({ where: { shopId: shop.id } });
    const error = await refusal(W.addToWishlist(identityOf(shop, 777), product(1)));
    assert.equal(error?.code, "shop_wishlist_limit_reached");
    assert.deepEqual([await items(shop), await prisma.actor.count({ where: { shopId: shop.id } }), await prisma.browsingSession.count({ where: { shopId: shop.id } })], [80, actorsBefore, sessionsBefore], "no item, no customer row, no session: the refusal rolled back completely");
    assert.equal(await items(shop), 80, "nothing was deleted to force compliance");

    // reads and removals work while over the limit
    const owner = await prisma.actor.findFirst({ where: { shopId: shop.id }, include: { wishlistItems: { take: 1 } } });
    const row = owner.wishlistItems[0];
    assert.ok((await W.listWishlist({ shopDomain: shop.domain, customerGid: owner.customerGid })).length > 0);
    await W.removeFromWishlist({ shopDomain: shop.domain, customerGid: owner.customerGid }, { productGid: row.productGid, variantGid: row.variantGid });
    assert.equal(await items(shop), 79);
    // still over the limit: still refused, and no reservation is left behind to block anyone later
    assert.equal((await refusal(W.addToWishlist(identityOf(shop, 778), product(2))))?.code, "shop_wishlist_limit_reached");
    await prisma.wishlistItem.deleteMany({ where: { shopId: shop.id, actor: { customerGid: { not: owner.customerGid } } } });
    assert.equal((await W.addToWishlist(identityOf(shop, 779), product(3))).saved, true, "below the limit again: additions work");
  }));

dbTest("Advance and Enterprise limits apply, and the per-customer cap of 200 still holds under them", () =>
  withEnforcement("on", async () => {
    const advance = await newShop("wl-advance");
    await paidSubscriptionOnRealClock(advance, { plan: "ADVANCE" });
    await seedItems(advance, 2499);
    assert.equal((await W.addToWishlist(identityOf(advance, 1), product(8000))).saved, true);
    assert.equal((await refusal(W.addToWishlist(identityOf(advance, 2), product(8001))))?.code, "shop_wishlist_limit_reached");

    const enterprise = await newShop("wl-enterprise");
    await paidSubscriptionOnRealClock(enterprise, { plan: "ENTERPRISE" });
    await seedItems(enterprise, 4999);
    assert.equal((await W.addToWishlist(identityOf(enterprise, 1), product(8000))).saved, true);
    assert.equal((await refusal(W.addToWishlist(identityOf(enterprise, 2), product(8001))))?.code, "shop_wishlist_limit_reached");

    const roomy = await newShop("wl-percustomer");
    await paidSubscriptionOnRealClock(roomy, { plan: "ENTERPRISE" });
    const actor = await prisma.actor.create({ data: { shopId: roomy.id, customerGid: "gid://shopify/Customer/4242" } });
    await prisma.wishlistItem.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ shopId: roomy.id, actorId: actor.id, productGid: `gid://shopify/Product/${i + 1}`, variantGid: `gid://shopify/ProductVariant/${i + 1}`, productTitle: "Item", productHandle: "item" })) });
    assert.equal((await refusal(W.addToWishlist(identityOf(roomy, 4242), product(9999))))?.code, "wishlist_full", "the existing per-customer cap is unchanged");
  }));

dbTest("a paid plan that cannot be verified falls back to Basic's cap, and nothing is deleted", () =>
  withEnforcement("on", async () => {
    const shop = await newShop("wl-fallback");
    await paidSubscription(shop, { plan: "ENTERPRISE", verifiedAt: new Date(Date.now() - 3 * DAY) }); // verification is stale
    await seedItems(shop, 120);
    assert.equal((await refusal(W.addToWishlist(identityOf(shop, 1), product(1))))?.code, "shop_wishlist_limit_reached");
    assert.equal(await items(shop), 120);
  }));

dbTest("with enforcement off (the default) the cap is not applied", () =>
  withEnforcement(undefined, async () => {
    const shop = await newShop("wl-off");
    await seedItems(shop, 60);
    assert.equal((await W.addToWishlist(identityOf(shop, 1), product(1))).saved, true);
    assert.equal(await items(shop), 61);
  }));

// ======================= plan recommendations: job life cycle =======================
const period = { periodStart: new Date(NOW.getTime() - 30 * DAY), periodEnd: NOW };
const recRow = (shop) => prisma.planRecommendation.findUnique({ where: { shopId: shop.id } });
const runRec = (shop, fetchSessions, now = NOW) => R.runPlanRecommendations({ fetchSessions, now: () => now, shopIds: [shop.id], log: { log() {}, error() {} } });
const answerOf = (sessions) => async () => ({ sessions, ...period });

dbTest("the threshold is strictly greater than 100,000, and each result starts a fresh retry history", async () => {
  for (const [sessions, plan] of [[100001, "ENTERPRISE"], [100000, "ADVANCE"], [0, "ADVANCE"]]) {
    const shop = await newShop(`r-threshold-${sessions}`);
    await R.ensurePlanRecommendation(shop.id, { now: due });
    await prisma.planRecommendation.update({ where: { shopId: shop.id }, data: { attempts: 3 } }); // earlier failed tries
    const summary = await runRec(shop, answerOf(sessions));
    assert.equal(summary.succeeded, 1);
    const row = await recRow(shop);
    assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan, row.attempts, row.errorCode, row.nextAttemptAt, row.leaseExpiresAt], ["SUCCEEDED", sessions, plan, 0, null, null, null]);
  }
});

dbTest("invalid, missing or failed data produces no recommendation and is never a zero", async () => {
  const shop = await newShop("r-invalid");
  await R.ensurePlanRecommendation(shop.id, { now: due });
  const bad = [undefined, null, { sessions: null, ...period }, { sessions: undefined, ...period }, { sessions: NaN, ...period }, { sessions: -3, ...period }, { sessions: "100", ...period }, { sessions: 1.5, ...period }, { sessions: 10, periodStart: NOW, periodEnd: period.periodStart }, { sessions: 10 }];
  let at = NOW;
  for (const answer of bad) {
    await prisma.planRecommendation.update({ where: { shopId: shop.id }, data: { status: "PENDING", nextAttemptAt: due, attempts: 0 } });
    const summary = await runRec(shop, async () => answer, at);
    assert.equal(summary.failed, 1, JSON.stringify(answer));
    const row = await recRow(shop);
    assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan, row.errorCode, R.publicRecommendation(row)], ["FAILED", null, null, "invalid_data", null], JSON.stringify(answer));
  }
  const thrown = await newShop("r-thrown");
  await R.ensurePlanRecommendation(thrown.id, { now: due });
  await runRec(thrown, async () => { throw Object.assign(new Error("down"), { code: "ECONNRESET" }); });
  const row = await recRow(thrown);
  assert.deepEqual([row.status, row.sessions30d, row.errorCode, row.attempts, row.nextAttemptAt.getTime() - NOW.getTime()], ["FAILED", null, "ECONNRESET", 1, MIN]);
});

dbTest("a failed refresh keeps the previous valid result", async () => {
  const shop = await newShop("r-keep");
  await R.ensurePlanRecommendation(shop.id, { now: due });
  await runRec(shop, answerOf(250000));
  await R.requestRecommendationRecheck(shop.id, { now: due });
  await runRec(shop, async () => { throw new Error("later outage"); }, NOW);
  const row = await recRow(shop);
  assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan, row.periodEnd.getTime(), row.fetchedAt.getTime()], ["FAILED", 250000, "ENTERPRISE", NOW.getTime(), NOW.getTime()], "the earlier valid count and advice are untouched");
  assert.equal(R.publicRecommendation(row).plan, "ENTERPRISE");
});

dbTest("a missing permission is NEEDS_ACCESS: not retried on a timer, retried when explicitly asked", async () => {
  const shop = await newShop("r-access");
  await R.ensurePlanRecommendation(shop.id, { now: due });
  const summary = await runRec(shop, async () => { throw Object.assign(new Error("denied"), { kind: "permission", code: "access_denied" }); });
  assert.equal(summary.needsAccess, 1);
  let row = await recRow(shop);
  assert.deepEqual([row.status, row.errorCode, row.nextAttemptAt, row.sessions30d], ["NEEDS_ACCESS", "access_denied", null, null]);
  assert.equal(await R.claimDueRecommendation({ now: new Date(NOW.getTime() + 30 * DAY), shopIds: [shop.id] }), null, "never claimed on its own, however long we wait");
  assert.equal((await R.requestRecommendationRecheck(shop.id, { now: NOW })).count, 1);
  const summary2 = await runRec(shop, answerOf(5000));
  assert.equal(summary2.succeeded, 1);
  row = await recRow(shop);
  assert.deepEqual([row.status, row.recommendedPlan], ["SUCCEEDED", "ADVANCE"]);
});

dbTest("retries are bounded and stop after the last attempt", async () => {
  const shop = await newShop("r-bounded");
  await R.ensurePlanRecommendation(shop.id, { now: due });
  const waits = [];
  let at = NOW;
  for (let i = 0; i < R.MAX_ATTEMPTS + 2; i += 1) {
    await prisma.planRecommendation.updateMany({ where: { shopId: shop.id, status: "FAILED", nextAttemptAt: { not: null } }, data: { nextAttemptAt: at } });
    const summary = await runRec(shop, async () => { throw new Error("down"); }, at);
    if (!summary.claimed) break;
    const row = await recRow(shop);
    waits.push(row.nextAttemptAt === null ? null : (row.nextAttemptAt.getTime() - at.getTime()) / MIN);
  }
  assert.deepEqual(waits, [1, 5, 30, 120, null], "1 min, 5, 30, 2 hours, then nothing is scheduled");
  assert.equal((await recRow(shop)).attempts, R.MAX_ATTEMPTS);
});

dbTest("two workers cannot claim the same job; an abandoned job is recovered after its lease; a stale worker cannot overwrite a newer result", async () => {
  const shop = await newShop("r-lease");
  await R.ensurePlanRecommendation(shop.id, { now: due });
  const claims = await Promise.all([R.claimDueRecommendation({ now: NOW, shopIds: [shop.id] }), R.claimDueRecommendation({ now: NOW, shopIds: [shop.id] }), R.claimDueRecommendation({ now: NOW, shopIds: [shop.id] })]);
  assert.equal(claims.filter(Boolean).length, 1);
  const a = claims.find(Boolean);
  assert.deepEqual([a.row.status, a.row.attempts], ["RUNNING", 1]);
  assert.equal(await R.claimDueRecommendation({ now: new Date(NOW.getTime() + MIN), shopIds: [shop.id] }), null, "a live lease is respected");

  // worker A dies; after the lease has run out worker B takes the job over
  const later = new Date(NOW.getTime() + 10 * MIN);
  const b = await R.claimDueRecommendation({ now: later, shopIds: [shop.id] });
  assert.deepEqual([b.row.status, b.row.attempts], ["RUNNING", 2], "the takeover counts as an attempt");
  const win = await R.recordSessionResult(shop.id, { sessions: 300000, ...period }, { lease: b.lease, now: later });
  assert.deepEqual([win.status, win.recommendedPlan, win.attempts], ["SUCCEEDED", "ENTERPRISE", 0]);

  // worker A wakes up late with an older answer: it no longer holds the job
  assert.equal(await R.recordSessionResult(shop.id, { sessions: 10, ...period }, { lease: a.lease, now: new Date(later.getTime() + MIN) }), null);
  assert.equal(await R.recordSessionFailure(shop.id, { code: "late_failure" }, { lease: a.lease, now: later }), null);
  const row = await recRow(shop);
  assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan, row.errorCode], ["SUCCEEDED", 300000, "ENTERPRISE", null], "the newer result stands");
  await assert.rejects(R.recordSessionResult(shop.id, { sessions: 1, ...period }, {}), TypeError, "a result is only written under a claim");
});

dbTest("a job that keeps crashing stops after the allowed attempts", async () => {
  const shop = await newShop("r-crash");
  await R.ensurePlanRecommendation(shop.id, { now: due });
  let at = NOW;
  for (let i = 0; i < R.MAX_ATTEMPTS; i += 1) {
    const claim = await R.claimDueRecommendation({ now: at, shopIds: [shop.id] });
    assert.ok(claim, `claim ${i + 1}`);
    at = new Date(at.getTime() + 10 * MIN); // the worker dies every time: no result, the lease expires
  }
  assert.equal(await R.claimDueRecommendation({ now: at, shopIds: [shop.id] }), null, "used up: not claimed again");
  const row = await recRow(shop);
  assert.deepEqual([row.status, row.errorCode, row.nextAttemptAt, row.sessions30d], ["FAILED", "lease_expired", null, null]);
});

dbTest("with no session source configured nothing is claimed or changed", async () => {
  const shop = await newShop("r-nosource");
  const before = await R.ensurePlanRecommendation(shop.id, { now: due });
  const summary = await R.runPlanRecommendations({ fetchSessions: undefined, now: () => NOW, shopIds: [shop.id], log: { log() {}, error() {} } });
  assert.equal(summary.skipped, "no_session_source");
  const row = await recRow(shop);
  assert.deepEqual([row.status, row.attempts, row.updatedAt.getTime()], ["PENDING", 0, before.updatedAt.getTime()]);
});
