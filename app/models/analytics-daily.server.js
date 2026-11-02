import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { DAY_MS, parseIsoDay } from "../utils/period";
import { activityCounts, sessionCountOf } from "./reporting.server";

// The metrics of ONE shop on ONE UTC calendar day, calculated from ActivityEvent with the same functions the
// Analytics screen used to call (activityCounts, sessionCountOf), so a day can never disagree with those definitions.
//
//   - The six events of the Analytics loader: Wishlist added / removed / product opened, Notify Me subscribed and
//     unsubscribed, restock email sent.
//   - Sessions with Wishlist activity and sessions with Notify Me activity: distinct browsing sessions, null
//     (unavailable) when that day holds events of that kind that carry no session.
//   - "Carried" sessions: those of the day that ALSO had qualifying events on the previous UTC day. They exist so
//     the Analytics page can turn daily sessions into exact range-wide distinct sessions without reading events:
//     range sessions = sum(daily sessions) - sum(carried, for every day of the range except its first).
//     A session lasts 30 minutes (browsing-session.server.js), so it touches at most two consecutive days and this is exact.
//
// A day is [00:00:00.000Z, next 00:00:00.000Z): an event at 23:59:59.999 belongs to that day, one at 00:00:00.000 to
// the next. A session counts on every day it has qualifying events, so a session that crosses midnight counts once on
// EACH of the two days; never sum daily sessions as if they were distinct over several days.
export const DAILY_EVENT_TYPES = ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED", "NOTIFY_SUBSCRIBED", "NOTIFY_UNSUBSCRIBED", "RESTOCK_EMAIL_SENT"];

// Same qualifying events as sessionCountOf (reporting.server.js).
const SESSION_TYPES = {
  WISHLIST: ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED"],
  NOTIFY_ME: ["NOTIFY_SUBSCRIBED"],
};

async function carriedSessions(shopId, feature, start, end, previousStart) {
  const types = Prisma.join(SESSION_TYPES[feature]);
  const [row] = await prisma.$queryRaw`SELECT COUNT(DISTINCT e.browsingSessionId) AS n FROM ActivityEvent e WHERE e.shopId = ${shopId} AND e.feature = ${feature} AND e.type IN (${types}) AND e.occurredAt >= ${start} AND e.occurredAt < ${end} AND e.browsingSessionId IS NOT NULL AND EXISTS (SELECT 1 FROM ActivityEvent p WHERE p.shopId = ${shopId} AND p.browsingSessionId = e.browsingSessionId AND p.feature = ${feature} AND p.type IN (${types}) AND p.occurredAt >= ${previousStart} AND p.occurredAt < ${start})`;
  return Number(row?.n ?? 0);
}

// `day` is "YYYY-MM-DD" (UTC). Returns { day, counts: { <the six types>: n }, wishlistSessions, notifyMeSessions,
// wishlistSessionsCarried, notifyMeSessionsCarried }. A carried count is null exactly when its sessions count is.
export async function calculateAnalyticsDay(shopId, day) {
  const start = parseIsoDay(day);
  if (!shopId || !start) throw new Error("calculateAnalyticsDay needs a shop id and a UTC day as YYYY-MM-DD");
  const end = new Date(start.getTime() + DAY_MS);
  const previousStart = new Date(start.getTime() - DAY_MS);
  const [all, wishlistSessions, notifyMeSessions] = await Promise.all([
    activityCounts(shopId, start, end),
    sessionCountOf(shopId, "WISHLIST", start, end),
    sessionCountOf(shopId, "NOTIFY_ME", start, end),
  ]);
  const [wishlistSessionsCarried, notifyMeSessionsCarried] = await Promise.all([
    wishlistSessions === null ? null : carriedSessions(shopId, "WISHLIST", start, end, previousStart),
    notifyMeSessions === null ? null : carriedSessions(shopId, "NOTIFY_ME", start, end, previousStart),
  ]);
  return { day, counts: Object.fromEntries(DAILY_EVENT_TYPES.map((type) => [type, all[type]])), wishlistSessions, notifyMeSessions, wishlistSessionsCarried, notifyMeSessionsCarried };
}
