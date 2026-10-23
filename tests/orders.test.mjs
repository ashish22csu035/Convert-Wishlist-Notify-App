// Tests for order collection and purchase attribution:
//   app/models/order-webhook.server.js, order-attribution.server.js, reporting.server.js (getAttribution)
//   and the verified webhook routes /webhooks/orders/paid and /webhooks/orders/updated.
//
// Run from the project root after `npm run build`:
//   node --test tests/orders.test.mjs
//
// Uses the REAL MySQL database from .env and a real app server for the HTTP tests (real HMAC
// verification with a dummy secret). Shopify itself is not contacted and no mail is sent. Every row
// belongs to uniquely named test shops that are deleted at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const PORT = 3201; // unique per test file: the files run in parallel (3195-3199 are taken)
const BASE = `http://localhost:${PORT}`;
const SECRET = "dummy-secret-for-tests-only";
const RUN = Date.now().toString(36);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const domains = [];
let seq = 9600000000;
let handle;
let attribution;
let reporting;
let format;
let appPrisma;
let server;
let serverOutput = "";

// ---- fixtures ------------------------------------------------------------------------------------
async function makeShop(tag) {
  const domain = `kw-ord-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
}
async function makeCustomer(shop) {
  const customerNumber = (seq += 1);
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${customerNumber}` } });
  return { actor, customerNumber };
}
const gid = (type, n) => `gid://shopify/${type}/${n}`;
let touchSeq = 0;
// An interaction recorded for a customer, `ago` ms before `at`.
function touch(shop, actor, type, { at, ago, product, variant = null }) {
  touchSeq += 1;
  return prisma.activityEvent.create({
    data: {
      shopId: shop.id,
      actorId: actor.id,
      type,
      feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME",
      productGid: gid("Product", product),
      variantGid: variant ? gid("ProductVariant", variant) : null,
      occurredAt: new Date(at.getTime() - ago + touchSeq), // a millisecond apart so the order is certain
    },
  });
}
const line = (n, { product, variant, qty = 1, price = "50.00", discount = "0.00" }) => ({
  id: n,
  admin_graphql_api_id: gid("LineItem", n),
  product_id: product,
  variant_id: variant,
  quantity: qty,
  price_set: { shop_money: { amount: price, currency_code: "USD" } },
  total_discount_set: { shop_money: { amount: discount, currency_code: "USD" } },
});
function orderPayload({ id = (seq += 1), customerNumber, at, updatedAt = at, status = "paid", lines, refunds = [], cancelledAt = null, total }) {
  const lineTotal = lines.reduce((sum, l) => sum + Number(l.price_set.shop_money.amount) * l.quantity, 0);
  return {
    id,
    admin_graphql_api_id: gid("Order", id),
    name: `#${id % 100000}`,
    created_at: at.toISOString(),
    updated_at: updatedAt.toISOString(),
    cancelled_at: cancelledAt ? cancelledAt.toISOString() : null,
    financial_status: status,
    currency: "USD",
    total_price_set: { shop_money: { amount: total ?? (lineTotal + 9.99).toFixed(2), currency_code: "USD" } }, // + shipping: the whole order is more than the items
    customer: customerNumber ? { id: customerNumber, email: "never.stored@example.invalid" } : null,
    line_items: lines,
    refunds,
  };
}
const refundOf = (lineId, amount) => ({ id: (seq += 1), refund_line_items: [{ line_item_id: lineId, quantity: 1, subtotal_set: { shop_money: { amount, currency_code: "USD" } } }], transactions: [] });

const deliver = (shop, payload, over = {}) =>
  handle({ shopDomain: shop.domain, topic: over.topic ?? "orders/paid", webhookId: over.webhookId ?? `wh-${(seq += 1)}`, eventId: over.eventId, triggeredAt: new Date().toISOString(), payload });
const orderRow = async (shop, id) => {
  const row = await prisma.shopifyOrder.findUnique({
    where: { shopId_orderGid: { shopId: shop.id, orderGid: gid("Order", id) } },
    include: { lineItems: true, attributions: true },
  });
  return row ? { ...row, attribution: row.attributions[0] ?? null } : null;
};
const money = (value) => Number(value).toFixed(2);


// The server's console output reaches the test through a pipe, which can lag when the machine is busy
// (the full suite runs many files at once). Wait until the expected lines are there instead of guessing a delay.
async function waitForOutput(...patterns) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (patterns.every((pattern) => pattern.test(serverOutput))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function signedRequest(path, body, { shop, secret = SECRET, topic = "orders/paid", webhookId = `wh-${(seq += 1)}`, hmac } = {}) {
  const raw = JSON.stringify(body);
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac ?? crypto.createHmac("sha256", secret).update(raw).digest("base64"),
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2027-01",
      "X-Shopify-Webhook-Id": webhookId,
      "X-Shopify-Triggered-At": new Date().toISOString(),
    },
    body: raw,
  });
}

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.SHOPIFY_APP_URL = BASE;
  process.env.SCOPES = "write_products";
  ({ handleOrderWebhook: handle } = await import("../app/models/order-webhook.server.js"));
  attribution = await import("../app/models/order-attribution.server.js");
  reporting = await import("../app/models/reporting.server.js");
  format = await import("../app/utils/format.js");
  appPrisma = (await import("../app/db.server.js")).default;

  server = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => (serverOutput += c));
  server.stderr.on("data", (c) => (serverOutput += c));
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server did not start:\n${serverOutput}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

