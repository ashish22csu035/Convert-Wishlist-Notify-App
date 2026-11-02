// Tests for the daily analytics worker (app/worker/analytics-daily.server.js): backfill, refresh, repair, retry,
// idempotency and the guard against an older computation overwriting a newer one.
//
// Run: node --test tests/analytics-daily-worker.test.mjs
// WRITES to the database in DATABASE_URL: run on a scratch database only.
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
const NOW = new Date("2026-10-22T10:00:00.000Z"); // today is 2026-10-22 (partial), yesterday 2026-10-21
const at = (iso) => new Date(iso);
const later = (ms) => () => new Date(NOW.getTime() + ms);
const quiet = { log() {}, error() {} };
let counter = 9900000000;
let worker;
let daily;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  worker = await import("../app/worker/analytics-daily.server.js");
  daily = await import("../app/models/analytics-daily.server.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const makeShop = async (tag, installedAt, status = "ACTIVE") => {
  const domain = `kw-adw-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at(installedAt), status } });
};
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const sent = (shop, actor, iso) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type: "RESTOCK_EMAIL_SENT", feature: "NOTIFY_ME", productGid: "gid://shopify/Product/1", occurredAt: at(iso) } });
const rows = (shop) => prisma.analyticsDaily.findMany({ where: { shopId: shop.id }, orderBy: { day: "asc" } });
const days = async (shop) => (await rows(shop)).map((row) => row.day.toISOString().slice(0, 10));
const run = (shop, over = {}) => worker.runAnalyticsDaily({ now: () => NOW, shopIds: [shop.id], log: quiet, ...over });
const result = (day, sentCount = 0) => ({
  day,
  counts: { WISHLIST_ADDED: 0, WISHLIST_REMOVED: 0, WISHLIST_PRODUCT_CLICKED: 0, NOTIFY_SUBSCRIBED: 0, NOTIFY_UNSUBSCRIBED: 0, RESTOCK_EMAIL_SENT: sentCount },
  wishlistSessions: 0,
  notifyMeSessions: 0,
  wishlistSessionsCarried: 0,
  notifyMeSessionsCarried: 0,
});
const byDay = (list, d) => list.find((row) => row.day.toISOString().startsWith(d));

test("backfill: every day since install, today included, gets one row equal to calculateAnalyticsDay", async () => {
  const shop = await makeShop("backfill", "2026-10-12T15:00:00Z");
  const actor = await actorOf(shop);
  await sent(shop, actor, "2026-10-14T09:00:00Z");
  await sent(shop, actor, "2026-10-14T10:00:00Z");
  await sent(shop, actor, "2026-10-22T08:00:00Z"); // today: summarised too (partial)
  const summary = await run(shop);
  assert.deepEqual([summary.shops, summary.written, summary.stale, summary.failed], [1, 11, 0, 0]);
  assert.deepEqual(await days(shop), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
  for (const row of await rows(shop)) {
    const expected = await daily.calculateAnalyticsDay(shop.id, row.day.toISOString().slice(0, 10));
    assert.deepEqual([row.restockEmailSent, row.wishlistAdded, row.wishlistSessions, row.notifyMeSessions], [expected.counts.RESTOCK_EMAIL_SENT, 0, expected.wishlistSessions, expected.notifyMeSessions]);
    assert.deepEqual([row.notifyUnsubscribed, row.wishlistSessionsCarried, row.notifyMeSessionsCarried], [expected.counts.NOTIFY_UNSUBSCRIBED, expected.wishlistSessionsCarried, expected.notifyMeSessionsCarried]);
  }
  const list = await rows(shop);
  assert.deepEqual([byDay(list, "2026-10-14").restockEmailSent, byDay(list, "2026-10-22").restockEmailSent], [2, 1]);
});

test("repeated runs are idempotent: no new rows; only today and yesterday are recalculated each run", async () => {
  const shop = await makeShop("idem", "2026-10-15T00:00:00Z");
  await run(shop);
  const before = await rows(shop);
  assert.equal(before.length, 8);
  const again = await run(shop, { now: later(60 * 1000) });
  assert.deepEqual([again.written, again.failed], [2, 0]);
  const after = await rows(shop);
  assert.equal(after.length, 8, "no duplicate rows");
  const moved = after.filter((row, i) => row.updatedAt.getTime() !== before[i].updatedAt.getTime()).map((row) => row.day.toISOString().slice(0, 10));
  assert.deepEqual(moved, ["2026-10-21", "2026-10-22"]);
});

test("backfill is bounded per run and works newest first until the history is complete", async () => {
  const shop = await makeShop("bounded", "2026-09-22T00:00:00Z"); // 31 days up to today; the 4 newest are the recent window
  const first = await run(shop, { backfillPerShop: 10 });
  assert.equal(first.written, 14, "4 recent days + 10 backfilled");
  assert.deepEqual((await days(shop)).slice(0, 2), ["2026-10-09", "2026-10-10"], "the oldest written day is 13 days back from today: newest first");
  const second = await run(shop, { backfillPerShop: 10, now: later(1000) });
  assert.equal(second.written, 12, "today and yesterday again + 10 more");
  const third = await run(shop, { backfillPerShop: 10, now: later(2000) });
  assert.equal(third.written, 9, "today and yesterday + only what is left");
  assert.equal((await days(shop)).length, 31);
  assert.equal((await run(shop, { backfillPerShop: 10, now: later(3000) })).written, 2, "complete: only today and yesterday");
});

test("today and yesterday are recalculated every run, the two days before them hourly, older days never", async () => {
  const shop = await makeShop("refresh", "2026-10-10T00:00:00Z");
  const actor = await actorOf(shop);
  await run(shop);
  const count = async (day) => byDay(await rows(shop), day).restockEmailSent;
  assert.deepEqual([await count("2026-10-22"), await count("2026-10-21"), await count("2026-10-20"), await count("2026-10-12")], [0, 0, 0, 0]);
  await sent(shop, actor, "2026-10-22T09:00:00Z"); // today
  await sent(shop, actor, "2026-10-21T22:00:00Z"); // yesterday
  await sent(shop, actor, "2026-10-20T22:00:00Z"); // two days back: a late arrival
  await sent(shop, actor, "2026-10-12T22:00:00Z"); // outside the window: final
  const soon = await run(shop, { now: later(10 * 60 * 1000) });
  assert.equal(soon.written, 2, "ten minutes later: today and yesterday");
  assert.deepEqual([await count("2026-10-22"), await count("2026-10-21"), await count("2026-10-20")], [1, 1, 0]);
  assert.equal((await run(shop, { now: later(90 * 60 * 1000) })).written, 4, "an hour later the two days before are due as well");
  assert.deepEqual([await count("2026-10-20"), await count("2026-10-12")], [1, 0]);
});

test("repair: a legacy row (notifyUnsubscribed NULL) and a row calculated before its day ended are recalculated, even outside the recent window", async () => {
  const shop = await makeShop("repair", "2026-10-05T00:00:00Z");
  await run(shop);
  const old = (d) => at(`2026-10-${d}T00:00:00Z`);
  // 10-08: a row from before the column existed; 10-09: a row calculated at noon that same day, i.e. before the day ended
  await prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: old("08") }, data: { notifyUnsubscribed: null, restockEmailSent: 99, updatedAt: at("2026-10-09T01:00:00Z") } });
  await prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: old("09") }, data: { restockEmailSent: 98, updatedAt: at("2026-10-09T12:00:00Z") } });
  await prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: old("10") }, data: { restockEmailSent: 97, updatedAt: at("2026-10-11T01:00:00Z") } }); // an ordinary final row: left alone
  const repaired = await run(shop, { now: later(1000) });
  assert.equal(repaired.written, 2 + 2, "today, yesterday and the two repaired days");
  const by = (d) => prisma.analyticsDaily.findFirst({ where: { shopId: shop.id, day: old(d) } });
  assert.deepEqual([(await by("08")).notifyUnsubscribed, (await by("08")).restockEmailSent, (await by("09")).restockEmailSent, (await by("10")).restockEmailSent], [0, 0, 0, 97]);
});

test("a failing day or shop does not stop the others and is retried on the next run", async () => {
  const a = await makeShop("fail-a", "2026-10-17T00:00:00Z");
  const b = await makeShop("fail-b", "2026-10-17T00:00:00Z");
  const real = daily.calculateAnalyticsDay;
  let broken = true;
  const calculate = async (shopId, day) => {
    if (broken && ((shopId === a.id && day === "2026-10-19") || shopId === b.id)) throw Object.assign(new Error("db hiccup"), { code: "P1001" });
    return real(shopId, day);
  };
  const errors = [];
  const summary = await worker.runAnalyticsDaily({ now: () => NOW, shopIds: [a.id, b.id], calculate, log: { log() {}, error: (m) => errors.push(m) } });
  assert.deepEqual([summary.written, summary.failed], [5, 1 + 6]);
  assert.ok(!(await days(a)).includes("2026-10-19"));
  assert.equal((await days(b)).length, 0);
  assert.ok(errors.every((line) => !line.includes("db hiccup") && line.includes("P1001")), "logs carry the error code only");
  broken = false;
  const retry = await worker.runAnalyticsDaily({ now: later(1000), shopIds: [a.id, b.id], calculate, log: quiet });
  assert.deepEqual([retry.written, retry.failed], [2 + 1 + 6, 0], "a: today, yesterday and the missing day; b: all six");
  assert.deepEqual([(await days(a)).length, (await days(b)).length], [6, 6]);
});

test("an older computation never overwrites a newer one, in either order and when racing", async () => {
  const shop = await makeShop("stale", "2026-10-01T00:00:00Z");
  const t = (ms) => new Date(NOW.getTime() + ms);
  const row = async () => (await rows(shop))[0];
  assert.equal(await worker.writeAnalyticsDay(shop.id, result("2026-10-05", 7), t(2000)), "written");
  assert.equal(await worker.writeAnalyticsDay(shop.id, result("2026-10-05", 1), t(1000)), "stale", "older start time loses");
  assert.equal(await worker.writeAnalyticsDay(shop.id, result("2026-10-05", 9), t(2000)), "stale", "same start time does not overwrite");
  assert.deepEqual([(await row()).restockEmailSent, (await row()).updatedAt.getTime()], [7, t(2000).getTime()]);
  assert.equal(await worker.writeAnalyticsDay(shop.id, result("2026-10-05", 8), t(3000)), "written", "newer start time wins");
  assert.equal((await row()).restockEmailSent, 8);

  for (let i = 0; i < 5; i += 1) {
    const day = `2026-10-${String(10 + i).padStart(2, "0")}`;
    const outcomes = await Promise.all([worker.writeAnalyticsDay(shop.id, result(day, 111), t(5000)), worker.writeAnalyticsDay(shop.id, result(day, 222), t(6000)), worker.writeAnalyticsDay(shop.id, result(day, 333), t(4000))]);
    assert.ok(outcomes.includes("written"));
    const saved = (await rows(shop)).filter((r) => r.day.toISOString().startsWith(day));
    assert.equal(saved.length, 1, "one row per day");
    assert.deepEqual([saved[0].restockEmailSent, saved[0].updatedAt.getTime()], [222, t(6000).getTime()], "the latest-starting computation wins whatever the order");
  }
});

test("shops are separate: inactive shops are skipped, each shop only gets its own events", async () => {
  const active = await makeShop("iso-a", "2026-10-19T00:00:00Z");
  const inactive = await makeShop("iso-b", "2026-10-19T00:00:00Z", "UNINSTALLED");
  const other = await makeShop("iso-c", "2026-10-19T00:00:00Z");
  await sent(other, await actorOf(other), "2026-10-20T10:00:00Z");
  const summary = await worker.runAnalyticsDaily({ now: () => NOW, shopIds: [active.id, inactive.id, other.id], log: quiet });
  assert.deepEqual([summary.shops, summary.written], [2, 8]);
  assert.equal((await rows(inactive)).length, 0);
  assert.deepEqual([(await rows(active)).reduce((n, r) => n + r.restockEmailSent, 0), (await rows(other)).reduce((n, r) => n + r.restockEmailSent, 0)], [0, 1]);
});

test("the run stops starting new days when told to, and finishes them on a later run", async () => {
  const shop = await makeShop("stop", "2026-10-14T00:00:00Z");
  let calls = 0;
  const summary = await run(shop, { shouldStop: () => calls++ >= 4 });
  assert.equal(summary.stopped, true);
  assert.ok(summary.written > 0 && summary.written < 9);
  await run(shop, { now: later(1000) });
  assert.equal((await days(shop)).length, 9);
});

test("the worker script runs the analytics step after the email queue and never when stopping", () => {
  const source = fs.readFileSync("scripts/worker.mjs", "utf8");
  assert.ok(source.indexOf("await worker.drain()") < source.indexOf("runAnalyticsDaily({"));
  assert.match(source, /if \(!signal\) \{\s*try \{\s*const done = await runAnalyticsDaily/);
});
