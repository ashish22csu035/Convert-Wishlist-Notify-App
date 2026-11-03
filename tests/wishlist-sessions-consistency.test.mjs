// Sessions on the Dashboard and Analytics: every BrowsingSession counts once, on the UTC day it started, whether or not the
// customer did anything in it. Dashboard "Total sessions" = Wishlist sessions + Notify Me sessions, counted live from
// BrowsingSession; the two Analytics cards are those two parts, read from the stored daily summaries. Once the worker has
// filled the summaries the screens agree (tests/dashboard-total-sessions.test.mjs covers the Dashboard on its own).
//
// Run: node --test tests/wishlist-sessions-consistency.test.mjs
//
// WRITES to the database in DATABASE_URL: run on a scratch database only. Every row belongs to uniquely named test shops
// that are removed at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const NOW = new Date("2026-10-22T10:00:00.000Z");
// A later worker run: a stored day is only replaced by a calculation that started after it (see writeAnalyticsDay).
const LATER = new Date(NOW.getTime() + 60 * 1000);
const at = (iso) => new Date(iso);
const domains = [];
let counter = 9960000000;
let reporting;
let cacheModel;
let worker;
let P;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  delete process.env.REDIS_URL;
  reporting = await import("../app/models/reporting.server.js");
  cacheModel = await import("../app/models/analytics-cache.server.js");
  worker = await import("../app/worker/analytics-daily.server.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const quiet = { log() {}, error() {} };
const fill = (shop, over = {}) => worker.runAnalyticsDaily({ now: () => NOW, shopIds: [shop.id], backfillPerShop: 500, log: quiet, invalidate: async () => {}, ...over });
const custom = (from, to) => P.customPeriod(from, to, NOW).period;
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const sessionAt = (shop, actor, feature, iso) =>
  prisma.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature, startedAt: at(iso), expiresAt: new Date(at(iso).getTime() + 30 * 60 * 1000) } });
const eventAt = (shop, actor, session, type, iso) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: session.id, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: "gid://shopify/Product/1", occurredAt: at(iso) } });

// The numbers each screen's loader reports for a range.
const dashboard = async (shop, input) => (await reporting.getDashboard(shop, input, NOW)).sessions;
const analytics = async (shop, input) => (await reporting.getAnalyticsOverview(shop, input, NOW)).sessionActivity;