after(async () => {
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: { in: domains } } });
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  const left = await prisma.shop.count({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
  server?.kill();
  assert.equal(left, 0, "test shops were removed");
});

// ======================= verified ingestion =======================
test("HTTP: a correctly signed paid order is stored with its line items and attributed; a bad signature stores nothing", async () => {
  const shop = await makeShop("http");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 2 * DAY, product: 11, variant: 111 });
  const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 11, variant: 111, qty: 2, price: "30.00", discount: "10.00" }), line(2, { product: 22, variant: 222 })] });

  const forged = await signedRequest("/webhooks/orders/paid", payload, { shop: shop.domain, secret: "not-the-secret" });
  assert.equal(forged.status, 401);
  assert.equal((await signedRequest("/webhooks/orders/paid", payload, { shop: shop.domain, hmac: "AAAA" })).status, 401);
  assert.equal(await prisma.shopifyOrder.count({ where: { shopId: shop.id } }), 0, "nothing is stored for an unverified body");

  assert.equal((await signedRequest("/webhooks/orders/paid", payload, { shop: shop.domain })).status, 200);
  const row = await orderRow(shop, payload.id);
  assert.deepEqual([row.financialStatus, row.currencyCode, money(row.totalPrice), row.customerGid], ["PAID", "USD", "119.99", gid("Customer", customerNumber)]);
  assert.deepEqual(row.lineItems.map((l) => [l.productGid, l.variantGid, l.quantity, money(l.lineTotal)]).sort(), [[gid("Product", 11), gid("ProductVariant", 111), 2, "50.00"], [gid("Product", 22), gid("ProductVariant", 222), 1, "50.00"]].sort());
  assert.deepEqual([row.attribution.feature, row.attribution.status, money(row.attribution.grossAmount)], ["WISHLIST", "ACTIVE", "50.00"], "only the saved product's discounted line is credited");
  assert.equal(JSON.stringify(row).includes("never.stored"), false, "the customer's email is never stored");

  assert.equal((await signedRequest("/webhooks/orders/updated", { ...payload, financial_status: "paid" }, { shop: shop.domain, topic: "orders/updated" })).status, 200);
  await waitForOutput(/\[orders\] webhook rejected before processing/, new RegExp(`\\[orders\\] webhook handled .*"shop":"${shop.domain}"`));
  assert.match(serverOutput, /\[orders\] webhook rejected before processing {"status":401}/);
  assert.match(serverOutput, new RegExp(`\\[orders\\] webhook handled .*"shop":"${shop.domain}".*"outcome":"processed","status":200`));
  assert.equal(serverOutput.includes(SECRET) || serverOutput.includes("never.stored"), false, "no secret or customer data is logged");
});

test("a duplicate delivery changes nothing, and a replayed order under a new delivery id still gives one order and one attribution", async () => {
  const shop = await makeShop("dup");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 11 });
  const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 11, variant: 111 })] });

  assert.equal((await deliver(shop, payload, { eventId: "ev-1" })).outcome, "processed");
  assert.equal((await deliver(shop, payload, { eventId: "ev-1", webhookId: "other" })).outcome, "duplicate");
  assert.equal((await deliver(shop, payload, { eventId: "ev-2", topic: "orders/updated" })).outcome, "processed"); // a different delivery of the same order
  assert.equal(await prisma.shopifyOrder.count({ where: { shopId: shop.id } }), 1);
  assert.equal(await prisma.shopifyOrderLineItem.count({ where: { shopId: shop.id } }), 1);
  assert.equal(await prisma.orderAttribution.count({ where: { shopId: shop.id } }), 1);
  const report = await reporting.getAttribution(shop.id, 30, { scopeGranted: true });
  assert.deepEqual([report.overall.orders, report.overall.revenue], [1, "50.00"]);
});

test("CONCURRENT deliveries of one order (real MySQL) create one order, one set of line items and one attribution", async () => {
  const shop = await makeShop("race");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 11 });
  const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 11, variant: 111 }), line(2, { product: 12, variant: 121 })] });
  const results = await Promise.all([1, 2, 3, 4].map((n) => deliver(shop, payload, { eventId: `race-${n}` })));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal(await prisma.shopifyOrder.count({ where: { shopId: shop.id } }), 1);
  assert.equal(await prisma.shopifyOrderLineItem.count({ where: { shopId: shop.id } }), 2);
  assert.equal(await prisma.orderAttribution.count({ where: { shopId: shop.id } }), 1);
});

