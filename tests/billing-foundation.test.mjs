// Tests for the billing foundation: the plan configuration (app/models/plans.server.js), the entitlement helpers
// (entitlements.server.js) and the recommendation storage rules (plan-recommendation.server.js, the two new tables).
//
// Run: node --test tests/billing-foundation.test.mjs
//
// The pure tests run anywhere. The database tests WRITE rows, so they only run when DATABASE_URL (set in the environment)
// names an isolated kw_*test* database with the migrations applied; otherwise they are skipped and say so.
// Nothing here calls Shopify.
import "./helpers/resolve-extensionless.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// Dynamic imports: the extensionless-import hook above must be active before the app modules are linked.
const { FALLBACK_PLAN, PLANS, PLAN_KEYS, RECOMMENDATION_SESSION_THRESHOLD, VERIFICATION_MAX_AGE_MS, getPlan, isPlanKey, recommendedPlanForSessions } = await import("../app/models/plans.server.js");
const { allowedRangeDays, clampHistoryDays, countActiveWishlistItems, getEntitlements, resolveEntitlements, restockEmailUsage, wishlistCapacity } = await import("../app/models/entitlements.server.js");
const { MAX_ATTEMPTS, ensurePlanRecommendation, publicRecommendation, retryDelayMs } = await import("../app/models/plan-recommendation.server.js");

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const NOW = new Date("2026-11-11T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const paidRow = (over = {}) => ({
  plan: "ADVANCE",
  status: "ACTIVE",
  verificationSource: "app_pricing",
  verifiedAt: new Date(NOW.getTime() - HOUR),
  currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
  currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
  ...over,
});

// ======================= plan configuration =======================
test("the three plans exist with the agreed starting limits, and no price is defined", () => {
  assert.deepEqual(PLAN_KEYS, ["BASIC", "ADVANCE", "ENTERPRISE"]);
  const shape = (key) => [PLANS[key].wishlistItems, PLANS[key].restockEmails.quota, PLANS[key].restockEmails.period, PLANS[key].analyticsHistoryDays, PLANS[key].paid];
  assert.deepEqual(shape("BASIC"), [50, 50, "lifetime", 7, false]);
  assert.deepEqual(shape("ADVANCE"), [2500, 1500, "billing_period", 30, true]);
  assert.deepEqual(shape("ENTERPRISE"), [5000, 3000, "billing_period", 90, true]);
  for (const key of PLAN_KEYS) assert.equal(Object.keys(PLANS[key]).some((name) => /price|amount|cost/i.test(name)), false, "prices belong to Shopify's billing, not to this file");
  assert.equal(FALLBACK_PLAN, "BASIC");
});

test("the configuration cannot be changed at run time by accident, and only known plan keys are accepted", () => {
  assert.throws(() => { "use strict"; PLANS.BASIC.wishlistItems = 9999; }, TypeError);
  assert.throws(() => { "use strict"; PLANS.BASIC.restockEmails.quota = 9999; }, TypeError);
  assert.equal(isPlanKey("ADVANCE"), true);
  for (const bad of ["advance", "toString", "__proto__", "", null, undefined, 3]) assert.equal(isPlanKey(bad), false, String(bad));
  assert.equal(getPlan("nope"), null);
});

// ======================= entitlement resolution =======================
test("a free Basic row gets Basic entitlements without any Shopify subscription data", () => {
  const view = resolveEntitlements({ plan: "BASIC", status: "ACTIVE" }, NOW);
  assert.deepEqual([view.plan.key, view.state, view.reason, view.billingPeriod], ["BASIC", "free", null, null]);
});

test("a verified paid subscription gets its own plan and its billing period", () => {
  for (const plan of ["ADVANCE", "ENTERPRISE"]) {
    const view = resolveEntitlements(paidRow({ plan }), NOW);
    assert.deepEqual([view.plan.key, view.state], [plan, "verified"]);
    assert.deepEqual([view.billingPeriod.start.toISOString(), view.billingPeriod.end.toISOString()], ["2026-11-01T12:00:00.000Z", "2026-12-01T12:00:00.000Z"]);
  }
});

