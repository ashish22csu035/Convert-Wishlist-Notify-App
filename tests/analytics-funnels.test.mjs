// Tests for the Analytics funnels: the Wishlist and Notify Me funnels built from this app's own records
// (app/utils/funnel.js), and how the date range reaches them.
//
// Run: node --test tests/analytics-funnels.test.mjs
//
// The data tests use the real MySQL database from .env with uniquely named shops that are deleted at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const domains = [];
const NOW = new Date("2026-10-22T10:00:00.000Z");
const at = (iso) => new Date(iso);
let reporting;
let analyticsWorker;
let F;
let P;
let counter = 9700000000;
let capture = null; // when an array, the app's client pushes every SQL statement into it

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  // The app's own client (app/db.server.js) is created on first import. Give it query events so a test can count the
  // statements a function sends; nothing is recorded unless a test turns `capture` on. The test's own client is unaffected.
  const prismaModule = require("@prisma/client");
  prismaModule.PrismaClient = class extends prismaModule.PrismaClient {
    constructor(options) {
      super({ ...options, log: [{ emit: "event", level: "query" }] });
      this.$on("query", (event) => capture?.push(event.query));
    }
  };
  reporting = await import("../app/models/reporting.server.js");
  analyticsWorker = await import("../app/worker/analytics-daily.server.js");
  F = await import("../app/utils/funnel.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

// ======================= Wishlist and Notify Me funnels =======================
const summary = {
  range: { wishlistAddedToCart: 5, restockEmailsSent: 6, wishlistCheckouts: 3, notifyCheckouts: 2, notifyAddedToCart: 4, coverage: { expectedDays: 30, availableDays: 30, complete: true } },
  allTime: { wishlistSaved: 12, notifySubscriptions: 8, coverage: { expectedDays: 90, availableDays: 90, complete: true } },
  lastUpdated: "2026-10-22T10:00:00.000Z",
};
const ready = { state: "ready", currency: "USD", overall: { orders: 3, revenue: "90.00" }, wishlist: { orders: 2, revenue: "60.00" }, notifyMe: { orders: 1, revenue: "30.00" } };

test("Wishlist funnel: four stages in the agreed order, all-time saves first, revenue with its order count, no percentages", () => {
  const funnel = F.buildFeatureFunnel("wishlist", { summary, attribution: ready });
  assert.deepEqual(funnel.stages.map((s) => s.label), ["Products saved", "Added to cart", "Checkout initiated", "Attributed revenue"]);
  assert.deepEqual(funnel.stages.map((s) => s.count), [12, 5, 3, 60]);
  assert.deepEqual(funnel.stages.map((s) => s.scope), ["all-time", "range", "range", "range"]);
  assert.equal(funnel.stages[3].display, "$60.00");
  assert.equal(funnel.stages[3].orders, 2);
  assert.ok(funnel.stages.every((s) => s.available && !("rate" in s)), "no conversion percentage exists on any stage");
  // the Notify Me figures never leak in, whatever their size
  assert.equal(JSON.stringify(funnel.stages).includes('"count":8'), false);
  assert.equal(/"count":6[,}]/.test(JSON.stringify(funnel.stages)), false);
});

test("Notify Me funnel: five stages in the agreed order, with the real Notify Me cart-addition count", () => {
  const funnel = F.buildFeatureFunnel("notifyMe", { summary, attribution: ready });
  assert.deepEqual(funnel.stages.map((s) => s.label), ["Total subscriptions", "Restock emails sent", "Added to cart", "Checkout initiated", "Attributed revenue"]);
  assert.deepEqual(funnel.stages.map((s) => s.count), [8, 6, 4, 2, 30]);
  assert.deepEqual(funnel.stages.map((s) => s.scope), ["all-time", "range", "range", "range", "range"]);
  assert.equal(funnel.stages[2].reason, null);
  assert.ok(funnel.stages.every((s) => !("hint" in s)), "no stage carries tooltip text: the funnel shows no info icons");
  assert.equal(funnel.stages[4].display, "$30.00");
  assert.equal(funnel.stages[4].orders, 1);
  assert.ok(funnel.stages.every((s) => !("rate" in s)), "the stages are not a cohort, so no percentage");
});

test("orders and revenue are unavailable, with the reason on the stage, when order data is missing or unusable", () => {
  for (const [attribution, reason] of [[{ state: "needs_access" }, /read_orders/], [{ state: "waiting" }, /No orders have been received/], [null, /read_orders/]]) {
    const stages = F.buildFeatureFunnel("wishlist", { summary, attribution }).stages;
    assert.deepEqual(stages.map((s) => s.count), [12, 5, 3, null], "events still count; revenue is not shown as zero");
    assert.match(stages[3].reason, reason);
  }
  const mixed = F.buildFeatureFunnel("wishlist", { summary, attribution: { ...ready, mixedCurrency: true, wishlist: { orders: 2, revenue: null } } }).stages;
  assert.deepEqual([mixed[3].count, mixed[3].orders], [null, 2], "orders are real, revenue is not added across currencies");
  assert.match(mixed[3].reason, /more than one currency/);
  const confirmedZero = F.buildFeatureFunnel("notifyMe", { summary, attribution: { ...ready, notifyMe: { orders: 0, revenue: "0.00" } } }).stages;
  assert.deepEqual([confirmedZero[4].count, confirmedZero[4].orders, confirmedZero[4].display], [0, 0, "$0.00"], "a confirmed zero stays a zero");
});