test("a webhook is ignored (and stores nothing) for an unknown shop, a bad topic or an unusable payload", async () => {
  const shop = await makeShop("ignored");
  const at = new Date(Date.now() - HOUR);
  const good = orderPayload({ customerNumber: 1, at, lines: [line(1, { product: 11, variant: 111 })] });
  assert.equal((await handle({ shopDomain: `kw-ord-nobody-${RUN}.myshopify.com`, topic: "orders/paid", webhookId: "x1", payload: good })).outcome, "ignored_shop");
  assert.equal((await deliver(shop, good, { topic: "orders/delete" })).outcome, "ignored_invalid");
  assert.equal((await deliver(shop, { ...good, created_at: "not a date" })).outcome, "ignored_invalid");
  assert.equal((await deliver(shop, { ...good, currency: "dollars", total_price_set: undefined })).outcome, "ignored_invalid");
  assert.equal((await deliver(shop, { ...good, total_price_set: { shop_money: { amount: "abc", currency_code: "USD" } } })).outcome, "ignored_invalid");
  assert.equal(await prisma.shopifyOrder.count({ where: { shopId: shop.id } }), 0);
});

// ======================= isolation =======================
test("two shops never see each other's orders or revenue, even for the same order number and customer id", async () => {
  const a = await makeShop("iso-a");
  const b = await makeShop("iso-b");
  const customerNumber = (seq += 1);
  for (const shop of [a, b]) await prisma.actor.create({ data: { shopId: shop.id, customerGid: gid("Customer", customerNumber) } });
  const actorA = await prisma.actor.findFirst({ where: { shopId: a.id } });
  const at = new Date(Date.now() - HOUR);
  await touch(a, actorA, "WISHLIST_ADDED", { at, ago: DAY, product: 11 });
  const orderId = (seq += 1);
  await deliver(a, orderPayload({ id: orderId, customerNumber, at, lines: [line(1, { product: 11, variant: 111, price: "80.00" })] }));

  const reportA = await reporting.getAttribution(a.id, 30, { scopeGranted: true });
  const reportB = await reporting.getAttribution(b.id, 30, { scopeGranted: true });
  assert.deepEqual([reportA.state, reportA.overall.orders, reportA.overall.revenue], ["ready", 1, "80.00"]);
  assert.equal(reportB.state, "waiting", "the other shop has collected no orders: no figure, not a zero");

  // The same order id arriving for shop B is its own row, and shop B's customer never touched anything.
  await deliver(b, orderPayload({ id: orderId, customerNumber, at, lines: [line(1, { product: 11, variant: 111, price: "80.00" })] }));
  assert.equal(await prisma.shopifyOrder.count({ where: { orderGid: gid("Order", orderId) } }), 2);
  assert.equal((await orderRow(b, orderId)).attribution, null, "B has no interaction of its own, and A's interaction is not borrowed");
  assert.equal((await reporting.getAttribution(a.id, 30, { scopeGranted: true })).overall.revenue, "80.00");
  assert.deepEqual((await reporting.getAttribution(b.id, 30, { scopeGranted: true })).overall, { orders: 0, revenue: "0.00", orderValue: "0.00" });
});

// ======================= attribution rules =======================
test("Wishlist last touch: the most recent Wishlist interaction within seven days attributes the order", async () => {
  const shop = await makeShop("wl");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  const old = await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 5 * DAY, product: 11, variant: 111 });
  const recent = await touch(shop, actor, "WISHLIST_PRODUCT_CLICKED", { at, ago: 2 * HOUR, product: 11, variant: 111 });
  const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 11, variant: 112 })] }); // another variant of the saved product
  await deliver(shop, payload);
  const row = await orderRow(shop, payload.id);
  assert.equal(row.attribution.feature, "WISHLIST");
  assert.equal(row.attribution.touchEventId, recent.id, "the latest touch, not the older save");
  assert.notEqual(row.attribution.touchEventId, old.id);
  assert.equal(row.attribution.matchedProductGid, gid("Product", 11), "Wishlist matching is product based: any variant qualifies");
});

test("Notify Me is attributed only after a SENT restock email, for the variant that was emailed", async () => {
  const shop = await makeShop("nm");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  // Subscribing, a queued email and a failed email are not touches: only the sent-email event is.
  await touch(shop, actor, "NOTIFY_SUBSCRIBED", { at, ago: 2 * DAY, product: 33, variant: 333 });
  const sub = await prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: gid("Product", 33), variantGid: gid("ProductVariant", 333), email: "x@example.invalid", consentedAt: new Date(), consentSource: "test" } });
  await prisma.emailDelivery.createMany({ data: [{ shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid: gid("ProductVariant", 333), status: "PENDING", nextAttemptAt: at }, { shopId: shop.id, subscriptionId: sub.id, restockCycle: 2, variantGid: gid("ProductVariant", 333), status: "FAILED" }] });

  const first = orderPayload({ customerNumber, at, lines: [line(1, { product: 33, variant: 333 })] });
  await deliver(shop, first);
  assert.equal((await orderRow(shop, first.id)).attribution, null, "subscribed / queued / failed: not attributed");

  const sent = await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: DAY, product: 33, variant: 333 });
  const second = orderPayload({ customerNumber, at, lines: [line(1, { product: 33, variant: 333 })] });
  await deliver(shop, second);
  const row = await orderRow(shop, second.id);
  assert.deepEqual([row.attribution.feature, row.attribution.touchEventId], ["NOTIFY_ME", sent.id]);

  const otherVariant = orderPayload({ customerNumber, at, lines: [line(1, { product: 33, variant: 334 })] });
  await deliver(shop, otherVariant);
  assert.equal((await orderRow(shop, otherVariant.id)).attribution, null, "a different variant than the one emailed does not match");
});

