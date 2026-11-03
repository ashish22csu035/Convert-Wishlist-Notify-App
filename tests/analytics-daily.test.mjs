// Tests for calculateAnalyticsDay (app/models/analytics-daily.server.js): one shop, one UTC day,
// compared with the live reference loader (getAnalytics, which reads ActivityEvent) day by day.
//
// Run: node --test tests/analytics-daily.test.mjs
// The data tests WRITE to the database in DATABASE_URL: run them on a scratch database only.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const domains = [];
const NOW = new Date("2026-10-22T10:00:00.000Z");
const at = (iso) => new Date(iso);
let counter = 9800000000;
let daily;
let reporting;
let P;
const SIX = ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED", "NOTIFY_SUBSCRIBED", "NOTIFY_UNSUBSCRIBED", "RESTOCK_EMAIL_SENT"];

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  daily = await import("../app/models/analytics-daily.server.js");
  reporting = await import("../app/models/reporting.server.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const makeShop = async (tag) => {
  const domain = `kw-daily-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-01-01T00:00:00Z") } });
};
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const session = (shop, actor, feature, iso) =>
  prisma.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature, startedAt: at(iso), expiresAt: new Date(at(iso).getTime() + 30 * 60 * 1000) } });
const event = (shop, actor, sess, type, iso) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: sess?.id ?? null, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid: "gid://shopify/Product/1", occurredAt: at(iso) } });
const live = (shop, day) => reporting.getAnalytics(shop, P.customPeriod(day, day, NOW).period, NOW);
const dayOf = (d) => `2026-10-${String(d).padStart(2, "0")}`;

test("the six types are exactly the activity types of the Analytics loader", () => {
  assert.deepEqual([...daily.DAILY_EVENT_TYPES].sort(), [...reporting.ACTIVITY_TYPES].sort());
  assert.deepEqual(daily.DAILY_EVENT_TYPES, SIX);
});

test("invalid input is refused", async () => {
  for (const day of ["2026-13-01", "2026-02-30", "20261001", "", null, undefined, new Date()]) {
    await assert.rejects(() => daily.calculateAnalyticsDay("s", day), /YYYY-MM-DD/, String(day));
  }
  await assert.rejects(() => daily.calculateAnalyticsDay("", "2026-10-01"), /YYYY-MM-DD/);
});

test("a day without activity is zeros for events and sessions", async () => {
  const shop = await makeShop("zero");
  assert.deepEqual(await daily.calculateAnalyticsDay(shop.id, "2026-10-05"), {
    day: "2026-10-05",
    counts: { WISHLIST_ADDED: 0, WISHLIST_REMOVED: 0, WISHLIST_PRODUCT_CLICKED: 0, NOTIFY_SUBSCRIBED: 0, NOTIFY_UNSUBSCRIBED: 0, RESTOCK_EMAIL_SENT: 0 },
    wishlistSessions: 0,
    notifyMeSessions: 0,
    wishlistSessionsCarried: 0,
    notifyMeSessionsCarried: 0,
  });
});

test("counts the six events and distinct sessions for the day", async () => {
  const shop = await makeShop("normal");
  const a = await actorOf(shop);
  const b = await actorOf(shop);
  const w1 = await session(shop, a, "WISHLIST", "2026-10-05T08:00:00Z");
  const w2 = await session(shop, b, "WISHLIST", "2026-10-05T09:00:00Z");
  const n1 = await session(shop, a, "NOTIFY_ME", "2026-10-05T10:00:00Z");
  await event(shop, a, w1, "WISHLIST_ADDED", "2026-10-05T08:01:00Z");
  await event(shop, a, w1, "WISHLIST_ADDED", "2026-10-05T08:02:00Z");
  await event(shop, a, w1, "WISHLIST_REMOVED", "2026-10-05T08:03:00Z");
  await event(shop, b, w2, "WISHLIST_PRODUCT_CLICKED", "2026-10-05T09:01:00Z");
  await event(shop, a, n1, "NOTIFY_SUBSCRIBED", "2026-10-05T10:01:00Z");
  await event(shop, b, null, "RESTOCK_EMAIL_SENT", "2026-10-05T11:00:00Z");
  await event(shop, b, null, "NOTIFY_UNSUBSCRIBED", "2026-10-05T11:30:00Z");
  const result = await daily.calculateAnalyticsDay(shop.id, "2026-10-05");
  assert.deepEqual(result.counts, { WISHLIST_ADDED: 2, WISHLIST_REMOVED: 1, WISHLIST_PRODUCT_CLICKED: 1, NOTIFY_SUBSCRIBED: 1, NOTIFY_UNSUBSCRIBED: 1, RESTOCK_EMAIL_SENT: 1 });
  assert.deepEqual([result.wishlistSessions, result.notifyMeSessions], [2, 1]);
});

test("UTC day boundaries: 23:59:59.999 belongs to the day, 00:00:00.000 to the next; nothing leaks across", async () => {
  const shop = await makeShop("edge");
  const a = await actorOf(shop);
  for (const iso of ["2026-10-04T23:59:59.999Z", "2026-10-05T00:00:00.000Z", "2026-10-05T23:59:59.999Z", "2026-10-06T00:00:00.000Z"]) await event(shop, a, null, "RESTOCK_EMAIL_SENT", iso);
  const sent = async (day) => (await daily.calculateAnalyticsDay(shop.id, day)).counts.RESTOCK_EMAIL_SENT;
  assert.deepEqual([await sent("2026-10-04"), await sent("2026-10-05"), await sent("2026-10-06")], [1, 2, 1]);
});

test("shops are isolated", async () => {
  const one = await makeShop("iso-1");
  const two = await makeShop("iso-2");
  const a = await actorOf(one);
  const b = await actorOf(two);
  const s1 = await session(one, a, "WISHLIST", "2026-10-05T08:00:00Z");
  await event(one, a, s1, "WISHLIST_ADDED", "2026-10-05T08:01:00Z");
  const s2 = await session(two, b, "WISHLIST", "2026-10-05T08:00:00Z");
  for (let i = 1; i <= 3; i += 1) await event(two, b, s2, "WISHLIST_ADDED", `2026-10-05T08:0${i}:00Z`);
  const first = await daily.calculateAnalyticsDay(one.id, "2026-10-05");
  const second = await daily.calculateAnalyticsDay(two.id, "2026-10-05");
  assert.deepEqual([first.counts.WISHLIST_ADDED, first.wishlistSessions], [1, 1]);
  assert.deepEqual([second.counts.WISHLIST_ADDED, second.wishlistSessions], [3, 1]);
});

test("a session that crosses midnight counts once, on the day it started, and the days add up to the period's", async () => {
  const shop = await makeShop("midnight");
  const a = await actorOf(shop);
  const s = await session(shop, a, "WISHLIST", "2026-10-14T23:50:00Z");
  await event(shop, a, s, "WISHLIST_ADDED", "2026-10-14T23:59:59Z");
  await event(shop, a, s, "WISHLIST_ADDED", "2026-10-15T00:00:01Z");
  const d14 = await daily.calculateAnalyticsDay(shop.id, "2026-10-14");
  const d15 = await daily.calculateAnalyticsDay(shop.id, "2026-10-15");
  assert.deepEqual([d14.wishlistSessions, d15.wishlistSessions], [1, 0], "it started on the 14th, so it is only there");
  assert.deepEqual([d14.counts.WISHLIST_ADDED, d15.counts.WISHLIST_ADDED], [1, 1], "its events are still counted on the day they happened");
  assert.deepEqual([d14.wishlistSessionsCarried, d15.wishlistSessionsCarried, d14.notifyMeSessionsCarried, d15.notifyMeSessionsCarried], [0, 0, 0, 0], "nothing needs carrying any more");
  const both = await reporting.getAnalytics(shop, P.customPeriod("2026-10-14", "2026-10-15", NOW).period, NOW);
  assert.equal(both.sessionActivity.wishlist.current, d14.wishlistSessions + d15.wishlistSessions, "the days add up to the period");
  assert.equal(both.activity.window.WISHLIST_ADDED, d14.counts.WISHLIST_ADDED + d15.counts.WISHLIST_ADDED, "events are additive across days");
});

test("events that carry no session do not make the session counts unavailable: sessions are counted from BrowsingSession", async () => {
  const shop = await makeShop("nosession");
  const a = await actorOf(shop);
  await event(shop, a, null, "WISHLIST_ADDED", "2026-10-05T08:00:00Z");
  await event(shop, a, null, "NOTIFY_SUBSCRIBED", "2026-10-05T09:00:00Z");
  await session(shop, a, "NOTIFY_ME", "2026-10-05T10:00:00Z");
  const result = await daily.calculateAnalyticsDay(shop.id, "2026-10-05");
  assert.deepEqual([result.wishlistSessions, result.notifyMeSessions, result.counts.WISHLIST_ADDED], [0, 1, 1]);
  const liveDay = await live(shop, "2026-10-05");
  assert.deepEqual([liveDay.sessionActivity.wishlist.current, liveDay.sessionActivity.notifyMe.current], [0, 1]);
  assert.equal((await daily.calculateAnalyticsDay(shop.id, "2026-10-06")).wishlistSessions, 0, "a neighbouring day is not affected");
});

test("parity: every day of a busy shop equals the live Analytics loader for that single day", async () => {
  const shop = await makeShop("parity");
  const actors = [await actorOf(shop), await actorOf(shop), await actorOf(shop)];
  const types = ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED"];
  for (let d = 1; d <= 12; d += 1) {
    const day = dayOf(d);
    if (d % 5 === 0) continue; // quiet days
    const w = await session(shop, actors[d % 3], "WISHLIST", `${day}T23:40:00Z`);
    const n = await session(shop, actors[(d + 1) % 3], "NOTIFY_ME", `${day}T05:00:00Z`);
    for (let k = 0; k <= d % 4; k += 1) await event(shop, actors[d % 3], w, types[k % 3], `${day}T${String(10 + k).padStart(2, "0")}:00:00Z`);
    if (d % 2 === 0) await event(shop, actors[(d + 1) % 3], n, "NOTIFY_SUBSCRIBED", `${day}T05:05:00Z`);
    if (d % 3 === 0) await event(shop, actors[0], null, "RESTOCK_EMAIL_SENT", `${day}T14:00:00Z`);
    if (d % 4 === 0) await event(shop, actors[1], null, "NOTIFY_UNSUBSCRIBED", `${day}T15:00:00Z`);
    // every third day the same Wishlist session continues after midnight
    if (d % 3 === 1) await event(shop, actors[d % 3], w, "WISHLIST_ADDED", new Date(Date.parse(`${day}T00:30:00Z`) + 86400000).toISOString());
  }
  const days = [];
  for (let d = 1; d <= 13; d += 1) {
    const mine = await daily.calculateAnalyticsDay(shop.id, dayOf(d));
    const liveDay = await live(shop, dayOf(d));
    assert.deepEqual(mine.counts, Object.fromEntries(SIX.map((type) => [type, liveDay.activity.window[type]])), `${dayOf(d)} events`);
    assert.deepEqual([mine.wishlistSessions, mine.notifyMeSessions], [liveDay.sessionActivity.wishlist.current, liveDay.sessionActivity.notifyMe.current], `${dayOf(d)} sessions`);
    days.push(mine);
  }
  // events are additive over the period; sessions are not (some sessions span two days)
  const period = await reporting.getAnalytics(shop, P.customPeriod(dayOf(1), dayOf(13), NOW).period, NOW);
  for (const type of SIX) assert.equal(days.reduce((sum, row) => sum + row.counts[type], 0), period.activity.window[type], `${type} adds up`);
  // a session has one start, so sessions add up over the period exactly like events do, and nothing is carried
  for (const [feature, sessions, carried] of [["wishlist", "wishlistSessions", "wishlistSessionsCarried"], ["notifyMe", "notifyMeSessions", "notifyMeSessionsCarried"]]) {
    assert.equal(days.reduce((sum, row) => sum + row[sessions], 0), period.sessionActivity[feature].current, `${feature}: the days add up to the period`);
    assert.ok(days.every((row) => row[carried] === 0), `${feature}: nothing is carried`);
  }
});
