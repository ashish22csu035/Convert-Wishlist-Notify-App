// BrowsingSession rows versus the session totals in AnalyticsDaily, and the one-off recalculation of old summaries.
//
// A day's totals are the BrowsingSession rows that STARTED on that UTC day, per feature, whether or not the customer did
// anything in them. The carried columns are always 0.
//
// Run: node --test tests/analytics-session-reconciliation.test.mjs
//
// WRITES to the database in DATABASE_URL: run on a scratch database only. Every row belongs to uniquely named test shops
// that are removed at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const NOW = new Date("2026-10-22T10:00:00.000Z");
const at = (iso) => new Date(iso);
const domains = [];
let counter = 9950000000;
let reporting;
let daily;
let worker;
let recalc;
let P;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  delete process.env.REDIS_URL;
  reporting = await import("../app/models/reporting.server.js");
  daily = await import("../app/models/analytics-daily.server.js");
  worker = await import("../app/worker/analytics-daily.server.js");
  recalc = await import("../app/worker/recalculate-sessions.server.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const quiet = { log() {}, error() {} };
const minutesAfter = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000);
const run = (shop, now = NOW) => worker.runAnalyticsDaily({ now: () => now, shopIds: [shop.id], backfillPerShop: 500, log: quiet, invalidate: async () => {} });
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const sessionAt = (shop, actor, feature, iso) =>
  prisma.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature, startedAt: at(iso), expiresAt: new Date(at(iso).getTime() + 30 * 60 * 1000) } });
const eventAt = (shop, actor, session, type, iso) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: session.id, type, feature: session.feature, productGid: "gid://shopify/Product/1", occurredAt: at(iso) } });
const rowsOf = (shop) => prisma.analyticsDaily.findMany({ where: { shopId: shop.id }, orderBy: { day: "asc" } });
const dayOf = (row) => row.day.toISOString().slice(0, 10);
const byDay = async (shop) => Object.fromEntries((await rowsOf(shop)).map((r) => [dayOf(r), r]));
const sessionCols = (r) => [dayOf(r), r.wishlistSessions, r.notifyMeSessions, r.wishlistSessionsCarried, r.notifyMeSessionsCarried];

