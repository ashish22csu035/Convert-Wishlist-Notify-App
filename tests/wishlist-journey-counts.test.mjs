// Regression tests for the Wishlist journey counts: two products added to the cart together, ONE checkout, ONE order.
// Each number has one unit, and these tests pin it:
//   Products saved      WISHLIST_ADDED events, all time        (a save is counted, not a distinct product)
//   Added to cart       WISHLIST_ADDED_TO_CART events          (one per product added: two products = +2)
//   Checkout initiated  distinct checkouts                     (CheckoutAttribution is UNIQUE per shop + checkout + feature)
//   Attributed orders   distinct Shopify orders                (OrderAttribution holds one row per product, orders are de-duplicated)
//   Attributed revenue  net value of the credited lines only   (the order total, with shipping and other lines, is kept apart)
//
// Run: node --test tests/wishlist-journey-counts.test.mjs
// WRITES to the database in DATABASE_URL: run it on a scratch database only.
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
const NOW = at("2026-11-10T18:00:00Z");
const DAY = "2026-11-10";
let seq = 9700000000;
let checkoutHook;
let orderHook;
let analyticsWorker;
let reporting;
let period;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  ({ handleCheckoutWebhook: checkoutHook } = await import("../app/models/checkout-webhook.server.js"));
  ({ handleOrderWebhook: orderHook } = await import("../app/models/order-webhook.server.js"));
  analyticsWorker = await import("../app/worker/analytics-daily.server.js");
  reporting = await import("../app/models/reporting.server.js");
  period = (await import("../app/utils/period.js")).customPeriod(DAY, DAY, NOW).period;
});

after(async () => {
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: { in: domains } } });
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

// ---- fixtures ----
const gid = (type, n) => `gid://shopify/${type}/${n}`;
const makeShop = async (tag) => {
  const domain = `kw-journey-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-11-01T00:00:00Z") } });
};
const makeCustomer = async (shop) => {
  const number = (seq += 1);
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: gid("Customer", number) } });
  return { actor, number };
};
const event = (shop, actor, type, iso, product, variant) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type, feature: "WISHLIST", productGid: gid("Product", product), variantGid: gid("ProductVariant", variant), occurredAt: at(iso) } });

// Two products saved, opened on My Wishlist, selected and added to the cart together: 2 saves, 2 cart additions.
async function saveAndAddToCart(shop, actor, products, { saved = "2026-11-10T09:00:00Z", carted = "2026-11-10T09:59:57Z" } = {}) {
  for (const [product, variant] of products) await event(shop, actor, "WISHLIST_ADDED", saved, product, variant);
  for (const [product, variant] of products) await event(shop, actor, "WISHLIST_ADDED_TO_CART", carted, product, variant);
}

let checkoutSeq = 0;
const checkoutBody = (number, products, { token = `tok-${RUN}-${(checkoutSeq += 1)}`, created = "2026-11-10T10:00:00Z" } = {}) => ({
  id: 500000 + checkoutSeq,
  token,
  created_at: created,
  customer: { id: number },
  email: "never.stored@example.invalid",
  line_items: products.map(([product, variant]) => ({ product_id: product, variant_id: variant, quantity: 1 })),
});
const sendCheckout = (shop, body, { topic = "checkouts/create", delivery = `d-${RUN}-${(seq += 1)}` } = {}) =>
  checkoutHook({ shopDomain: shop.domain, topic, webhookId: delivery, eventId: delivery, triggeredAt: "2026-11-10T10:00:10Z", payload: body });

let lineSeq = 0;
const line = (product, variant, price) => ({
  id: (lineSeq += 1) + 7000,
  admin_graphql_api_id: gid("LineItem", lineSeq + 7000),
  product_id: product,
  variant_id: variant,
  quantity: 1,
  price_set: { shop_money: { amount: price, currency_code: "USD" } },
  total_discount_set: { shop_money: { amount: "0.00", currency_code: "USD" } },
});
const orderBody = (number, lines, { id = (seq += 1), placed = "2026-11-10T10:05:00Z", shipping = 9.99 } = {}) => ({
  id,
  admin_graphql_api_id: gid("Order", id),
  name: `#${id % 100000}`,
  created_at: placed,
  updated_at: placed,
  cancelled_at: null,
  financial_status: "paid",
  currency: "USD",
  total_price_set: { shop_money: { amount: (lines.reduce((sum, l) => sum + Number(l.price_set.shop_money.amount), 0) + shipping).toFixed(2), currency_code: "USD" } },
  customer: { id: number, email: "never.stored@example.invalid" },
  line_items: lines,
  refunds: [],
});
const sendOrder = (shop, body, delivery = `o-${RUN}-${(seq += 1)}`) =>
  orderHook({ shopDomain: shop.domain, topic: "orders/paid", webhookId: delivery, triggeredAt: "2026-11-10T10:05:05Z", payload: body });