test("empty store: missing summaries are unavailable (not zero), real zeros are zeros, and an all-zero funnel is empty", () => {
  const none = F.buildFeatureFunnel("wishlist", { summary: { range: {}, allTime: {} }, attribution: { state: "waiting" } });
  assert.deepEqual(none.stages.map((s) => s.count), [null, null, null, null], "days the worker has not calculated are unavailable, not zero");
  assert.match(none.stages[0].reason, /Not calculated yet/);
  assert.equal(F.isEmptyFunnel(none.stages), true);
  const nothing = F.buildFeatureFunnel("wishlist", { summary: null, attribution: null });
  assert.deepEqual(nothing.stages.map((s) => s.count), [null, null, null, null], "no summary at all is unavailable");
  const zeros = { range: { wishlistAddedToCart: 0, restockEmailsSent: 0, wishlistCheckouts: 0, notifyCheckouts: 0, notifyAddedToCart: 0 }, allTime: { wishlistSaved: 0, notifySubscriptions: 0 } };
  const zeroFunnel = F.buildFeatureFunnel("notifyMe", { summary: zeros, attribution: { ...ready, notifyMe: { orders: 0, revenue: "0.00" } } });
  assert.deepEqual(zeroFunnel.stages.map((s) => s.count), [0, 0, 0, 0, 0], "tracking is operational and nothing qualified: a real zero");
  const uncalculated = F.buildFeatureFunnel("notifyMe", { summary: { ...zeros, range: { ...zeros.range, notifyAddedToCart: null } }, attribution: ready });
  assert.equal(uncalculated.stages[2].count, null, "a day not calculated yet is unavailable, not zero");
  assert.match(uncalculated.stages[2].reason, /Not calculated yet/);
  assert.equal(F.isEmptyFunnel(zeroFunnel.stages), true, "real zeros everywhere");
  assert.equal(F.isEmptyFunnel(F.buildFeatureFunnel("notifyMe", { summary: zeros, attribution: ready }).stages), false, "an attributed order alone is activity");
});

test("a summary with missing days is flagged as partial so the screen can say the figures are a lower bound", () => {
  const partial = { ...summary, range: { ...summary.range, coverage: { expectedDays: 30, availableDays: 12, complete: false } } };
  assert.equal(F.buildFeatureFunnel("wishlist", { summary: partial, attribution: ready }).partial, true);
  assert.equal(F.buildFeatureFunnel("wishlist", { summary, attribution: ready }).partial, false);
});

