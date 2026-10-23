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
let F;
let P;
let counter = 9700000000;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  reporting = await import("../app/models/reporting.server.js");
  F = await import("../app/utils/funnel.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

// ======================= Wishlist and Notify Me funnels =======================
const window = { WISHLIST_ADDED: 12, WISHLIST_PRODUCT_CLICKED: 5, NOTIFY_SUBSCRIBED: 8, RESTOCK_EMAIL_SENT: 6 };
const ready = { state: "ready", currency: "USD", overall: { orders: 3, revenue: "90.00" }, wishlist: { orders: 2, revenue: "60.00" }, notifyMe: { orders: 1, revenue: "30.00" } };

test("Wishlist funnel: only Wishlist events and the Wishlist attribution, with no cart or checkout stage and no percentages", () => {
  const funnel = F.buildFeatureFunnel("wishlist", { window, attribution: ready });
  assert.deepEqual(funnel.stages.map((s) => s.label), ["Products saved", "Opened from Wishlist", "Attributed orders", "Attributed revenue"]);
  assert.deepEqual(funnel.stages.map((s) => s.count), [12, 5, 2, 60]);
  assert.equal(funnel.stages[3].display, "$60.00");
  assert.ok(funnel.stages.every((s) => s.available && !("rate" in s)), "no conversion percentage exists on any stage");
  assert.equal(funnel.stages.some((s) => /cart|checkout|session/i.test(s.label)), false, "no stage is borrowed from the store funnel");
  assert.match(funnel.note, /Add to cart and checkout from the Wishlist are not tracked/);
  // the Notify Me figures never leak in, whatever their size
  assert.equal(JSON.stringify(funnel.stages).includes('"count":8'), false);
});

test("Notify Me funnel: subscriptions, emails the mail server accepted, and the Notify Me attribution", () => {
  const funnel = F.buildFeatureFunnel("notifyMe", { window, attribution: ready });
  assert.deepEqual(funnel.stages.map((s) => s.label), ["Subscriptions", "Restock emails sent", "Attributed orders", "Attributed revenue"]);
  assert.deepEqual(funnel.stages.map((s) => s.count), [8, 6, 1, 30]);
  assert.equal(funnel.stages[3].display, "$30.00");
  assert.ok(funnel.stages.every((s) => !("rate" in s)), "the stages are not a cohort, so no percentage");
  assert.match(funnel.note, /queued, failed, skipped and unknown ones do not/);
});

test("orders and revenue are unavailable, with the reason on the stage, when order data is missing or unusable", () => {
  for (const [attribution, reason] of [[{ state: "needs_access" }, /read_orders/], [{ state: "waiting" }, /No orders have been received/], [null, /read_orders/]]) {
    const stages = F.buildFeatureFunnel("notifyMe", { window, attribution }).stages;
    assert.deepEqual(stages.map((s) => s.count), [8, 6, null, null], "events still count; orders are not shown as zero");
    assert.match(stages[2].reason, reason);
    assert.match(stages[3].reason, reason);
  }
  const mixed = F.buildFeatureFunnel("wishlist", { window, attribution: { ...ready, mixedCurrency: true, wishlist: { orders: 2, revenue: null } } }).stages;
  assert.deepEqual(mixed.map((s) => s.count), [12, 5, 2, null], "orders are real, revenue is not added across currencies");
  assert.match(mixed[3].reason, /more than one currency/);
  const confirmedZero = F.buildFeatureFunnel("notifyMe", { window, attribution: { ...ready, notifyMe: { orders: 0, revenue: "0.00" } } }).stages;
  assert.deepEqual([confirmedZero[2].count, confirmedZero[3].count, confirmedZero[3].display], [0, 0, "$0.00"], "a confirmed zero stays a zero");
});

test("a funnel with no activity is empty, and unavailable stages do not count as activity", () => {
  const none = F.buildFeatureFunnel("wishlist", { window: {}, attribution: { state: "waiting" } });
  assert.deepEqual(none.stages.map((s) => s.count), [null, null, null, null], "missing event counts are unavailable, not zero");
  assert.equal(F.isEmptyFunnel(none.stages), true);
  const zero = F.buildFeatureFunnel("notifyMe", { window: { NOTIFY_SUBSCRIBED: 0, RESTOCK_EMAIL_SENT: 0 }, attribution: ready });
  assert.equal(F.isEmptyFunnel(F.buildFeatureFunnel("notifyMe", { window: { NOTIFY_SUBSCRIBED: 0, RESTOCK_EMAIL_SENT: 0 }, attribution: { ...ready, notifyMe: { orders: 0, revenue: "0.00" } } }).stages), true);
  assert.equal(F.isEmptyFunnel(zero.stages), false, "an attributed order alone is activity");
});

// ======================= the funnels follow the date range (real database) =======================
const makeShop = async (tag) => {
  const domain = `kw-funnel-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-01-01T00:00:00Z") } });
};

test("both feature funnels count exactly the selected days, and only emails that were accepted are 'sent'", async () => {
  const shop = await makeShop("range");
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
  const variantGid = "gid://shopify/ProductVariant/77";
  const event = (type, iso) => prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: "gid://shopify/Product/1", variantGid, occurredAt: at(iso) } });
  await event("WISHLIST_ADDED", "2026-10-01T23:59:59Z"); // before
  await event("WISHLIST_ADDED", "2026-10-02T00:00:00Z");
  await event("WISHLIST_ADDED", "2026-10-03T23:59:59Z");
  await event("WISHLIST_ADDED", "2026-10-04T00:00:00Z"); // after
  await event("WISHLIST_PRODUCT_CLICKED", "2026-10-03T08:00:00Z");
  await event("WISHLIST_REMOVED", "2026-10-03T09:00:00Z"); // not a funnel stage
  await event("NOTIFY_SUBSCRIBED", "2026-10-02T12:00:00Z");
  await event("NOTIFY_SUBSCRIBED", "2026-10-09T12:00:00Z"); // after
  const sentEvent = await event("RESTOCK_EMAIL_SENT", "2026-10-03T12:00:00Z");

  // deliveries in every state: only the accepted one has the RESTOCK_EMAIL_SENT event the funnel reads
  await prisma.variantAvailability.create({ data: { shopId: shop.id, variantGid, productGid: "gid://shopify/Product/1", inventoryItemGid: "gid://shopify/InventoryItem/77", isInStock: true, restockCycle: 6 } });
  const sub = await prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid, email: "customer@example.invalid", baselineCycle: 0, consentedAt: at("2026-10-01T00:00:00Z"), consentSource: "test" } });
  for (const [cycle, status] of [[1, "SENT"], [2, "PENDING"], [3, "FAILED"], [4, "SKIPPED"], [5, "UNKNOWN"], [6, "SENDING"]]) {
    await prisma.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: sub.id, restockCycle: cycle, variantGid, status, createdAt: at("2026-10-03T00:00:00Z") } });
  }

  // one Wishlist and one Notify Me purchase inside the range, one Wishlist purchase outside
  let n = 0;
  const attributed = async (feature, placedAt, amount, touchEventId) => {
    n += 1;
    const order = await prisma.shopifyOrder.create({ data: { shopId: shop.id, orderGid: `gid://shopify/Order/${RUN}${n}`, orderName: `#${n}`, customerGid: actor.customerGid, placedAt: at(placedAt), financialStatus: "PAID", currencyCode: "USD", totalPrice: amount, shopifyUpdatedAt: at(placedAt) } });
    await prisma.orderAttribution.create({ data: { shopId: shop.id, orderId: order.id, feature, touchEventId, touchedAt: at("2026-10-02T00:00:00Z"), matchedProductGid: "gid://shopify/Product/1", grossAmount: amount, currencyCode: "USD" } });
  };
  await attributed("WISHLIST", "2026-10-03T10:00:00Z", 25, null);
  await attributed("NOTIFY_ME", "2026-10-03T11:00:00Z", 40, sentEvent.id);
  await attributed("WISHLIST", "2026-10-06T10:00:00Z", 99, null);

  const { period } = P.customPeriod("2026-10-02", "2026-10-03", NOW);
  const ref = await reporting.getShopByDomain(shop.domain);
  const analytics = await reporting.getAnalytics(ref, period, NOW);
  const attribution = await reporting.getAttribution(shop.id, period, { scopeGranted: true, now: NOW });

  const wishlist = F.buildFeatureFunnel("wishlist", { window: analytics.activity.window, attribution });
  assert.deepEqual(wishlist.stages.map((s) => s.count), [2, 1, 1, 25], "saves and opens inside the range; removals are not a stage; the outside purchase is excluded");
  const notify = F.buildFeatureFunnel("notifyMe", { window: analytics.activity.window, attribution });
  assert.deepEqual(notify.stages.map((s) => s.count), [1, 1, 1, 40], "one accepted email, not six deliveries");
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id } }), 6, "the other five deliveries exist but are not counted as sent");

  // a preset covers everything to now and the numbers move accordingly
  const wide = await reporting.getAnalytics(ref, 30, NOW);
  assert.equal(F.buildFeatureFunnel("wishlist", { window: wide.activity.window, attribution: await reporting.getAttribution(shop.id, 30, { scopeGranted: true, now: NOW }) }).stages[0].count, 4, "all four saves up to now");
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
  assert.equal((sessionGrid.match(/not customers and not total events/g) ?? []).length, 2, "both tooltips say what is counted");
  assert.match(source, /<FunnelSwitch funnels={funnels} rangeLabel={words\.label} \/>/);
  assert.match(source, /buildFeatureFunnel\("wishlist", \{ window: analytics\.activity\.window, attribution \}\)/, "the existing dashboard counts and attribution service are reused");
  for (const gone of [
    "Store conversion", "storeFunnel", "fetchStoreFunnel", "buildStoreFunnel", "ProductFunnel", "Sessions", "Checkout initiated",
    "Unique Wishlist users", "Average saved items per customer", "Emails accepted by mail server",
    "Product opens from Wishlist", "UnavailableCard", "Not available yet",
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
  assert.equal(analytics.sessionActivity.notifyMe.current, 1, "one session with two sign-ups; emails and unsubscribes are not sessions; an idle session has no event");
  const w = analytics.activity.window;
  assert.equal(w.WISHLIST_ADDED + w.WISHLIST_PRODUCT_CLICKED + w.WISHLIST_REMOVED, 6);
});

