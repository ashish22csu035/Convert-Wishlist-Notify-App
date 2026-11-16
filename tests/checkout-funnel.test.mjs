// Tests for the "Checkout initiated" stage: the checkouts/create webhook (app/models/checkout-webhook.server.js) and
// how a checkout is tied to the Wishlist or Notify Me journey.
//
// Run: node --test tests/checkout-funnel.test.mjs
// The data tests WRITE to the database in DATABASE_URL: run them on a scratch database only.
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
const at = (iso) => new Date(iso);
let counter = 9600000000;
let M;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  M = await import("../app/models/checkout-webhook.server.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const makeShop = async (tag, installed = "2026-01-01T00:00:00Z", extra = {}) => {
  const domain = `kw-checkout-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at(installed), ...extra } });
};
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const event = (shop, actor, type, iso, product = 1, variant = 11) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: `gid://shopify/Product/${product}`, variantGid: `gid://shopify/ProductVariant/${variant}`, occurredAt: at(iso) } });
const payload = (actor, lines, overrides = {}) => ({
  id: "981820079255243537",
  token: `tok${(counter += 1)}`,
  created_at: "2026-10-10T12:00:00Z",
  customer: actor ? { id: Number(actor.customerGid.split("/").pop()) } : null,
  email: "secret@example.invalid",
  line_items: lines.map(([product, variant]) => ({ product_id: product, variant_id: variant, quantity: 1 })),
  ...overrides,
});
const rows = (shop) => prisma.checkoutAttribution.findMany({ where: { shopId: shop.id }, orderBy: [{ feature: "asc" }, { checkoutKey: "asc" }] });

// ---------------------------------------------------------------------------------------------------------------------
test("parseCheckout: a usable checkout keeps only ids and the time; garbage is rejected", () => {
  const parsed = M.parseCheckout({ token: "abc", created_at: "2026-10-10T12:00:00Z", customer: { id: 5 }, email: "x@y.z", line_items: [{ product_id: 1, variant_id: 2 }, { product_id: null }, { product_id: 3, variant_id: null }] });
  assert.deepEqual(parsed.items, [{ productGid: "gid://shopify/Product/1", variantGid: "gid://shopify/ProductVariant/2" }, { productGid: "gid://shopify/Product/3", variantGid: null }]);
  assert.equal(parsed.customerGid, "gid://shopify/Customer/5");
  assert.equal(JSON.stringify(parsed).includes("x@y.z"), false, "no email is kept");
  assert.equal(M.parseCheckout({ token: "abc", created_at: "not a date" }), null);
  assert.equal(M.parseCheckout({ created_at: "2026-10-10T12:00:00Z" }), null, "no checkout id");
  assert.equal(M.parseCheckout(null), null);
  assert.equal(M.parseCheckout({ token: "t", created_at: "2026-10-10T12:00:00Z" }).customerGid, null, "a guest has no customer");
});

test("Wishlist journey: a checkout holding a product added to the cart FROM the Wishlist in the last 7 days counts for Wishlist only", async () => {
  const shop = await makeShop("wl");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-08T12:00:00Z", 1, 11);
  await event(shop, actor, "WISHLIST_ADDED", "2026-10-01T12:00:00Z", 2, 21); // a save alone is not a cart addition
  const checkout = M.parseCheckout(payload(actor, [[1, 11], [2, 21]]));
  assert.equal(await M.attributeCheckout(prisma, shop.id, checkout), 1);
  const stored = await rows(shop);
  assert.deepEqual(stored.map((r) => [r.feature, r.checkoutKey]), [["WISHLIST", checkout.key]]);
  assert.equal(stored[0].startedAt.toISOString(), "2026-10-10T12:00:00.000Z");
});

test("a cart addition older than 7 days, or after the checkout, or for another product, does not count", async () => {
  const shop = await makeShop("window");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-02T11:59:59Z", 1, 11); // 8 days before: stale
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-10T12:00:01Z", 1, 11); // after the checkout
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-09T12:00:00Z", 9, 91); // another product
  assert.equal(await M.attributeCheckout(prisma, shop.id, M.parseCheckout(payload(actor, [[1, 11]]))), 0);
  assert.equal((await rows(shop)).length, 0, "nothing is stored for an unmatched checkout");
});

test("Notify Me journey: a variant the customer was emailed about in the last 7 days; queued or failed emails leave no event, so never count", async () => {
  const shop = await makeShop("nm");
  const actor = await actorOf(shop);
  await event(shop, actor, "RESTOCK_EMAIL_SENT", "2026-10-09T08:00:00Z", 4, 41);
  assert.equal(await M.attributeCheckout(prisma, shop.id, M.parseCheckout(payload(actor, [[4, 42]]))), 0, "another variant of the product is not the emailed one");
  const hit = M.parseCheckout(payload(actor, [[4, 41]]));
  assert.equal(await M.attributeCheckout(prisma, shop.id, hit), 1);
  assert.deepEqual((await rows(shop)).map((r) => r.feature), ["NOTIFY_ME"]);
});

test("a customer who used both journeys is attributed per matching line, never twice for the same feature", async () => {
  const shop = await makeShop("both");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-09T10:00:00Z", 1, 11);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-09T11:00:00Z", 1, 11); // a second cart addition of the same product
  await event(shop, actor, "RESTOCK_EMAIL_SENT", "2026-10-09T08:00:00Z", 4, 41);
  const checkout = M.parseCheckout(payload(actor, [[1, 11], [4, 41]]));
  assert.equal(await M.attributeCheckout(prisma, shop.id, checkout), 2);
  assert.deepEqual((await rows(shop)).map((r) => r.feature), ["WISHLIST", "NOTIFY_ME"], "one row per feature");
  // the SAME product through both journeys: last touch wins, so one feature only
  const shop2 = await makeShop("same");
  const actor2 = await actorOf(shop2);
  await event(shop2, actor2, "WISHLIST_ADDED_TO_CART", "2026-10-09T10:00:00Z", 1, 11);
  await event(shop2, actor2, "RESTOCK_EMAIL_SENT", "2026-10-09T11:00:00Z", 1, 11);
  assert.equal(await M.attributeCheckout(prisma, shop2.id, M.parseCheckout(payload(actor2, [[1, 11]]))), 1, "a line item is credited to one journey");
  assert.deepEqual((await rows(shop2)).map((r) => r.feature), ["NOTIFY_ME"], "the latest touch (the email) wins, as in order attribution");
});