// ======================= the summaries: ETL -> AnalyticsDaily -> getFunnelSummary (real database) =======================
// A recent install date keeps the ETL's day-by-day backfill short (it works through every day since the install).
const makeShop = async (tag, installedAt = "2026-09-28T00:00:00Z") => {
  const domain = `kw-funnel-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at(installedAt) } });
};
const runEtl = (shop, now = NOW) => analyticsWorker.runAnalyticsDaily({ now: () => now, shopIds: [shop.id], backfillPerShop: 400, log: { log() {}, error() {} }, invalidate: async () => {} });

test("funnel summary: every stage is aggregated from its own source, with the right date scope", async () => {
  const shop = await makeShop("range", "2026-08-10T00:00:00Z");
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
  const variantGid = "gid://shopify/ProductVariant/77";
  const event = (type, iso) => prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: "gid://shopify/Product/1", variantGid, occurredAt: at(iso) } });
  // Wishlist saves: all time (the Aug one is outside the selected dates but still counts)
  await event("WISHLIST_ADDED", "2026-08-15T10:00:00Z");
  await event("WISHLIST_ADDED", "2026-10-02T00:00:00Z");
  await event("WISHLIST_ADDED", "2026-10-04T00:00:00Z");
  await event("WISHLIST_REMOVED", "2026-10-03T09:00:00Z"); // not a stage
  // cart additions: filtered by date
  await event("WISHLIST_ADDED_TO_CART", "2026-10-01T23:59:59Z"); // before
  await event("WISHLIST_ADDED_TO_CART", "2026-10-02T09:00:00Z");
  await event("WISHLIST_ADDED_TO_CART", "2026-10-03T23:59:59Z");
  await event("WISHLIST_ADDED_TO_CART", "2026-10-04T00:00:00Z"); // after
  // restock emails: only the accepted one has the event
  await event("RESTOCK_EMAIL_SENT", "2026-10-03T12:00:00Z");
  // subscriptions: active, fulfilled and unsubscribed ones are all "ever created"
  const subs = [];
  for (const [i, [status, created]] of [["ACTIVE", "2026-09-01T10:00:00Z"], ["FULFILLED", "2026-10-02T10:00:00Z"], ["UNSUBSCRIBED", "2026-10-03T10:00:00Z"]].entries()) {
    const other = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
    subs.push(await prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: other.id, productGid: "gid://shopify/Product/1", variantGid: `gid://shopify/ProductVariant/9${i}`, email: "customer@example.invalid", status, consentedAt: at(created), consentSource: "test", createdAt: at(created), unsubscribedAt: status === "UNSUBSCRIBED" ? at(created) : null } }));
  }
  for (const [cycle, status] of [[1, "SENT"], [2, "PENDING"], [3, "FAILED"], [4, "SKIPPED"], [5, "UNKNOWN"], [6, "SENDING"]]) {
    await prisma.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: subs[0].id, restockCycle: cycle, variantGid, status, createdAt: at("2026-10-03T00:00:00Z") } });
  }
  // checkouts per feature
  const checkout = (feature, key, iso) => prisma.checkoutAttribution.create({ data: { shopId: shop.id, actorId: actor.id, checkoutKey: key, feature, startedAt: at(iso) } });
  await checkout("WISHLIST", "c1", "2026-10-02T10:00:00Z");
  await checkout("WISHLIST", "c2", "2026-10-03T10:00:00Z");
  await checkout("WISHLIST", "c3", "2026-10-05T10:00:00Z"); // after
  await checkout("NOTIFY_ME", "c1", "2026-10-02T10:00:00Z"); // the same checkout may serve both journeys
  await checkout("NOTIFY_ME", "c9", "2026-09-20T10:00:00Z"); // before

  const first = await runEtl(shop);
  assert.equal(first.failed, 0);
  const ref = await reporting.getShopByDomain(shop.domain);
  const { period } = P.customPeriod("2026-10-02", "2026-10-03", NOW);
  const result = await reporting.getFunnelSummary(ref, period, NOW);
  assert.deepEqual({ ...result.range, coverage: undefined }, { wishlistAddedToCart: 2, restockEmailsSent: 1, wishlistCheckouts: 2, notifyCheckouts: 1, notifyAddedToCart: 0, coverage: undefined });
  assert.deepEqual(result.range.coverage, { expectedDays: 2, availableDays: 2, complete: true });
  assert.equal(result.allTime.wishlistSaved, 3, "all three saves, whatever the dates; the removal is not a save");
  assert.equal(result.allTime.notifySubscriptions, 3, "active, fulfilled and unsubscribed subscriptions are all counted");
  assert.ok(result.lastUpdated, "the screen can say when the summaries were calculated");
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id } }), 6, "six deliveries exist; only the accepted one is a sent email");

  // a wider date selection: the all-time stages do not move, the filtered ones do
  const wide = await reporting.getFunnelSummary(ref, P.presetPeriod(30, NOW), NOW);
  assert.equal(wide.allTime.wishlistSaved, 3);
  assert.equal(wide.range.wishlistAddedToCart, 4, "every cart addition up to now");

  // a subscription that becomes inactive is still counted, and re-running the ETL never double counts
  await prisma.notifySubscription.update({ where: { id: subs[0].id }, data: { status: "UNSUBSCRIBED", unsubscribedAt: at("2026-10-10T00:00:00Z") } });
  await runEtl(shop);
  await runEtl(shop);
  const again = await reporting.getFunnelSummary(ref, period, NOW);
  assert.deepEqual([again.range.wishlistAddedToCart, again.range.wishlistCheckouts, again.range.notifyCheckouts, again.allTime.wishlistSaved, again.allTime.notifySubscriptions], [2, 2, 1, 3, 3]);
});

test("funnel summary: days without the funnel columns are unavailable (never zero) until the worker calculates them, and an empty store is a confirmed zero", async () => {
  const shop = await makeShop("legacy");
  const ref = await reporting.getShopByDomain(shop.domain);
  const { period } = P.customPeriod("2026-10-02", "2026-10-03", NOW);
  // an old-format row: finished for the old metrics, the funnel columns NULL
  await prisma.analyticsDaily.create({ data: { shopId: shop.id, day: at("2026-10-02T00:00:00Z"), wishlistAdded: 4, notifyUnsubscribed: 0, updatedAt: at("2026-10-02T12:00:00Z") } });
  const before = await reporting.getFunnelSummary(ref, period, NOW);
  assert.equal(before.range.wishlistAddedToCart, null, "not calculated yet is unavailable, not zero");
  assert.equal(before.allTime.wishlistSaved, null);
  assert.equal(before.range.coverage.complete, false);
  // the worker treats such a row as needing a calculation and fills the funnel columns
  await runEtl(shop);
  const after = await reporting.getFunnelSummary(ref, period, NOW);
  assert.deepEqual([after.range.wishlistAddedToCart, after.range.wishlistCheckouts, after.allTime.wishlistSaved, after.allTime.notifySubscriptions], [0, 0, 0, 0], "an empty store: confirmed zeros");
  assert.equal(after.range.coverage.complete, true);
  // a range that ends before the shop existed has nothing to count: a confirmed zero
  const early = await reporting.getFunnelSummary({ ...ref, installedAt: at("2026-10-20T00:00:00Z") }, P.customPeriod("2026-10-01", "2026-10-02", NOW).period, NOW);
  assert.equal(early.range.wishlistAddedToCart, 0);
});