test("Wishlist saves and successful Notify Me emails remain eligible after eight days", async () => {
  const shop = await makeShop("lifetime");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 8 * DAY, product: 41, variant: 410 });
  await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: 8 * DAY, product: 42, variant: 420 });

  const wishlistOrder = orderPayload({ customerNumber, at, lines: [line(1, { product: 41, variant: 411 })] });
  const notifyOrder = orderPayload({ customerNumber, at, lines: [line(1, { product: 42, variant: 420 })] });
  await deliver(shop, wishlistOrder);
  await deliver(shop, notifyOrder);

  assert.equal((await orderRow(shop, wishlistOrder.id)).attribution.feature, "WISHLIST");
  assert.equal((await orderRow(shop, notifyOrder.id)).attribution.feature, "NOTIFY_ME");
});

test("a webhook delivered after a post-placement touch does not attribute that later touch", async () => {
  const shop = await makeShop("late-touch");
  const { actor, customerNumber } = await makeCustomer(shop);
  const placedAt = new Date(Date.now() - 10 * DAY);
  const afterPlacement = await touch(shop, actor, "RESTOCK_EMAIL_SENT", {
    at: placedAt,
    ago: -DAY,
    product: 421,
    variant: 4210,
  });
  const payload = orderPayload({
    customerNumber,
    at: placedAt,
    lines: [line(1, { product: 421, variant: 4210 })],
  });

  assert.ok(afterPlacement.occurredAt > placedAt);
  assert.equal((await deliver(shop, payload)).outcome, "processed");
  assert.equal((await orderRow(shop, payload.id)).attribution, null);
});

test("Wishlist cart attribution is seven days, inclusive at the UTC boundary, and a later cart add resets it", async () => {
  const shop = await makeShop("cart-window");
  const { customerNumber, actor } = await makeCustomer(shop);
  const at = new Date("2026-10-20T12:00:00.000Z");
  const exact = await touch(shop, actor, "WISHLIST_ADDED_TO_CART", { at, ago: 7 * DAY, product: 44, variant: 440 });
  const outside = await touch(shop, actor, "WISHLIST_ADDED_TO_CART", { at, ago: 7 * DAY, product: 45, variant: 450 });
  const stale = await touch(shop, actor, "WISHLIST_ADDED_TO_CART", { at, ago: 8 * DAY, product: 46, variant: 460 });
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 20 * DAY, product: 46, variant: 460 });
  await touch(shop, actor, "WISHLIST_ADDED_TO_CART", { at, ago: 8 * DAY, product: 47, variant: 470 });
  const reset = await touch(shop, actor, "WISHLIST_ADDED_TO_CART", { at, ago: DAY, product: 47, variant: 470 });
  await prisma.activityEvent.update({ where: { id: exact.id }, data: { occurredAt: new Date(at.getTime() - 7 * DAY) } });
  await prisma.activityEvent.update({ where: { id: outside.id }, data: { occurredAt: new Date(at.getTime() - 7 * DAY - 1) } });
  await prisma.activityEvent.update({ where: { id: stale.id }, data: { occurredAt: new Date(at.getTime() - 8 * DAY) } });
  await prisma.activityEvent.update({ where: { id: reset.id }, data: { occurredAt: new Date(at.getTime() - DAY) } });

  for (const [product, variant, expected] of [[44, 440, true], [45, 450, false], [46, 460, false], [47, 470, true]]) {
    const payload = orderPayload({ customerNumber, at, lines: [line(1, { product, variant })] });
    await deliver(shop, payload);
    const row = await orderRow(shop, payload.id);
    assert.equal(Boolean(row.attribution), expected, `product ${product}`);
  }
});

test("a stale Wishlist cart suppresses Wishlist saves but does not suppress a valid Notify Me match", async () => {
  const shop = await makeShop("cart-notify");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 20 * DAY, product: 48, variant: 480 });
  await touch(shop, actor, "WISHLIST_ADDED_TO_CART", { at, ago: 8 * DAY, product: 48, variant: 480 });
  const notify = await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: 2 * DAY, product: 48, variant: 480 });
  const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 48, variant: 480 })] });
  await deliver(shop, payload);

  const row = await orderRow(shop, payload.id);
  assert.deepEqual([row.attribution.feature, row.attribution.touchEventId], ["NOTIFY_ME", notify.id]);
});

