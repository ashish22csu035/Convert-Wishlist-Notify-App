// Tests for the subscription verification TRIGGER on the Pricing page (verifyForPricingPage in app/models/plan-usage.server.js, wired in
// app/routes/app.plan.jsx) and the lifecycle it relies on (verifyShopOnDemand in app/models/subscription-verification.server.js): first-time
// shops, repeat visits, simultaneous visits, temporary failures, a confirmed paid subscription, confirmed Basic / cancellation, stale
// verification, and what the page says about each.
//
// Run: node --test tests/billing-trigger.test.mjs
//
// NOTHING here calls Shopify, the Partner API or any billing service: every verifier is a stub returning fixtures, and no subscription is
// created, approved or cancelled anywhere but in a throw-away test database. The pure tests and the rendering tests run anywhere. The database
// tests WRITE rows, so they only run when DATABASE_URL (set in the environment) names an isolated kw_*test* database with the migrations
// applied; otherwise they are skipped and say so.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const { build } = require("esbuild");

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

const U = await import("../app/models/plan-usage.server.js");
const V = await import("../app/models/subscription-verification.server.js");
const S = await import("../app/models/billing-services.server.js");
const { resolveEntitlements } = await import("../app/models/entitlements.server.js");

const NOW = new Date("2026-11-12T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RUN = Date.now().toString(36);
const at = (ms = 0) => new Date(NOW.getTime() + ms);
const clock = (ms = 0) => () => at(ms);
const iso = (ms) => at(ms).toISOString();

// ---------- fixtures ----------
const domains = [];
let seq = 7700000000;
const newShop = async (tag) => {
  const domain = `kw-bt-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});

// A verifier stub: counts its calls and answers with a fixture (or the result of a function, which may throw or wait).
function stub(answer) {
  const fn = async (context) => {
    fn.calls += 1;
    fn.shops.push(context.shop.domain);
    return typeof answer === "function" ? answer() : answer;
  };
  fn.calls = 0;
  fn.shops = [];
  return fn;
}
const active = (over = {}) => ({ outcome: "active", plan: "ADVANCE", periodStart: at(-10 * DAY), periodEnd: at(20 * DAY), source: "app_pricing", planHandle: "advance", ...over });
const noContract = { outcome: "none", reason: "no_contract", requireRepeat: true };
const transient = () => {
  throw Object.assign(new Error("network down"), { code: "ECONNRESET" });
};

const paidRow = (shop, over = {}) =>
  prisma.shopSubscription.create({
    data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: at(-HOUR), currentPeriodStart: at(-10 * DAY), currentPeriodEnd: at(20 * DAY), nextVerificationAt: at(11 * HOUR), ...over },
  });
const rowOf = (shop) => prisma.shopSubscription.findUnique({ where: { shopId: shop.id } });
const page = (shop, verify, ms = 0, extra = {}) => U.verifyForPricingPage(shop.id, { verify, now: clock(ms), ...extra });
const viewAt = (shop, check, ms = 0) => U.loadPlanUsage(shop.id, { now: at(ms), env: {}, shopDomain: shop.domain, check });
const quiet = async (work) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = original;
  }
};

// ======================= what the code does today (documented as tests) =======================
test("a free Basic row is never claimed by the worker: a shop that subscribes later can only be found by a check that is asked for", () => {
  const source = fs.readFileSync("app/models/subscription-verification.server.js", "utf8");
  assert.match(source, /const dueOrNew = \(now\) => \[\{ nextVerificationAt: \{ lte: now \} \}, \{ nextVerificationAt: null, plan: \{ in: PAID \}, status: "ACTIVE" \}\]/, "due rows, or a PAID row nobody scheduled: nothing else");
  assert.match(fs.readFileSync("app/models/shop-lock.server.js", "utf8"), /create: \{ shopId \}/, "ensureShopSubscription makes a Basic row with no nextVerificationAt");
});

// ======================= no verifier: nothing is asked, nothing is written =======================
test("with the billing settings off there is no verifier: nothing is asked, nothing is written, and the page says the check is not available", async () => {
  for (const verify of [null, undefined, "x", 5]) assert.deepEqual(await U.verifyForPricingPage("any-shop", { verify }), { enabled: false, status: "unavailable" });
  S.resetSharedBillingServices();
  try {
    assert.equal(S.getSharedBillingServices({}).verify, null, "BILLING_MECHANISM unset: no verifier");
    assert.equal(S.getSharedBillingServices({ BILLING_MECHANISM: "app_pricing" }), S.getSharedBillingServices({}), "built once and kept, so the verifier's identity check survives between page loads");
  } finally {
    S.resetSharedBillingServices();
  }
  for (const env of [{}, { BILLING_MECHANISM: "" }, { BILLING_MECHANISM: "billing_api" }, { BILLING_MECHANISM: "off" }]) assert.equal(S.getBillingServices(env, { log: { warn() {} } }).verify, null, JSON.stringify(env));
  S.resetBillingConfigWarning();
  const warnings = [];
  const fakeSecret = "fake-secret-value-for-the-test";
  assert.equal(S.getBillingServices({ BILLING_MECHANISM: "app_pricing", SHOPIFY_PARTNER_API_ACCESS_TOKEN: fakeSecret }, { log: { warn: (message) => warnings.push(message) } }).verify, null, "the mechanism on without its full configuration: still no verifier");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Missing: SHOPIFY_PARTNER_API_URL/, "the NAMES of what is missing");
  assert.ok(!warnings[0].includes(fakeSecret), "never a value");
});

test("the Pricing page is the only trigger: one route loader, no other caller, no new welcome route, and nothing in the request is read", () => {
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  const route = strip(fs.readFileSync("app/routes/app.plan.jsx", "utf8"));
  assert.match(route, /verifyForPricingPage\(shop\.id, \{ verify \}\)/, "the check is for the shop of the verified session");
  assert.match(route, /getSharedBillingServices\(\)\.verify/);
  assert.doesNotMatch(route, /searchParams|plan_handle|request\.url|formData|headers\.get|params\b/, "the plan_handle and shop parameters Shopify appends are not read");
  // every use of the on-demand check and of the worker's verification in the application code
  const callers = (name) => {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx)$/.test(entry.name) && new RegExp(`\\b${name}\\b`).test(strip(fs.readFileSync(full, "utf8")))) found.push(full.replaceAll("\\", "/"));
      }
    };
    walk("app");
    return found.sort();
  };
  assert.deepEqual(callers("verifyShopOnDemand"), ["app/models/plan-usage.server.js", "app/models/subscription-verification.server.js"]);
  assert.deepEqual(callers("verifyForPricingPage"), ["app/models/plan-usage.server.js", "app/routes/app.plan.jsx"]);
  assert.deepEqual(callers("runSubscriptionVerification"), ["app/models/subscription-verification.server.js", "app/worker/billing-jobs.server.js"], "the worker's step is unchanged");
  assert.deepEqual(fs.readdirSync("app/routes").filter((name) => /welcome|billing|subscription/i.test(name)), [], "no extra route duplicates the check: the welcome link is configured to open the Pricing page");
  const server = strip(fs.readFileSync("app/models/plan-usage.server.js", "utf8"));
  assert.match(server, /PAGE_VERIFY_TIMEOUT_MS = 6 \* 1000/);
  assert.match(server, /verifyShopOnDemand\(shopId, \{ verify, now, timeoutMs, db \}\)/, "the existing on-demand check, with its lease and backoff, not a second implementation");
});

// ======================= first-time shops, repeat visits, simultaneous visits =======================
dbTest("a first-time shop: the page check creates its free row, asks once, records the answer and schedules the daily recheck", async () => {
  const shop = await newShop("first");
  assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id } }), 0, "a new shop has no row at all");
  const verify = stub(noContract);
  const result = await page(shop, verify);
  assert.deepEqual([result, verify.calls, verify.shops], [{ enabled: true, status: "none" }, 1, [shop.domain]]);
  const row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, row.verificationFailures, row.lastVerificationError], ["BASIC", "ACTIVE", 0, null], "no subscription found: still the free plan, nothing cancelled");
  assert.equal(row.verifiedAt.getTime(), NOW.getTime());
  assert.equal(row.nextVerificationAt.getTime(), NOW.getTime() + DAY, "from now on the worker rechecks it daily");
  assert.equal(row.verificationLeaseExpiresAt, null, "the lease is released");
  const view = await viewAt(shop, result);
  assert.deepEqual([view.status, view.plan.key, view.verification.check, view.warning], ["free", "BASIC", "verified", null]);
});

dbTest("repeat page visits do not hammer the API: one request, then nothing for a minute, then at most one a minute", async () => {
  const shop = await newShop("repeat");
  const verify = stub(noContract);
  assert.equal((await page(shop, verify, 0)).status, "none");
  for (const ms of [1 * SEC, 10 * SEC, 30 * SEC, 59 * SEC]) assert.equal((await page(shop, verify, ms)).status, "fresh", `${ms / SEC}s later`);
  assert.equal(verify.calls, 1, "five visits inside a minute: ONE request");
  assert.equal((await page(shop, verify, 61 * SEC)).status, "none");
  assert.equal(verify.calls, 2, "a new visit after the minute may check again (this is how a merchant who just subscribed sees it)");
  assert.equal((await page(shop, verify, 62 * SEC)).status, "fresh");
  assert.equal(verify.calls, 2);
});

dbTest("simultaneous visits make ONE request: the others see the check in progress and never start another", async () => {
  const shop = await newShop("concurrent");
  const verify = stub(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return active();
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => page(shop, verify)));
  assert.equal(verify.calls, 1, "ten simultaneous page loads, one Partner API request");
  const statuses = results.map((result) => result.status);
  assert.equal(statuses.filter((status) => status === "active").length, 1, "exactly one visit did the check");
  assert.ok(statuses.every((status) => ["active", "in_progress", "fresh"].includes(status)), statuses.join(","));
  const row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, row.verificationLeaseExpiresAt], ["ADVANCE", "ACTIVE", null]);
  // a worker holding the lease: the page does not bypass it
  const held = await newShop("lease");
  await paidRow(held, { verifiedAt: at(-HOUR), verificationLeaseExpiresAt: at(4 * MIN) });
  const second = stub(active());
  assert.equal((await page(held, second)).status, "in_progress");
  assert.equal(second.calls, 0);
  const view = await viewAt(held, { enabled: true, status: "in_progress" });
  assert.equal(view.verification.check, "pending", "a check that is running is shown as waiting, not as a result");
});

// ======================= temporary failures are never cancellations =======================
dbTest("a temporary failure changes nothing about the subscription, backs off, and is shown as a failed check, not a cancellation", async () => {
  const shop = await newShop("failure");
  await paidRow(shop);
  const before = await rowOf(shop);
  const verify = stub(transient);
  const first = await page(shop, verify, 0);
  assert.deepEqual([first.status, verify.calls], ["error", 1]);
  const row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, row.verificationSource, row.verifiedAt.getTime(), row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime()], [before.plan, "ACTIVE", before.verificationSource, before.verifiedAt.getTime(), before.currentPeriodStart.getTime(), before.currentPeriodEnd.getTime()], "plan, status, source, verification time and period are untouched");
  assert.deepEqual([row.verificationFailures, row.lastVerificationError, row.nextVerificationAt.getTime()], [1, "ECONNRESET", NOW.getTime() + MIN], "only the failure and the next attempt are written");
  const view = await viewAt(shop, first);
  assert.deepEqual([view.status, view.plan.key, view.plan.verifiedPaid, view.verification.check, view.verification.checkingAgainAt], ["verified", "ADVANCE", true, "temporary_failure", iso(MIN)], "still verified (the last good check is recent), and the failed check is shown plainly");
  assert.equal(view.warning, null, "a plan that is still confirmed gets no alarm");
  assert.ok(!JSON.stringify(view).includes("ECONNRESET"), "internal error codes never reach the page");

  // backoff: visits during the wait ask nobody
  for (const ms of [5 * SEC, 30 * SEC, 59 * SEC]) assert.equal((await page(shop, verify, ms)).status, "backoff");
  assert.equal(verify.calls, 1);
  // after the wait it asks again; the second failure waits twice as long
  assert.equal((await page(shop, verify, 61 * SEC)).status, "error");
  assert.deepEqual([verify.calls, (await rowOf(shop)).verificationFailures, (await rowOf(shop)).nextVerificationAt.getTime()], [2, 2, NOW.getTime() + 61 * SEC + 2 * MIN]);
  assert.equal((await page(shop, verify, 100 * SEC)).status, "backoff");
  // recovery: the next successful answer clears the failure state
  const recovered = stub(active());
  assert.equal((await page(shop, recovered, 200 * SEC)).status, "active");
  const healed = await rowOf(shop);
  assert.deepEqual([healed.verificationFailures, healed.lastVerificationError, healed.status, healed.plan], [0, null, "ACTIVE", "ADVANCE"]);
  assert.equal(healed.verifiedAt.getTime(), NOW.getTime() + 200 * SEC);
});

dbTest("permission and configuration failures wait hours, a hung request is cut off, and none of them cancels anything", async () => {
  const denied = await newShop("denied");
  await paidRow(denied);
  const permission = stub({ outcome: "error", kind: "permission", code: "access_denied" });
  assert.equal((await page(denied, permission)).status, "error");
  const permissionRow = await rowOf(denied);
  assert.deepEqual([permissionRow.status, permissionRow.plan, permissionRow.lastVerificationError, permissionRow.nextVerificationAt.getTime()], ["ACTIVE", "ADVANCE", "permission_access_denied", NOW.getTime() + 6 * HOUR]);
  assert.equal((await page(denied, permission, 30 * MIN)).status, "backoff", "no request for six hours");
  assert.equal(permission.calls, 1);

  const hung = await newShop("hung");
  await paidRow(hung);
  const never = stub(() => new Promise(() => {}));
  const started = Date.now();
  const result = await page(hung, never, 0, { timeoutMs: 40 });
  assert.equal(result.status, "error");
  assert.ok(Date.now() - started < 3000, "the page is not held by a slow Partner API");
  const hungRow = await rowOf(hung);
  assert.deepEqual([hungRow.status, hungRow.plan, hungRow.verificationFailures, hungRow.lastVerificationError], ["ACTIVE", "ADVANCE", 1, "timeout"]);

  const garbage = await newShop("garbage");
  await paidRow(garbage);
  assert.equal((await page(garbage, stub({ outcome: "who knows" }))).status, "error");
  assert.deepEqual([(await rowOf(garbage)).status, (await rowOf(garbage)).lastVerificationError], ["ACTIVE", "invalid_response"], "an unusable answer is a failure, never a cancellation");
});

test("a failure of the page's own database work never breaks the page and is never presented as a result", async () => {
  const broken = { shopSubscription: { upsert: async () => { throw Object.assign(new Error("connection lost"), { code: "P1001" }); } } };
  const result = await quiet(() => U.verifyForPricingPage("shop", { verify: stub(active()), db: broken }));
  assert.deepEqual(result, { enabled: true, status: "error" });
});

// ======================= confirmed paid subscription =======================
dbTest("a confirmed paid subscription updates the existing row and period, and the page shows it as verified", async () => {
  const shop = await newShop("paid");
  const verify = stub(active({ plan: "ENTERPRISE", planHandle: "enterprise", shopifySubscriptionGid: "gid://shopify/AppSubscription/1", cancelAtEndOfCycle: false }));
  const result = await page(shop, verify);
  assert.equal(result.status, "active");
  const row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, row.verificationSource, row.planHandle, row.shopifySubscriptionGid, row.cancelAtPeriodEnd, row.trialEndsAt], ["ENTERPRISE", "ACTIVE", "app_pricing", "enterprise", "gid://shopify/AppSubscription/1", false, null]);
  assert.deepEqual([row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime(), row.verifiedAt.getTime()], [NOW.getTime() - 10 * DAY, NOW.getTime() + 20 * DAY, NOW.getTime()], "the period exactly as Shopify reported it");
  assert.equal(row.nextVerificationAt.getTime(), NOW.getTime() + 12 * HOUR, "the next check: 12 hours, or the period end if sooner");
  assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id } }), 1, "the same row, no second one");
  const view = await viewAt(shop, result);
  assert.deepEqual([view.status, view.plan, view.verification.check, view.period], ["verified", { key: "ENTERPRISE", label: "Enterprise", verifiedPaid: true }, "verified", { start: iso(-10 * DAY), end: iso(20 * DAY) }]);
  assert.equal(view.email.quota, 3000);
  assert.equal(view.email.resetsAt, iso(20 * DAY));
  // a paid answer that is not valid is not a paid plan
  const bad = await newShop("badpaid");
  assert.equal((await page(bad, stub(active({ periodEnd: at(-10 * DAY) })))).status, "error", "a period that ends before it starts is not accepted");
  assert.equal((await rowOf(bad)).plan, "BASIC");
});

dbTest("a trial is a verified paid plan without a billing period: Basic limits, and no period is invented", async () => {
  const shop = await newShop("trial");
  const result = await page(shop, stub({ outcome: "trial", plan: "ADVANCE", trialEndsAt: at(5 * DAY), source: "app_pricing", planHandle: "advance" }));
  assert.equal(result.status, "trial");
  const row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, row.currentPeriodStart, row.currentPeriodEnd, row.trialEndsAt.getTime()], ["ADVANCE", "ACTIVE", null, null, NOW.getTime() + 5 * DAY]);
  const view = await viewAt(shop, result);
  assert.deepEqual([view.status, view.plan.key, view.plan.verifiedPaid, view.trial, view.period, view.verification.check], ["trial", "BASIC", false, { planLabel: "Advance", endsAt: iso(5 * DAY) }, null, "verified"]);
});

// ======================= confirmed Basic / cancellation =======================
dbTest("a paid subscription is only cancelled by TWO consecutive 'no contract' answers a few minutes apart; refreshing the page cannot make them one", async () => {
  const shop = await newShop("cancel");
  await paidRow(shop);
  const verify = stub(noContract);
  const first = await page(shop, verify, 0);
  assert.equal(first.status, "unconfirmed");
  let row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, row.lastVerificationError, row.nextVerificationAt.getTime()], ["ADVANCE", "ACTIVE", V.UNCONFIRMED_NONE, NOW.getTime() + 5 * MIN], "the first one only leaves a marker");
  const midway = await viewAt(shop, first);
  assert.deepEqual([midway.status, midway.plan.key, midway.warning], ["verified", "ADVANCE", null], "the merchant still sees the plan they pay for");
  // the page is refreshed again and again: nothing is asked until the confirming check is due
  for (const ms of [2 * SEC, 61 * SEC, 2 * MIN, 4 * MIN + 59 * SEC]) assert.equal((await page(shop, verify, ms)).status, "confirming", `${ms / SEC}s`);
  assert.equal(verify.calls, 1, "refreshing never turns one answer into two");
  row = await rowOf(shop);
  assert.equal(row.status, "ACTIVE");
  // when the confirming check is due the second answer cancels
  const second = await page(shop, verify, 5 * MIN);
  assert.equal(second.status, "inactive");
  row = await rowOf(shop);
  assert.deepEqual([row.status, row.plan, row.lastVerificationError, row.trialEndsAt, row.cancelAtPeriodEnd, row.nextVerificationAt.getTime()], ["CANCELLED", "ADVANCE", null, null, null, NOW.getTime() + 5 * MIN + DAY], "cancelled; the plan stays as history");
  const view = await viewAt(shop, second, 5 * MIN);
  assert.deepEqual([view.status, view.plan.key, view.plan.verifiedPaid, view.verification.check], ["inactive", "BASIC", false, "verified"]);
  assert.match(view.warning.title, /no longer active/i);
  assert.match(view.warning.message, /kept/i);
});

dbTest("another answer between the two 'no contract' answers resets the confirmation, and a real downgrade to the free plan is authoritative", async () => {
  const shop = await newShop("interleave");
  await paidRow(shop);
  assert.equal((await page(shop, stub(noContract), 0)).status, "unconfirmed");
  assert.equal((await page(shop, stub(active()), 5 * MIN)).status, "active");
  assert.equal((await rowOf(shop)).lastVerificationError, null, "the marker is gone");
  assert.equal((await page(shop, stub(noContract), 5 * MIN + 2 * MIN)).status, "unconfirmed", "the next 'no contract' starts again: it is a first answer, not a second");
  assert.deepEqual([(await rowOf(shop)).status, (await rowOf(shop)).plan], ["ACTIVE", "ADVANCE"]);

  const down = await newShop("freeplan");
  await paidRow(down);
  assert.equal((await page(down, stub({ outcome: "none", reason: "free_plan" }))).status, "inactive");
  assert.equal((await rowOf(down)).status, "CANCELLED", "Shopify reports a subscription to the free plan: that is a real answer, needs no repeat");

  const basic = await newShop("basic-none");
  assert.equal((await page(basic, stub(noContract))).status, "none");
  assert.deepEqual([(await rowOf(basic)).plan, (await rowOf(basic)).status], ["BASIC", "ACTIVE"], "a free shop with no subscription is simply free: nothing to cancel");
  const frozen = await newShop("frozen");
  await paidRow(frozen);
  assert.equal((await page(frozen, stub({ outcome: "inactive", status: "FROZEN" }))).status, "inactive");
  assert.equal((await viewAt(frozen, { enabled: true, status: "inactive" })).plan.key, "BASIC");
});

// ======================= stale verification =======================
dbTest("a stale verification falls back to Basic with the right explanation, and the next successful check restores the paid plan", async () => {
  const stale = await newShop("stale");
  await paidRow(stale, { verifiedAt: at(-30 * HOUR), nextVerificationAt: at(-MIN) });
  const before = await viewAt(stale, { enabled: true, status: "none" });
  assert.deepEqual([before.status, before.plan.key, before.verification.check, before.lastConfirmedPlan], ["temporary", "BASIC", "stale", "Advance"]);
  assert.match(before.warning.title, /couldn't confirm/i);
  assert.match(before.warning.message, /not a cancellation/i);
  const verify = stub(active());
  const result = await page(stale, verify);
  assert.equal(result.status, "active");
  const after = await viewAt(stale, result);
  assert.deepEqual([after.status, after.plan.key, after.plan.verifiedPaid, after.verification.check, after.warning], ["verified", "ADVANCE", true, "verified", null]);

  // stale AND the check keeps failing: still Basic, still not a cancellation, and the failure is visible
  const failing = await newShop("stale-failing");
  await paidRow(failing, { verifiedAt: at(-30 * HOUR), nextVerificationAt: at(-MIN) });
  const failed = await page(failing, stub(transient));
  const view = await viewAt(failing, failed);
  assert.deepEqual([view.status, view.plan.key, view.verification.check, view.lastConfirmedPlan, (await rowOf(failing)).status], ["temporary", "BASIC", "temporary_failure", "Advance", "ACTIVE"]);
  assert.doesNotMatch(`${view.warning.title} ${view.warning.message}`.replace(/not a cancellation/i, ""), /cancel/i);
});

// ======================= the view's account of the check (pure) =======================
const row = (over = {}) => ({ plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: at(-HOUR), currentPeriodStart: at(-10 * DAY), currentPeriodEnd: at(20 * DAY), trialEndsAt: null, cancelAtPeriodEnd: null, verificationFailures: 0, nextVerificationAt: at(11 * HOUR), ...over });
const viewOf = (subscription, over = {}) => U.buildPlanUsageView({ entitlements: resolveEntitlements(subscription, NOW), subscription, email: null, wishlist: null, now: NOW, ...over });
const free = row({ plan: "BASIC", verifiedAt: null, verificationSource: null, currentPeriodStart: null, currentPeriodEnd: null, nextVerificationAt: null });

test("the page distinguishes a verified status, a check that has not happened yet, a failed check and an out-of-date one", () => {
  const states = (subscription, over) => viewOf(subscription, over).verification.check;
  assert.equal(states(free, {}), "not_checked", "verification off: a paid subscription cannot be known");
  assert.equal(states(null, { verificationEnabled: true }), "pending");
  assert.equal(states(free, { verificationEnabled: true }), "pending", "enabled, nothing verified yet");
  assert.equal(states(free, { verificationEnabled: true, checkStatus: "in_progress" }), "pending");
  assert.equal(states(row({ verifiedAt: at(-HOUR) }), { verificationEnabled: true }), "verified");
  assert.equal(states(row({ verifiedAt: at(-30 * HOUR) }), { verificationEnabled: true }), "stale");
  assert.equal(states(row({ verificationFailures: 2 }), { verificationEnabled: true }), "temporary_failure");
  assert.equal(states(free, { verificationEnabled: true, checkStatus: "backoff" }), "pending");
  assert.equal(states(row({ verificationFailures: 1, verifiedAt: null }), { verificationEnabled: true }), "temporary_failure");
  assert.equal(U.buildPlanUsageView({ entitlements: null, now: NOW }).verification.check, null, "nothing is claimed when the plan itself could not be read");
});

test("a paid plan is never shown as confirmed unless the stored verification is authoritative and recent, whatever the check says", () => {
  const confirmed = viewOf(row(), { verificationEnabled: true, checkStatus: "active" });
  assert.deepEqual([confirmed.status, confirmed.plan.key, confirmed.plan.verifiedPaid], ["verified", "ADVANCE", true]);
  for (const [tag, subscription] of [["stale", row({ verifiedAt: at(-30 * HOUR) })], ["never verified", row({ verifiedAt: null, verificationSource: null })], ["no source", row({ verificationSource: null })], ["no period", row({ currentPeriodStart: null, currentPeriodEnd: null })]]) {
    const view = viewOf(subscription, { verificationEnabled: true, checkStatus: "active" });
    assert.deepEqual([view.plan.key, view.plan.verifiedPaid], ["BASIC", false], `${tag}: even right after a check that said "active"`);
  }
  // the page's own check result cannot grant anything: only the stored row can
  const granted = viewOf(free, { verificationEnabled: true, checkStatus: "active" });
  assert.deepEqual([granted.plan.key, granted.plan.verifiedPaid], ["BASIC", false]);
});

test("a free shop whose check failed is told why a plan it just chose is not showing yet, in words that are neither alarming nor a cancellation", () => {
  const view = viewOf(row({ plan: "BASIC", verifiedAt: at(-2 * HOUR), verificationSource: "authoritative_check", currentPeriodStart: null, currentPeriodEnd: null, verificationFailures: 2, nextVerificationAt: at(4 * MIN) }), { verificationEnabled: true });
  assert.deepEqual([view.status, view.plan.key, view.verification.check, view.warning.tone], ["free", "BASIC", "temporary_failure", "info"]);
  assert.match(view.warning.title, /couldn't check for subscription changes just now/i);
  assert.match(view.warning.message, /recently chose a paid plan/i);
  assert.match(view.warning.message, /nothing has been changed or deleted/i);
  assert.doesNotMatch(`${view.warning.title} ${view.warning.message}`, /cancel/i);
  assert.equal(view.verification.checkingAgainAt, iso(4 * MIN));
  // a healthy free shop gets no banner at all
  assert.equal(viewOf(row({ plan: "BASIC", verifiedAt: at(-HOUR), verificationSource: "authoritative_check", currentPeriodStart: null, currentPeriodEnd: null }), { verificationEnabled: true }).warning, null);
});

// ======================= the page body =======================
const OUT_DIR = path.resolve("node_modules/.cache/kw-billing-trigger-test");
let PlanUsage;
let renderToStaticMarkup;
let React;
before(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `plan-usage-${Date.now().toString(36)}.mjs`);
  await build({
    entryPoints: ["app/components/plan-usage.jsx"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    external: ["react", "react/jsx-runtime", "react-dom", "react-router"],
    alias: { "@shopify/shopify-app-react-router/server": path.resolve("tests/helpers/shopify-server-stub.mjs") },
    logLevel: "silent",
  });
  ({ PlanUsage } = await import(pathToFileURL(outfile).href));
  React = (await import("react")).default;
  ({ renderToStaticMarkup } = await import("react-dom/server"));
});
after(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
});
const dec = (markup) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const text = (markup) => dec(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const html = (view) => renderToStaticMarkup(React.createElement(PlanUsage, { view }));

test("the Subscription card says in plain words what the check did, and never shows a failed check as a cancellation", () => {
  const sayings = {
    verified: /Subscription check Confirmed with Shopify/,
    pending: /Subscription check Waiting for the first check with Shopify/,
    temporary_failure: /Subscription check Could not be completed just now: your plan is unchanged and we will try again/,
    stale: /Subscription check The last check is out of date: checking again/,
    not_checked: /Subscription check Not available yet/,
  };
  const subscriptions = {
    verified: [row(), { verificationEnabled: true }],
    pending: [free, { verificationEnabled: true }],
    temporary_failure: [row({ verificationFailures: 1, nextVerificationAt: at(MIN) }), { verificationEnabled: true }],
    stale: [row({ verifiedAt: at(-30 * HOUR) }), { verificationEnabled: true }],
    not_checked: [free, {}],
  };
  for (const [state, [subscription, over]] of Object.entries(subscriptions)) {
    const view = viewOf(subscription, { email: null, wishlist: null, ...over });
    assert.equal(view.verification.check, state);
    const words = text(html(view));
    assert.match(words, sayings[state], state);
    assert.doesNotMatch(words, /cancelled|has been cancel/i, `${state}: never presented as a cancellation`);
  }
  const failing = text(html(viewOf(row({ verificationFailures: 1, nextVerificationAt: at(4 * MIN) }), { verificationEnabled: true })));
  assert.match(failing, /Advance Current plan/, "a recent confirmation still stands while the next check is retried");
  assert.match(failing, /Checking again Around 2026-11-12 12:04 UTC/);
  const freeFailing = html(viewOf(row({ plan: "BASIC", verifiedAt: at(-HOUR), verificationSource: "authoritative_check", currentPeriodStart: null, currentPeriodEnd: null, verificationFailures: 1, nextVerificationAt: at(MIN) }), { verificationEnabled: true }));
  assert.match(dec(freeFailing), /heading="We couldn't check for subscription changes just now"/);
  assert.match(freeFailing, /tone="info"/);
});

// ======================= everything else stays as it was =======================
test("the worker, the billing flags and the plan quota semantics are untouched by the page check", () => {
  const jobs = fs.readFileSync("app/worker/billing-jobs.server.js", "utf8");
  assert.match(jobs, /runSubscriptionVerification\(\{ verify: services\.verify/, "the worker still verifies due rows, exactly as before");
  const plans = fs.readFileSync("app/models/plans.server.js", "utf8");
  assert.match(plans, /billingEnforced = \(env = process\.env\) => String\(env\?\.BILLING_ENFORCEMENT \?\? ""\)\.trim\(\)\.toLowerCase\(\) === "on"/, "enforcement is still off unless BILLING_ENFORCEMENT=on");
  for (const file of ["app/routes/app.plan.jsx", "app/models/plan-usage.server.js", "app/models/billing-services.server.js"]) {
    const source = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(source, /process\.env\.(BILLING_ENFORCEMENT|BILLING_MECHANISM|SESSION_ANALYTICS_SOURCE)\s*=[^=]/, `${file} sets no flag`);
  }
  assert.equal(V.CANCEL_CONFIRM_MS, 5 * MIN);
  assert.equal(V.ON_DEMAND_MIN_INTERVAL_MS, MIN);
});