test("ETL failure handling: a day that fails is reported and keeps its previous summary", async () => {
  const shop = await makeShop("fail");
  await runEtl(shop);
  const ref = await reporting.getShopByDomain(shop.domain);
  const { period } = P.customPeriod("2026-10-01", "2026-10-02", NOW);
  const good = await reporting.getFunnelSummary(ref, period, NOW);
  const run = await analyticsWorker.runAnalyticsDaily({
    now: () => new Date(NOW.getTime() + 60 * 60 * 1000),
    shopIds: [shop.id],
    log: { log() {}, error() {} },
    calculate: async () => {
      throw new Error("boom");
    },
  });
  assert.ok(run.failed > 0 && run.written === 0);
  assert.deepEqual((await reporting.getFunnelSummary(ref, period, NOW)).range, good.range, "the last good summary is still what the funnel shows");
});

// ======================= the page =======================
test("Analytics page source: the four KPIs, the selector over the two funnels, and nothing of the removed sections", () => {
  const source = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");
  const firstGrid = source.slice(source.indexOf("<Grid>"), source.indexOf("</Grid>"));
  assert.deepEqual([...firstGrid.matchAll(/label="([^"]+)"/g)].map((m) => m[1]), ["Products added to Wishlist", "Products removed from Wishlist", "Notify Me subscriptions", "Restock emails sent"]);
  assert.equal((source.match(/<Grid>/g) ?? []).length, 2, "the four KPIs, then the two session cards");
  const afterFirst = source.indexOf("</Grid>") + 1;
  const sessionGrid = source.slice(source.indexOf("<Grid>", afterFirst), source.indexOf("</Grid>", afterFirst));
  assert.deepEqual([...sessionGrid.matchAll(/label="([^"]+)"/g)].map((m) => m[1]), ["Wishlist sessions", "Notify Me sessions"]);
  assert.ok(source.indexOf('label="Wishlist sessions"') < source.indexOf('<Card title="Product funnel">'), "directly below the four, above the funnel");
  assert.equal((sessionGrid.match(/Actions close together count once/g) ?? []).length, 2, "both tooltips say what is counted");
  assert.match(source, /<FunnelSwitch funnels={funnels} rangeLabel={words\.label} \/>/);
  assert.match(source, /buildFeatureFunnel\("wishlist", \{ summary, attribution \}\)/, "the stored daily summaries and the shared attribution service are used");
  for (const gone of [
    "Store conversion", "storeFunnel", "fetchStoreFunnel", "buildStoreFunnel", "ProductFunnel", "Sessions", "Checkout initiated",
    "Unique Wishlist users", "Average saved items per customer", "Emails accepted by mail server",
    "Product opens from Wishlist", "UnavailableCard", // ("Not available yet" now appears only in the notice's Last updated line)
  ]) {
    assert.equal(source.includes(gone), false, gone);
  }
  assert.equal(/average|finished/.test(source), false, "no helper left over from the removed cards");
});

test("Analytics: no explanatory text under the Attributed revenue table, and its table and data are still there", () => {
  const source = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");
  for (const gone of ["Orders placed", "ATTRIBUTION_FOOTNOTE", "Overall counts each order once"]) assert.equal(source.includes(gone), false, gone);
  assert.ok(source.includes('<Card title="Attributed revenue">'));
  for (const kept of ['["Overall", a.attribution.overall]', '["Wishlist", a.attribution.wishlist]', '["Notify Me", a.attribution.notifyMe]', "Full value of those orders"]) assert.ok(source.includes(kept), kept);
});

// ======================= session cards =======================
const session = (shop, actor, feature, startedAt) =>
  prisma.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature, startedAt: at(startedAt), expiresAt: new Date(at(startedAt).getTime() + 30 * 60 * 1000) } });
const sessionEvent = (shop, actor, sess, type, iso) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: sess?.id ?? null, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: "gid://shopify/Product/1", occurredAt: at(iso) } });
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const range = (from, to) => P.customPeriod(from, to, NOW).period;