test("guests, unknown customers and other shops' customers are never attributed", async () => {
  const shop = await makeShop("guest");
  const other = await makeShop("guest-other");
  const actor = await actorOf(shop);
  const stranger = await actorOf(other);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-09T10:00:00Z", 1, 11);
  assert.equal(await M.attributeCheckout(prisma, shop.id, M.parseCheckout(payload(null, [[1, 11]]))), 0, "a guest checkout");
  assert.equal(await M.attributeCheckout(prisma, shop.id, M.parseCheckout(payload({ customerGid: "gid://shopify/Customer/123" }, [[1, 11]]))), 0, "a customer this shop has never seen");
  assert.equal(await M.attributeCheckout(prisma, shop.id, M.parseCheckout(payload(stranger, [[1, 11]]))), 0, "an actor of another shop");
  assert.equal((await rows(shop)).length, 0);
});

test("webhook handler: processes once, a redelivery and a second delivery of the same checkout never double count, bad input is acknowledged", async () => {
  const shop = await makeShop("hook");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-09T10:00:00Z", 1, 11);
  const body = payload(actor, [[1, 11]]);
  const input = { shopDomain: shop.domain, topic: "checkouts/create", webhookId: `wh-${RUN}-1`, eventId: `ev-${RUN}-1`, triggeredAt: "2026-10-10T12:00:01Z", payload: body };

  assert.deepEqual(await M.handleCheckoutWebhook(input), { status: 200, outcome: "processed" });
  assert.deepEqual(await M.handleCheckoutWebhook(input), { status: 200, outcome: "duplicate" }, "the same delivery again");
  // Shopify may also send the same checkout under a new event id: the unique row keeps it at one
  assert.equal((await M.handleCheckoutWebhook({ ...input, eventId: `ev-${RUN}-2`, webhookId: `wh-${RUN}-2` })).status, 200);
  assert.equal((await rows(shop)).length, 1);

  assert.equal((await M.handleCheckoutWebhook({ ...input, eventId: "x", payload: { nope: true } })).outcome, "ignored_invalid");
  assert.equal((await M.handleCheckoutWebhook({ ...input, eventId: "y", topic: "orders/paid" })).outcome, "ignored_invalid", "only checkouts/create");
  assert.equal((await M.handleCheckoutWebhook({ ...input, eventId: "z", shopDomain: "not-a-shop.example.com" })).outcome, "ignored_invalid");
  assert.equal((await M.handleCheckoutWebhook({ ...input, eventId: "w", shopDomain: `nobody-${RUN}.myshopify.com` })).outcome, "ignored_shop");
  const log = await prisma.webhookEvent.findMany({ where: { shopId: shop.id } });
  assert.ok(log.length >= 2 && log.every((row) => row.topic === "CHECKOUTS_CREATE"), "an audit row per delivery, without any payload");
  assert.equal(JSON.stringify(log).includes("secret@example.invalid"), false, "no customer email is stored");
});

