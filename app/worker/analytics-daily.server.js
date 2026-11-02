import prisma from "../db.server";
import { DAY_MS, parseIsoDay, startOfUtcDay } from "../utils/period";
import { calculateAnalyticsDay } from "../models/analytics-daily.server";
import { invalidateAnalytics } from "../models/analytics-cache.server";

// Keeps the AnalyticsDaily table (one row per shop per UTC day) filled. The Analytics page reads ONLY this table for its
// event counts and sessions, so this is what makes its numbers current. Called once per worker run (every 10 minutes);
// it does a bounded amount of work and leaves the rest for the next run.
//   - Today and yesterday: recalculated on EVERY run. Today's row is partial by nature; yesterday is recalculated until
//     its last events have arrived (the first run after midnight closes the previous day).
//   - The 2 days before that: recalculated when their row is older than REFRESH_AFTER_MS, for late events (a restock
//     email retried after hours, a webhook redelivered within Shopify's 48 h, inventory events replayed by recovery).
//     Older days are final.
//   - Backfill / repair, newest first, at most BACKFILL_DAYS_PER_SHOP per shop and run: days since the shop was installed
//     that have no row; rows written before the notifyUnsubscribed column existed (it is NULL); rows that were
//     calculated before their day ended (the worker was down at midnight). Missing days are looked for in chunks of
//     CHUNK_DAYS, so memory does not grow with history.
//   - Failures: a day that fails is logged (error code only) and stays missing / stale, so the next run tries it again.
//     A failing day or shop never stops the others.
//   - Cache: after a shop's summaries were written, its Analytics cache version is bumped (invalidateAnalytics).
//   - Concurrency: see writeAnalyticsDay.
export const ALWAYS_REFRESH_DAYS = 2; // today and yesterday
export const REFRESH_DAYS = 4; // those two plus the 2 days before them
export const REFRESH_AFTER_MS = 60 * 60 * 1000;
export const BACKFILL_DAYS_PER_SHOP = 30;
const CHUNK_DAYS = 60;
const SHOP_PAGE = 50;
const DEFAULT_BUDGET_MS = 3 * 60 * 1000; // no new day is started after this, so the run ends well inside the cron limit

const dayKey = (date) => date.toISOString().slice(0, 10);