test("sessions: each session counts once per feature however many events it holds, and sessions are not customers or events", async () => {
  const shop = await makeShop("sess");
  const a = await actorOf(shop);
  const b = await actorOf(shop);
  const w1 = await session(shop, a, "WISHLIST", "2026-10-02T08:00:00Z");
  const w2 = await session(shop, a, "WISHLIST", "2026-10-02T15:00:00Z"); // same customer, a second visit
  const w3 = await session(shop, b, "WISHLIST", "2026-10-03T09:00:00Z");
  for (const type of ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED", "WISHLIST_ADDED"]) await sessionEvent(shop, a, w1, type, "2026-10-02T08:05:00Z");
  await sessionEvent(shop, a, w2, "WISHLIST_ADDED", "2026-10-02T15:01:00Z");
  await sessionEvent(shop, b, w3, "WISHLIST_PRODUCT_CLICKED", "2026-10-03T09:01:00Z");
  const n1 = await session(shop, a, "NOTIFY_ME", "2026-10-02T10:00:00Z");
  await sessionEvent(shop, a, n1, "NOTIFY_SUBSCRIBED", "2026-10-02T10:01:00Z");
  await sessionEvent(shop, a, n1, "NOTIFY_SUBSCRIBED", "2026-10-02T10:02:00Z");
  await sessionEvent(shop, a, null, "RESTOCK_EMAIL_SENT", "2026-10-03T10:00:00Z"); // written by the worker: no session
  await sessionEvent(shop, a, null, "NOTIFY_UNSUBSCRIBED", "2026-10-03T11:00:00Z"); // from the email link: no session
  await session(shop, b, "NOTIFY_ME", "2026-10-03T12:00:00Z"); // opened the form, did nothing: no event

  const ref = await reporting.getShopByDomain(shop.domain);
  const analytics = await reporting.getAnalytics(ref, range("2026-10-02", "2026-10-03"), NOW);
  assert.equal(analytics.sessionActivity.wishlist.current, 3, "3 sessions: 6 events and 2 customers collapse to sessions");
  assert.equal(analytics.sessionActivity.notifyMe.current, 2, "one session with two sign-ups and one idle session that only opened the form; emails and unsubscribes are not sessions");
  const w = analytics.activity.window;
  assert.equal(w.WISHLIST_ADDED + w.WISHLIST_PRODUCT_CLICKED + w.WISHLIST_REMOVED, 6);
});

test("sessions: the date range decides by when the session started, and a session is counted once even when its events span the edge", async () => {
  const shop = await makeShop("sessrange");
  const a = await actorOf(shop);
  const early = await session(shop, a, "WISHLIST", "2026-10-01T23:50:00Z");
  await sessionEvent(shop, a, early, "WISHLIST_ADDED", "2026-10-01T23:59:59Z");
  await sessionEvent(shop, a, early, "WISHLIST_ADDED", "2026-10-02T00:00:00Z"); // after midnight: still the session that started on the 1st
  const late = await session(shop, a, "WISHLIST", "2026-10-03T23:50:00Z");
  await sessionEvent(shop, a, late, "WISHLIST_ADDED", "2026-10-03T23:59:59Z");
  await sessionEvent(shop, a, late, "WISHLIST_ADDED", "2026-10-04T00:00:00Z");
  const onlyOutside = await session(shop, a, "WISHLIST", "2026-10-05T10:00:00Z");
  await sessionEvent(shop, a, onlyOutside, "WISHLIST_ADDED", "2026-10-05T10:01:00Z");
  await session(shop, a, "WISHLIST", "2026-10-03T10:00:00Z"); // no event at all: still a session
  const count = (period) => reporting.sessionCountOf(shop.id, "WISHLIST", period.since, period.until);
  assert.equal(await count(range("2026-10-02", "2026-10-03")), 2, "the idle one and `late`; `early` started on the 1st");
  assert.equal(await count(range("2026-10-01", "2026-10-01")), 1);
  assert.equal(await count(range("2026-10-04", "2026-10-04")), 0, "`late` started on the 3rd, so the 4th has nothing");
  assert.equal(await count(range("2026-10-06", "2026-10-07")), 0, "a period with no sessions is a confirmed zero");
  assert.equal(await count(P.presetPeriod(30, NOW)), 4, "a preset runs to now; each session once");
  assert.equal(await reporting.sessionCountOf(shop.id, "NOTIFY_ME", P.presetPeriod(30, NOW).since, null), 0, "the other feature has none");
});

test("sessions: the previous period of the same length is counted for the comparison", async () => {
  const shop = await makeShop("sessprev");
  const a = await actorOf(shop);
  const s1 = await session(shop, a, "WISHLIST", "2026-10-04T10:00:00Z");
  await sessionEvent(shop, a, s1, "WISHLIST_ADDED", "2026-10-04T10:01:00Z");
  const s2 = await session(shop, a, "WISHLIST", "2026-10-06T10:00:00Z");
  await sessionEvent(shop, a, s2, "WISHLIST_ADDED", "2026-10-06T10:01:00Z");
  const s3 = await session(shop, a, "WISHLIST", "2026-10-07T10:00:00Z");
  await sessionEvent(shop, a, s3, "WISHLIST_ADDED", "2026-10-07T10:01:00Z");
  const analytics = await reporting.getAnalytics(await reporting.getShopByDomain(shop.domain), range("2026-10-06", "2026-10-07"), NOW);
  assert.deepEqual(analytics.sessionActivity.wishlist, { current: 2, previous: 1 }, "Oct 6-7 has two sessions; the two days before (Oct 4-5) have one");
});

test("sessions: events that carry no session do not make the count unavailable: sessions come from BrowsingSession", async () => {
  const shop = await makeShop("sessna");
  const a = await actorOf(shop);
  const s1 = await session(shop, a, "WISHLIST", "2026-10-02T10:00:00Z");
  await sessionEvent(shop, a, s1, "WISHLIST_ADDED", "2026-10-02T10:01:00Z");
  await sessionEvent(shop, a, null, "WISHLIST_ADDED", "2026-10-03T10:00:00Z"); // recorded before sessions existed
  const ref = await reporting.getShopByDomain(shop.domain);
  const both = await reporting.getAnalytics(ref, range("2026-10-02", "2026-10-03"), NOW);
  assert.equal(both.sessionActivity.wishlist.current, 1, "the session-less event is not a session");
  assert.equal(both.sessionActivity.notifyMe.current, 0, "the other feature is a real zero");
  assert.equal((await reporting.getAnalytics(ref, range("2026-10-02", "2026-10-02"), NOW)).sessionActivity.wishlist.current, 1);
});

test("no stage carries helper text, in either funnel and whatever the data", async () => {
  const phrases = ["Added to a Wishlist in this period", "Product opens from the Wishlist page", "New sign-ups in this period", "Accepted by the mail server", "Last touch within 7 days", "Net of refunds on the credited items"];
  const funnelSource = fs.readFileSync("app/utils/funnel.js", "utf8");
  for (const phrase of phrases) assert.equal(funnelSource.includes(phrase), false, phrase);
  for (const attribution of [ready, { state: "waiting" }, { ...ready, mixedCurrency: true, wishlist: { orders: 2, revenue: null }, notifyMe: { orders: 2, revenue: null } }]) {
    for (const feature of ["wishlist", "notifyMe"]) {
      for (const item of F.buildFeatureFunnel(feature, { summary, attribution }).stages) assert.equal("caption" in item, false, `${feature}/${item.key} has no caption`);
    }
  }
});

test("the removed store funnel leaves no code, no permission and no query behind", () => {
  assert.equal(fs.existsSync("app/models/store-analytics.server.js"), false);
  const funnel = fs.readFileSync("app/utils/funnel.js", "utf8");
  for (const gone of ["buildStoreFunnel", "buildFunnel", "conversionRate", "changeSince", "read_reports"]) assert.equal(funnel.includes(gone), false, gone);
  const toml = fs.readFileSync("shopify.app.toml", "utf8");
  const scopes = /^scopes = "([^"]+)"/m.exec(toml)[1].split(",");
  assert.deepEqual(scopes, ["write_products", "write_metaobjects", "write_metaobject_definitions", "write_app_proxy", "read_customers", "read_inventory", "read_orders"], "read_reports is not requested any more");
  assert.equal(/orderCount|savedPerCustomer|paidOrders/.test(fs.readFileSync("app/models/reporting.server.js", "utf8")), false);
});