test("an uninstalled shop receives nothing", async () => {
  const shop = await makeShop("gone", undefined, { status: "UNINSTALLED" });
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-09T10:00:00Z", 1, 11);
  const result = await M.handleCheckoutWebhook({ shopDomain: shop.domain, topic: "checkouts/create", webhookId: "g1", eventId: "g1", payload: payload(actor, [[1, 11]]) });
  assert.equal(result.outcome, "ignored_shop");
  assert.equal((await rows(shop)).length, 0);
});

test("the route verifies Shopify's signature first; the webhook is registered in both app configs and needs no new scope", () => {
  const route = fs.readFileSync("app/routes/webhooks.checkouts.create.jsx", "utf8");
  assert.ok(route.indexOf("authenticate.webhook(request)") < route.indexOf("handleCheckoutWebhook("), "HMAC check before the body is used");
  for (const file of ["shopify.app.toml", "shopify.app.konvert-wishlist-notify.toml"]) {
    const toml = fs.readFileSync(file, "utf8");
    assert.match(toml, /uri = "\/webhooks\/checkouts\/create"\s+topics = \[ "checkouts\/create" \]/, file);
    assert.match(/^scopes = "([^"]+)"/m.exec(toml)[1], /read_orders/, "checkouts/create needs read_orders, already requested");
  }
});