async function seed(tag) {
  const domain = `kw-sess-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  const created = await prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-09-01T00:00:00Z") } });
  const shop = await prisma.shop.findUnique({ where: { id: created.id } });
  const actor = await actorOf(shop);

  await sessionAt(shop, actor, "WISHLIST", "2026-10-20T10:00:00Z"); // opened the page, did nothing: counted
  const busy = await sessionAt(shop, actor, "WISHLIST", "2026-10-20T11:00:00Z"); // many events: still one session
  for (const type of ["WISHLIST_ADDED", "WISHLIST_ADDED", "WISHLIST_REMOVED"]) await eventAt(shop, actor, busy, type, "2026-10-20T11:01:00Z");
  const crossing = await sessionAt(shop, actor, "WISHLIST", "2026-10-20T23:50:00Z"); // starts on the 20th, active on the 21st
  await eventAt(shop, actor, crossing, "WISHLIST_PRODUCT_CLICKED", "2026-10-21T00:05:00Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-20T23:59:59.999Z"); // last millisecond of the 20th
  await sessionAt(shop, actor, "WISHLIST", "2026-10-21T00:00:00.000Z"); // first millisecond of the 21st
  await sessionAt(shop, actor, "WISHLIST", "2026-10-18T12:00:00Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-17T12:00:00Z");
  const cart = await sessionAt(shop, actor, "WISHLIST", "2026-10-16T12:00:00Z"); // only an add-to-cart event
  await eventAt(shop, actor, cart, "WISHLIST_ADDED_TO_CART", "2026-10-16T12:01:00Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-10T09:00:00Z"); // outside Last 7 days

  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-19T09:00:00Z"); // form opened, nobody subscribed
  const subscribed = await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-21T09:00:00Z");
  await eventAt(shop, actor, subscribed, "NOTIFY_SUBSCRIBED", "2026-10-21T09:02:00Z");

  await fill(shop);
  return { shop, actor };
}

test("Dashboard Total sessions equals the Analytics Wishlist sessions plus Notify Me sessions, for Last 7, Last 30 and custom ranges", async () => {
  const { shop } = await seed("same");
  const ranges = [
    [7, 8, 2, "Last 7 days: eight Wishlist sessions (the 10th is outside) and two Notify Me sessions"],
    [30, 9, 2, "Last 30 days"],
    [custom("2026-10-20", "2026-10-20"), 4, 0, "the 20th only: the 23:59:59.999 session is in, the 00:00:00.000 one is not"],
    [custom("2026-10-21", "2026-10-21"), 1, 1, "the 21st only: the session that started on the 20th is not"],
    [custom("2026-10-19", "2026-10-21"), 5, 2, "three days"],
    [custom("2026-10-01", "2026-10-15"), 1, 0, "early October"],
  ];
  for (const [input, wishlist, notifyMe, why] of ranges) {
    const cards = await analytics(shop, input);
    assert.equal(cards.wishlist.current, wishlist, `Analytics Wishlist sessions, ${why}`);
    assert.equal(cards.notifyMe.current, notifyMe, `Analytics Notify Me sessions, ${why}`);
    const total = await dashboard(shop, input);
    assert.equal(total.current, wishlist + notifyMe, `Dashboard Total sessions, ${why}`);
    assert.equal(total.previous, cards.wishlist.previous === null || cards.notifyMe.previous === null ? null : cards.wishlist.previous + cards.notifyMe.previous, `previous period, ${why}`);
  }
});

test("each session is counted once in its own feature: a session with no event counts, and Wishlist never leaks into Notify Me", async () => {
  const { shop } = await seed("features");
  const rows = await prisma.browsingSession.groupBy({ by: ["feature"], where: { shopId: shop.id }, _count: { _all: true } });
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.feature, r._count._all])), { WISHLIST: 9, NOTIFY_ME: 2 });
  const all = P.customPeriod("2026-10-01", "2026-10-22", NOW).period;
  assert.deepEqual([(await analytics(shop, all)).wishlist.current, (await analytics(shop, all)).notifyMe.current], [9, 2], "every raw row, including the ones without events");
  assert.equal((await dashboard(shop, all)).current, 11);
  assert.equal(await reporting.sessionCountOf(shop.id, "WISHLIST", at("2026-10-01T00:00:00Z"), null), 9);
  assert.equal(await reporting.sessionCountOf(shop.id, "NOTIFY_ME", at("2026-10-01T00:00:00Z"), null), 2);
});

test("another shop's sessions are never counted", async () => {
  const mine = await seed("iso-a");
  const other = await seed("iso-b");
  const extra = await sessionAt(other.shop, other.actor, "NOTIFY_ME", "2026-10-21T08:00:00Z");
  assert.ok(extra.id);
  await fill(other.shop, { now: () => LATER });
  assert.equal((await dashboard(mine.shop, 30)).current, 11);
  assert.equal((await dashboard(other.shop, 30)).current, 12);
  assert.equal((await analytics(other.shop, 30)).notifyMe.current, 3);
  assert.equal((await analytics(mine.shop, 30)).notifyMe.current, 2);
});

test("missing or unfinished daily summaries make Analytics show a lower bound or unavailable, while the Dashboard still counts every session", async () => {
  const { shop } = await seed("gaps");
  await prisma.analyticsDaily.deleteMany({ where: { shopId: shop.id, day: at("2026-10-20T00:00:00Z") } }); // 4 Wishlist sessions
  await prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: at("2026-10-10T00:00:00Z") }, data: { notifyUnsubscribed: null } }); // 1 Wishlist session
  const cards = await analytics(shop, 30);
  assert.deepEqual([cards.wishlist.current, cards.notifyMe.current], [4, 2], "9 - 4 - 1 Wishlist sessions are left");
  assert.equal((await dashboard(shop, 30)).current, 11, "the Dashboard does not read the summaries, so the gaps do not touch it");
  assert.equal((await reporting.getAnalyticsOverview(shop, 30, NOW)).coverage.complete, false);

  const nulled = await seed("gaps-null");
  await prisma.analyticsDaily.updateMany({ where: { shopId: nulled.shop.id, day: at("2026-10-20T00:00:00Z") }, data: { wishlistSessions: null, wishlistSessionsCarried: null } });
  assert.equal((await analytics(nulled.shop, 30)).wishlist.current, 5, "a NULL day is skipped, not read as zero");

  const empty = await seed("gaps-empty");
  await prisma.analyticsDaily.deleteMany({ where: { shopId: empty.shop.id } });
  assert.equal((await analytics(empty.shop, 30)).wishlist.current, null, "no usable summary: Analytics is unavailable");
  assert.equal((await dashboard(empty.shop, 30)).current, 11, "and the Dashboard still has its number");
});

test("after the worker writes new summaries and invalidates the cache, the cached Analytics figures and the Dashboard agree", async () => {
  const { shop, actor } = await seed("cache");
  const store = new Map();
  const versions = new Map();
  const deps = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => { store.set(key, value); return true; },
    version: async (key) => String(versions.get(key) ?? 0),
  };
  const invalidate = async (shopId) => versions.set(cacheModel.analyticsVersionKey(shopId), (versions.get(cacheModel.analyticsVersionKey(shopId)) ?? 0) + 1);
  const cached = async () => (await cacheModel.getCachedAnalyticsOverview(shop, 30, NOW, deps)).sessionActivity;

  assert.equal((await cached()).wishlist.current, 9);
  assert.equal((await cached()).wishlist.current, 9, "the second request is served from the cache");

  await sessionAt(shop, actor, "WISHLIST", "2026-10-22T08:00:00Z"); // opened and abandoned
  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-22T08:30:00Z");
  assert.equal((await cached()).wishlist.current, 9, "until the worker runs, the cache and the stored summaries still say 9");
  assert.equal((await dashboard(shop, 30)).current, 13, "but the Dashboard counts BrowsingSession live and already says 13");

  await fill(shop, { invalidate, now: () => LATER });
  const after = await cached();
  assert.deepEqual([after.wishlist.current, after.notifyMe.current], [10, 3], "the worker bumped the version, so the next Analytics request recalculates");
  assert.equal((await dashboard(shop, 30)).current, after.wishlist.current + after.notifyMe.current, "and now the screens agree");
});

test("the screens: Dashboard shows Total sessions, Analytics keeps separate Wishlist and Notify Me cards", () => {
  const dashboardPage = fs.readFileSync("app/routes/app._index.jsx", "utf8");
  const analyticsPage = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");
  assert.match(dashboardPage, /<KpiCard label="Total sessions" value=\{d\.sessions\.current\}/);
  assert.equal(/label="Wishlist sessions"/.test(dashboardPage), false, "the Dashboard no longer shows Wishlist sessions on its own");
  assert.match(analyticsPage, /<KpiCard label="Wishlist sessions" value=\{a\.sessionActivity\.wishlist\.current\}/);
  assert.match(analyticsPage, /<KpiCard label="Notify Me sessions" value=\{a\.sessionActivity\.notifyMe\.current\}/);
});