// ======================= the lightweight Analytics loader =======================
// getAnalyticsOverview returns what the Analytics screen shows. These tests hold it to getAnalytics (the earlier
// loader, kept as the reference) on the same seeded data, for every kind of period, and count the statements sent.
const SLIM_FIELDS = (a) => ({ days: a.days, period: a.period, comparable: a.comparable, window: a.activity.window, previous: a.activity.previous, topProducts: a.topProducts, topCustomers: a.topCustomers, sessionActivity: a.sessionActivity });
const utc = (offsetDays, hour, minute = 5, second = 0) => new Date(Date.UTC(2026, 9, 22 - offsetDays, hour, minute, second));

// Events over ~95 days (never before the shop's install date): Wishlist and Notify Me sessions, worker-written emails
// (no session), a session that crosses midnight, a few shared products and customers. `unattributed` adds Wishlist
// events that carry no session. The daily summaries the Analytics loader reads are filled by the analytics worker.
async function seedBusyShop(tag, installedAt, { unattributed = false } = {}) {
  const shop = await prisma.shop.create({ data: { domain: `kw-funnel-${tag}-${RUN}.myshopify.com`, currencyCode: "USD", installedAt: at(installedAt) } });
  domains.push(shop.domain);
  const actors = [await actorOf(shop), await actorOf(shop), await actorOf(shop)];
  const make = (actor, sess, type, when, n = 1) =>
    prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: sess?.id ?? null, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: `gid://shopify/Product/${n}`, variantGid: `gid://shopify/ProductVariant/${n}1`, occurredAt: when } });
  const offsets = [0, 1, 2, 3, 6, 7, 9, 13, 14, 20, 29, 30, 33, 45, 59, 61, 89, 95];
  for (const [k, off] of offsets.entries()) {
    if (utc(off, 2) < at(installedAt)) continue; // nothing exists before the shop was installed
    const actor = actors[k % 3];
    const w = await session(shop, actor, "WISHLIST", utc(off, 2).toISOString());
    await make(actor, w, "WISHLIST_ADDED", utc(off, 2, 6), (k % 3) + 1);
    await make(actors[(k + 1) % 3], w, "WISHLIST_PRODUCT_CLICKED", utc(off, 2, 7), 1);
    if (k % 2 === 0) await make(actor, w, "WISHLIST_REMOVED", utc(off, 2, 8), 2);
    const n = await session(shop, actor, "NOTIFY_ME", utc(off, 3).toISOString());
    await make(actor, n, "NOTIFY_SUBSCRIBED", utc(off, 3, 6), 4);
    await make(actors[(k + 2) % 3], null, "RESTOCK_EMAIL_SENT", utc(off, 4), 4);
  }
  // one Wishlist session that crosses midnight (Oct 14 23:50 -> Oct 15 00:10)
  const straddle = await session(shop, actors[0], "WISHLIST", "2026-10-14T23:50:00Z");
  await make(actors[0], straddle, "WISHLIST_ADDED", at("2026-10-14T23:59:59Z"), 3);
  await make(actors[0], straddle, "WISHLIST_ADDED", at("2026-10-15T00:00:01Z"), 3);
  if (unattributed) {
    await make(actors[1], null, "WISHLIST_ADDED", utc(2, 8), 1); // inside the current window of 7, 30 and 90 days
    await make(actors[1], null, "NOTIFY_SUBSCRIBED", utc(40, 8), 4); // only in the PREVIOUS window of the 30-day period
  }
  // saved items: product 1 x3, product 2 x2, product 3 x1
  for (const [i, product] of [1, 1, 1, 2, 2, 3].entries()) {
    await prisma.wishlistItem.create({ data: { shopId: shop.id, actorId: actors[i % 3].id, productGid: `gid://shopify/Product/${product}`, variantGid: `gid://shopify/ProductVariant/${product}${i}`, productTitle: `Product ${product}`, productHandle: `product-${product}` } });
  }
  const order = await prisma.shopifyOrder.create({ data: { shopId: shop.id, orderGid: `gid://shopify/Order/${RUN}${tag}`, orderName: "#1", customerGid: actors[0].customerGid, placedAt: utc(3, 12), financialStatus: "PAID", currencyCode: "USD", totalPrice: 50, shopifyUpdatedAt: utc(3, 12) } });
  await prisma.orderAttribution.create({ data: { shopId: shop.id, orderId: order.id, feature: "WISHLIST", touchedAt: utc(4, 1), matchedProductGid: "gid://shopify/Product/1", grossAmount: 30, currencyCode: "USD" } });
  await analyticsWorker.runAnalyticsDaily({ now: () => NOW, shopIds: [shop.id], backfillPerShop: 400, log: { log() {}, error() {} }, invalidate: async () => {} });
  return shop;
}