test("a missing or unverifiable subscription temporarily gets Basic, with the reason", () => {
  const reason = (row) => {
    const view = resolveEntitlements(row, NOW);
    assert.deepEqual([view.plan.key, view.state], ["BASIC", "fallback"], JSON.stringify(row));
    return view.reason;
  };
  assert.equal(reason(null), "no_subscription");
  assert.equal(reason(undefined), "no_subscription");
  assert.equal(reason(paidRow({ plan: "GOLD" })), "unknown_plan");
  assert.equal(reason(paidRow({ status: "PENDING" })), "subscription_pending");
  assert.equal(reason(paidRow({ status: "CANCELLED" })), "subscription_cancelled");
  assert.equal(reason(paidRow({ status: "FROZEN" })), "subscription_frozen");
  assert.equal(reason(paidRow({ status: "EXPIRED" })), "subscription_expired");
  assert.equal(reason(paidRow({ verifiedAt: null })), "not_verified");
  assert.equal(reason(paidRow({ verificationSource: null })), "not_verified", "a paid plan nobody verified is not paid");
  assert.equal(reason(paidRow({ verifiedAt: new Date(NOW.getTime() - VERIFICATION_MAX_AGE_MS - 1) })), "verification_stale");
  assert.equal(reason(paidRow({ verifiedAt: new Date(NOW.getTime() + HOUR) })), "verification_stale", "a verification from the future is not trusted");
  assert.equal(reason(paidRow({ currentPeriodStart: null })), "billing_period_unknown");
  assert.equal(reason(paidRow({ currentPeriodEnd: null })), "billing_period_unknown");
  assert.equal(reason(paidRow({ currentPeriodStart: NOW, currentPeriodEnd: NOW })), "billing_period_unknown");
  assert.equal(reason(paidRow({ currentPeriodEnd: new Date(NOW.getTime() - 1) })), "billing_period_ended");
  assert.equal(resolveEntitlements(paidRow({ verifiedAt: new Date(NOW.getTime() - VERIFICATION_MAX_AGE_MS) }), NOW).state, "verified", "exactly at the limit is still fresh");
});

test("a recommendation is never proof of a subscription: only the subscription row is read", () => {
  const view = resolveEntitlements(null, NOW);
  assert.equal(view.plan.key, "BASIC");
  assert.equal(resolveEntitlements({ plan: "BASIC", status: "ACTIVE", recommendedPlan: "ENTERPRISE" }, NOW).plan.key, "BASIC");
});

// ======================= analytics history =======================
test("analytics history follows the plan: longer requests are shortened, never refused", () => {
  const basic = resolveEntitlements(null, NOW);
  const advance = resolveEntitlements(paidRow(), NOW);
  const enterprise = resolveEntitlements(paidRow({ plan: "ENTERPRISE" }), NOW);
  assert.deepEqual([basic, advance, enterprise].map((view) => clampHistoryDays(90, view)), [7, 30, 90]);
  assert.deepEqual([basic, advance, enterprise].map((view) => clampHistoryDays(7, view)), [7, 7, 7]);
  assert.equal(clampHistoryDays(undefined, advance), 30);
  assert.equal(clampHistoryDays("junk", basic), 7);
  assert.deepEqual(allowedRangeDays([7, 30, 90], basic), [7]);
  assert.deepEqual(allowedRangeDays([7, 30, 90], advance), [7, 30]);
  assert.deepEqual(allowedRangeDays([7, 30, 90], enterprise), [7, 30, 90]);
});

// ======================= recommendation rule and retry metadata (pure) =======================
test("the recommendation rule: more than 100,000 sessions is Enterprise, otherwise Advance, and anything else is nothing", () => {
  assert.equal(RECOMMENDATION_SESSION_THRESHOLD, 100000);
  assert.equal(recommendedPlanForSessions(100001), "ENTERPRISE");
  assert.equal(recommendedPlanForSessions(100000), "ADVANCE");
  assert.equal(recommendedPlanForSessions(0), "ADVANCE", "a real zero is a real answer");
  for (const bad of [null, undefined, NaN, Infinity, -1, 1.5, "5000", "", {}, [], true]) assert.equal(recommendedPlanForSessions(bad), null, String(bad));
});

test("retries back off, then stop after the last attempt", () => {
  assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [60000, 300000, 1800000, 7200000]);
  assert.equal(retryDelayMs(MAX_ATTEMPTS), null);
  assert.equal(retryDelayMs(0), null);
  assert.equal(retryDelayMs(2.5), null);
});

test("a screen sees advice only when a valid count was recorded, never a zero for missing data", () => {
  assert.equal(publicRecommendation(null), null);
  assert.equal(publicRecommendation({ sessions30d: null, recommendedPlan: null }), null);
  assert.equal(publicRecommendation({ sessions30d: undefined, recommendedPlan: "ADVANCE" }), null);
  assert.deepEqual(publicRecommendation({ sessions30d: 0, recommendedPlan: "ADVANCE", periodStart: 1, periodEnd: 2, fetchedAt: 3 }), { plan: "ADVANCE", sessions30d: 0, periodStart: 1, periodEnd: 2, fetchedAt: 3 });
});