test("removing the saved item before the order cancels the Wishlist episode; saving it again restores it", async () => {
  const shop = await makeShop("episode");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 3 * DAY, product: 51, variant: 511 });
  await touch(shop, actor, "WISHLIST_REMOVED", { at, ago: 2 * DAY, product: 51, variant: 511 });
  const removed = orderPayload({ customerNumber, at, lines: [line(1, { product: 51, variant: 511 })] });
  await deliver(shop, removed);
  assert.equal((await orderRow(shop, removed.id)).attribution, null);

  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 51, variant: 511 });
  const again = orderPayload({ customerNumber, at, lines: [line(1, { product: 51, variant: 511 })] });
  await deliver(shop, again);
  assert.equal((await orderRow(shop, again.id)).attribution.feature, "WISHLIST");
});

test("last touch is selected per line item, with no double-credit across features", async () => {
  const shop = await makeShop("compete");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  // Product 61 is Wishlist-only. Product 62 matches both features, with Notify Me newer.
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 3 * DAY, product: 61, variant: 611 });
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 2 * DAY, product: 62, variant: 622 });
  await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: DAY, product: 62, variant: 622 });
  const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 61, variant: 611, price: "40.00" }), line(2, { product: 62, variant: 622, price: "25.00" }), line(3, { product: 63, variant: 633, price: "99.00" })] });
  await deliver(shop, payload);
  const split = await orderRow(shop, payload.id);
  assert.deepEqual(split.attributions.map((row) => [row.feature, row.matchedProductGid, money(row.grossAmount)]).sort((a, b) => a[1].localeCompare(b[1])), [
    ["WISHLIST", gid("Product", 61), "40.00"],
    ["NOTIFY_ME", gid("Product", 62), "25.00"],
  ].sort((a, b) => a[1].localeCompare(b[1])));
  assert.equal(money(split.totalPrice), "173.99", "the full order total stays separate and is never credited");
  assert.equal(await prisma.orderAttribution.count({ where: { orderId: split.id } }), 2);

  // When both features match the same line, only its most recent touch wins.
  const { actor: actor2, customerNumber: customer2 } = await makeCustomer(shop);
  await touch(shop, actor2, "RESTOCK_EMAIL_SENT", { at, ago: 3 * DAY, product: 61, variant: 611 });
  await touch(shop, actor2, "WISHLIST_ADDED", { at, ago: 4 * DAY, product: 61, variant: 611 });
  await touch(shop, actor2, "WISHLIST_PRODUCT_CLICKED", { at, ago: HOUR / 2, product: 61, variant: 611 });
  const second = orderPayload({ customerNumber: customer2, at, lines: [line(1, { product: 61, variant: 611, price: "40.00" })] });
  await deliver(shop, second);
  const wishlistWins = await orderRow(shop, second.id);
  assert.deepEqual([wishlistWins.attribution.feature, money(wishlistWins.attribution.grossAmount)], ["WISHLIST", "40.00"]);
});

test("same-line Wishlist and Notify Me ties use the lexicographically greater event id", async () => {
  const shop = await makeShop("tie-break");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  const wishlist = await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 621, variant: 6210 });
  const notify = await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: DAY, product: 621, variant: 6210 });
  const tiedAt = new Date(at.getTime() - HOUR);
  await prisma.activityEvent.updateMany({
    where: { id: { in: [wishlist.id, notify.id] } },
    data: { occurredAt: tiedAt },
  });
  const expected = wishlist.id > notify.id ? wishlist : notify;
  const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 621, variant: 6210 })] });

  await deliver(shop, payload);
  const row = await orderRow(shop, payload.id);
  assert.equal(row.attribution.touchEventId, expected.id);
  assert.equal(row.attribution.feature, expected === wishlist ? "WISHLIST" : "NOTIFY_ME");
});

test("multi-line order revenue is split by each line's last touch and never double-counted", async () => {
  const shop = await makeShop("line-split");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 3 * DAY, product: 64, variant: 641 });
  await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: 2 * DAY, product: 65, variant: 651 });
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 3 * DAY, product: 66, variant: 661 });
  await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: 2 * DAY, product: 66, variant: 661 });
  const payload = orderPayload({
    customerNumber,
    at,
    lines: [
      line(1, { product: 64, variant: 641, price: "10.00" }),
      line(2, { product: 65, variant: 651, price: "20.00" }),
      line(3, { product: 66, variant: 661, price: "30.00" }),
    ],
  });
  await deliver(shop, payload);

  const row = await orderRow(shop, payload.id);
  assert.deepEqual(row.attributions.map((item) => [item.feature, item.matchedProductGid, money(item.grossAmount)]).sort((a, b) => a[1].localeCompare(b[1])), [
    ["WISHLIST", gid("Product", 64), "10.00"],
    ["NOTIFY_ME", gid("Product", 65), "20.00"],
    ["NOTIFY_ME", gid("Product", 66), "30.00"],
  ].sort((a, b) => a[1].localeCompare(b[1])));
  assert.equal(row.attributions.reduce((sum, item) => sum + Number(item.grossAmount), 0), 60, "each line contributes once");
  const report = await reporting.getAttribution(shop.id, 30, { scopeGranted: true });
  assert.deepEqual([report.overall.orders, report.wishlist.orders, report.notifyMe.orders], [1, 1, 1]);
  assert.deepEqual([report.overall.revenue, report.wishlist.revenue, report.notifyMe.revenue], ["60.00", "10.00", "50.00"]);
});

