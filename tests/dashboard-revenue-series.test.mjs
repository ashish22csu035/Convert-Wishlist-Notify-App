// The Dashboard chart's daily revenue (reporting.dailyRevenue): the bars must add up to the revenue card (getAttribution).
//
// Run: node --test tests/dashboard-revenue-series.test.mjs   (WRITES to DATABASE_URL: scratch database only)
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const RUN = Date.now().toString(36);
const domains = [];
const at = (iso) => new Date(iso);
const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const NOW = at("2026-10-04T18:00:00Z");
let reporting;
let seq = 9900000000;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  reporting = await import("../app/models/reporting.server.js");
});
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const makeShop = async (tag) => {
  const domain = `kw-rev-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-09-01T00:00:00Z") } });
};
// One order with its credited lines: lines = [[feature, productNumber, gross, refunded?]]
async function order(shop, placed, lines, { currency = "USD", total = null } = {}) {
  const id = (seq += 1);
  const row = await prisma.shopifyOrder.create({
    data: { shopId: shop.id, orderGid: `gid://shopify/Order/${id}`, orderName: `#${id % 100000}`, placedAt: at(placed), financialStatus: "paid", currencyCode: currency, totalPrice: total ?? lines.reduce((sum, l) => sum + l[2], 0) + 9.99, shopifyUpdatedAt: at(placed) },
  });
  for (const [feature, product, gross, refunded = 0] of lines) {
    await prisma.orderAttribution.create({ data: { shopId: shop.id, orderId: row.id, feature, touchedAt: at(placed), matchedProductGid: `gid://shopify/Product/${product}`, grossAmount: gross, refundedAmount: refunded, currencyCode: currency } });
  }
  return row;
}

test("revenue is split by feature and UTC day, with the orders of each day counted once", async () => {
  const shop = await makeShop("split");
  await order(shop, "2026-10-01T10:00:00Z", [["WISHLIST", 1, 229], ["WISHLIST", 2, 229]]); // one order, two credited lines
  await order(shop, "2026-10-03T23:59:59Z", [["NOTIFY_ME", 3, 50]]);
  await order(shop, "2026-10-03T00:00:00Z", [["WISHLIST", 4, 100], ["NOTIFY_ME", 5, 20]]);
  const series = await reporting.dailyRevenue(shop.id, DAYS);
  assert.deepEqual(series.days, DAYS);
  assert.deepEqual(series.wishlist, [458, 0, 100, 0]);
  assert.deepEqual(series.notifyMe, [0, 0, 70, 0]);
  assert.deepEqual(series.orders, [1, 0, 2, 0], "an order with two credited lines is one order");
  assert.deepEqual([series.total, series.ordersTotal, series.currency, series.mixedCurrency], [628, 3, "USD", false]);
});

test("refunds are netted and the bars add up to the revenue card (getAttribution)", async () => {
  const shop = await makeShop("card");
  await order(shop, "2026-10-02T09:00:00Z", [["WISHLIST", 1, 200, 50], ["NOTIFY_ME", 2, 80]]);
  await order(shop, "2026-10-04T09:00:00Z", [["WISHLIST", 3, 300]]);
  const series = await reporting.dailyRevenue(shop.id, DAYS);
  assert.equal(series.total, 530);
  const card = await reporting.getAttribution(shop.id, { since: at("2026-10-01T00:00:00Z"), until: at("2026-10-05T00:00:00Z") }, { scopeGranted: true, now: NOW });
  assert.equal(card.overall.revenue, "530.00");
  assert.equal(String(series.total.toFixed(2)), card.overall.revenue, "the chart and the card show the same revenue");
  assert.equal(series.ordersTotal, card.overall.orders);
});

test("orders outside the shown days and other shops' orders never reach the chart; cancelled attributions are left out", async () => {
  const mine = await makeShop("mine");
  const other = await makeShop("other");
  await order(mine, "2026-09-30T23:59:59Z", [["WISHLIST", 1, 999]]); // the day before
  await order(mine, "2026-10-05T00:00:00Z", [["WISHLIST", 2, 999]]); // the day after
  await order(other, "2026-10-02T10:00:00Z", [["WISHLIST", 3, 500]]);
  const kept = await order(mine, "2026-10-02T10:00:00Z", [["WISHLIST", 4, 40]]);
  const dropped = await order(mine, "2026-10-02T11:00:00Z", [["WISHLIST", 5, 60]]);
  await prisma.orderAttribution.updateMany({ where: { orderId: dropped.id }, data: { status: "REVERSED" } });
  const series = await reporting.dailyRevenue(mine.id, DAYS);
  assert.deepEqual(series.wishlist, [0, 40, 0, 0]);
  assert.equal(kept.id > 0, true);
  assert.equal(series.ordersTotal, 1);
});

test("mixed currencies are reported as unavailable, never added; no orders and no days are a clean zero", async () => {
  const shop = await makeShop("mixed");
  await order(shop, "2026-10-02T10:00:00Z", [["WISHLIST", 1, 40]], { currency: "USD" });
  await order(shop, "2026-10-03T10:00:00Z", [["WISHLIST", 2, 40]], { currency: "EUR" });
  const mixed = await reporting.dailyRevenue(shop.id, DAYS);
  assert.equal(mixed.mixedCurrency, true);
  assert.equal(mixed.total, 0);
  const empty = await makeShop("empty");
  const none = await reporting.dailyRevenue(empty.id, DAYS);
  assert.deepEqual([none.total, none.ordersTotal, none.wishlist, none.notifyMe, none.mixedCurrency], [0, 0, [0, 0, 0, 0], [0, 0, 0, 0], false]);
  assert.deepEqual((await reporting.dailyRevenue(empty.id, [])).days, []);
});

test("asking again returns the same figures: nothing is accumulated between calls", async () => {
  const shop = await makeShop("again");
  await order(shop, "2026-10-02T10:00:00Z", [["WISHLIST", 1, 40]]);
  const first = await reporting.dailyRevenue(shop.id, DAYS);
  const second = await reporting.dailyRevenue(shop.id, DAYS);
  assert.deepEqual(second, first);
});
