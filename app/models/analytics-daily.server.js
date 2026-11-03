import { DAY_MS, parseIsoDay } from "../utils/period";
import { activityCounts, sessionCountOf } from "./reporting.server";

// The metrics of ONE shop on ONE UTC calendar day.
//
//   - The six events of the Analytics loader: Wishlist added / removed / product opened, Notify Me subscribed and
//     unsubscribed, restock email sent (activityCounts, from ActivityEvent).
//   - Wishlist sessions and Notify Me sessions: the BrowsingSession rows that STARTED on this day (sessionCountOf, from
//     BrowsingSession), whether or not the customer did anything in them. A session has one start, so it belongs to
//     exactly one day and the days can be added up with no correction. The "carried" columns (sessions that also had
//     events the day before) were that correction for the old event-based definition; they are kept in the table
//     (no migration) and always written as 0, and nothing reads them.
//
// A day is [00:00:00.000Z, next 00:00:00.000Z): a session that starts at 23:59:59.999 belongs to that day, one that starts at
// 00:00:00.000 to the next.
export const DAILY_EVENT_TYPES = ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED", "NOTIFY_SUBSCRIBED", "NOTIFY_UNSUBSCRIBED", "RESTOCK_EMAIL_SENT"];

// `day` is "YYYY-MM-DD" (UTC). Returns { day, counts: { <the six types>: n }, wishlistSessions, notifyMeSessions,
// wishlistSessionsCarried, notifyMeSessionsCarried } with both carried counts 0.
export async function calculateAnalyticsDay(shopId, day) {
  const start = parseIsoDay(day);
  if (!shopId || !start) throw new Error("calculateAnalyticsDay needs a shop id and a UTC day as YYYY-MM-DD");
  const end = new Date(start.getTime() + DAY_MS);
  const [all, wishlistSessions, notifyMeSessions] = await Promise.all([
    activityCounts(shopId, start, end),
    sessionCountOf(shopId, "WISHLIST", start, end),
    sessionCountOf(shopId, "NOTIFY_ME", start, end),
  ]);
  return { day, counts: Object.fromEntries(DAILY_EVENT_TYPES.map((type) => [type, all[type]])), wishlistSessions, notifyMeSessions, wishlistSessionsCarried: 0, notifyMeSessionsCarried: 0 };
}