test("Analytics route: still behind the merchant session; the funnel reads summaries, not raw tables", () => {
  const source = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");
  assert.match(source, /loadMerchantContext\(request\)/, "authentication and the shop come from the session, never from the request");
  assert.match(source, /getFunnelSummary\(shop,/);
  const reporting = fs.readFileSync("app/models/reporting.server.js", "utf8");
  const fn = reporting.slice(reporting.indexOf("export async function getFunnelSummary"), reporting.indexOf("export async function getWishlistOverview"));
  assert.ok(fn.includes("prisma.analyticsDaily.aggregate"));
  for (const raw of ["activityEvent", "notifySubscription", "emailDelivery", "checkoutAttribution"]) assert.equal(fn.includes(`prisma.${raw}`), false, `${raw} is not read on a page request`);
});

// ======================= checkouts/create without a customer, then checkouts/update with one =======================
test("the real-world sequence: create arrives without the buyer, the update attaches them: counted once, with the reason recorded for the create", async () => {
  const shop = await makeShop("seq");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-10T11:58:44Z", 1, 11);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-10T11:58:45Z", 3, 31);
  const base = payload(actor, [[1, 11], [3, 31]], { token: `seq-${RUN}`, created_at: "2026-10-10T11:59:01Z" });
  const input = (topic, suffix, body) => ({ shopDomain: shop.domain, topic, webhookId: `wh-${RUN}-${suffix}`, eventId: `ev-${RUN}-${suffix}`, triggeredAt: "2026-10-10T11:59:02Z", payload: body });

  // 1. checkouts/create: no customer yet
  assert.deepEqual(await M.handleCheckoutWebhook(input("checkouts/create", "a", { ...base, customer: null })), { status: 200, outcome: "no_customer" });
  assert.equal((await rows(shop)).length, 0, "nothing can be attributed without a customer, and nothing is made up");
  const audit = await prisma.webhookEvent.findMany({ where: { shopId: shop.id, topic: "CHECKOUTS_CREATE" } });
  assert.deepEqual(audit.map((r) => [r.status, r.errorCode]), [["PROCESSED", "no_customer"]], "the reason is a fixed word, so a missing match can be told apart from a missing delivery");

  // 2. checkouts/update without a customer: ignored, not logged
  assert.equal((await M.handleCheckoutWebhook(input("checkouts/update", "b", { ...base, customer: null }))).outcome, "ignored_no_customer");
  assert.equal(await prisma.webhookEvent.count({ where: { shopId: shop.id } }), 1, "updates leave no audit row");

  // 3. checkouts/update with the customer: attributed, with the checkout's own created_at
  assert.deepEqual(await M.handleCheckoutWebhook(input("checkouts/update", "c", base)), { status: 200, outcome: "processed" });
  const stored = await rows(shop);
  assert.deepEqual(stored.map((r) => [r.feature, r.checkoutKey, r.startedAt.toISOString()]), [["WISHLIST", `seq-${RUN}`, "2026-10-10T11:59:01.000Z"]]);

  // 4. more updates, a redelivery, and a late create: still one row
  assert.equal((await M.handleCheckoutWebhook(input("checkouts/update", "d", base))).outcome, "already_attributed");
  assert.equal((await M.handleCheckoutWebhook(input("checkouts/update", "c", base))).outcome, "already_attributed", "the same update delivered again");
  assert.equal((await M.handleCheckoutWebhook(input("checkouts/create", "e", base))).status, 200);
  assert.equal((await rows(shop)).length, 1, "a checkout is counted once however many deliveries arrive");
});

test("every reason a checkout is not attributed is a distinct, recorded word", async () => {
  const shop = await makeShop("reasons");
  const actor = await actorOf(shop);
  const send = (suffix, body) => M.handleCheckoutWebhook({ shopDomain: shop.domain, topic: "checkouts/create", webhookId: `r-${RUN}-${suffix}`, eventId: `r-${RUN}-${suffix}`, payload: body });
  assert.equal((await send("1", payload(actor, []))).outcome, "no_items");
  assert.equal((await send("2", payload({ customerGid: "gid://shopify/Customer/424242" }, [[1, 11]]))).outcome, "unknown_customer");
  assert.equal((await send("3", payload(actor, [[1, 11]]))).outcome, "no_touch_no_events", "a known customer with no cart addition from the Wishlist");
  assert.equal((await rows(shop)).length, 0);
  const reasons = (await prisma.webhookEvent.findMany({ where: { shopId: shop.id } })).map((r) => r.errorCode).sort();
  assert.deepEqual(reasons, ["no_items", "no_touch_no_events", "unknown_customer"]);
});

test("an ineligible checkout (stale cart addition) never counts, even through checkouts/update", async () => {
  const shop = await makeShop("inelig");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-01T10:00:00Z", 1, 11); // 9 days before
  const body = payload(actor, [[1, 11]], { created_at: "2026-10-10T12:00:00Z" });
  assert.equal((await M.handleCheckoutWebhook({ shopDomain: shop.domain, topic: "checkouts/update", webhookId: "i1", eventId: "i1", payload: body })).outcome, "no_touch_stale");
  assert.equal((await rows(shop)).length, 0);
});