// ======================= database =======================
const dbUrl = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const prisma = skip ? null : new PrismaClient();
const dbTest = (name, fn) => test(name, { skip }, fn);
const RUN = Date.now().toString(36);
const domains = [];
const newShop = async (tag) => {
  const domain = `kw-bill-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});
const addItems = async (shop, customers, perCustomer) => {
  const existing = await prisma.actor.count({ where: { shopId: shop.id } }); // each call adds NEW customers
  for (let c = 0; c < customers; c += 1) {
    const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${existing + c + 1}` } });
    await prisma.wishlistItem.createMany({
      data: Array.from({ length: perCustomer }, (_, i) => ({ shopId: shop.id, actorId: actor.id, productGid: `gid://shopify/Product/${i + 1}`, variantGid: `gid://shopify/ProductVariant/${i + 1}`, productTitle: "Item", productHandle: "item" })),
    });
  }
};

dbTest("the wishlist allowance is counted for the whole shop, across customers, and never across shops", async () => {
  const a = await newShop("wl-a");
  const b = await newShop("wl-b");
  await addItems(a, 3, 10); // three customers, 30 items together
  await addItems(b, 1, 4);
  const basic = resolveEntitlements(null, NOW);
  assert.equal(await countActiveWishlistItems(a.id), 30, "all customers of the shop together");
  assert.equal(await countActiveWishlistItems(b.id), 4, "another shop's items are not counted");
  assert.deepEqual(await wishlistCapacity(a.id, basic), { limit: 50, used: 30, remaining: 20, overLimit: false, canAdd: true });
  await addItems(a, 1, 20); // a fourth customer: 50 together, no single customer is near the limit
  assert.deepEqual(await wishlistCapacity(a.id, basic), { limit: 50, used: 50, remaining: 0, overLimit: false, canAdd: false });
});

dbTest("a shop over its limit keeps every item: the helpers measure and delete nothing", async () => {
  const shop = await newShop("wl-over");
  await addItems(shop, 2, 40); // 80 items, Basic allows 50
  const before = await prisma.wishlistItem.count({ where: { shopId: shop.id } });
  const capacity = await wishlistCapacity(shop.id, resolveEntitlements(null, NOW));
  assert.deepEqual([capacity.used, capacity.limit, capacity.overLimit, capacity.canAdd, capacity.remaining], [80, 50, true, false, 0]);
  await getEntitlements(shop.id, { now: NOW });
  await restockEmailUsage(shop.id, resolveEntitlements(null, NOW));
  assert.equal(await prisma.wishlistItem.count({ where: { shopId: shop.id } }), before, "nothing was deleted or changed");
  assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id } }), 0, "and no subscription row was invented");
  // A plan that fits the data again simply reports room, the items were never touched.
  const enterprise = resolveEntitlements(paidRow({ plan: "ENTERPRISE" }), NOW);
  assert.equal((await wishlistCapacity(shop.id, enterprise)).overLimit, false);
});

dbTest("entitlements come from the stored subscription row, per shop, and a failed read falls back to Basic", async () => {
  const free = await newShop("ent-free");
  const paid = await newShop("ent-paid");
  const none = await newShop("ent-none");
  await prisma.shopSubscription.create({ data: { shopId: free.id } }); // defaults: BASIC, ACTIVE
  await prisma.shopSubscription.create({ data: { shopId: paid.id, plan: "ENTERPRISE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date(NOW.getTime() - HOUR), currentPeriodStart: new Date(NOW.getTime() - DAY), currentPeriodEnd: new Date(NOW.getTime() + 29 * DAY) } });
  assert.deepEqual([(await getEntitlements(free.id, { now: NOW })).plan.key, (await getEntitlements(free.id, { now: NOW })).state], ["BASIC", "free"]);
  assert.deepEqual([(await getEntitlements(paid.id, { now: NOW })).plan.key, (await getEntitlements(paid.id, { now: NOW })).state], ["ENTERPRISE", "verified"]);
  assert.deepEqual([(await getEntitlements(none.id, { now: NOW })).plan.key, (await getEntitlements(none.id, { now: NOW })).reason], ["BASIC", "no_subscription"]);
  assert.equal((await getEntitlements(paid.id, { now: new Date(NOW.getTime() + 3 * DAY) })).reason, "verification_stale", "verification not renewed in time: Basic until it is, the row stays as it is");
  const broken = { shopSubscription: { findUnique: async () => { throw new Error("db down"); } } };
  const failed = await getEntitlements(paid.id, { now: NOW, db: broken });
  assert.deepEqual([failed.plan.key, failed.state, failed.reason], ["BASIC", "fallback", "lookup_failed"]);
  assert.equal((await prisma.shopSubscription.findUnique({ where: { shopId: paid.id } })).plan, "ENTERPRISE", "a failed check never rewrites the stored plan");
});

dbTest("a shop has one subscription row and one recommendation row, and the database rejects impossible periods", async () => {
  const shop = await newShop("unique");
  await prisma.shopSubscription.create({ data: { shopId: shop.id } });
  await assert.rejects(prisma.shopSubscription.create({ data: { shopId: shop.id } }), (error) => error.code === "P2002");
  await assert.rejects(
    prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { currentPeriodStart: NOW, currentPeriodEnd: new Date(NOW.getTime() - DAY) } }),
    /check|constraint/i,
  );
  await assert.rejects(prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { verificationFailures: -1 } }), /check|constraint/i);
});