async function newShop(tag) {
  const domain = `kw-recon-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  const created = await prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-10-01T00:00:00Z") } });
  const shop = await prisma.shop.findUnique({ where: { id: created.id } });
  return { shop, actor: await actorOf(shop) };
}

// 19th: 3 Wishlist (one with events, two without) and 2 Notify Me (one subscribed). 20th: sessions at both edges of the day.
// 21st: a session that started on the 20th and is active on the 21st.
async function seedMixed(shop, actor) {
  const w1 = await sessionAt(shop, actor, "WISHLIST", "2026-10-19T09:00:00Z");
  await eventAt(shop, actor, w1, "WISHLIST_ADDED", "2026-10-19T09:01:00Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-19T12:00:00Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-19T15:00:00Z");
  const n1 = await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-19T10:00:00Z");
  await eventAt(shop, actor, n1, "NOTIFY_SUBSCRIBED", "2026-10-19T10:02:00Z");
  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-19T11:00:00Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-20T00:00:00.000Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-20T23:59:59.999Z");
  const crossing = await sessionAt(shop, actor, "WISHLIST", "2026-10-20T23:50:00Z");
  await eventAt(shop, actor, crossing, "WISHLIST_PRODUCT_CLICKED", "2026-10-21T00:05:00Z");
}

test("a day's totals are the sessions that started that day: no event needed, one feature each, several per day", async () => {
  const { shop, actor } = await newShop("per-day");
  await seedMixed(shop, actor);
  await run(shop);
  const rows = await byDay(shop);
  assert.deepEqual(sessionCols(rows["2026-10-19"]), ["2026-10-19", 3, 2, 0, 0], "two Wishlist sessions and one Notify Me session had no activity and still count");
  assert.deepEqual(sessionCols(rows["2026-10-20"]), ["2026-10-20", 3, 0, 0, 0], "00:00:00.000, 23:50 and 23:59:59.999 all started on the 20th");
  assert.deepEqual(sessionCols(rows["2026-10-21"]), ["2026-10-21", 0, 0, 0, 0], "the session that started on the 20th is not counted again on the 21st");
  const raw = await prisma.browsingSession.groupBy({ by: ["feature"], where: { shopId: shop.id }, _count: { _all: true } });
  const total = Object.fromEntries(raw.map((r) => [r.feature, r._count._all]));
  assert.deepEqual([total.WISHLIST, total.NOTIFY_ME], [6, 2]);
  const all = await rowsOf(shop);
  assert.deepEqual([all.reduce((n, r) => n + r.wishlistSessions, 0), all.reduce((n, r) => n + r.notifyMeSessions, 0)], [6, 2], "the stored days add up to the raw rows");
  const overview = await reporting.getAnalyticsOverview(shop, P.customPeriod("2026-10-19", "2026-10-21", NOW).period, NOW);
  assert.deepEqual([overview.sessionActivity.wishlist.current, overview.sessionActivity.notifyMe.current], [6, 2]);
});

test("calculateAnalyticsDay assigns by startedAt, excludes other shops, and never reads events", async () => {
  const { shop, actor } = await newShop("calc");
  const other = await newShop("calc-other");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-15T23:59:59.999Z");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-16T00:00:00.000Z");
  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-16T12:00:00Z");
  await sessionAt(other.shop, other.actor, "WISHLIST", "2026-10-16T12:00:00Z");
  const d15 = await daily.calculateAnalyticsDay(shop.id, "2026-10-15");
  const d16 = await daily.calculateAnalyticsDay(shop.id, "2026-10-16");
  assert.deepEqual([d15.wishlistSessions, d15.notifyMeSessions], [1, 0]);
  assert.deepEqual([d16.wishlistSessions, d16.notifyMeSessions, d16.wishlistSessionsCarried, d16.notifyMeSessionsCarried], [1, 1, 0, 0]);
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id } }), 0, "there is not a single event, and the sessions still count");
});

test("repeated runs are idempotent and an older calculation never overwrites a newer one", async () => {
  const { shop, actor } = await newShop("idempotent");
  await seedMixed(shop, actor);
  await run(shop);
  const first = (await rowsOf(shop)).map(sessionCols);
  await run(shop, minutesAfter(NOW, 5));
  await run(shop, minutesAfter(NOW, 10));
  assert.deepEqual((await rowsOf(shop)).map(sessionCols), first, "recalculating existing rows gives the same totals");

  const before = (await byDay(shop))["2026-10-22"];
  const summary = await run(shop, minutesAfter(NOW, -30)); // a worker that started earlier than the stored calculation
  assert.equal(summary.written, 0);
  assert.ok(summary.stale > 0);
  assert.equal((await byDay(shop))["2026-10-22"].updatedAt.getTime(), before.updatedAt.getTime());
});

test("a session opened just before a run is counted by it, one opened after is picked up by the next run, and never twice", async () => {
  const { shop, actor } = await newShop("timing");
  await sessionAt(shop, actor, "WISHLIST", "2026-10-22T09:58:00Z");
  await run(shop);
  const today = async () => (await byDay(shop))["2026-10-22"];
  assert.equal((await today()).wishlistSessions, 1);
  await sessionAt(shop, actor, "WISHLIST", "2026-10-22T10:01:00Z"); // opened after the calculation started
  await sessionAt(shop, actor, "NOTIFY_ME", "2026-10-22T10:02:00Z");
  assert.equal((await today()).wishlistSessions, 1, "the stored day does not know yet");
  await run(shop, minutesAfter(NOW, 5));
  assert.deepEqual([(await today()).wishlistSessions, (await today()).notifyMeSessions], [2, 1]);
  await run(shop, minutesAfter(NOW, 6));
  assert.deepEqual([(await today()).wishlistSessions, (await today()).notifyMeSessions], [2, 1], "running again does not add them twice");
});

// Rows as the old (event-based) definition wrote them: only sessions with qualifying events, a session over midnight in
// two rows with a carried count, and NULL where a day held events with no session.
async function backdate(shop) {
  // updatedAt is set by hand: Prisma would stamp the real clock, and the old rows were written by a worker run at NOW.
  const set = (day, data) => prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: at(`${day}T00:00:00Z`) }, data: { ...data, updatedAt: NOW } });
  await set("2026-10-19", { wishlistSessions: 1, notifyMeSessions: 1 });
  await set("2026-10-20", { wishlistSessions: 0, notifyMeSessions: 0 });
  await set("2026-10-21", { wishlistSessions: 1, wishlistSessionsCarried: 1 });
  await set("2026-10-17", { wishlistSessions: null, wishlistSessionsCarried: null });
}

test("historical summaries: the dry run reports and writes nothing; apply fixes only the session columns of the rows that differ; a second apply writes nothing", async () => {
  const { shop, actor } = await newShop("history");
  await seedMixed(shop, actor);
  await run(shop);
  const correct = await rowsOf(shop);
  await backdate(shop);
  const oldRows = await rowsOf(shop);
  const sessionsBefore = await prisma.browsingSession.findMany({ where: { shopId: shop.id }, orderBy: { id: "asc" } });
  const eventsBefore = await prisma.activityEvent.findMany({ where: { shopId: shop.id }, orderBy: { id: "asc" } });

  const bumped = [];
  const invalidate = async (shopId) => bumped.push(shopId);
  const dry = await recalc.recalculateSessionTotals({ shopIds: [shop.id], now: () => minutesAfter(NOW, 30), invalidate });
  assert.deepEqual(dry.changes.map((c) => c.day), ["2026-10-17", "2026-10-19", "2026-10-20", "2026-10-21"], "exactly the rows written under the old definition");
  assert.deepEqual([dry.changed, dry.written, bumped.length], [4, 0, 0], "a dry run does not touch the cache either");
  assert.deepEqual((await rowsOf(shop)).map((r) => [...sessionCols(r), r.updatedAt.getTime()]), oldRows.map((r) => [...sessionCols(r), r.updatedAt.getTime()]), "a dry run changes nothing");

  const applied = await recalc.recalculateSessionTotals({ shopIds: [shop.id], apply: true, now: () => minutesAfter(NOW, 30), invalidate });
  assert.deepEqual(bumped, [shop.id], "the shop's Analytics cache was invalidated once");
  assert.deepEqual([applied.changed, applied.written, applied.stale], [4, 4, 0]);
  const fixed = await rowsOf(shop);
  assert.deepEqual(fixed.map(sessionCols), correct.map(sessionCols), "the session columns are back to the new definition's values");
  for (const [i, row] of fixed.entries()) {
    const { updatedAt, ...rest } = row;
    const { updatedAt: _ignored, ...expected } = correct[i];
    assert.deepEqual(rest, expected, `${dayOf(row)}: nothing but the session columns differs`);
    const touched = ["2026-10-17", "2026-10-19", "2026-10-20", "2026-10-21"].includes(dayOf(row));
    assert.equal(updatedAt.getTime() === oldRows[i].updatedAt.getTime(), !touched, `${dayOf(row)}: only a changed row is rewritten`);
  }

  const second = await recalc.recalculateSessionTotals({ shopIds: [shop.id], apply: true, now: () => minutesAfter(NOW, 40), invalidate });
  assert.equal(bumped.length, 1, "nothing written, so no further invalidation");
  assert.deepEqual([second.changed, second.written], [0, 0], "idempotent: nothing left to change");
  assert.deepEqual(await prisma.browsingSession.findMany({ where: { shopId: shop.id }, orderBy: { id: "asc" } }), sessionsBefore, "BrowsingSession is untouched");
  assert.deepEqual(await prisma.activityEvent.findMany({ where: { shopId: shop.id }, orderBy: { id: "asc" } }), eventsBefore, "ActivityEvent is untouched");
});

test("the recalculation is scoped to the shops asked for and skips a row a newer calculation already wrote", async () => {
  const a = await newShop("scope-a");
  const b = await newShop("scope-b");
  for (const x of [a, b]) {
    await sessionAt(x.shop, x.actor, "WISHLIST", "2026-10-19T09:00:00Z");
    await run(x.shop);
    await prisma.analyticsDaily.updateMany({ where: { shopId: x.shop.id, day: at("2026-10-19T00:00:00Z") }, data: { wishlistSessions: 0, updatedAt: NOW } });
  }
  const only = await recalc.recalculateSessionTotals({ shopIds: [a.shop.id], apply: true, now: () => minutesAfter(NOW, 30), invalidate: async () => {} });
  assert.equal(only.written, 1);
  assert.equal((await byDay(a.shop))["2026-10-19"].wishlistSessions, 1);
  assert.equal((await byDay(b.shop))["2026-10-19"].wishlistSessions, 0, "the other shop's summary was not touched");

  const stale = await recalc.recalculateSessionTotals({ shopIds: [b.shop.id], apply: true, now: () => at("2020-01-01T00:00:00Z"), invalidate: async () => {} });
  assert.deepEqual([stale.written, stale.stale], [0, 1], "a calculation that started before the stored row does not overwrite it");
});

test("incomplete or NULL daily rows give a lower bound, never a negative or doubled figure", async () => {
  const { shop, actor } = await newShop("gaps");
  await seedMixed(shop, actor);
  await run(shop);
  await prisma.analyticsDaily.deleteMany({ where: { shopId: shop.id, day: at("2026-10-19T00:00:00Z") } });
  await prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: at("2026-10-20T00:00:00Z") }, data: { wishlistSessions: null, wishlistSessionsCarried: null } });
  const range = P.customPeriod("2026-10-19", "2026-10-21", NOW).period;
  const overview = await reporting.getAnalyticsOverview(shop, range, NOW);
  assert.equal(overview.sessionActivity.wishlist.current, 0, "the 19th is missing and the 20th is NULL: only the 21st (0) is usable");
  assert.equal(overview.sessionActivity.notifyMe.current, 0);
  assert.equal(overview.coverage.complete, false);
});