test("pure rule: chooseTouch selects one line-item winner, ignores unsaved items, and breaks ties by event id", () => {
  const items = [{ id: 1, productGid: gid("Product", 1), variantGid: gid("ProductVariant", 11) }, { id: 2, productGid: gid("Product", 2), variantGid: gid("ProductVariant", 22) }];
  const ev = (id, type, feature, ms, product, variant) => ({ id, type, feature, occurredAt: new Date(ms), productGid: gid("Product", product), variantGid: variant ? gid("ProductVariant", variant) : null });
  const saved = new Map([[gid("ProductVariant", 11), true]]);
  const orderTime = new Date(2000);
  assert.deepEqual(attribution.chooseTouch([ev(1, "WISHLIST_ADDED", "WISHLIST", 1000, 1, 11)], items, new Map(), orderTime), [], "not saved at order time");
  const tie = attribution.chooseTouch([ev(5, "WISHLIST_ADDED", "WISHLIST", 1000, 1, 11), ev(9, "RESTOCK_EMAIL_SENT", "NOTIFY_ME", 1000, 2, 22)], items, saved, orderTime);
  assert.deepEqual(tie.map(({ event, item }) => [event.id, item.id]), [[5, 1], [9, 2]]);
  assert.deepEqual(attribution.chooseTouch([], items, saved, orderTime), []);
});

// ======================= money: refunds, edits, cancellations =======================
test("updates and refunds change net revenue without double counting; an older update never undoes a newer one", async () => {
  const shop = await makeShop("refund");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - 3 * HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 71, variant: 711 });
  const lines = [line(1, { product: 71, variant: 711, price: "100.00" }), line(2, { product: 72, variant: 722, price: "10.00" })];
  const base = { id: (seq += 1), customerNumber, at, lines };
  const t = (hours) => new Date(at.getTime() + hours * HOUR);

  await deliver(shop, orderPayload({ ...base, updatedAt: t(0) }), { eventId: "r1" });
  const net = async () => (await reporting.getAttribution(shop.id, 30, { scopeGranted: true })).overall;
  assert.deepEqual(await net(), { orders: 1, revenue: "100.00", orderValue: "119.99" });

  // Partial refund of the credited item: net revenue falls, the order is still counted once.
  const refunded = orderPayload({ ...base, updatedAt: t(1), status: "partially_refunded", refunds: [refundOf(1, "30.00")] });
  await deliver(shop, refunded, { eventId: "r2", topic: "orders/updated" });
  assert.deepEqual(await net(), { orders: 1, revenue: "70.00", orderValue: "119.99" });
  await deliver(shop, refunded, { eventId: "r3", topic: "orders/updated" }); // the same update delivered again
  assert.deepEqual(await net(), { orders: 1, revenue: "70.00", orderValue: "119.99" });

  // A refund of an item that earned nothing does not touch attributed revenue.
  await deliver(shop, orderPayload({ ...base, updatedAt: t(2), status: "partially_refunded", refunds: [refundOf(1, "30.00"), refundOf(2, "10.00")] }), { eventId: "r4", topic: "orders/updated" });
  assert.equal((await net()).revenue, "70.00");

  // An older version arriving late is ignored.
  const stale = await deliver(shop, orderPayload({ ...base, updatedAt: t(0.5) }), { eventId: "r5", topic: "orders/updated" });
  assert.equal(stale.outcome, "stale");
  assert.equal((await net()).revenue, "70.00");

  // Cancelled: the attribution is kept for the record but no longer counted.
  await deliver(shop, orderPayload({ ...base, updatedAt: t(3), status: "refunded", cancelledAt: t(3), refunds: [refundOf(1, "100.00")] }), { eventId: "r6", topic: "orders/updated" });
  assert.deepEqual(await net(), { orders: 0, revenue: "0.00", orderValue: "0.00" });
  const row = await orderRow(shop, base.id);
  assert.equal(row.attribution.status, "REVERSED");
  assert.equal(await prisma.orderAttribution.count({ where: { orderId: row.id } }), 1);
});