// ======================= recommendation storage (database) =======================
// The job life cycle (claim, lease, result, failure, recovery) and the email quota accounting are tested in tests/billing-enforcement.test.mjs.
dbTest("repeated and simultaneous requests create one recommendation row per shop", async () => {
  const shop = await newShop("rec-once");
  const rows = await Promise.all([ensurePlanRecommendation(shop.id, { now: NOW }), ensurePlanRecommendation(shop.id, { now: NOW }), ensurePlanRecommendation(shop.id, { now: NOW })]);
  assert.equal(new Set(rows.map((row) => row.id)).size, 1);
  assert.equal(await prisma.planRecommendation.count({ where: { shopId: shop.id } }), 1);
  const row = rows[0];
  assert.deepEqual([row.status, row.attempts, row.sessions30d, row.recommendedPlan, row.fetchedAt], ["PENDING", 0, null, null, null], "no count, no advice, until a lookup succeeds");
  assert.equal(row.nextAttemptAt.getTime(), NOW.getTime());
});

// ======================= only a real verification source can verify =======================
// Decision (see plans.server.js): a paid row grants entitlements only when verificationSource is app_pricing, the one real source. Tests
// use that same label with an injected verifier; there is no test-only source in production code.
const { VERIFIED_SOURCES, APP_PRICING_SOURCE: PLANS_SOURCE } = await import("../app/models/plans.server.js");
const { APP_PRICING_SOURCE } = await import("../app/models/partner-api-verifier.server.js");
const { normalizeVerification } = await import("../app/models/subscription-verification.server.js");

test("the only source that can verify a paid plan is the Partner API's, and the verifier module reports the same label", () => {
  assert.deepEqual([...VERIFIED_SOURCES], ["app_pricing"]);
  assert.equal(APP_PRICING_SOURCE, PLANS_SOURCE);
  assert.equal(Object.isFrozen(VERIFIED_SOURCES), true);
});

test("a paid row with any other source is NOT verified, however fresh and complete the rest of the row is", () => {
  const view = (source) => resolveEntitlements(paidRow({ verificationSource: source }), NOW);
  assert.deepEqual([view("app_pricing").plan.key, view("app_pricing").state], ["ADVANCE", "verified"]);
  for (const source of ["test", "stub", "x", "billing_api", "authoritative_check", "APP_PRICING", " app_pricing", "app_pricing ", "toString", "__proto__"]) {
    const result = view(source);
    assert.deepEqual([result.plan.key, result.state, result.reason, result.billingPeriod], ["BASIC", "fallback", "verification_source_unrecognised", null], JSON.stringify(source));
  }
  assert.equal(view(null).reason, "not_verified", "a missing source keeps its own reason");
  assert.equal(view("").reason, "not_verified");
});

test("an answer from an unrecognised source is not recorded as a verification (it becomes an invalid-response error, not a paid plan)", () => {
  const periodStart = new Date("2026-11-01T00:00:00Z");
  const periodEnd = new Date("2026-12-01T00:00:00Z");
  const answer = (source) => normalizeVerification({ outcome: "active", plan: "ADVANCE", periodStart, periodEnd, source });
  assert.equal(answer("app_pricing").outcome, "active");
  assert.equal(answer(" app_pricing ").source, "app_pricing", "surrounding spaces are trimmed, as before");
  for (const source of ["test", "stub", "billing_api", "", undefined, null, 5, {}]) assert.deepEqual(answer(source), { outcome: "error", kind: "transient", code: "invalid_response" }, String(source));
  const trial = (source) => normalizeVerification({ outcome: "trial", plan: "ENTERPRISE", trialEndsAt: periodEnd, source });
  assert.equal(trial("app_pricing").outcome, "trial");
  assert.equal(trial("stub").outcome, "error");
});

test("the legacy sources the app itself writes on cancel/inactive paths can never grant a paid plan", () => {
  const cancelled = resolveEntitlements(paidRow({ status: "CANCELLED", verificationSource: "authoritative_check" }), NOW);
  assert.deepEqual([cancelled.plan.key, cancelled.state], ["BASIC", "fallback"]);
  const active = resolveEntitlements(paidRow({ verificationSource: "authoritative_check" }), NOW);
  assert.equal(active.state, "fallback");
});
