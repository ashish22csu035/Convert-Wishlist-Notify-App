// Tests for the Analytics loader reading ONLY AnalyticsDaily (getAnalyticsOverview -> summarizedActivity).
//
// How a test proves "this came from the stored summary": it edits a stored row to a value no event can produce
// (+1000) and looks at whether the figure moves, or it adds an event and looks at whether the figure stays put until
// the worker has run. The statement log proves that no event totals are read from ActivityEvent.
//
// Run: node --test tests/analytics-summaries.test.mjs
// WRITES to the database in DATABASE_URL: run on a scratch database only.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const domains = [];
const NOW = new Date("2026-10-22T10:00:00.000Z"); // today 10-22 (partial), yesterday 10-21
const at = (iso) => new Date(iso);
let counter = 9950000000;
let capture = null; // when an array, the app's client pushes every SQL statement into it
let reporting;
let analyticsWorker;
let P;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  // The app's own client is created on first import: give it query events so a test can see every statement sent.
  const prismaModule = require("@prisma/client");
  prismaModule.PrismaClient = class extends prismaModule.PrismaClient {
    constructor(options) {
      super({ ...options, log: [{ emit: "event", level: "query" }] });
      this.$on("query", (event) => capture?.push(event.query));
    }
  };
  reporting = await import("../app/models/reporting.server.js");
  analyticsWorker = await import("../app/worker/analytics-daily.server.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const range = (from, to) => P.customPeriod(from, to, NOW).period;
const day = (n) => `2026-10-${String(n).padStart(2, "0")}`;
const quiet = { log() {}, error() {} };
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const session = (shop, actor, feature, iso) =>
  prisma.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature, startedAt: at(iso), expiresAt: new Date(at(iso).getTime() + 30 * 60 * 1000) } });
const event = (shop, actor, sess, type, iso) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: sess?.id ?? null, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: "gid://shopify/Product/1", occurredAt: at(iso) } });

