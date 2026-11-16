// Tests for Notify Me cart-addition tracking: the restock email's tracking link, the storefront script that watches the
// cart, the server operation that records ONE event per email, and how the daily summary and the funnel report it.
//
// Run: node --test tests/notify-cart.test.mjs
// The data tests WRITE to the database in DATABASE_URL: run them on a scratch database only. The storefront script runs in a
// node:vm sandbox with a stub cart: a real theme, real browser and Shopify's real cart are NOT exercised here.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const domains = [];
const at = (iso) => new Date(iso);
const NOW = new Date("2026-10-22T10:00:00.000Z");
let counter = 9400000000;
let N; // notify.server
let E; // restock-email.server
let U; // unsubscribe.server
let reporting;
let analyticsWorker;
let P;
let CW; // checkout-webhook.server
const newTok = () => crypto.randomBytes(32).toString("base64url");

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  N = await import("../app/models/notify.server.js");
  E = await import("../app/models/restock-email.server.js");
  U = await import("../app/models/unsubscribe.server.js");
  reporting = await import("../app/models/reporting.server.js");
  analyticsWorker = await import("../app/worker/analytics-daily.server.js");
  P = await import("../app/utils/period.js");
  CW = await import("../app/models/checkout-webhook.server.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const makeShop = async (tag, installedAt = "2026-09-28T00:00:00Z") => {
  const domain = `kw-ncart-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at(installedAt) } });
};
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const VARIANT = "gid://shopify/ProductVariant/1002";
const PRODUCT = "gid://shopify/Product/101";

// A subscription and its restock email, with the cart-tracking token a real send would have stored (as a hash).
async function makeEmail(shop, actor, { status = "SENT", variantGid = VARIANT, sentAt = at("2026-10-21T10:00:00Z"), token = newTok() } = {}) {
  const sub = await prisma.notifySubscription.create({
    data: { shopId: shop.id, actorId: actor.id, productGid: PRODUCT, variantGid, email: "customer@example.invalid", status: "FULFILLED", consentedAt: at("2026-10-01T00:00:00Z"), consentSource: "test" },
  });
  const delivery = await prisma.emailDelivery.create({
    data: { shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid, status, sentAt: status === "SENT" ? sentAt : null, cartTokenHash: U.hashToken(token) },
  });
  return { token, delivery, sub };
}
const identityOf = (shop, actor) => ({ shopDomain: shop.domain, customerGid: actor.customerGid });
const eventsOf = (shop, type = "NOTIFY_ADDED_TO_CART") => prisma.activityEvent.findMany({ where: { shopId: shop.id, type } });
const refused = (promise) => assert.rejects(promise, (error) => error.code === "attribution_invalid" && error.status === 422);

// ======================= the email's tracking link =======================
test("the restock email's product link carries an opaque tracking token, never an email address, id or the unsubscribe token", () => {
  const token = newTok();
  const base = { shop: { domain: "s.myshopify.com", name: "S" }, settings: null, product: { productTitle: "Board", variantTitle: "Small", handle: "board", onlineStoreUrl: "https://s.example/products/board" }, variantGid: VARIANT, recipient: "customer@example.invalid", mailFrom: "from@example.invalid", unsubscribeLink: "https://app.example/notify/unsubscribe?t=UNSUBSCRIBE_SECRET_TOKEN_0123456789", messageId: "<m@x>" };
  const mail = E.buildRestockEmail({ ...base, cartToken: token });
  const link = /https:\/\/s\.example\/products\/board\?[^\s"'<>)]+/.exec(mail.text)[0];
  const params = new URL(link.replace(/&amp;/g, "&")).searchParams;
  assert.equal(params.get("variant"), "1002");
  assert.equal(params.get("kw_n"), token);
  assert.equal(link.includes("customer@example.invalid") || link.includes("UNSUBSCRIBE_SECRET"), false, "no personal data and not the unsubscribe secret in the product URL");
  assert.notEqual(token, "UNSUBSCRIBE_SECRET_TOKEN_0123456789");
  // without a token the link is exactly what it was before (an email sent before this change, or a missing token)
  const plain = E.buildRestockEmail(base);
  assert.equal(new URL(/https:\/\/s\.example\/products\/board\?[^\s"'<>)]+/.exec(plain.text)[0]).searchParams.has("kw_n"), false);
  // a malformed token is dropped, never put in a link
  for (const bad of ["short", "has space and ?& chars ........", "x".repeat(100), 42, null]) {
    assert.equal(E.productLink({ onlineStoreUrl: "https://s.example/products/board", variantGid: VARIANT, notifyToken: bad }), "https://s.example/products/board?variant=1002");
  }
});

test("the delivery worker stores only a HASH of the tracking token, a different secret from the unsubscribe token, and clears it when nothing was sent", () => {
  const source = fs.readFileSync("app/models/email-delivery.server.js", "utf8");
  assert.match(source, /const cartToken = newToken\(\);/);
  assert.match(source, /cartTokenHash: hashToken\(cartToken\)/);
  assert.match(source, /cartToken,\s*\}\);\s*if \(!mail\)/, "the same token is the one built into the email");
  assert.equal((source.match(/cartTokenHash: null/g) ?? []).length, 2, "a failed or retried attempt keeps no token");
});

// ======================= the server records at most one event per email, only when everything matches =======================
test("a customer who came from the restock email adds the emailed variant: one NOTIFY_ADDED_TO_CART event, tied to the shop, customer, variant and email", async () => {
  const shop = await makeShop("ok");
  const actor = await actorOf(shop);
  const { token, delivery } = await makeEmail(shop, actor);
  assert.deepEqual(await N.recordNotifyCartAdd(identityOf(shop, actor), { token, variantGid: VARIANT }, () => NOW), { recorded: true, duplicate: false });
  const [event] = await eventsOf(shop);
  assert.deepEqual([event.feature, event.actorId, event.productGid, event.variantGid, event.emailDeliveryId, event.browsingSessionId], ["NOTIFY_ME", actor.id, PRODUCT, VARIANT, delivery.id, null]);
  assert.equal(await prisma.browsingSession.count({ where: { shopId: shop.id } }), 0, "no engagement session is opened by a cart report");
});

test("duplicate reports (a retry, a second tab, a repeated callback, concurrent requests) never inflate the count", async () => {
  const shop = await makeShop("dup");
  const actor = await actorOf(shop);
  const { token } = await makeEmail(shop, actor);
  const send = () => N.recordNotifyCartAdd(identityOf(shop, actor), { token, variantGid: VARIANT }, () => NOW);
  const results = await Promise.all([send(), send(), send()]);
  assert.equal(results.filter((r) => r.recorded).length, 1, "exactly one of three concurrent reports recorded");
  assert.deepEqual(await send(), { recorded: false, duplicate: true });
  assert.equal((await eventsOf(shop)).length, 1);
});

test("an unrelated product or variant, a foreign customer, another shop, a made-up token and a failed email never count", async () => {
  const shop = await makeShop("no");
  const other = await makeShop("no-other");
  const actor = await actorOf(shop);
  const stranger = await actorOf(shop);
  const { token } = await makeEmail(shop, actor);
  const ok = identityOf(shop, actor);
  await refused(N.recordNotifyCartAdd(ok, { token, variantGid: "gid://shopify/ProductVariant/9999" }, () => NOW)); // an unrelated variant
  await refused(N.recordNotifyCartAdd(identityOf(shop, stranger), { token, variantGid: VARIANT }, () => NOW)); // someone else's email
  await refused(N.recordNotifyCartAdd({ shopDomain: other.domain, customerGid: actor.customerGid }, { token, variantGid: VARIANT }, () => NOW)); // another shop
  await refused(N.recordNotifyCartAdd({ shopDomain: shop.domain, customerGid: "gid://shopify/Customer/1" }, { token, variantGid: VARIANT }, () => NOW)); // a customer the shop has never seen
  await refused(N.recordNotifyCartAdd(ok, { token: newTok(), variantGid: VARIANT }, () => NOW)); // a made-up token
  for (const bad of ["", "short", "a b".repeat(10), undefined, null, 7]) await refused(N.recordNotifyCartAdd(ok, { token: bad, variantGid: VARIANT }, () => NOW));
  for (const status of ["PENDING", "SENDING", "FAILED", "SKIPPED", "UNKNOWN"]) {
    const owner = await actorOf(shop); // one subscription per customer and variant
    const row = await makeEmail(shop, owner, { status });
    await refused(N.recordNotifyCartAdd(identityOf(shop, owner), { token: row.token, variantGid: VARIANT }, () => NOW)); // never accepted by the mail server
  }
  assert.equal((await eventsOf(shop)).length, 0, "every refusal wrote nothing");
});

test("the same 7-day window as every other touch: an email older than 7 days no longer counts", async () => {
  const shop = await makeShop("window");
  const actor = await actorOf(shop);
  const { token } = await makeEmail(shop, actor, { sentAt: at("2026-10-14T09:59:59Z") });
  await refused(N.recordNotifyCartAdd(identityOf(shop, actor), { token, variantGid: VARIANT }, () => NOW));
  const other = await actorOf(shop);
  const fresh = await makeEmail(shop, other, { sentAt: at("2026-10-15T10:00:01Z") });
  assert.equal((await N.recordNotifyCartAdd(identityOf(shop, other), { token: fresh.token, variantGid: VARIANT }, () => NOW)).recorded, true);
});

test("the proxy route: the shop and customer come from the signed identity, the operation is validated, and a refusal is a 422", () => {
  const route = fs.readFileSync("app/routes/proxy.api.notify.jsx", "utf8");
  assert.match(route, /\["open", "subscribe", "cart_add"\]\.includes\(body\.op\)/);
  assert.match(route, /recordNotifyCartAdd\(identity, \{ token: body\.token, variantGid \}\)/, "identity (signed proxy query) is passed, never a body field");
  assert.ok(route.indexOf("authenticateStorefront(request)") < route.indexOf("recordNotifyCartAdd("), "authenticated first");
  assert.ok(route.indexOf("login_required") < route.indexOf("recordNotifyCartAdd("), "a logged-out visitor is refused before anything is read");
  assert.ok(route.indexOf("feature_disabled") < route.indexOf("recordNotifyCartAdd("), "nothing is recorded while Notify Me is switched off");
});

// ======================= ETL, summary and funnel =======================
const runEtl = (shop, now = NOW) => analyticsWorker.runAnalyticsDaily({ now: () => now, shopIds: [shop.id], backfillPerShop: 400, log: { log() {}, error() {} }, invalidate: async () => {} });

test("ETL: Notify Me cart additions are summarised per day, re-running never double counts, and the funnel reads them; Wishlist counts are untouched", async () => {
  const shop = await makeShop("etl");
  const actor = await actorOf(shop);
  const a = await makeEmail(shop, actor, { sentAt: at("2026-10-12T10:00:00Z") });
  const b = await makeEmail(shop, await actorOf(shop), { sentAt: at("2026-10-05T10:00:00Z") });
  // two emails, each credited once, on different days; a third report of the first changes nothing
  await N.recordNotifyCartAdd(identityOf(shop, actor), { token: a.token, variantGid: VARIANT }, () => at("2026-10-13T10:00:00Z"));
  const second = await prisma.actor.findUnique({ where: { id: b.sub.actorId } });
  await N.recordNotifyCartAdd(identityOf(shop, second), { token: b.token, variantGid: VARIANT }, () => at("2026-10-08T10:00:00Z"));
  await N.recordNotifyCartAdd(identityOf(shop, actor), { token: a.token, variantGid: VARIANT }, () => at("2026-10-13T11:00:00Z"));
  // events happen "now" in the table, so place them on the days of this scenario
  const events = await eventsOf(shop);
  assert.equal(events.length, 2);
  await prisma.activityEvent.update({ where: { id: events.find((e) => e.emailDeliveryId === a.delivery.id).id }, data: { occurredAt: at("2026-10-13T10:00:00Z") } });
  await prisma.activityEvent.update({ where: { id: events.find((e) => e.emailDeliveryId === b.delivery.id).id }, data: { occurredAt: at("2026-10-08T10:00:00Z") } });
  // Wishlist cart additions are a different event and a different column
  await prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type: "WISHLIST_ADDED_TO_CART", feature: "WISHLIST", productGid: PRODUCT, variantGid: VARIANT, occurredAt: at("2026-10-13T12:00:00Z") } });

  assert.equal((await runEtl(shop)).failed, 0);
  await runEtl(shop);
  await runEtl(shop);
  const ref = await reporting.getShopByDomain(shop.domain);
  const range = (from, to) => reporting.getFunnelSummary(ref, P.customPeriod(from, to, NOW).period, NOW);
  const whole = await range("2026-10-01", "2026-10-20");
  assert.equal(whole.range.notifyAddedToCart, 2);
  assert.equal(whole.range.wishlistAddedToCart, 1, "the Wishlist count is its own, unchanged by Notify Me events");
  assert.equal((await range("2026-10-13", "2026-10-13")).range.notifyAddedToCart, 1, "the date range decides by when the cart addition happened");
  assert.equal((await range("2026-10-14", "2026-10-20")).range.notifyAddedToCart, 0, "tracking is operational and nothing qualified: a real zero, not unavailable");
  assert.equal(whole.range.coverage.complete, true);
  const day = await prisma.analyticsDaily.findFirst({ where: { shopId: shop.id, day: at("2026-10-13T00:00:00Z") } });
  assert.equal(day.notifyAddedToCart, 1);
});

test("a day calculated before this column existed is Unavailable for this stage only, until the worker fills it; it never reads as zero", async () => {
  const shop = await makeShop("legacy");
  const ref = await reporting.getShopByDomain(shop.domain);
  const { period } = P.customPeriod("2026-10-02", "2026-10-03", NOW);
  for (const day of ["2026-10-02", "2026-10-03"]) {
    await prisma.analyticsDaily.create({ data: { shopId: shop.id, day: at(`${day}T00:00:00Z`), wishlistAdded: 3, notifyUnsubscribed: 0, wishlistAddedToCart: 2, notifySubscriptionsCreated: 1, wishlistCheckouts: 0, notifyCheckouts: 0, updatedAt: at(`${day}T12:00:00Z`) } });
  }
  const before = await reporting.getFunnelSummary(ref, period, NOW);
  assert.equal(before.range.notifyAddedToCart, null, "not calculated yet");
  assert.equal(before.range.wishlistAddedToCart, 4, "the other stages are still shown");
  assert.equal(before.range.coverage.complete, false, "and the screen says the figures are incomplete");
  await runEtl(shop);
  const after = await reporting.getFunnelSummary(ref, period, NOW);
  assert.equal(after.range.notifyAddedToCart, 0);
  assert.equal(after.range.coverage.complete, true);
});

test("cache: the worker bumps the shop's Analytics version after writing summaries (the existing convention), and the funnel is read from the summaries, not cached", async () => {
  const shop = await makeShop("cache");
  let bumped = 0;
  await analyticsWorker.runAnalyticsDaily({ now: () => NOW, shopIds: [shop.id], backfillPerShop: 400, log: { log() {}, error() {} }, invalidate: async (id) => { if (id === shop.id) bumped += 1; } });
  assert.equal(bumped, 1);
  const source = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");
  assert.match(source, /getFunnelSummary\(shop, resolvePeriod\(period\)\)/);
});

test("checkout and revenue attribution are unchanged: a cart addition alone creates no checkout attribution, the restock email still does", async () => {
  const shop = await makeShop("chk");
  const actor = await actorOf(shop);
  const { token } = await makeEmail(shop, actor, { sentAt: at("2026-10-09T08:00:00Z") });
  await N.recordNotifyCartAdd(identityOf(shop, actor), { token, variantGid: VARIANT }, () => at("2026-10-09T09:00:00Z"));
  const ev = await prisma.activityEvent.findFirst({ where: { shopId: shop.id, type: "NOTIFY_ADDED_TO_CART" } });
  await prisma.activityEvent.update({ where: { id: ev.id }, data: { occurredAt: at("2026-10-09T09:00:00Z") } });
  const checkout = (key) => CW.parseCheckout({ token: key, created_at: "2026-10-10T12:00:00Z", customer: { id: actor.customerGid.split("/").pop() }, line_items: [{ product_id: 101, variant_id: 1002 }] });
  assert.equal(await CW.attributeCheckout(prisma, shop.id, checkout("c-only-cart")), 0, "the new event is not a checkout touch");
  await prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type: "RESTOCK_EMAIL_SENT", feature: "NOTIFY_ME", productGid: PRODUCT, variantGid: VARIANT, occurredAt: at("2026-10-09T08:00:00Z") } });
  assert.equal(await CW.attributeCheckout(prisma, shop.id, checkout("c-with-email")), 1, "the existing rule: the accepted email for that variant");
  const order = fs.readFileSync("app/models/order-attribution.server.js", "utf8");
  assert.match(order, /const TOUCH_TYPES = \["WISHLIST_ADDED", "WISHLIST_ADDED_TO_CART", "WISHLIST_PRODUCT_CLICKED", "RESTOCK_EMAIL_SENT"\];/, "order attribution's touches are exactly what they were");
});

// ======================= the storefront script (the shipped code, in a sandbox) =======================
const EXTRAS = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");
const BLOCK = EXTRAS.slice(EXTRAS.indexOf("/* ---------- Notify Me: the emailed variant is added to the cart"), EXTRAS.indexOf("/* ---------- start ---------- */"));
const TOKEN = newTok();

function storefront({ search = `?variant=1002&kw_n=${TOKEN}`, loggedIn = true, cart = [], respond = () => ({}), notifyEnabled = true, shared = null } = {}) {
  const state = shared ?? { session: new Map(), local: new Map(), cart: [...cart] };
  const log = { requests: [], cartReads: 0, replaced: [], warned: 0 };
  const store = (map) => ({ getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) });
  const win = {
    location: { search, pathname: "/products/board", hash: "" },
    history: { state: null, replaceState: (s, t, url) => { log.replaced.push(url); win.location.search = url.includes("?") ? `?${url.split("?")[1]}` : ""; } },
    URLSearchParams,
    sessionStorage: store(state.session),
    localStorage: store(state.local),
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    addEventListener() {},
  };
  const fetchStub = async (url) => {
    if (String(url).endsWith("cart.js")) {
      log.cartReads += 1;
      return { ok: true, json: async () => ({ items: state.cart.map(([variant_id, quantity]) => ({ variant_id, quantity })) }) };
    }
    return { ok: true, json: async () => ({}) }; // a theme cart write
  };
  win.fetch = fetchStub;
  const kw = {
    shopRoot: () => "/",
    request: async (options) => {
      log.requests.push(options);
      const outcome = respond(options, log.requests.length);
      if (outcome && outcome.status) throw Object.assign(new Error("refused"), { status: outcome.status });
      return outcome;
    },
  };
  const config = { loggedIn, notifyPath: "/apps/konvert-notify/api/notify", notifyEnabled };
  const api = new Function("window", "fetch", "config", "kw", "warn", "noop", `${BLOCK}\nreturn { trackNotifyCart, checkNotifyCart, readNotifyCtx };`)(win, fetchStub, config, kw, () => { log.warned += 1; }, () => {});
  return { api, state, log, win, config };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("storefront: landing from the email remembers the token and the cart baseline, and removes the token from the address bar", async () => {
  const s = storefront();
  s.api.trackNotifyCart();
  await settle();
  assert.deepEqual(s.log.replaced, ["/products/board?variant=1002"], "the variant stays, the token is gone");
  const ctx = s.api.readNotifyCtx();
  assert.deepEqual([ctx.t, ctx.v, ctx.b, ctx.done], [TOKEN, "1002", 0, false]);
  assert.equal(s.log.requests.length, 0, "an email click alone reports nothing: it does not prove a cart addition");
});

test("storefront: the emailed variant added to the cart is reported once, with the token and the variant, and never again", async () => {
  const s = storefront();
  s.api.trackNotifyCart();
  await settle();
  s.state.cart.push(["1002", 1]);
  await s.api.checkNotifyCart();
  assert.equal(s.log.requests.length, 1);
  assert.deepEqual(s.log.requests[0].body, { op: "cart_add", token: TOKEN, variantId: "1002" });
  assert.equal(s.log.requests[0].path, "/apps/konvert-notify/api/notify");
  assert.equal(s.log.requests[0].method, "POST");
  await s.api.checkNotifyCart();
  await s.api.checkNotifyCart();
  assert.equal(s.log.requests.length, 1, "repeated callbacks send nothing more once it is recorded");
});

test("storefront: an unrelated product, a failed addition and an unchanged cart are never reported", async () => {
  const s = storefront();
  s.api.trackNotifyCart();
  await settle();
  s.state.cart.push(["2002", 3]); // an unrelated product
  await s.api.checkNotifyCart();
  assert.equal(s.log.requests.length, 0, "another variant in the cart is not the emailed one");
  // a failed cart addition leaves Shopify's cart unchanged, and the cart is what is trusted
  await s.api.checkNotifyCart();
  assert.equal(s.log.requests.length, 0, "nothing was added: nothing is reported");
});

test("storefront: a line already in the cart before the email is not credited; only a real increase is", async () => {
  const s = storefront({ cart: [["1002", 1]] });
  s.api.trackNotifyCart();
  await settle();
  assert.equal(s.api.readNotifyCtx().b, 1);
  await s.api.checkNotifyCart();
  assert.equal(s.log.requests.length, 0, "the earlier line is the baseline");
  s.state.cart[0][1] = 2;
  await s.api.checkNotifyCart();
  assert.equal(s.log.requests.length, 1);
});

test("storefront: reloading the landing page keeps the first baseline, and survives navigation to another page (the stored context is what is read)", async () => {
  const s = storefront();
  s.api.trackNotifyCart();
  await settle();
  s.state.cart.push(["1002", 1]); // added; then the page reloads with the same link
  const reload = storefront({ shared: s.state });
  reload.api.trackNotifyCart();
  await settle();
  assert.equal(reload.api.readNotifyCtx().b, 0, "the baseline is not replaced by the later cart");
  assert.equal(reload.log.requests.length, 1, "the cart page load (a plain form post) is enough to report it");
  const cartPage = storefront({ search: "", shared: s.state }); // another page: no token in the URL, context from storage
  cartPage.api.trackNotifyCart();
  await settle();
  assert.equal(cartPage.log.requests.length, 0, "already recorded: nothing repeats");
});

test("storefront: a visitor who is not signed in keeps the context and reports only after signing in; a refusal clears it, a server error retries", async () => {
  const guest = storefront({ loggedIn: false });
  guest.api.trackNotifyCart();
  await settle();
  guest.state.cart.push(["1002", 1]);
  await guest.api.checkNotifyCart();
  assert.equal(guest.log.requests.length, 0, "no identity, nothing is sent");
  const signedIn = storefront({ search: "", shared: guest.state });
  await signedIn.api.checkNotifyCart();
  assert.equal(signedIn.log.requests.length, 1);

  const refusedOnce = storefront({ respond: () => ({ status: 422 }) });
  refusedOnce.api.trackNotifyCart();
  await settle();
  refusedOnce.state.cart.push(["1002", 1]);
  await refusedOnce.api.checkNotifyCart();
  assert.equal(refusedOnce.api.readNotifyCtx(), null, "a final refusal drops the token");

  const flaky = storefront({ respond: (o, n) => (n === 1 ? { status: 500 } : {}) });
  flaky.api.trackNotifyCart();
  await settle();
  flaky.state.cart.push(["1002", 1]);
  await flaky.api.checkNotifyCart();
  assert.equal(flaky.api.readNotifyCtx().done, false, "a server error keeps it for the next attempt");
  await flaky.api.checkNotifyCart();
  assert.equal(flaky.log.requests.length, 2);
  assert.equal(flaky.api.readNotifyCtx().done, true);
});

test("storefront: a cart write by the theme (fetch to /cart/add) triggers the check; other requests do not; malformed links track nothing", async () => {
  const s = storefront();
  s.api.trackNotifyCart();
  await settle();
  s.state.cart.push(["1002", 1]);
  await s.win.fetch("/products/board.js");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(s.log.requests.length, 0, "an unrelated request triggers nothing");
  await s.win.fetch("/cart/add.js", { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(s.log.requests.length, 1, "the theme's own add-to-cart is noticed, then confirmed against the cart");

  for (const search of ["?variant=1002&kw_n=short", `?kw_n=${TOKEN}`, `?variant=abc&kw_n=${TOKEN}`, "?variant=1002"]) {
    const bad = storefront({ search });
    bad.api.trackNotifyCart();
    await settle();
    assert.equal(bad.api.readNotifyCtx(), null, search);
  }
  const off = storefront({ notifyEnabled: false });
  off.api.trackNotifyCart();
  await settle();
  assert.equal(off.api.readNotifyCtx(), null, "nothing is tracked while Notify Me is off");
});