test("both topics are registered for the app and routed to the verified handler", () => {
  for (const file of ["shopify.app.toml", "shopify.app.konvert-wishlist-notify.toml"]) {
    const toml = fs.readFileSync(file, "utf8");
    assert.match(toml, /uri = "\/webhooks\/checkouts\/update"\s+topics = \[ "checkouts\/update" \]/, file);
  }
  const update = fs.readFileSync("app/routes/webhooks.checkouts.update.jsx", "utf8");
  assert.match(update, /export const action = checkoutsCreateAction/);
});

// ======================= the touch is recorded just after the checkout was created =======================
const sendHook = (shop, topic, suffix, body, triggeredAt) => M.handleCheckoutWebhook({ shopDomain: shop.domain, topic, webhookId: `a-${RUN}-${suffix}`, eventId: `a-${RUN}-${suffix}`, triggeredAt, payload: body });

test("a touch recorded seconds AFTER the checkout's created_at (the real dev-store ordering) is credited through the webhook's snapshot", async () => {
  // dev store, Notify Me: checkout created_at 11:53:26, the cart addition recorded at 11:53:28.377; Wishlist the same way
  const shop = await makeShop("late-wl");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-10T12:00:03.377Z", 1, 11);
  const body = payload(actor, [[1, 11]], { token: `late-${RUN}`, created_at: "2026-10-10T12:00:00Z" });
  assert.deepEqual(await sendHook(shop, "checkouts/create", "1", body, "2026-10-10T12:00:12Z"), { status: 200, outcome: "processed" });
  const stored = await rows(shop);
  assert.deepEqual(stored.map((r) => [r.feature, r.startedAt.toISOString()]), [["WISHLIST", "2026-10-10T12:00:00.000Z"]], "startedAt stays the checkout's own created_at");
  const touch = await prisma.activityEvent.findUnique({ where: { id: stored[0].touchEventId } });
  assert.equal(touch.occurredAt.toISOString(), "2026-10-10T12:00:03.377Z", "tied to the right touch event");

  // the same data without the delivery time keeps the strict comparison, and says exactly why
  const strict = await makeShop("late-strict");
  const a2 = await actorOf(strict);
  await event(strict, a2, "WISHLIST_ADDED_TO_CART", "2026-10-10T12:00:03.377Z", 1, 11);
  assert.deepEqual(await sendHook(strict, "checkouts/create", "2", payload(a2, [[1, 11]], { token: `late2-${RUN}`, created_at: "2026-10-10T12:00:00Z" })), { status: 200, outcome: "no_touch_recorded_late" });
  assert.equal((await rows(strict)).length, 0);
});

test("Notify Me and Wishlist are attributed independently when their touches are recorded just after the checkout started", async () => {
  const shop = await makeShop("late-both");
  const actor = await actorOf(shop);
  await event(shop, actor, "RESTOCK_EMAIL_SENT", "2026-10-10T12:00:02.400Z", 4, 41);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-10T12:00:04Z", 1, 11);
  const body = payload(actor, [[1, 11], [4, 41]], { token: `both-${RUN}`, created_at: "2026-10-10T12:00:00Z" });
  assert.equal((await sendHook(shop, "checkouts/create", "3", body, "2026-10-10T12:00:10Z")).outcome, "processed");
  assert.deepEqual((await rows(shop)).map((r) => r.feature), ["WISHLIST", "NOTIFY_ME"]);
});