// Stores one calculated day. `computedAt` is when the calculation STARTED, and it is saved as the row's updatedAt, so a
// row says "this reflects the data as of <updatedAt>". A write only replaces a row that is older than that:
// two workers computing the same day can finish in any order, and the one that read the data later always wins.
// Create is the fallback for a missing row; losing the create race (P2002) goes back to the guarded update.
// Returns "written", or "stale" when a row computed from newer data is already there.
export async function writeAnalyticsDay(shopId, result, computedAt) {
  const day = parseIsoDay(result.day);
  if (!shopId || !day) throw new Error("writeAnalyticsDay needs a shop id and a result for a UTC day");
  const data = {
    wishlistAdded: result.counts.WISHLIST_ADDED,
    wishlistRemoved: result.counts.WISHLIST_REMOVED,
    wishlistProductClicked: result.counts.WISHLIST_PRODUCT_CLICKED,
    notifySubscribed: result.counts.NOTIFY_SUBSCRIBED,
    notifyUnsubscribed: result.counts.NOTIFY_UNSUBSCRIBED,
    restockEmailSent: result.counts.RESTOCK_EMAIL_SENT,
    wishlistSessions: result.wishlistSessions,
    notifyMeSessions: result.notifyMeSessions,
    wishlistSessionsCarried: result.wishlistSessionsCarried,
    notifyMeSessionsCarried: result.notifyMeSessionsCarried,
    updatedAt: computedAt,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const updated = await prisma.analyticsDaily.updateMany({ where: { shopId, day, updatedAt: { lt: computedAt } }, data });
    if (updated.count) return "written";
    try {
      await prisma.analyticsDaily.create({ data: { shopId, day, ...data } });
      return "written";
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }
  return "stale";
}

// The days of one shop that need a calculation now, in the order they are worked on.
async function daysToCalculate(shop, now, backfillLimit) {
  const today = startOfUtcDay(now).getTime();
  const first = startOfUtcDay(shop.installedAt).getTime();
  const todo = [];

  // Today and the recent days (day numbers counted back from today: 0 = today).
  const recentFrom = Math.max(first, today - (REFRESH_DAYS - 1) * DAY_MS);
  const recent = await prisma.analyticsDaily.findMany({ where: { shopId: shop.id, day: { gte: new Date(recentFrom), lte: new Date(today) } }, select: { day: true, updatedAt: true, notifyUnsubscribed: true } });
  const saved = new Map(recent.map((row) => [dayKey(row.day), row]));
  for (let t = today; t >= recentFrom; t -= DAY_MS) {
    const row = saved.get(dayKey(new Date(t)));
    const always = t >= today - (ALWAYS_REFRESH_DAYS - 1) * DAY_MS;
    if (always || !row || row.notifyUnsubscribed === null || row.updatedAt.getTime() < now.getTime() - REFRESH_AFTER_MS) todo.push(dayKey(new Date(t)));
  }

  // Older days: missing, written before the notifyUnsubscribed column, or calculated before their day ended.
  const olderLast = recentFrom - DAY_MS;
  if (olderLast < first) return todo;
  const older = new Set();
  const repair = await prisma.$queryRaw`SELECT day FROM AnalyticsDaily WHERE shopId = ${shop.id} AND day <= ${new Date(olderLast)} AND (notifyUnsubscribed IS NULL OR updatedAt < DATE_ADD(day, INTERVAL 1 DAY)) ORDER BY day DESC LIMIT ${backfillLimit}`;
  for (const row of repair) older.add(dayKey(new Date(row.day)));
  const expected = (olderLast - first) / DAY_MS + 1;
  const have = await prisma.analyticsDaily.count({ where: { shopId: shop.id, day: { gte: new Date(first), lte: new Date(olderLast) } } });
  if (have < expected) {
    let missing = 0;
    for (let hi = olderLast; hi >= first && missing < backfillLimit; ) {
      const lo = Math.max(first, hi - (CHUNK_DAYS - 1) * DAY_MS);
      const rows = await prisma.analyticsDaily.findMany({ where: { shopId: shop.id, day: { gte: new Date(lo), lte: new Date(hi) } }, select: { day: true } });
      const present = new Set(rows.map((row) => dayKey(row.day)));
      for (let t = hi; t >= lo && missing < backfillLimit; t -= DAY_MS) {
        if (!present.has(dayKey(new Date(t)))) {
          older.add(dayKey(new Date(t)));
          missing += 1;
        }
      }
      hi = lo - DAY_MS;
    }
  }
  return todo.concat([...older].sort().reverse().slice(0, backfillLimit));
}

// One pass over all active shops. Returns { shops, written, stale, failed, stopped }.
export async function runAnalyticsDaily({ now = () => new Date(), calculate = calculateAnalyticsDay, shopIds, shouldStop = () => false, budgetMs = DEFAULT_BUDGET_MS, backfillPerShop = BACKFILL_DAYS_PER_SHOP, log = console, invalidate = invalidateAnalytics } = {}) {
  const summary = { shops: 0, written: 0, stale: 0, failed: 0, stopped: false };
  const deadline = Date.now() + budgetMs;
  const outOfTime = () => {
    summary.stopped = summary.stopped || shouldStop() || Date.now() > deadline;
    return summary.stopped;
  };
  let cursor;
  while (!outOfTime()) {
    const shops = await prisma.shop.findMany({
      where: { status: "ACTIVE", ...(shopIds ? { id: { in: shopIds } } : {}) },
      select: { id: true, domain: true, installedAt: true },
      orderBy: { id: "asc" },
      take: SHOP_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!shops.length) break;
    cursor = shops[shops.length - 1].id;
    for (const shop of shops) {
      if (outOfTime()) break;
      summary.shops += 1;
      let wrote = 0;
      try {
        for (const day of await daysToCalculate(shop, now(), backfillPerShop)) {
          if (outOfTime()) break;
          try {
            const startedAt = now(); // before reading: see writeAnalyticsDay
            const outcome = await writeAnalyticsDay(shop.id, await calculate(shop.id, day), startedAt);
            summary[outcome] += 1;
            if (outcome === "written") wrote += 1;
          } catch (error) {
            summary.failed += 1;
            log.error(`[analytics] day failed ${JSON.stringify({ shop: shop.domain, day, reason: String(error?.code ?? error?.name ?? "error").slice(0, 64) })}`);
          }
        }
      } catch (error) {
        summary.failed += 1;
        log.error(`[analytics] shop failed ${JSON.stringify({ shop: shop.domain, reason: String(error?.code ?? error?.name ?? "error").slice(0, 64) })}`);
      }
      // The Analytics page caches its report per shop (analytics-cache.server.js): tell it the summaries changed. This
      // comes after the writes, so a page that misses afterwards reads the new rows. A failure here is not a failure of
      // the analytics work (the cache expires by itself within minutes).
      if (wrote) {
        try {
          await invalidate(shop.id);
        } catch {
          /* ignored on purpose */
        }
      }
    }
    if (shops.length < SHOP_PAGE) break;
  }
  return summary;
}
