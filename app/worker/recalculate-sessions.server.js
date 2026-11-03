import prisma from "../db.server";
import { DAY_MS } from "../utils/period";
import { sessionCountOf } from "../models/reporting.server";
import { invalidateAnalytics } from "../models/analytics-cache.server";

// One-off correction of the session totals already stored in AnalyticsDaily, written under the old event-based definition
// ("sessions with qualifying activity, counted on every day they have events"). The new definition counts every
// BrowsingSession on the UTC day it STARTED (sessionCountOf, used by calculateAnalyticsDay).
//
//   - It only looks at AnalyticsDaily rows that already exist (missing days are the worker's backfill job) and recomputes
//     four columns of each from BrowsingSession: wishlistSessions, notifyMeSessions, and both carried counts (always 0
//     now). A row is written only if one of those four values differs; nothing else in the row is touched.
//   - Read-only on BrowsingSession and ActivityEvent. Nothing is deleted. No DDL.
//   - Idempotent: BrowsingSession rows do not change, so a second run finds every row already correct and writes nothing.
//   - DRY RUN BY DEFAULT: `apply` must be true to write. A written row gets updatedAt = the moment its calculation started,
//     and only replaces a row older than that (the same guard as writeAnalyticsDay), so it cannot clobber a newer worker write.
//   - After writing, each changed shop's Analytics cache version is bumped.
// Returns { shops, rows, changed, written, stale, changes: [{ shop, day, from, to }] }.
export async function recalculateSessionTotals({ shopIds, apply = false, now = () => new Date(), invalidate = invalidateAnalytics } = {}) {
  const shops = await prisma.shop.findMany({ where: shopIds ? { id: { in: shopIds } } : {}, select: { id: true, domain: true }, orderBy: { id: "asc" } });
  const result = { shops: shops.length, rows: 0, changed: 0, written: 0, stale: 0, changes: [] };
  for (const shop of shops) {
    let wrote = 0;
    const daily = await prisma.analyticsDaily.findMany({
      where: { shopId: shop.id },
      orderBy: { day: "asc" },
      select: { day: true, wishlistSessions: true, notifyMeSessions: true, wishlistSessionsCarried: true, notifyMeSessionsCarried: true },
    });
    for (const row of daily) {
      result.rows += 1;
      const computedAt = now(); // before reading, as in writeAnalyticsDay
      const end = new Date(row.day.getTime() + DAY_MS);
      const [wishlistSessions, notifyMeSessions] = await Promise.all([sessionCountOf(shop.id, "WISHLIST", row.day, end), sessionCountOf(shop.id, "NOTIFY_ME", row.day, end)]);
      const from = { wishlistSessions: row.wishlistSessions, notifyMeSessions: row.notifyMeSessions, wishlistSessionsCarried: row.wishlistSessionsCarried, notifyMeSessionsCarried: row.notifyMeSessionsCarried };
      const to = { wishlistSessions, notifyMeSessions, wishlistSessionsCarried: 0, notifyMeSessionsCarried: 0 };
      if (Object.keys(to).every((key) => from[key] === to[key])) continue;
      result.changed += 1;
      result.changes.push({ shop: shop.domain, day: row.day.toISOString().slice(0, 10), from, to });
      if (!apply) continue;
      const updated = await prisma.analyticsDaily.updateMany({ where: { shopId: shop.id, day: row.day, updatedAt: { lt: computedAt } }, data: { ...to, updatedAt: computedAt } });
      if (updated.count) {
        result.written += 1;
        wrote += 1;
      } else {
        result.stale += 1;
      }
    }
    if (wrote) {
      try {
        await invalidate(shop.id);
      } catch {
        /* the cache expires by itself within minutes */
      }
    }
  }
  return result;
}