// Days 1..22 of October (22 = today): every day has a Wishlist session with an add and a click, some days more. Day 9
// is deliberately EMPTY. A Wishlist session runs over midnight 14 -> 15. The shop is installed on 2026-09-15.
async function seedShop(tag, installedAt = "2026-09-15T00:00:00Z") {
  const domain = `kw-sum-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  const shop = await prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at(installedAt) } });
  const actor = await actorOf(shop);
  for (let d = 1; d <= 22; d += 1) {
    if (d === 9) continue;
    const w = await session(shop, actor, "WISHLIST", `${day(d)}T08:00:00Z`);
    await event(shop, actor, w, "WISHLIST_ADDED", `${day(d)}T08:01:00Z`);
    await event(shop, actor, w, "WISHLIST_PRODUCT_CLICKED", `${day(d)}T08:02:00Z`);
    if (d % 2 === 0) await event(shop, actor, w, "WISHLIST_REMOVED", `${day(d)}T08:03:00Z`);
    if (d % 3 === 0) {
      const n = await session(shop, actor, "NOTIFY_ME", `${day(d)}T09:00:00Z`);
      await event(shop, actor, n, "NOTIFY_SUBSCRIBED", `${day(d)}T09:01:00Z`);
    }
    if (d % 4 === 0) await event(shop, actor, null, "RESTOCK_EMAIL_SENT", `${day(d)}T12:00:00Z`);
    if (d % 5 === 0) await event(shop, actor, null, "NOTIFY_UNSUBSCRIBED", `${day(d)}T13:00:00Z`);
  }
  const straddle = await session(shop, actor, "WISHLIST", "2026-10-14T23:50:00Z");
  await event(shop, actor, straddle, "WISHLIST_ADDED", "2026-10-14T23:59:00Z");
  await event(shop, actor, straddle, "WISHLIST_ADDED", "2026-10-15T00:01:00Z");
  return shop;
}
const fill = (shop, over = {}) => analyticsWorker.runAnalyticsDaily({ now: () => NOW, shopIds: [shop.id], backfillPerShop: 500, log: quiet, ...over });
const bump = (shop, n, data) => prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: at(`${day(n)}T00:00:00Z`) }, data });
const overview = (shop, period) => reporting.getAnalyticsOverview(shop, period, NOW);
const reference = (shop, period) => reporting.getAnalytics(shop, period, NOW); // live: reads ActivityEvent
const SIX = ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED", "NOTIFY_SUBSCRIBED", "NOTIFY_UNSUBSCRIBED", "RESTOCK_EMAIL_SENT"];

test("every date comes from the stored summaries, today and yesterday included, and equals the live figures once they are filled", async () => {
  const shop = await seedShop("stored");
  assert.equal((await fill(shop)).failed, 0);
  for (const period of [7, 30, range(day(3), day(18)), range(day(20), day(22)), range(day(22), day(22))]) {
    const got = await overview(shop, period);
    const live = await reference(shop, period);
    assert.deepEqual(got.activity.window, live.activity.window);
    assert.deepEqual(got.sessionActivity.wishlist.current, live.sessionActivity.wishlist.current);
    assert.deepEqual(got.sessionActivity.notifyMe.current, live.sessionActivity.notifyMe.current);
    assert.equal(got.coverage.complete, true);
  }
  // an edit to a stored row moves the figure: today (22), yesterday (21) and a historical day (10) are all read from the table
  const period = range(day(8), day(22));
  const base = (await overview(shop, period)).activity.window.WISHLIST_ADDED;
  await bump(shop, 22, { wishlistAdded: { increment: 1000 } });
  await bump(shop, 21, { wishlistAdded: { increment: 100 } });
  await bump(shop, 10, { wishlistAdded: { increment: 10 } });
  assert.equal((await overview(shop, period)).activity.window.WISHLIST_ADDED, base + 1110);
});

test("a new event does not show on the page until the worker has recalculated its day", async () => {
  const shop = await seedShop("fresh");
  await fill(shop);
  const before = (await overview(shop, 7)).activity.window;
  const actor = await actorOf(shop);
  await event(shop, actor, null, "RESTOCK_EMAIL_SENT", "2026-10-22T09:30:00Z"); // today
  await event(shop, actor, null, "RESTOCK_EMAIL_SENT", "2026-10-21T21:30:00Z"); // yesterday
  assert.deepEqual((await overview(shop, 7)).activity.window, before, "nothing is read from ActivityEvent");
  await fill(shop, { now: () => new Date(NOW.getTime() + 10 * 60 * 1000) }); // the next 10-minute run
  const after = (await overview(shop, 7)).activity.window;
  assert.equal(after.RESTOCK_EMAIL_SENT, before.RESTOCK_EMAIL_SENT + 2);
});

test("the Analytics loader sends no ActivityEvent statement for event totals or sessions", async () => {
  const shop = await seedShop("noevents");
  await fill(shop);
  for (const period of [7, 30, range(day(3), day(18))]) {
    capture = [];
    await overview(shop, period);
    const statements = capture;
    capture = null;
    const eventReads = statements.filter((sql) => /ActivityEvent/.test(sql));
    assert.ok(statements.some((sql) => /AnalyticsDaily/.test(sql)), "the summaries were read");
    assert.equal(eventReads.length, 1, "only the top-customers ranking still reads events");
    assert.ok(/actorId/.test(eventReads[0]) && !/browsingSessionId|`type`/.test(eventReads[0]), "it ranks customers; it counts no event type and no session");
  }
});

test("missing summaries are not replaced by live counts: the figures are what the stored days hold, the gap is reported, sessions count the days that exist, and comparisons are withheld", async () => {
  const shop = await seedShop("missing");
  await fill(shop);
  const period = range(day(3), day(18)); // 16 days
  const full = await overview(shop, period);
  await prisma.analyticsDaily.deleteMany({ where: { shopId: shop.id, day: at(`${day(10)}T00:00:00Z`) } });
  capture = [];
  const partial = await overview(shop, period);
  const statements = capture;
  capture = null;
  assert.equal(statements.filter((sql) => /ActivityEvent/.test(sql)).length, 1, "still no totals read from events");
  assert.deepEqual(partial.coverage, { expectedDays: 16, availableDays: 15, complete: false });
  assert.equal(partial.activity.window.WISHLIST_ADDED, full.activity.window.WISHLIST_ADDED - 1, "day 10 had one add, which is not counted");
  // a missing day hides nothing that exists: day 10 had one Wishlist session and no Notify Me session
  assert.equal(partial.sessionActivity.wishlist.current, full.sessionActivity.wishlist.current - 1);
  assert.equal(partial.sessionActivity.notifyMe.current, full.sessionActivity.notifyMe.current);
  // a range that does not contain the gap is complete and unaffected
  assert.equal((await overview(shop, range(day(11), day(18)))).coverage.complete, true);
  // a previous period with a gap is not offered (a comparison with missing days would look like growth)
  await prisma.analyticsDaily.deleteMany({ where: { shopId: shop.id, day: at(`${day(12)}T00:00:00Z`) } });
  const week = await overview(shop, 7); // 10-16..22, previous 10-09..10-15 lacks day 12
  assert.equal(week.coverage.complete, true);
  assert.equal(week.comparable, true);
  assert.deepEqual([week.activity.previous, week.sessionActivity.wishlist.previous, week.sessionActivity.notifyMe.previous], [null, null, null]);
  // a shop with no summaries at all: zeros, reported as 0 of N days, and no events read
  const bare = await seedShop("bare");
  const none = await overview(bare, 7);
  assert.deepEqual(none.coverage, { expectedDays: 7, availableDays: 0, complete: false });
  assert.ok(SIX.every((type) => none.activity.window[type] === 0));
});

test("a stored row of zeros is a real day; a row from before notifyUnsubscribed existed is not", async () => {
  const shop = await seedShop("zero");
  await fill(shop);
  const empty = await prisma.analyticsDaily.findFirst({ where: { shopId: shop.id, day: at(`${day(9)}T00:00:00Z`) } });
  assert.deepEqual([empty.wishlistAdded, empty.wishlistRemoved, empty.wishlistProductClicked, empty.notifySubscribed, empty.notifyUnsubscribed, empty.restockEmailSent], [0, 0, 0, 0, 0, 0]);
  const period = range(day(5), day(14));
  assert.equal((await overview(shop, period)).coverage.complete, true, "the empty day counts as present");
  await bump(shop, 9, { notifySubscribed: 7 });
  assert.equal((await overview(shop, period)).activity.window.NOTIFY_SUBSCRIBED, (await reference(shop, period)).activity.window.NOTIFY_SUBSCRIBED + 7);
  await bump(shop, 9, { notifyUnsubscribed: null });
  const legacy = await overview(shop, period);
  assert.deepEqual([legacy.coverage.complete, legacy.coverage.availableDays], [false, 9], "an unfinished legacy row is a missing day");
});

test("NOTIFY_UNSUBSCRIBED is represented: stored, summed and equal to the live count", async () => {
  const shop = await seedShop("unsub");
  await fill(shop);
  const got = await overview(shop, 30);
  const live = await reference(shop, 30);
  assert.ok(live.activity.window.NOTIFY_UNSUBSCRIBED > 0);
  assert.equal(got.activity.window.NOTIFY_UNSUBSCRIBED, live.activity.window.NOTIFY_UNSUBSCRIBED);
  assert.deepEqual(Object.keys(got.activity.window), reporting.ACTIVITY_TYPES);
});

test("sessions are the sessions that started in the range: the days simply add up and equal the live count", async () => {
  const shop = await seedShop("sessions");
  await fill(shop);
  const period = range(day(13), day(16)); // the session over midnight 14 -> 15 started on the 14th and is in one daily row only
  const stored = await prisma.analyticsDaily.findMany({ where: { shopId: shop.id, day: { gte: at(`${day(13)}T00:00:00Z`), lte: at(`${day(16)}T00:00:00Z`) } } });
  const sum = stored.reduce((total, row) => total + row.wishlistSessions, 0);
  const live = await reference(shop, period);
  assert.equal(sum, live.sessionActivity.wishlist.current, "the daily rows add up to exactly the live count");
  assert.ok(stored.every((row) => row.wishlistSessionsCarried === 0 && row.notifyMeSessionsCarried === 0), "nothing is carried");
  assert.equal((await overview(shop, period)).sessionActivity.wishlist.current, live.sessionActivity.wishlist.current);
  const fromFifteenth = range(day(15), day(16));
  assert.equal((await overview(shop, fromFifteenth)).sessionActivity.wishlist.current, (await reference(shop, fromFifteenth)).sessionActivity.wishlist.current);
  // an event that carries no session changes no session count: sessions come from BrowsingSession
  const actor = await actorOf(shop);
  const recent = range(day(18), day(21));
  const before = (await overview(shop, recent)).sessionActivity.wishlist.current;
  assert.notEqual(before, null);
  await event(shop, actor, null, "WISHLIST_ADDED", "2026-10-20T20:00:00Z");
  await fill(shop, { now: () => new Date(NOW.getTime() + 3 * 60 * 60 * 1000) });
  const day20 = await prisma.analyticsDaily.findFirst({ where: { shopId: shop.id, day: at(`${day(20)}T00:00:00Z`) } });
  assert.notEqual(day20.wishlistSessions, null);
  assert.equal((await overview(shop, recent)).sessionActivity.wishlist.current, before, "the sessions are unchanged");
});

test("sessions from stored rows: partial ranges, NULL values and range edges", async () => {
  const shop = await seedShop("sess-rows");
  await fill(shop);
  const rowsIn = (a, b) => prisma.analyticsDaily.findMany({ where: { shopId: shop.id, day: { gte: at(`${day(a)}T00:00:00Z`), lte: at(`${day(b)}T00:00:00Z`) } } });
  const total = (rows) => rows.reduce((t, r) => t + r.wishlistSessions, 0);
  // only days 12..16 hold rows inside 10..20; the rest are deleted
  await prisma.analyticsDaily.deleteMany({ where: { shopId: shop.id, OR: [{ day: { lt: at(`${day(12)}T00:00:00Z`) } }, { day: { gt: at(`${day(16)}T00:00:00Z`) } }] } });
  const kept = await rowsIn(12, 16);
  const period = range(day(10), day(20));
  const got = await overview(shop, period);
  assert.equal(got.coverage.complete, false);
  assert.equal(got.sessionActivity.wishlist.current, total(kept), "the days that exist are added up; nothing outside them leaks in");
  const fromFifteen = await overview(shop, range(day(15), day(20)));
  assert.equal(fromFifteen.sessionActivity.wishlist.current, total(kept.filter((r) => r.day.getUTCDate() >= 15)));
  // an edited value shows up exactly once, in the range holding its day only
  await bump(shop, 13, { wishlistSessions: { increment: 1000 } });
  assert.equal((await overview(shop, period)).sessionActivity.wishlist.current, got.sessionActivity.wishlist.current + 1000);
  assert.equal((await overview(shop, range(day(14), day(20)))).sessionActivity.wishlist.current, total(kept.filter((r) => r.day.getUTCDate() >= 14)), "the 1000 added on day 13 is not in a range that starts on day 14");
  // NULL sessions are not activity: those rows are skipped, and with none usable the figure is unavailable
  await bump(shop, 13, { wishlistSessions: null, wishlistSessionsCarried: null });
  const d13 = kept.find((r) => r.day.getUTCDate() === 13);
  assert.equal((await overview(shop, period)).sessionActivity.wishlist.current, got.sessionActivity.wishlist.current - d13.wishlistSessions);
  await prisma.analyticsDaily.updateMany({ where: { shopId: shop.id }, data: { wishlistSessions: null, wishlistSessionsCarried: null, notifyMeSessions: null, notifyMeSessionsCarried: null } });
  const unusable = await overview(shop, period);
  assert.deepEqual([unusable.sessionActivity.wishlist.current, unusable.sessionActivity.notifyMe.current], [null, null]);
  assert.equal(unusable.activity.window.WISHLIST_ADDED > 0, true, "event counts are unaffected");
});

test("date boundaries: a custom range takes its first and last day and nothing from the days around it", async () => {
  const shop = await seedShop("bounds");
  await fill(shop);
  const period = range(day(5), day(8));
  const base = (await overview(shop, period)).activity.window.WISHLIST_ADDED;
  await bump(shop, 4, { wishlistAdded: { increment: 1000 } }); // the day before: excluded
  await bump(shop, 9, { wishlistAdded: { increment: 1000 } }); // the day after: excluded
  assert.equal((await overview(shop, period)).activity.window.WISHLIST_ADDED, base);
  await bump(shop, 5, { wishlistAdded: { increment: 1 } }); // first day: included
  await bump(shop, 8, { wishlistAdded: { increment: 10 } }); // last day: included
  assert.equal((await overview(shop, period)).activity.window.WISHLIST_ADDED, base + 11);
  // the 7-day preset is 10-16 .. today (10-22); its previous period is 10-09 .. 10-15
  const week = await overview(shop, 7);
  const before = { cur: week.activity.window.WISHLIST_ADDED, prev: week.activity.previous.WISHLIST_ADDED };
  await bump(shop, 15, { wishlistAdded: { increment: 100 } }); // last day of the previous period
  await bump(shop, 16, { wishlistAdded: { increment: 1000 } }); // first day of the current period
  await bump(shop, 22, { wishlistAdded: { increment: 10000 } }); // today: part of the current period
  await bump(shop, 8, { wishlistAdded: { increment: 100000 } }); // before the previous period
  const after = await overview(shop, 7);
  assert.equal(after.activity.window.WISHLIST_ADDED, before.cur + 11000);
  assert.equal(after.activity.previous.WISHLIST_ADDED, before.prev + 100);
});

test("days before the shop was installed are not missing days", async () => {
  const shop = await seedShop("young", "2026-10-15T09:00:00Z"); // installed 10-15: days 15..22 = 8 days
  await fill(shop);
  const got = await overview(shop, 30);
  assert.deepEqual(got.coverage, { expectedDays: 8, availableDays: 8, complete: true });
  assert.equal(got.comparable, false);
  assert.equal(got.activity.previous, null);
});

test("shops are isolated: another shop's summaries are never read, and a shop without its own rows borrows none", async () => {
  const a = await seedShop("iso-a");
  const b = await seedShop("iso-b");
  await fill(a);
  await fill(b);
  const period = range(day(3), day(18));
  const baseA = (await overview(a, period)).activity.window.WISHLIST_ADDED;
  await prisma.analyticsDaily.updateMany({ where: { shopId: b.id }, data: { wishlistAdded: 999 } });
  assert.equal((await overview(a, period)).activity.window.WISHLIST_ADDED, baseA);
  assert.equal((await overview(b, period)).activity.window.WISHLIST_ADDED, 999 * 16);
  await prisma.analyticsDaily.deleteMany({ where: { shopId: a.id } });
  const empty = await overview(a, period);
  assert.deepEqual([empty.activity.window.WISHLIST_ADDED, empty.coverage.availableDays], [0, 0]);
});

test("the response keeps its shape for the page: the same keys plus coverage, and the same non-activity data as the live loader", async () => {
  const shop = await seedShop("shape");
  await fill(shop);
  for (const period of [7, 30, range(day(2), day(12))]) {
    const got = await overview(shop, period);
    const live = await reference(shop, period);
    assert.deepEqual(Object.keys(got).sort(), ["activity", "comparable", "coverage", "days", "lastUpdated", "period", "sessionActivity", "topCustomers", "topProducts"]);
    assert.deepEqual(Object.keys(got.activity.window), reporting.ACTIVITY_TYPES);
    assert.deepEqual(Object.keys(got.sessionActivity), ["wishlist", "notifyMe"]);
    assert.deepEqual({ days: got.days, period: got.period, comparable: got.comparable, topProducts: got.topProducts, topCustomers: got.topCustomers }, { days: live.days, period: live.period, comparable: live.comparable, topProducts: live.topProducts, topCustomers: live.topCustomers });
    assert.equal(got.activity.previous === null, !got.comparable);
  }
});

test("lastUpdated: the newest finished summary's updatedAt for THIS shop only; none yet is null; unfinished legacy rows and createdAt do not count", async () => {
  const a = await seedShop("lu-a");
  const b = await seedShop("lu-b");
  const none = await seedShop("lu-none");
  assert.equal((await overview(a, 7)).lastUpdated, null, "no summaries yet: no time is invented");
  await fill(a);
  assert.equal((await overview(a, 7)).lastUpdated, NOW.toISOString(), "the worker saved its calculation time");
  assert.equal((await overview(b, 7)).lastUpdated, null, "another shop's summaries are not visible");
  // a later pass for the other shop does not move this shop's time
  const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
  await fill(b, { now: () => later });
  assert.equal((await overview(b, 7)).lastUpdated, later.toISOString());
  assert.equal((await overview(a, 7)).lastUpdated, NOW.toISOString());
  // the figure is the MAX over the shop's rows, whatever day it belongs to and whatever the range on screen
  const stamp = new Date(NOW.getTime() + 60 * 60 * 1000);
  await prisma.analyticsDaily.updateMany({ where: { shopId: a.id, day: at(`${day(5)}T00:00:00Z`) }, data: { updatedAt: stamp } });
  assert.equal((await overview(a, 7)).lastUpdated, stamp.toISOString());
  assert.equal((await overview(a, range(day(1), day(3)))).lastUpdated, stamp.toISOString());
  // an unfinished row (notifyUnsubscribed NULL) is not a successful summary
  await prisma.analyticsDaily.updateMany({ where: { shopId: a.id, day: at(`${day(5)}T00:00:00Z`) }, data: { notifyUnsubscribed: null } });
  assert.equal((await overview(a, 7)).lastUpdated, NOW.toISOString());
  // createdAt is ignored: a row created later but with an older updatedAt does not win
  await prisma.analyticsDaily.create({ data: { shopId: none.id, day: at(`${day(2)}T00:00:00Z`), notifyUnsubscribed: 0, updatedAt: at("2026-01-01T00:00:00Z") } });
  assert.equal((await overview(none, 7)).lastUpdated, "2026-01-01T00:00:00.000Z");
});

test("lastUpdated moves when the worker rewrites a day, and not when the write is refused as stale", async () => {
  const shop = await seedShop("lu-move");
  await fill(shop);
  const first = (await overview(shop, 7)).lastUpdated;
  assert.equal(first, NOW.toISOString());
  await event(shop, await actorOf(shop), null, "RESTOCK_EMAIL_SENT", "2026-10-22T09:30:00Z");
  const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
  await fill(shop, { now: () => later });
  const second = (await overview(shop, 7)).lastUpdated;
  assert.equal(second, later.toISOString(), "a rewritten day moves the time forward");
  const older = new Date(NOW.getTime() + 60 * 60 * 1000);
  await fill(shop, { now: () => older }); // computed from older data than what is stored
  assert.equal((await overview(shop, 7)).lastUpdated, second, "an older calculation never moves it back");
});