// each run is a little later than the last (a summary row only replaces an older one, like the real worker every 10 minutes)
let tick = 0;
const refresh = (shop) => analyticsWorker.runAnalyticsDaily({ now: () => new Date(NOW.getTime() + (tick += 1000)), shopIds: [shop.id], backfillPerShop: 400, log: { log() {}, error() {} }, invalidate: async () => {} });
const funnel = async (shop) => {
  const summary = await reporting.getFunnelSummary(await reporting.getShopByDomain(shop.domain), period, NOW);
  return { saved: summary.allTime.wishlistSaved, carted: summary.range.wishlistAddedToCart, checkouts: summary.range.wishlistCheckouts };
};
const orders = async (shop) => {
  const report = await reporting.getAttribution(shop.id, period, { scopeGranted: true, now: NOW });
  return { orders: report.wishlist.orders, revenue: report.wishlist.revenue, orderValue: report.wishlist.orderValue, overall: report.overall.orders };
};
const checkoutRows = (shop) => prisma.checkoutAttribution.findMany({ where: { shopId: shop.id } });

// ---------------------------------------------------------------------------------------------------------------------
test("the manual test: two products saved, added together, ONE checkout, ONE order: saves +2, cart +2, checkout +1, orders +1, revenue +458", async () => {
  const shop = await makeShop("manual");
  const { actor, number } = await makeCustomer(shop);
  // an earlier journey (the numbers shown before the test)
  await saveAndAddToCart(shop, actor, [[1, 11]], { saved: "2026-11-10T07:00:00Z", carted: "2026-11-10T07:30:00Z" });
  await sendCheckout(shop, checkoutBody(number, [[1, 11]], { created: "2026-11-10T07:31:00Z" }));
  await sendOrder(shop, orderBody(number, [line(1, 11, "100.00")], { placed: "2026-11-10T07:40:00Z" }));
  await refresh(shop);
  assert.deepEqual(await funnel(shop), { saved: 1, carted: 1, checkouts: 1 });
  assert.deepEqual(await orders(shop), { orders: 1, revenue: "100.00", orderValue: "109.99", overall: 1 });

  // the test: two products together
  await saveAndAddToCart(shop, actor, [[2, 22], [3, 33]]);
  const body = checkoutBody(number, [[2, 22], [3, 33]]);
  assert.equal((await sendCheckout(shop, body)).outcome, "processed");
  await sendOrder(shop, orderBody(number, [line(2, 22, "200.00"), line(3, 33, "258.00")]));
  await refresh(shop);

  assert.deepEqual(await funnel(shop), { saved: 3, carted: 3, checkouts: 2 }, "+2 saves, +2 cart additions, +1 checkout");
  const after = await orders(shop);
  assert.equal(after.orders, 2, "one more order, not two");
  assert.equal(after.revenue, "558.00", "100 + (200 + 258): the credited lines, once each");
  assert.equal(after.orderValue, "577.98", "the full order totals (109.99 + 467.99, shipping included) stay separate from revenue");
  assert.equal((await checkoutRows(shop)).filter((row) => row.checkoutKey === body.token).length, 1, "one row for the two-product checkout");
});

test("one checkout holding several eligible products of the same source is ONE checkout row", async () => {
  const shop = await makeShop("rows");
  const { actor, number } = await makeCustomer(shop);
  const products = [[1, 11], [2, 22], [3, 33]];
  await saveAndAddToCart(shop, actor, products);
  assert.equal((await sendCheckout(shop, checkoutBody(number, products))).outcome, "processed");
  const rows = await checkoutRows(shop);
  assert.deepEqual(rows.map((row) => row.feature), ["WISHLIST"]);
  await refresh(shop);
  assert.equal((await funnel(shop)).checkouts, 1);
});

test("one order with several eligible lines is one order, revenue is the sum of the credited lines, the order total is kept separately", async () => {
  const shop = await makeShop("order");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22], [3, 33]]);
  const body = orderBody(number, [line(2, 22, "200.00"), line(3, 33, "258.00")]);
  await sendOrder(shop, body);
  const stored = await prisma.shopifyOrder.findUnique({ where: { shopId_orderGid: { shopId: shop.id, orderGid: gid("Order", body.id) } }, include: { attributions: true } });
  assert.equal(stored.attributions.length, 2, "an attribution row per product");
  assert.equal(Number(stored.totalPrice), 467.99, "the whole order, shipping included, is stored as is");
  assert.deepEqual(await orders(shop), { orders: 1, revenue: "458.00", orderValue: "467.99", overall: 1 });
});

test("a duplicate checkout delivery, a repeated create and a later update never add a second checkout", async () => {
  const shop = await makeShop("dup-checkout");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22], [3, 33]]);
  const body = checkoutBody(number, [[2, 22], [3, 33]]);
  await sendCheckout(shop, body, { delivery: `same-${RUN}` });
  await sendCheckout(shop, body, { delivery: `same-${RUN}` }); // the same webhook again
  await sendCheckout(shop, body, { delivery: `other-${RUN}` }); // a new delivery of the same checkout
  await sendCheckout(shop, body, { topic: "checkouts/update" });
  await sendCheckout(shop, body, { topic: "checkouts/update" });
  assert.equal((await checkoutRows(shop)).length, 1);
  await refresh(shop);
  assert.equal((await funnel(shop)).checkouts, 1);
});