const PARITY_PERIODS = () => [7, 30, 90, range("2026-10-20", "2026-10-20"), range("2026-10-02", "2026-10-03"), range("2026-10-15", "2026-10-22"), range("2026-10-14", "2026-10-15"), range("2026-09-01", "2026-09-30")];

test("lightweight loader: the same figures as getAnalytics, for presets and custom ranges, with and without a comparable previous period", async () => {
  const shops = [
    ["comparable", await seedBusyShop("slim-a", "2026-01-01T00:00:00Z")],
    ["not-comparable", await seedBusyShop("slim-b", "2026-10-12T00:00:00Z")], // installed inside the 30-day previous window
  ];
  for (const [label, shop] of shops) {
    const ref = await reporting.getShopByDomain(shop.domain);
    let sawPrevious = false;
    for (const period of PARITY_PERIODS()) {
      const slim = await reporting.getAnalyticsOverview(ref, period, NOW);
      const full = await reporting.getAnalytics(ref, period, NOW);
      const name = `${label} ${typeof period === "number" ? `${period} days` : `${period.from}..${period.to}`}`;
      assert.deepEqual(SLIM_FIELDS(slim), SLIM_FIELDS(full), name);
      // the funnels the page builds are identical, and so is the attribution they read
      const attribution = await reporting.getAttribution(shop.id, period, { scopeGranted: true, now: NOW });
      for (const feature of ["wishlist", "notifyMe"]) {
        assert.deepEqual(F.buildFeatureFunnel(feature, { window: slim.activity.window, attribution }), F.buildFeatureFunnel(feature, { window: full.activity.window, attribution }), `${name} ${feature} funnel`);
      }
      assert.equal(slim.comparable, ref.installedAt <= P.previousOf(P.resolvePeriod(period, NOW)).since, `${name}: the installed-date rule`);
      assert.equal(slim.activity.previous !== null, slim.comparable, `${name}: previous-period figures exist exactly when tracking covers the previous period`);
      sawPrevious ||= slim.comparable;
    }
    assert.equal(sawPrevious, true, `${label}: at least one compared period had a previous period`);
    for (const days of [7, 30, 90]) assert.equal((await reporting.getAnalyticsOverview(ref, days, NOW)).comparable, label === "comparable", `${label}: ${days}-day preset`);
  }
  // the data is not trivially empty: figures, leaderboards and sessions are real
  const ref = await reporting.getShopByDomain(shops[0][1].domain);
  const thirty = await reporting.getAnalyticsOverview(ref, 30, NOW);
  assert.ok(thirty.activity.window.WISHLIST_ADDED > 0 && thirty.activity.previous.WISHLIST_ADDED > 0);
  assert.deepEqual(thirty.topProducts.map((p) => p.saves), [3, 2, 1]);
  assert.ok(thirty.topCustomers.length === 3 && thirty.sessionActivity.wishlist.current > 0 && thirty.sessionActivity.notifyMe.previous > 0);
  const notComparable = await reporting.getAnalyticsOverview(await reporting.getShopByDomain(shops[1][1].domain), 30, NOW);
  assert.deepEqual([notComparable.comparable, notComparable.activity.previous, notComparable.sessionActivity.wishlist.previous, notComparable.sessionActivity.notifyMe.previous], [false, null, null, null]);
});