test("an order edit that removes the matching item removes the attribution; unpaid and voided orders are never attributed", async () => {
  const shop = await makeShop("edit");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - 3 * HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 81, variant: 811 });
  const id = (seq += 1);
  const both = [line(1, { product: 81, variant: 811, price: "20.00" }), line(2, { product: 82, variant: 822, price: "20.00" })];
  const pending = orderPayload({ id, customerNumber, at, status: "pending", lines: both, updatedAt: at });
  await deliver(shop, pending);
  assert.equal((await orderRow(shop, id)).attribution, null, "not paid yet");

  await deliver(shop, orderPayload({ id, customerNumber, at, status: "paid", lines: both, updatedAt: new Date(at.getTime() + HOUR) }), { topic: "orders/paid" });
  assert.equal(money((await orderRow(shop, id)).attribution.grossAmount), "20.00");

  await deliver(shop, orderPayload({ id, customerNumber, at, status: "paid", lines: [both[1]], updatedAt: new Date(at.getTime() + 2 * HOUR) }), { topic: "orders/updated" });
  const edited = await orderRow(shop, id);
  assert.equal(edited.lineItems.length, 1);
  assert.equal(edited.attribution, null, "the saved product is no longer on the order");

  const voided = orderPayload({ customerNumber, at, status: "voided", lines: both });
  await deliver(shop, voided);
  assert.equal((await orderRow(shop, voided.id)).attribution, null);
});

test("guest orders, orders without a customer id and customers unknown to the app are never attributed", async () => {
  const shop = await makeShop("guest");
  const { actor } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 91, variant: 911 });
  for (const customerNumber of [undefined, (seq += 1)]) {
    const payload = orderPayload({ customerNumber, at, lines: [line(1, { product: 91, variant: 911 })] });
    await deliver(shop, payload);
    assert.equal((await orderRow(shop, payload.id)).attribution, null);
  }
});

// ======================= reporting =======================
test("Overall counts each order once and equals Wishlist plus Notify Me; revenue is net of refunds on credited items", async () => {
  const shop = await makeShop("overall");
  const at = new Date(Date.now() - HOUR);
  const make = async (tag, type, product, variant, price) => {
    const { actor, customerNumber } = await makeCustomer(shop);
    await touch(shop, actor, type, { at, ago: DAY, product, variant });
    const payload = orderPayload({ customerNumber, at, lines: [line(1, { product, variant, price })] });
    await deliver(shop, payload);
    return payload;
  };
  await make("w1", "WISHLIST_ADDED", 101, 1011, "10.00");
  await make("w2", "WISHLIST_ADDED", 102, 1021, "20.00");
  await make("n1", "RESTOCK_EMAIL_SENT", 103, 1031, "5.50");
  // A customer with both touches on the same product still produces ONE attributed order.
  const { actor, customerNumber } = await makeCustomer(shop);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: 2 * DAY, product: 104, variant: 1041 });
  await touch(shop, actor, "RESTOCK_EMAIL_SENT", { at, ago: DAY, product: 104, variant: 1041 });
  await deliver(shop, orderPayload({ customerNumber, at, lines: [line(1, { product: 104, variant: 1041, price: "7.00" })] }));

  const report = await reporting.getAttribution(shop.id, 30, { scopeGranted: true });
  assert.equal(report.state, "ready");
  assert.deepEqual([report.wishlist.orders, report.wishlist.revenue], [2, "30.00"]);
  assert.deepEqual([report.notifyMe.orders, report.notifyMe.revenue], [2, "12.50"]);
  assert.deepEqual([report.overall.orders, report.overall.revenue], [4, "42.50"]);
  const activeRows = await prisma.orderAttribution.findMany({ where: { shopId: shop.id, status: "ACTIVE" }, select: { orderId: true } });
  assert.equal(report.overall.orders, new Set(activeRows.map((row) => row.orderId)).size, "Overall counts distinct orders even when they have multiple attribution rows");
  assert.equal(report.currency, "USD");
  assert.ok(Number(report.overall.orderValue) > Number(report.overall.revenue), "the full order value is reported separately and is larger");
});

test("the date range applies to the order date", async () => {
  const shop = await makeShop("range");
  const { actor, customerNumber } = await makeCustomer(shop);
  const old = new Date(Date.now() - 20 * DAY);
  await touch(shop, actor, "WISHLIST_ADDED", { at: old, ago: DAY, product: 111, variant: 1111 });
  await deliver(shop, orderPayload({ customerNumber, at: old, lines: [line(1, { product: 111, variant: 1111, price: "12.00" })] }));
  assert.equal((await reporting.getAttribution(shop.id, 7, { scopeGranted: true })).overall.orders, 0);
  assert.equal((await reporting.getAttribution(shop.id, 30, { scopeGranted: true })).overall.orders, 1);
});

test("empty data versus a real zero: no permission and no orders are not zeros; once orders exist, zero is confirmed", async () => {
  const shop = await makeShop("empty");
  assert.deepEqual(await reporting.getAttribution(shop.id, 30, { scopeGranted: false }).then((r) => r.state), "needs_access");
  assert.equal((await reporting.getAttribution(shop.id, 30, { scopeGranted: true })).state, "waiting");
  assert.equal("overall" in (await reporting.getAttribution(shop.id, 30, { scopeGranted: true })), false, "no figure at all before any order");

  const { customerNumber } = await makeCustomer(shop);
  await deliver(shop, orderPayload({ customerNumber, at: new Date(Date.now() - HOUR), lines: [line(1, { product: 121, variant: 1211 })] })); // nothing qualifies
  const report = await reporting.getAttribution(shop.id, 30, { scopeGranted: false });
  assert.equal(report.state, "ready", "orders were collected, so the data is trusted whatever the session scope says");
  assert.deepEqual(report.overall, { orders: 0, revenue: "0.00", orderValue: "0.00" });
  assert.equal(reporting.hasOrderScope("read_products,read_orders"), true);
  assert.equal(reporting.hasOrderScope("read_products"), false);
});