test("sessions: the date range decides by when the activity happened, and a session is counted once even when it spans the edge", async () => {
  const shop = await makeShop("sessrange");
  const a = await actorOf(shop);
  const early = await session(shop, a, "WISHLIST", "2026-10-01T23:50:00Z");
  await sessionEvent(shop, a, early, "WISHLIST_ADDED", "2026-10-01T23:59:59Z"); // out
  await sessionEvent(shop, a, early, "WISHLIST_ADDED", "2026-10-02T00:00:00Z"); // in: the session counts once for this range
  const late = await session(shop, a, "WISHLIST", "2026-10-03T23:50:00Z");
  await sessionEvent(shop, a, late, "WISHLIST_ADDED", "2026-10-03T23:59:59Z"); // in
  await sessionEvent(shop, a, late, "WISHLIST_ADDED", "2026-10-04T00:00:00Z"); // out
  const onlyOutside = await session(shop, a, "WISHLIST", "2026-10-05T10:00:00Z");
  await sessionEvent(shop, a, onlyOutside, "WISHLIST_ADDED", "2026-10-05T10:01:00Z");
  const count = (period) => reporting.sessionsWithActivity(shop.id, "WISHLIST", period.since, period.until);
  assert.equal(await count(range("2026-10-02", "2026-10-03")), 2);
  assert.equal(await count(range("2026-10-01", "2026-10-01")), 1);
  assert.equal(await count(range("2026-10-04", "2026-10-04")), 1);
  assert.equal(await count(range("2026-10-06", "2026-10-07")), 0, "a period with no activity is a confirmed zero");
  assert.equal(await count(P.presetPeriod(30, NOW)), 3, "a preset runs to now; each session once");
  assert.equal(await reporting.sessionsWithActivity(shop.id, "NOTIFY_ME", P.presetPeriod(30, NOW).since, null), 0, "the other feature has none");
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

test("sessions: events that carry no session make the count unavailable, never a guess; events outside the range do not", async () => {
  const shop = await makeShop("sessna");
  const a = await actorOf(shop);
  const s1 = await session(shop, a, "WISHLIST", "2026-10-02T10:00:00Z");
  await sessionEvent(shop, a, s1, "WISHLIST_ADDED", "2026-10-02T10:01:00Z");
  await sessionEvent(shop, a, null, "WISHLIST_ADDED", "2026-10-03T10:00:00Z"); // recorded before sessions existed
  const ref = await reporting.getShopByDomain(shop.domain);
  const bad = await reporting.getAnalytics(ref, range("2026-10-02", "2026-10-03"), NOW);
  assert.equal(bad.sessionActivity.wishlist.current, null, "cannot be attributed reliably: unavailable");
  assert.equal(bad.sessionActivity.notifyMe.current, 0, "the other feature is unaffected and a real zero");
  const clean = await reporting.getAnalytics(ref, range("2026-10-02", "2026-10-02"), NOW);
  assert.equal(clean.sessionActivity.wishlist.current, 1, "the unattributed event is outside this range");
});

test("no stage carries helper text, in either funnel and whatever the data", async () => {
  const phrases = ["Added to a Wishlist in this period", "Product opens from the Wishlist page", "New sign-ups in this period", "Accepted by the mail server", "Last touch within 7 days", "Net of refunds on the credited items"];
  const funnelSource = fs.readFileSync("app/utils/funnel.js", "utf8");
  for (const phrase of phrases) assert.equal(funnelSource.includes(phrase), false, phrase);
  for (const attribution of [ready, { state: "waiting" }, { ...ready, mixedCurrency: true, wishlist: { orders: 2, revenue: null }, notifyMe: { orders: 2, revenue: null } }]) {
    for (const feature of ["wishlist", "notifyMe"]) {
      for (const item of F.buildFeatureFunnel(feature, { window, attribution }).stages) assert.equal("caption" in item, false, `${feature}/${item.key} has no caption`);
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
