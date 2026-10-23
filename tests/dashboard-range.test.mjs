// Tests for the custom date range (app/utils/period.js), how it reaches every report in
// app/models/reporting.server.js,.
//
// Run: node --test tests/dashboard-range.test.mjs
//
// Pure tests need nothing. The report tests use the real MySQL database from .env with uniquely named
// test shops that are deleted at the end (cascade). Dates are fixed (a fake "now"), so nothing depends on the clock.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const domains = [];
let reporting;
let P; // utils/period
let counter = 9600000000;

const NOW = new Date("2026-10-22T10:00:00.000Z");
const at = (iso) => new Date(iso);

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  reporting = await import("../app/models/reporting.server.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const makeShop = async (tag) => {
  const domain = `kw-range-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-01-01T00:00:00Z") } });
};
const makeActor = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const event = (shop, actor, type, occurredAt) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: "gid://shopify/Product/1", occurredAt: at(occurredAt) } });
const shopRef = (shop) => reporting.getShopByDomain(shop.domain);

// ======================= validation (pure) =======================
test("custom range: valid ranges include both end days, in UTC", () => {
  const { period } = P.customPeriod("2026-10-02", "2026-10-03", NOW);
  assert.deepEqual([period.kind, period.days, period.from, period.to], ["custom", 2, "2026-10-02", "2026-10-03"]);
  assert.equal(period.since.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(period.until.toISOString(), "2026-10-04T00:00:00.000Z", "the end is exclusive: the start of the day after the last day");
  assert.equal(P.customPeriod("2026-10-05", "2026-10-05", NOW).period.days, 1, "one day is a valid range");
});

test("custom range: bad input is refused with a reason", () => {
  const refused = (from, to) => P.customPeriod(from, to, NOW).error;
  assert.match(refused("2026-10-10", "2026-10-09"), /end date cannot be before the start date/i);
  assert.match(refused("", "2026-10-09"), /valid calendar days/);
  assert.match(refused("2026-02-30", "2026-03-01"), /valid calendar days/, "a day that does not exist");
  assert.match(refused("10/02/2026", "10/03/2026"), /valid calendar days/);
  assert.match(refused("2026-10-23", "2026-10-30"), /start date cannot be in the future/);
  assert.match(refused("1999-12-31", "2000-01-02"), /too far in the past/);
  assert.match(refused("2024-01-01", "2026-10-01"), /at most 366 days/);
  assert.equal(P.customPeriod("2025-10-22", "2026-10-22", NOW).period?.days, 366, "the limit itself is allowed");
});

test("custom range: an end date in the future is cut back to today, so nothing after now is included", () => {
  const { period } = P.customPeriod("2026-10-20", "2026-12-31", NOW);
  assert.deepEqual([period.to, period.days], ["2026-10-22", 3]);
  assert.equal(period.until.toISOString(), "2026-10-23T00:00:00.000Z");
});

test("URL parsing: presets, custom ranges, and a bad custom range falls back to the default with the reason", () => {
  assert.deepEqual(P.periodView(P.parsePeriod(new URLSearchParams("days=7"), NOW)), { kind: "preset", days: 7, from: null, to: null, error: null, requested: null });
  assert.equal(P.parsePeriod(new URLSearchParams("days=11"), NOW).days, 30);
  const custom = P.parsePeriod(new URLSearchParams("range=custom&from=2026-10-01&to=2026-10-05"), NOW);
  assert.deepEqual([custom.kind, custom.days, custom.from, custom.to, custom.error], ["custom", 5, "2026-10-01", "2026-10-05", undefined]);
  const bad = P.parsePeriod(new URLSearchParams("range=custom&from=2026-10-09&to=2026-10-01"), NOW);
  assert.deepEqual([bad.kind, bad.days], ["preset", 30]);
  assert.match(bad.error, /before the start date/);
  assert.deepEqual(bad.requested, { from: "2026-10-09", to: "2026-10-01" });
  assert.equal(P.parsePeriod(new URLSearchParams("range=custom"), NOW).kind, "preset");
  // a preset is "the last N days up to now", exactly as before
  const preset = P.presetPeriod(7, NOW);
  assert.equal(preset.since.toISOString(), "2026-10-16T00:00:00.000Z");
  assert.equal(preset.until, null);
  assert.equal(P.previousOf(P.customPeriod("2026-10-10", "2026-10-14", NOW).period).since.toISOString(), "2026-10-05T00:00:00.000Z", "the previous period has the same length");
});

test("the selected range is described the same way everywhere", () => {
  assert.equal(P.describePeriod(P.presetPeriod(30, NOW)).label, "Last 30 days");
  assert.equal(P.describePeriod(P.presetPeriod(30, NOW)).within, "in the last 30 days");
  assert.equal(P.describePeriod(P.customPeriod("2026-10-01", "2026-10-15", NOW).period).label, "Oct 1 – Oct 15, 2026 (UTC)");
  assert.equal(P.describePeriod(P.customPeriod("2026-10-05", "2026-10-05", NOW).period).label, "Oct 5, 2026 (UTC)");
  assert.equal(P.describePeriod(P.customPeriod("2025-12-30", "2026-01-02", NOW).period).label, "Dec 30, 2025 – Jan 2, 2026 (UTC)");
});

// ======================= the range reaches every report =======================
test("Dashboard: a custom range counts exactly its days (UTC edges inclusive/exclusive) and the chart shows only those days", async () => {
  const shop = await makeShop("dash");
  const a = await makeActor(shop);
  const b = await makeActor(shop);
  await event(shop, a, "WISHLIST_ADDED", "2026-10-01T23:59:59.999Z"); // day before: out
  await event(shop, a, "WISHLIST_ADDED", "2026-10-02T00:00:00.000Z"); // first instant: in
  await event(shop, b, "WISHLIST_ADDED", "2026-10-03T12:00:00.000Z"); // in
  await event(shop, b, "NOTIFY_SUBSCRIBED", "2026-10-03T23:59:59.999Z"); // last instant: in
  await event(shop, a, "RESTOCK_EMAIL_SENT", "2026-10-04T00:00:00.000Z"); // day after: out

  const { period } = P.customPeriod("2026-10-02", "2026-10-03", NOW);
  const d = await reporting.getDashboard(await shopRef(shop), period, NOW);
  assert.equal(d.activity.window.WISHLIST_ADDED, 2);
  assert.equal(d.activity.window.NOTIFY_SUBSCRIBED, 1);
  assert.equal(d.activity.window.RESTOCK_EMAIL_SENT, 0);
  assert.equal(d.wishlistUsers.current, 2);
  assert.deepEqual(d.series.days, ["2026-10-02", "2026-10-03"]);
  assert.deepEqual(d.series.values.WISHLIST_ADDED, [1, 1]);
  assert.deepEqual(d.series.values.NOTIFY_SUBSCRIBED, [0, 1]);
  assert.deepEqual(d.series.values.RESTOCK_EMAIL_SENT, [0, 0]);
  assert.deepEqual(d.period, { kind: "custom", days: 2, from: "2026-10-02", to: "2026-10-03" });
  assert.equal(d.activity.allTime.WISHLIST_ADDED, 3, "all-time totals do not depend on the range");
  assert.notEqual(d.activity.previous, null, "the previous period of the same length is compared");

  // the presets still behave as before
  const preset = await reporting.getDashboard(await shopRef(shop), 30, NOW);
  assert.equal(preset.activity.window.WISHLIST_ADDED, 3);
  assert.equal(preset.series.days.at(-1), "2026-10-22");
  assert.equal(preset.period.kind, "preset");
});

test("Notify Me, Wishlist log, email activity and customers use the same range", async () => {
  const shop = await makeShop("pages");
  const a = await makeActor(shop);
  await event(shop, a, "NOTIFY_SUBSCRIBED", "2026-10-02T08:00:00Z");
  await event(shop, a, "NOTIFY_SUBSCRIBED", "2026-10-09T08:00:00Z");
  await event(shop, a, "RESTOCK_EMAIL_SENT", "2026-10-03T08:00:00Z");
  await event(shop, a, "WISHLIST_ADDED", "2026-10-02T09:00:00Z");
  await event(shop, a, "WISHLIST_ADDED", "2026-10-10T09:00:00Z");
  const { period } = P.customPeriod("2026-10-02", "2026-10-03", NOW);
  const ref = await shopRef(shop);

  const notify = await reporting.getNotifyOverview(shop.id, period, NOW);
  assert.deepEqual([notify.window.subscribed, notify.window.emailsSent, notify.period.kind], [1, 1, "custom"]);

  const wishlist = await reporting.getWishlistOverview(shop.id, period, NOW);
  assert.equal(wishlist.window.added, 1);
  const log = await reporting.getWishlistActivity(shop.id, { days: period }, NOW);
  assert.equal(log.total, 1);

  const customers = await reporting.getCustomersReport(shop.id, { days: period, sort: "activity" }, NOW);
  assert.equal(customers.customers[0].recentActivity, 3, "the two Wishlist/Notify events and the email inside the range");
  assert.equal(customers.total, 1);

  const analytics = await reporting.getAnalytics(ref, period, NOW);
  assert.equal(analytics.topCustomers[0].activity, 3);

  // emails are filtered by the day they were queued
  const variantGid = "gid://shopify/ProductVariant/55";
  await prisma.variantAvailability.create({ data: { shopId: shop.id, variantGid, productGid: "gid://shopify/Product/1", inventoryItemGid: "gid://shopify/InventoryItem/55", isInStock: true, restockCycle: 1 } });
  const sub = await prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: a.id, productGid: "gid://shopify/Product/1", variantGid, email: "customer@example.invalid", baselineCycle: 0, consentedAt: at("2026-10-01T00:00:00Z"), consentSource: "test" } });
  for (const [cycle, createdAt] of [[1, "2026-10-02T12:00:00Z"], [2, "2026-10-04T00:00:00Z"]]) {
    await prisma.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: sub.id, restockCycle: cycle, variantGid, status: "SENT", createdAt: at(createdAt) } });
  }
  assert.equal((await reporting.getDeliveries(shop.id, { days: period }, NOW)).total, 1);
});

test("Attributed revenue: orders are dated by placement time inside the custom range, the end day is included", async () => {
  const shop = await makeShop("rev");
  const a = await makeActor(shop);
  const touch = await event(shop, a, "RESTOCK_EMAIL_SENT", "2026-10-01T00:00:00Z");
  let n = 0;
  const order = async (placedAt, amount) => {
    n += 1;
    const row = await prisma.shopifyOrder.create({
      data: { shopId: shop.id, orderGid: `gid://shopify/Order/${RUN}${n}`, orderName: `#${n}`, customerGid: a.customerGid, placedAt: at(placedAt), financialStatus: "PAID", currencyCode: "USD", totalPrice: amount, shopifyUpdatedAt: at(placedAt) },
    });
    await prisma.orderAttribution.create({
      data: { shopId: shop.id, orderId: row.id, feature: "NOTIFY_ME", touchEventId: touch.id, touchedAt: touch.occurredAt, matchedProductGid: "gid://shopify/Product/1", grossAmount: amount, currencyCode: "USD" },
    });
  };
  await order("2026-10-01T23:59:59Z", 10); // before the range
  await order("2026-10-03T00:00:00Z", 20); // first day, first instant
  await order("2026-10-04T23:59:59Z", 40); // last day, last second
  await order("2026-10-05T00:00:00Z", 80); // after
  const { period } = P.customPeriod("2026-10-03", "2026-10-04", NOW);
  const result = await reporting.getAttribution(shop.id, period, { scopeGranted: true, now: NOW });
  assert.equal(result.state, "ready");
  assert.deepEqual([result.notifyMe.orders, result.notifyMe.revenue, result.overall.revenue], [2, "60.00", "60.00"]);
  assert.equal(result.wishlist.orders, 0);
  const preset = await reporting.getAttribution(shop.id, 30, { scopeGranted: true, now: NOW });
  assert.equal(preset.notifyMe.orders, 4, "a preset still runs up to now");
});