test("a duplicate order delivery, and the same order under a new delivery id, change nothing", async () => {
  const shop = await makeShop("dup-order");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22], [3, 33]]);
  const body = orderBody(number, [line(2, 22, "200.00"), line(3, 33, "258.00")]);
  await sendOrder(shop, body, `same-o-${RUN}`);
  await sendOrder(shop, body, `same-o-${RUN}`);
  await sendOrder(shop, body, `new-o-${RUN}`);
  assert.equal(await prisma.shopifyOrder.count({ where: { shopId: shop.id } }), 1);
  assert.equal(await prisma.orderAttribution.count({ where: { shopId: shop.id } }), 2);
  assert.deepEqual(await orders(shop), { orders: 1, revenue: "458.00", orderValue: "467.99", overall: 1 });
});

test("a checkout followed by its order counts as one checkout and one order, never two checkouts", async () => {
  const shop = await makeShop("sequence");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22], [3, 33]]);
  await sendCheckout(shop, checkoutBody(number, [[2, 22], [3, 33]]));
  await sendOrder(shop, orderBody(number, [line(2, 22, "200.00"), line(3, 33, "258.00")]));
  await refresh(shop);
  assert.equal((await funnel(shop)).checkouts, 1, "the order is not a second checkout initiation");
  assert.equal((await orders(shop)).orders, 1);
  assert.equal(await prisma.webhookEvent.count({ where: { shopId: shop.id, topic: "CHECKOUTS_CREATE" } }), 1);
});

test("distinct checkouts each count, even when they hold the same products", async () => {
  const shop = await makeShop("distinct");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22], [3, 33]]);
  await sendCheckout(shop, checkoutBody(number, [[2, 22], [3, 33]], { created: "2026-11-10T10:00:00Z" }));
  await sendCheckout(shop, checkoutBody(number, [[2, 22], [3, 33]], { created: "2026-11-10T10:30:00Z" }));
  await sendCheckout(shop, checkoutBody(number, [[2, 22]], { created: "2026-11-10T11:00:00Z" }));
  assert.equal((await checkoutRows(shop)).length, 3);
  await refresh(shop);
  assert.equal((await funnel(shop)).checkouts, 3);
});

test("eligible and ineligible lines: only the eligible ones are credited; the whole order total is kept", async () => {
  const shop = await makeShop("mixed");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22]]); // product 9 was never on the wishlist
  const body = orderBody(number, [line(2, 22, "200.00"), line(9, 99, "75.00")]);
  await sendOrder(shop, body);
  await sendCheckout(shop, checkoutBody(number, [[2, 22], [9, 99]]));
  assert.deepEqual(await orders(shop), { orders: 1, revenue: "200.00", orderValue: "284.99", overall: 1 });
  assert.equal(await prisma.orderAttribution.count({ where: { shopId: shop.id } }), 1);
  assert.equal((await checkoutRows(shop)).length, 1, "the checkout still counts once");
});

test("repeated analytics aggregation never inflates a count", async () => {
  const shop = await makeShop("repeat");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22], [3, 33]]);
  await sendCheckout(shop, checkoutBody(number, [[2, 22], [3, 33]]));
  await sendOrder(shop, orderBody(number, [line(2, 22, "200.00"), line(3, 33, "258.00")]));
  const results = [];
  for (let run = 0; run < 3; run += 1) {
    await refresh(shop);
    results.push([await funnel(shop), await orders(shop)]);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.deepEqual(results[0][0], { saved: 2, carted: 2, checkouts: 1 });
  assert.equal(await prisma.analyticsDaily.count({ where: { shopId: shop.id, day: at(`${DAY}T00:00:00Z`) } }), 1, "one summary row per shop and day");
});

test("Notify Me checkouts and orders stay out of the Wishlist numbers, and the shared logic keeps both features separate", async () => {
  const shop = await makeShop("both");
  const { actor, number } = await makeCustomer(shop);
  await saveAndAddToCart(shop, actor, [[2, 22]]);
  await prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type: "RESTOCK_EMAIL_SENT", feature: "NOTIFY_ME", productGid: gid("Product", 4), variantGid: gid("ProductVariant", 44), occurredAt: at("2026-11-10T09:00:00Z") } });
  await sendCheckout(shop, checkoutBody(number, [[2, 22], [4, 44]]));
  await sendOrder(shop, orderBody(number, [line(2, 22, "200.00"), line(4, 44, "50.00")]));
  await refresh(shop);
  const rows = await checkoutRows(shop);
  assert.deepEqual(rows.map((row) => row.feature).sort(), ["NOTIFY_ME", "WISHLIST"]);
  assert.equal((await funnel(shop)).checkouts, 1, "Wishlist tab: one checkout");
  const report = await reporting.getAttribution(shop.id, period, { scopeGranted: true, now: NOW });
  assert.deepEqual([report.wishlist.orders, report.wishlist.revenue, report.notifyMe.orders, report.notifyMe.revenue, report.overall.orders], [1, "200.00", 1, "50.00", 1], "Overall counts the order once");
});
