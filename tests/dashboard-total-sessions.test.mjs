// Dashboard "Total sessions": counted live from BrowsingSession (Wishlist + Notify Me), never from AnalyticsDaily.
//
// Run: node --test tests/dashboard-total-sessions.test.mjs
//
// WRITES to the database in DATABASE_URL: run on a scratch database only. Every row belongs to uniquely named test shops
// that are removed at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prismaModule = require("@prisma/client");
const { PrismaClient } = prismaModule;
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const NOW = new Date("2026-10-22T10:00:00.000Z");
const at = (iso) => new Date(iso);
const domains = [];
let counter = 9940000000;
let capture = null;
let reporting;
let worker;
let periodModule;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  delete process.env.REDIS_URL;
  // The app's own client logs every statement, so a test can see exactly which tables the Dashboard loader reads.
  prismaModule.PrismaClient = class extends PrismaClient {
    constructor(options) {
      super({ ...options, log: [{ emit: "event", level: "query" }] });
      this.$on("query", (event) => capture?.push(event.query));
    }
  };
  reporting = await import("../app/models/reporting.server.js");
  worker = await import("../app/worker/analytics-daily.server.js");
  periodModule = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const sessionAt = (shop, actor, feature, iso) =>
  prisma.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature, startedAt: at(iso), expiresAt: new Date(at(iso).getTime() + 30 * 60 * 1000) } });
const eventAt = (shop, actor, session, type, iso) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: session.id, type, feature: session.feature, productGid: "gid://shopify/Product/1", occurredAt: at(iso) } });
const fill = (shop, now = NOW) => worker.runAnalyticsDaily({ now: () => now, shopIds: [shop.id], backfillPerShop: 500, log: { log() {}, error() {} }, invalidate: async () => {} });