test("lightweight loader: the stored session totals equal the live count for every period, even when some events carry no session", async () => {
  const shop = await seedBusyShop("slim-c", "2026-01-01T00:00:00Z", { unattributed: true });
  const ref = await reporting.getShopByDomain(shop.domain);
  let compared = 0;
  for (const period of PARITY_PERIODS()) {
    const slim = await reporting.getAnalyticsOverview(ref, period, NOW);
    const live = await reporting.getAnalytics(ref, period, NOW);
    const label = typeof period === "number" ? `${period} days` : `${period.from}..${period.to}`;
    assert.deepEqual({ ...SLIM_FIELDS(slim), sessionActivity: null }, { ...SLIM_FIELDS(live), sessionActivity: null }, label);
    for (const feature of ["wishlist", "notifyMe"]) {
      for (const key of ["current", "previous"]) {
        assert.equal(slim.sessionActivity[feature][key], live.sessionActivity[feature][key], `${label} ${feature}.${key}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 0);
  const day15 = await reporting.getAnalyticsOverview(ref, range("2026-10-15", "2026-10-15"), NOW);
  assert.equal(day15.sessionActivity.wishlist.current, await reporting.sessionCountOf(ref.id, "WISHLIST", new Date("2026-10-15T00:00:00Z"), new Date("2026-10-16T00:00:00Z")), "Oct 15: the sessions that started that day");
  const both = (await reporting.getAnalyticsOverview(ref, range("2026-10-14", "2026-10-15"), NOW)).sessionActivity.wishlist.current;
  assert.equal(both, (await reporting.getAnalytics(ref, range("2026-10-14", "2026-10-15"), NOW)).sessionActivity.wishlist.current);
});

test("lightweight loader: far fewer SQL statements than getAnalytics for the same screen (measured)", async () => {
  const shop = await seedBusyShop("slim-d", "2026-01-01T00:00:00Z");
  const notComparable = await seedBusyShop("slim-e", "2026-10-12T00:00:00Z");
  const measured = {};
  for (const [label, s] of [["comparable", shop], ["not comparable", notComparable]]) {
    const ref = await reporting.getShopByDomain(s.domain);
    capture = [];
    try {
      await reporting.getAnalytics(ref, 30, NOW);
      await reporting.getAttribution(s.id, 30, { scopeGranted: true, now: NOW });
      measured[label] = { before: capture.length };
      capture = [];
      await Promise.all([reporting.getAnalyticsOverview(ref, 30, NOW), reporting.getAttribution(s.id, 30, { scopeGranted: true, now: NOW })]);
      measured[label].after = capture.length;
    } finally {
      capture = null;
    }
  }
  console.log(`analytics statements per page (loader only), measured: ${JSON.stringify(measured)}`);
  for (const [label, { before, after }] of Object.entries(measured)) {
    assert.ok(before > 0 && after > 0, `${label}: statements were captured`);
    assert.ok(after * 2 <= before, `${label}: ${after} statements after vs ${before} before`);
  }
});

test("Analytics route loads through the cached getAnalyticsOverview and runs its two independent reads together; getDashboard is unchanged for the other pages", () => {
  const source = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");
  assert.match(source, /Promise\.all\(\[\s*getCachedAnalyticsOverview\(shop, period\),\s*getAttribution\(shop\.id, period,/); // the cache wraps getAnalyticsOverview (analytics-cache.server.js)
  assert.equal(source.includes("getAnalytics("), false, "the heavy loader is no longer used by this screen");
  for (const file of ["app/routes/app._index.jsx"]) assert.ok(fs.readFileSync(file, "utf8").includes("getDashboard(shop, period)"), `${file} still uses getDashboard`);
});