test("the grace is bounded: a touch recorded long after the checkout started is never credited, even by a late update", async () => {
  const shop = await makeShop("grace");
  const actor = await actorOf(shop);
  const created = "2026-10-10T12:00:00Z";
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-10T12:06:00Z", 1, 11); // 6 minutes after created_at
  const body = payload(actor, [[1, 11]], { token: `grace-${RUN}`, created_at: created });
  assert.equal((await sendHook(shop, "checkouts/update", "4", body, "2026-10-10T12:07:00Z")).outcome, "no_touch_recorded_late", "the snapshot is capped 5 minutes after created_at");
  const inside = await makeShop("grace-in");
  const a2 = await actorOf(inside);
  await event(inside, a2, "WISHLIST_ADDED_TO_CART", "2026-10-10T12:04:00Z", 1, 11); // 4 minutes after created_at
  assert.equal((await sendHook(inside, "checkouts/update", "5", payload(a2, [[1, 11]], { token: `grace2-${RUN}`, created_at: created }), "2026-10-10T12:07:00Z")).outcome, "processed");
  // a nonsensical delivery time (before creation, or in the future) is ignored: the strict created_at comparison applies
  const s = M.snapshotAt(M.parseCheckout({ token: "t", created_at: created }), "2026-10-10T11:00:00Z");
  assert.equal(s.toISOString(), "2026-10-10T12:00:00.000Z");
  assert.equal(M.snapshotAt(M.parseCheckout({ token: "t", created_at: created }), "2999-01-01T00:00:00Z").toISOString(), "2026-10-10T12:00:00.000Z");
  assert.equal(M.snapshotAt(M.parseCheckout({ token: "t", created_at: created }), "not a date").toISOString(), "2026-10-10T12:00:00.000Z");
});

test("the 7-day window boundary is exact, measured back from the snapshot", async () => {
  const shop = await makeShop("bound");
  const actor = await actorOf(shop);
  const created = "2026-10-10T12:00:00.000Z";
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-03T12:00:00.000Z", 1, 11); // exactly 7 days before
  assert.equal(await M.attributeCheckout(prisma, shop.id, M.parseCheckout(payload(actor, [[1, 11]], { token: "b-exact", created_at: created }))), 1);
  const older = await makeShop("bound-old");
  const a2 = await actorOf(older);
  await event(older, a2, "WISHLIST_ADDED_TO_CART", "2026-10-03T11:59:59.999Z", 1, 11); // 1 ms too old
  const result = await M.attributeCheckoutWithReason(prisma, older.id, M.parseCheckout(payload(a2, [[1, 11]], { token: "b-old", created_at: created })));
  assert.deepEqual(result, { features: 0, reason: "no_touch_stale" });
});

test("every unmatched checkout carries a specific reason, and only the reason: no personal data", async () => {
  const shop = await makeShop("reasons2");
  const actor = await actorOf(shop);
  const check = async (key, lines, body = {}) => (await M.attributeCheckoutWithReason(prisma, shop.id, M.parseCheckout(payload(actor, lines, { token: key, created_at: "2026-10-10T12:00:00Z", ...body })))).reason;
  assert.equal(await check("r1", [[1, 11]]), "no_touch_no_events", "the customer has nothing recorded");
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-09T12:00:00Z", 1, 11);
  await event(shop, actor, "RESTOCK_EMAIL_SENT", "2026-10-09T12:00:00Z", 4, 41);
  assert.equal(await check("r2", [[9, 91]]), "no_touch_other_product", "a different product");
  assert.equal(await check("r3", [[4, 42]]), "no_touch_other_product", "Notify Me needs the exact emailed variant");
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-10T12:30:00Z", 7, 71);
  assert.equal(await check("r4", [[7, 71]]), "no_touch_recorded_late", "recorded after the checkout");
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-09-20T12:00:00Z", 8, 81);
  assert.equal(await check("r5", [[8, 81]]), "no_touch_stale", "older than 7 days");
  assert.equal((await rows(shop)).length, 0, "none of them was attributed");
  const log = JSON.stringify(await prisma.webhookEvent.findMany({ where: { shopId: shop.id } }));
  assert.equal(/example\.invalid|secret/.test(log), false);
});