async function newShop(tag) {
  const domain = `kw-dts-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  const created = await prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-09-01T00:00:00Z") } });
  const shop = await prisma.shop.findUnique({ where: { id: created.id } });
  return { shop, actor: await actorOf(shop) };
}

// Last 7 days at NOW is [2026-10-16, 2026-10-23); the previous period is [2026-10-09, 2026-10-16).
async function seed(tag) {
  const { shop, actor } = await newShop(tag);
  const other = await newShop(`${tag}-other`);
  await sessionAt(shop, actor, "WISHLIST", "2026-10-20T10:00:00Z"); // opened the page, nothing else: no ActivityEvent
  const busy = await sessionAt(shop, actor, "WISHLIST", "2026-10-18T10:00:00Z");
  await eventAt(shop, actor, busy, "WISHLIST_ADDED", "2026-10-18T10:01:00Z");
  await eventAt(shop, actor, busy, "WISHLIST_ADDED", "2026-10-18T10:02:00Z"); // two events, still one session
  await sessionAt(shop, actor, "WISHLIST", "2026-10-16T00:00:00.000Z"); // first instant of the range
  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-21T10:00:00Z"); // form opened, nobody subscribed
  await sessionAt(shop, actor, "WISHLIST", "2026-10-10T10:00:00Z"); // previous period
  await sessionAt(shop, actor, "WISHLIST", "2026-10-15T23:59:59.999Z"); // last instant of the previous period
  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-12T10:00:00Z"); // previous period
  await sessionAt(shop, actor, "WISHLIST", "2026-10-08T10:00:00Z"); // before the previous period
  await sessionAt(other.shop, other.actor, "WISHLIST", "2026-10-20T10:00:00Z"); // another shop
  await sessionAt(other.shop, other.actor, "NOTIFY_ME", "2026-10-12T10:00:00Z");
  return { shop, actor, other };
}

const dashboard = (shop, input = 7) => reporting.getDashboard(shop, input, NOW);

test("Total sessions = Wishlist + Notify Me BrowsingSession rows in the range, including sessions with no ActivityEvent", async () => {
  const { shop } = await seed("sum");
  const d = await dashboard(shop);
  assert.equal(d.sessions.current, 4, "3 Wishlist (one idle, one with two events, one at the first instant) + 1 Notify Me (idle)");
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id, browsingSessionId: { not: null } } }), 2, "only one of those sessions has events");
  const wishlist = await reporting.sessionCountOf(shop.id, "WISHLIST", at("2026-10-16T00:00:00Z"), at("2026-10-23T00:00:00Z"));
  const notifyMe = await reporting.sessionCountOf(shop.id, "NOTIFY_ME", at("2026-10-16T00:00:00Z"), at("2026-10-23T00:00:00Z"));
  assert.deepEqual([wishlist, notifyMe, wishlist + notifyMe], [3, 1, 4], "the parts and their sum");
  const raw = await prisma.browsingSession.count({ where: { shopId: shop.id, startedAt: { gte: at("2026-10-16T00:00:00Z"), lt: at("2026-10-23T00:00:00Z") } } });
  assert.equal(d.sessions.current, raw, "the same number a plain COUNT(BrowsingSession.id) gives");
});

test("the shop filter and the date range (UTC boundaries) are applied", async () => {
  const { shop, other } = await seed("filters");
  assert.equal((await dashboard(shop)).sessions.current, 4);
  assert.equal((await dashboard(other.shop)).sessions.current, 1, "another shop sees only its own session in this range");
  assert.equal((await dashboard(shop, 30)).sessions.current, 8, "Last 30 days takes in every session of this shop");
  const day = periodModule.customPeriod("2026-10-16", "2026-10-16", NOW).period;
  assert.equal((await dashboard(shop, day)).sessions.current, 1, "the 16th only: the session at 00:00:00.000 is in, the one at 23:59:59.999 on the 15th is not");
  const edge = periodModule.customPeriod("2026-10-15", "2026-10-15", NOW).period;
  assert.equal((await dashboard(shop, edge)).sessions.current, 1, "the 15th only: its last millisecond is in");
});

test("the previous-period comparison counts the BrowsingSession rows of the previous period", async () => {
  const { shop, other } = await seed("previous");
  const d = await dashboard(shop);
  assert.equal(d.comparable, true);
  assert.equal(d.sessions.previous, 3, "2 Wishlist (the 10th and the last millisecond of the 15th) + 1 Notify Me (the 12th); the 8th is too early");
  assert.equal((await dashboard(other.shop)).sessions.previous, 1);
  const fresh = await newShop("previous-new");
  assert.equal((await dashboard(fresh.shop, 30)).sessions.previous, null, "a shop installed inside the previous period has no comparison, as before");
});

test("a new BrowsingSession shows on the next load with no worker run, and the Dashboard never reads AnalyticsDaily", async () => {
  const { shop, actor } = await seed("live");
  assert.equal(await prisma.analyticsDaily.count({ where: { shopId: shop.id } }), 0, "no daily summary exists at all");
  capture = [];
  const first = await dashboard(shop);
  const statements = capture;
  capture = null;
  assert.equal(first.sessions.current, 4);
  assert.ok(statements.some((sql) => /BrowsingSession/i.test(sql)), "it reads BrowsingSession");
  assert.deepEqual(statements.filter((sql) => /AnalyticsDaily/i.test(sql)), [], "and no statement of the loader touches AnalyticsDaily");

  await sessionAt(shop, actor, "WISHLIST", "2026-10-22T09:30:00Z");
  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-22T09:31:00Z");
  assert.equal((await dashboard(shop)).sessions.current, 6, "both new sessions are in the next loader result");
  assert.equal(await prisma.analyticsDaily.count({ where: { shopId: shop.id } }), 0, "still no worker run");
});

test("Analytics keeps reading its session counts from AnalyticsDaily, and agrees once the worker has run", async () => {
  const { shop, actor } = await seed("analytics");
  const before = await reporting.getAnalyticsOverview(shop, 7, NOW);
  assert.deepEqual([before.sessionActivity.wishlist.current, before.sessionActivity.notifyMe.current], [null, null], "nothing stored yet, so Analytics has nothing to show");
  assert.equal((await dashboard(shop)).sessions.current, 4, "while the Dashboard already counts");

  await fill(shop);
  const filled = await reporting.getAnalyticsOverview(shop, 7, NOW);
  assert.deepEqual([filled.sessionActivity.wishlist.current, filled.sessionActivity.notifyMe.current], [3, 1]);
  assert.equal((await dashboard(shop)).sessions.current, filled.sessionActivity.wishlist.current + filled.sessionActivity.notifyMe.current);

  await sessionAt(shop, actor, "WISHLIST", "2026-10-22T09:40:00Z");
  assert.equal((await reporting.getAnalyticsOverview(shop, 7, NOW)).sessionActivity.wishlist.current, 3, "Analytics waits for the next worker run");
  assert.equal((await dashboard(shop)).sessions.current, 5, "the Dashboard does not");
  await fill(shop, new Date(NOW.getTime() + 60 * 1000));
  assert.equal((await reporting.getAnalyticsOverview(shop, 7, NOW)).sessionActivity.wishlist.current, 4);
});

test("the Dashboard session total has no AnalyticsDaily dependency in the source and the Analytics page is unchanged", () => {
  const source = fs.readFileSync("app/models/reporting.server.js", "utf8");
  const start = source.indexOf("async function totalSessions(");
  const body = source.slice(start, start + source.slice(start).search(/\r?\n\}\r?\n/));
  assert.ok(start > 0 && /sessionCountOf\(shopId, "WISHLIST"/.test(body) && /sessionCountOf\(shopId, "NOTIFY_ME"/.test(body));
  assert.equal(/summarizedActivity|analyticsDaily/i.test(body), false);
  assert.match(source, /sessions: \{ wishlist: sessions\("wishlistSessions"\), notifyMe: sessions\("notifyMeSessions"\) \}/, "summarizedActivity (Analytics) still sums the stored columns");
  const analytics = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");
  assert.match(analytics, /label="Wishlist sessions" value=\{a\.sessionActivity\.wishlist\.current\}/);
  assert.match(analytics, /label="Notify Me sessions" value=\{a\.sessionActivity\.notifyMe\.current\}/);
});