test("mixed currencies are reported as unavailable instead of being added together", async () => {
  const shop = await makeShop("fx");
  const { actor, customerNumber } = await makeCustomer(shop);
  const at = new Date(Date.now() - HOUR);
  await touch(shop, actor, "WISHLIST_ADDED", { at, ago: DAY, product: 131, variant: 1311 });
  await deliver(shop, orderPayload({ customerNumber, at, lines: [line(1, { product: 131, variant: 1311 })] }));
  const second = orderPayload({ customerNumber, at, lines: [line(1, { product: 131, variant: 1311 })] });
  await deliver(shop, second);
  await prisma.orderAttribution.updateMany({ where: { order: { orderGid: second.admin_graphql_api_id, shopId: shop.id } }, data: { currencyCode: "EUR" } });
  const report = await reporting.getAttribution(shop.id, 30, { scopeGranted: true });
  assert.deepEqual([report.mixedCurrency, report.overall.revenue], [true, null]);
});

// ======================= the card =======================
test("card view: setup states show no figures; ready shows each feature with its own explanation, and a zero stays a zero", () => {
  assert.match(format.attributionView({ state: "needs_access" }, 30).setup.note, /read_orders/);
  assert.equal(format.attributionView({ state: "waiting" }, 30).setup.display, "Waiting for orders");
  assert.equal(format.attributionView(null, 30).options, undefined);

  const ready = { state: "ready", currency: "USD", overall: { orders: 3, revenue: "90.00", orderValue: "140.00" }, wishlist: { orders: 2, revenue: "60.00", orderValue: "90.00" }, notifyMe: { orders: 0, revenue: "0.00", orderValue: "0.00" } };
  const { options } = format.attributionView(ready, 30);
  assert.deepEqual(options.map((o) => o.label), ["Overall", "Wishlist", "Notify Me"]);
  assert.deepEqual(options.map((o) => o.display), ["$90.00", "$60.00", "$0.00"]);
  assert.deepEqual(options[0].details, ["3 attributed orders · last 30 days", "Full order value: $140.00"]);
  assert.deepEqual(options[2].details, ["0 attributed orders · last 30 days"], "a confirmed zero is shown as zero");
  assert.equal(new Set(options.map((o) => o.hint)).size, 3, "each option explains itself");
  assert.match(format.ATTRIBUTION_FOOTNOTE, /not the whole order/);

  const mixed = format.attributionView({ ...ready, mixedCurrency: true, overall: { orders: 3, revenue: null, orderValue: null } }, 30).options[0];
  assert.equal(mixed.value, null);
});

// ======================= one source of truth =======================
test("revenue has one source of truth: the Dashboard card, the Wishlist and Notify Me cards, the Analytics table and the per-product list add up", async () => {
  const shop = await makeShop("truth");
  const at = new Date(Date.now() - HOUR);
  const place = async (type, product, variant, price, refund) => {
    const { actor, customerNumber } = await makeCustomer(shop);
    await touch(shop, actor, type, { at, ago: DAY, product, variant });
    const payload = orderPayload({ customerNumber, at, status: refund ? "partially_refunded" : "paid", lines: [line(1, { product, variant, price })], refunds: refund ? [refundOf(1, refund)] : [] });
    await deliver(shop, payload);
  };
  await place("WISHLIST_ADDED", 201, 2011, "40.00", "10.00"); // net 30.00
  await place("WISHLIST_ADDED", 201, 2011, "25.00"); // same product, another order
  await place("RESTOCK_EMAIL_SENT", 202, 2021, "15.50");

  const report = await reporting.getAttribution(shop.id, 30, { scopeGranted: true });
  const cents = (value) => Math.round(Number(value) * 100);
  assert.equal(cents(report.wishlist.revenue) + cents(report.notifyMe.revenue), cents(report.overall.revenue), "features add up to Overall");
  assert.equal(report.wishlist.orders + report.notifyMe.orders, report.overall.orders);
  assert.equal(report.topProducts.reduce((sum, p) => sum + cents(p.revenue), 0), cents(report.overall.revenue), "the per-product list is the same revenue, split by product");
  assert.deepEqual(report.topProducts.map((p) => [p.productId, p.orders, p.revenue]), [["201", 2, "55.00"], ["202", 1, "15.50"]]);

  // The card on every page is built from this same report, so it shows these same figures.
  const { options } = format.attributionView(report, 30);
  assert.deepEqual(options.map((o) => o.display), ["$70.50", "$55.00", "$15.50"]);
  assert.equal(options[0].display, format.formatMoney(report.overall.revenue, report.currency));
});