test("store isolation: another shop's touches and customers are never used", async () => {
  const mine = await makeShop("iso-a");
  const other = await makeShop("iso-b");
  const customerGid = `gid://shopify/Customer/${(counter += 1)}`;
  const here = await prisma.actor.create({ data: { shopId: mine.id, customerGid } });
  const there = await prisma.actor.create({ data: { shopId: other.id, customerGid } }); // the same Shopify customer in another store
  await event(other, there, "WISHLIST_ADDED_TO_CART", "2026-10-09T12:00:00Z", 1, 11);
  const body = payload(here, [[1, 11]], { token: `iso-${RUN}`, created_at: "2026-10-10T12:00:00Z" });
  assert.deepEqual(await sendHook(mine, "checkouts/create", "6", body), { status: 200, outcome: "no_touch_no_events" });
  assert.equal((await rows(mine)).length + (await rows(other)).length, 0);
  // the same checkout in the shop that does hold the touch is attributed, to that shop only
  assert.equal((await sendHook(other, "checkouts/create", "7", body)).outcome, "processed");
  assert.deepEqual([(await rows(mine)).length, (await rows(other)).length], [0, 1]);
});

test("daily metrics: attributed checkouts are summarised per shop and day once, whatever the number of create and update deliveries", async () => {
  const analyticsWorker = await import("../app/worker/analytics-daily.server.js");
  const reporting = await import("../app/models/reporting.server.js");
  const P = await import("../app/utils/period.js");
  const NOW = new Date("2026-10-22T10:00:00.000Z");
  const shop = await makeShop("daily", "2026-10-01T00:00:00Z");
  const other = await makeShop("daily-other", "2026-10-01T00:00:00Z");
  const actor = await actorOf(shop);
  await event(shop, actor, "WISHLIST_ADDED_TO_CART", "2026-10-20T11:59:57Z", 1, 11); // recorded 3 s after the checkout began
  await event(shop, actor, "RESTOCK_EMAIL_SENT", "2026-10-20T09:00:00Z", 4, 41);
  const body = payload(actor, [[1, 11], [4, 41]], { token: `daily-${RUN}`, created_at: "2026-10-20T11:59:54Z" });
  for (const [topic, suffix] of [["checkouts/create", "d1"], ["checkouts/create", "d1"], ["checkouts/update", "d2"], ["checkouts/update", "d3"]]) await sendHook(shop, topic, suffix, body, "2026-10-20T12:00:06Z");
  assert.equal((await rows(shop)).length, 2, "one row per feature however many deliveries");
  const run = (s) => analyticsWorker.runAnalyticsDaily({ now: () => NOW, shopIds: [s.id], backfillPerShop: 400, log: { log() {}, error() {} }, invalidate: async () => {} });
  await run(shop);
  await run(shop);
  await run(other);
  const summary = async (s) => (await reporting.getFunnelSummary(await reporting.getShopByDomain(s.domain), P.customPeriod("2026-10-20", "2026-10-20", NOW).period, NOW)).range;
  const mineRange = await summary(shop);
  assert.deepEqual([mineRange.wishlistCheckouts, mineRange.notifyCheckouts], [1, 1], "the right shop, the right day, counted once");
  assert.deepEqual([(await summary(other)).wishlistCheckouts, (await summary(other)).notifyCheckouts], [0, 0], "another shop is unaffected");
  const wrongDay = (await reporting.getFunnelSummary(await reporting.getShopByDomain(shop.domain), P.customPeriod("2026-10-21", "2026-10-21", NOW).period, NOW)).range;
  assert.deepEqual([wrongDay.wishlistCheckouts, wrongDay.notifyCheckouts], [0, 0], "and not on another day");
  const day = await prisma.analyticsDaily.findFirst({ where: { shopId: shop.id, day: new Date("2026-10-20T00:00:00Z") } });
  assert.deepEqual([day.wishlistCheckouts, day.notifyCheckouts], [1, 1]);
});
