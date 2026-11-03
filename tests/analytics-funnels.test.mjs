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
  await analyticsWorker.runAnalyticsDaily({ now: () => NOW, shopIds: [shop.id], backfillPerShop: 400, log: { log() {}, error() {} } });
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
  assert.match(source, /Promise\.all\(\[getCachedAnalyticsOverview\(shop, period\), getAttribution\(shop\.id, period,/); // the cache wraps getAnalyticsOverview (analytics-cache.server.js)
  assert.equal(source.includes("getAnalytics("), false, "the heavy loader is no longer used by this screen");
  for (const file of ["app/routes/app._index.jsx"]) assert.ok(fs.readFileSync(file, "utf8").includes("getDashboard(shop, period)"), `${file} still uses getDashboard`);
});
