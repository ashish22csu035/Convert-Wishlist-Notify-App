import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { numericId } from "../utils/shopify-ids.server";
import { DEFAULT_DAYS, PAGE_SIZE, RANGE_DAYS } from "../utils/dashboard-constants";
import { DAY_MS, parsePeriod, previousOf, resolvePeriod, startOfUtcDay } from "../utils/period";

export { parsePeriod };

// Read-only merchant reporting. Every query is scoped by shopId, which callers get from the
// authenticated shop's domain (getShopByDomain), never from browser input.
//
// Only what the database really holds is reported:
//   - Notify Me email clicks are not tracked anywhere, so they are reported as unavailable, never as zero.
//   - Orders and revenue come from verified order webhooks (see order-webhook.server.js). Until the order
//     permission is granted, or before the first order arrives, they are "not set up" / "waiting", never zero.
//   - Customers are shown by customer id only. Names and email addresses are never returned.
//   - A "previous period" comparison is only produced when tracking covers the whole previous period.
//
// Windows are whole UTC days: "last N days" is today plus the N-1 days before it, and a custom range
// includes both its first and its last day (see utils/period.js). Every report takes either a number of days
// or a period object and filters with the same bounds.

export const UNAVAILABLE = {
  emailClicks: "Clicks on restock emails are not tracked.",
  conversion: "Conversion from Wishlist to cart is not tracked.",
};

// What the screens need to know about the period (plain data, safe to send to the browser).
const publicPeriod = (period) => ({ kind: period.kind, days: period.days, from: period.from, to: period.to });

export function parseDays(value) {
  const days = Number(value);
  return RANGE_DAYS.includes(days) ? days : DEFAULT_DAYS;
}

export const sinceDays = (days, now = new Date()) => new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);

export function parsePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1;
}

export const parseChoice = (value, allowed, fallback) => (Object.hasOwn(allowed, value) ? value : fallback);

// Search text from the browser: trimmed, control characters removed, capped.
// eslint-disable-next-line no-control-regex
export const cleanQuery = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);

export const getShopByDomain = (domain) =>
  prisma.shop.findUnique({ where: { domain }, select: { id: true, domain: true, status: true, installedAt: true } });

const countMap = (rows, key) => Object.fromEntries(rows.map((row) => [row[key], row._count._all]));

export const ACTIVITY_TYPES = [
  "WISHLIST_ADDED",
  "WISHLIST_REMOVED",
  "WISHLIST_PRODUCT_CLICKED",
  "NOTIFY_SUBSCRIBED",
  "NOTIFY_UNSUBSCRIBED",
  "RESTOCK_EMAIL_SENT",
];
const WISHLIST_TYPES = ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED"];
const SUBSCRIPTION_STATUSES = ["ACTIVE", "FULFILLED", "UNSUBSCRIBED"];
const DELIVERY_STATUSES = ["PENDING", "SENDING", "SENT", "FAILED", "UNKNOWN", "SKIPPED"];

const withAll = (keys, counts) => Object.fromEntries(keys.map((key) => [key, counts[key] ?? 0]));

const range = (from, to) => ({ ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) });

export async function activityCounts(shopId, from, to) {
  const rows = await prisma.activityEvent.groupBy({
    by: ["type"],
    where: { shopId, ...(from || to ? { occurredAt: range(from, to) } : {}) },
    _count: { _all: true },
  });
  return withAll(ACTIVITY_TYPES, countMap(rows, "type"));
}

// The event counts that AnalyticsDaily stores, by the column that holds them.
const SUMMARY_COLUMNS = {
  WISHLIST_ADDED: "wishlistAdded",
  WISHLIST_REMOVED: "wishlistRemoved",
  WISHLIST_PRODUCT_CLICKED: "wishlistProductClicked",
  NOTIFY_SUBSCRIBED: "notifySubscribed",
  NOTIFY_UNSUBSCRIBED: "notifyUnsubscribed",
  RESTOCK_EMAIL_SENT: "restockEmailSent",
};

// What the Analytics screen shows for [from, to), read ONLY from the stored daily summaries (AnalyticsDaily, kept
// current by the worker, today included): the event counts, and the Wishlist / Notify Me session counts. ActivityEvent
// is never queried, and nothing falls back to it.
//   - Coverage: every UTC day from the shop's install day (or `from`, if later) to today needs a finished row. A row
//     with notifyUnsubscribed NULL was written before that column existed and does not count. `coverage` says how many
//     of the expected days were there.
//   - Counts: the sum of the rows that exist; a missing day contributes nothing. When coverage is incomplete the screen
//     says so (the numbers are then a lower bound) and a comparison to this period is not offered.
//   - Sessions: distinct, from the usable daily rows: sum(sessions) - sum(carried) for every counted day whose previous
//     day is also counted (a session over midnight is in two rows; "carried" is how many of a day's sessions began the
//     day before). Missing days and days with NULL sessions are left out, so valid days still show; the figure is then
//     a lower bound. null (unavailable) only when no row is usable; 0 when the range ends before the shop was installed.
// `to` is exclusive; null means "through today".
export async function summarizedActivity(shop, from, to, now = new Date()) {
  const end = Math.min(to ? to.getTime() : Infinity, startOfUtcDay(now).getTime() + DAY_MS);
  const start = Math.max(from.getTime(), startOfUtcDay(shop.installedAt).getTime());
  const expected = Math.max(0, Math.round((end - start) / DAY_MS));
  const rows = expected
    ? (await prisma.analyticsDaily.findMany({ where: { shopId: shop.id, day: { gte: new Date(start), lt: new Date(end) } }, orderBy: { day: "asc" } })).filter((row) => row.notifyUnsubscribed !== null)
    : [];
  const counts = Object.fromEntries(ACTIVITY_TYPES.map((type) => [type, 0]));
  for (const row of rows) for (const [type, column] of Object.entries(SUMMARY_COLUMNS)) counts[type] += row[column];
  const complete = rows.length === expected;
  // Sessions from the rows that are usable: a row whose session count is NULL (that day holds events with no session) is
  // skipped rather than read as zero, and a day with no row adds nothing. A day's "carried" sessions are subtracted only
  // when the PREVIOUS calendar day is itself a counted row, because only then were they counted twice. null when no row is
  // usable at all. With missing or skipped days the figure is a lower bound, never an invented one.
  const sessions = (daily, carried) => {
    const usable = rows.filter((row) => row[daily] !== null && row[carried] !== null);
    if (expected === 0) return 0; // the range ends before tracking began: nothing to count, and nothing missing
    if (usable.length === 0) return null;
    const counted = new Set(usable.map((row) => row.day.getTime()));
    return usable.reduce((total, row) => total + row[daily] - (counted.has(row.day.getTime() - DAY_MS) ? row[carried] : 0), 0);
  };
  return {
    counts,
    sessions: { wishlist: sessions("wishlistSessions", "wishlistSessionsCarried"), notifyMe: sessions("notifyMeSessions", "notifyMeSessionsCarried") },
    coverage: { expectedDays: expected, availableDays: rows.length, complete },
  };
}

async function subscriptionCounts(shopId) {
  const rows = await prisma.notifySubscription.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } });
  return withAll(SUBSCRIPTION_STATUSES, countMap(rows, "status"));
}

async function deliveryCounts(shopId) {
  const rows = await prisma.emailDelivery.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } });
  return withAll(DELIVERY_STATUSES, countMap(rows, "status"));
}

async function wishlistTotals(shopId) {
  const [savedItems, customers, products] = await Promise.all([
    prisma.wishlistItem.count({ where: { shopId } }),
    prisma.wishlistItem.groupBy({ by: ["actorId"], where: { shopId } }).then((rows) => rows.length),
    prisma.wishlistItem.groupBy({ by: ["productGid"], where: { shopId } }).then((rows) => rows.length),
  ]);
  return { savedItems, customers, products };
}

// Distinct logged-in customers who used Wishlist in the period, and Wishlist browsing sessions.
async function wishlistUsers(shopId, from, to) {
  const rows = await prisma.activityEvent.groupBy({
    by: ["actorId"],
    where: { shopId, feature: "WISHLIST", occurredAt: range(from, to) },
  });
  return rows.length;
}
const wishlistSessions = (shopId, from, to) =>
  prisma.browsingSession.count({ where: { shopId, feature: "WISHLIST", startedAt: range(from, to) } });

const dayKey = (value) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

// Daily counts for the period, one entry per UTC day from the later of the period start and the day
// tracking began for this shop (earlier days are not "zero", they simply were not tracked).
async function dailySeries(shop, since, until, now) {
  const end = until ?? new Date(startOfUtcDay(now).getTime() + DAY_MS); // exclusive: the day after the last day shown
  const [rows, userRows] = await Promise.all([
    prisma.$queryRaw`SELECT DATE(occurredAt) AS day, type, COUNT(*) AS n FROM ActivityEvent WHERE shopId = ${shop.id} AND occurredAt >= ${since} AND occurredAt < ${end} GROUP BY DATE(occurredAt), type`,
    prisma.$queryRaw`SELECT DATE(occurredAt) AS day, COUNT(DISTINCT actorId) AS n FROM ActivityEvent WHERE shopId = ${shop.id} AND feature = 'WISHLIST' AND occurredAt >= ${since} AND occurredAt < ${end} GROUP BY DATE(occurredAt)`,
  ]);
  const first = Math.max(since.getTime(), startOfUtcDay(shop.installedAt).getTime());
  const days = [];
  for (let t = first; t < end.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  const index = new Map(days.map((day, i) => [day, i]));
  const values = Object.fromEntries([...ACTIVITY_TYPES, "wishlistUsers"].map((key) => [key, days.map(() => 0)]));
  for (const row of rows) {
    const i = index.get(dayKey(row.day));
    if (i !== undefined && values[row.type]) values[row.type][i] = Number(row.n);
  }
  for (const row of userRows) {
    const i = index.get(dayKey(row.day));
    if (i !== undefined) values.wishlistUsers[i] = Number(row.n);
  }
  return { days, values };
}

async function topSavedProducts(shopId, take) {
  const rows = await prisma.wishlistItem.groupBy({
    by: ["productGid"],
    where: { shopId },
    _count: { _all: true },
    _max: { productTitle: true, createdAt: true },
    orderBy: [{ _count: { productGid: "desc" } }, { productGid: "asc" }],
    take,
  });
  return rows.map((row) => ({ productGid: row.productGid, productId: numericId(row.productGid), fallbackTitle: row._max.productTitle, saves: row._count._all }));
}

const toEvent = (row) => ({
  id: row.id,
  type: row.type,
  occurredAt: row.occurredAt,
  productGid: row.productGid,
  variantGid: row.variantGid,
});

// Everything the Dashboard needs.
export async function getDashboard(shop, input = DEFAULT_DAYS, now = new Date()) {
  const period = resolvePeriod(input, now);
  const { since, until, days } = period;
  const { since: prevSince } = previousOf(period);
  const comparable = shop.installedAt <= prevSince; // tracking covers the whole previous period
  const prev = (fn) => (comparable ? fn() : Promise.resolve(null));

  const [window, previous, allTime, subscriptions, deliveries, wishlist, users, previousUsers, sessions, previousSessions, series, top, recent] =
    await Promise.all([
      activityCounts(shop.id, since, until),
      prev(() => activityCounts(shop.id, prevSince, since)),
      activityCounts(shop.id, null, null),
      subscriptionCounts(shop.id),
      deliveryCounts(shop.id),
      wishlistTotals(shop.id),
      wishlistUsers(shop.id, since, until),
      prev(() => wishlistUsers(shop.id, prevSince, since)),
      wishlistSessions(shop.id, since, until),
      prev(() => wishlistSessions(shop.id, prevSince, since)),
      dailySeries(shop, since, until, now),
      topSavedProducts(shop.id, 5),
      prisma.activityEvent.findMany({
        where: { shopId: shop.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 8,
        select: { id: true, type: true, occurredAt: true, productGid: true, variantGid: true },
      }),
    ]);
  return {
    days,
    period: publicPeriod(period),
    since,
    now,
    comparable,
    activity: { window, previous, allTime },
    wishlistUsers: { current: users, previous: previousUsers },
    sessions: { current: sessions, previous: previousSessions },
    subscriptions,
    deliveries,
    wishlist,
    series,
    topProducts: top,
    recent: recent.map(toEvent),
    unavailable: UNAVAILABLE,
  };
}

async function topCustomers(shopId, from, until, take) {
  const rows = await prisma.activityEvent.groupBy({
    by: ["actorId"],
    where: { shopId, occurredAt: range(from, until) },
    _count: { _all: true },
    orderBy: [{ _count: { actorId: "desc" } }, { actorId: "asc" }],
    take,
  });
  if (!rows.length) return [];
  const actors = await prisma.actor.findMany({
    where: { shopId, id: { in: rows.map((row) => row.actorId) } },
    select: { id: true, customerGid: true, _count: { select: { wishlistItems: true, subscriptions: { where: { status: "ACTIVE" } } } } },
  });
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  return rows
    .filter((row) => byId.has(row.actorId))
    .map((row) => {
      const actor = byId.get(row.actorId);
      return { customerId: numericId(actor.customerGid), activity: row._count._all, savedItems: actor._count.wishlistItems, activeSubscriptions: actor._count.subscriptions };
    });
}

// The Analytics screen: the dashboard figures plus daily series and a few leaderboards.
// Distinct browsing sessions that did something in a feature during a period: each session counts once, however
// many events it holds. Source: ActivityEvent.browsingSessionId (the session every customer-made event is stored
// with) restricted to the event types made inside a session. Restock emails and unsubscribes are written by the
// worker and the email link, outside any session, so they never count. Events recorded before sessions existed
// have no session id; if the period contains any of those the count cannot be trusted and is null (unavailable).
const SESSION_EVENT_TYPES = {
  WISHLIST: ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED"],
  NOTIFY_ME: ["NOTIFY_SUBSCRIBED"],
};

export async function sessionsWithActivity(shopId, feature, from, until) {
  const types = SESSION_EVENT_TYPES[feature];
  const end = until ?? new Date("9999-12-31T00:00:00Z");
  const [counted, unattributed] = await Promise.all([
    prisma.$queryRaw`SELECT COUNT(DISTINCT browsingSessionId) AS n FROM ActivityEvent WHERE shopId = ${shopId} AND feature = ${feature} AND type IN (${Prisma.join(types)}) AND occurredAt >= ${from} AND occurredAt < ${end} AND browsingSessionId IS NOT NULL`,
    prisma.activityEvent.count({ where: { shopId, feature, type: { in: types }, occurredAt: range(from, until), browsingSessionId: null } }),
  ]);
  return unattributed > 0 ? null : Number(counted[0]?.n ?? 0);
}

export async function getAnalytics(shop, input = DEFAULT_DAYS, now = new Date()) {
  const period = resolvePeriod(input, now);
  const dashboard = await getDashboard(shop, period, now);
  const { since: prevSince } = previousOf(period);
  const comparable = shop.installedAt <= prevSince; // tracking covers the whole previous period
  const [customers, topProducts, sessionCounts] = await Promise.all([
    topCustomers(shop.id, period.since, period.until, 5),
    topSavedProducts(shop.id, 5),
    Promise.all(
      ["WISHLIST", "NOTIFY_ME"].map(async (feature) => ({
        current: await sessionsWithActivity(shop.id, feature, period.since, period.until),
        previous: comparable ? await sessionsWithActivity(shop.id, feature, prevSince, period.since) : null,
      })),
    ),
  ]);
  return { ...dashboard, topProducts, topCustomers: customers, sessionActivity: { wishlist: sessionCounts[0], notifyMe: sessionCounts[1] } };
}

// sessionsWithActivity for one feature and period in ONE query instead of two: the distinct sessions, and how many
// of the same events carry no session (COUNT(DISTINCT col) skips NULLs; COUNT(*) - COUNT(col) is exactly the NULLs).
// Same events, same filters, same null-when-unattributed rule as sessionsWithActivity above.
export async function sessionCountOf(shopId, feature, from, until) {
  const types = SESSION_EVENT_TYPES[feature];
  const end = until ?? new Date("9999-12-31T00:00:00Z");
  const [row] = await prisma.$queryRaw`SELECT COUNT(DISTINCT browsingSessionId) AS counted, COUNT(*) - COUNT(browsingSessionId) AS unattributed FROM ActivityEvent WHERE shopId = ${shopId} AND feature = ${feature} AND type IN (${Prisma.join(types)}) AND occurredAt >= ${from} AND occurredAt < ${end}`;
  return Number(row?.unattributed ?? 0) > 0 ? null : Number(row?.counted ?? 0);
}

// When the Analytics figures were last brought up to date for a shop: the newest finished AnalyticsDaily row's updatedAt.
// The worker saves each calculated day with updatedAt = the moment its calculation STARTED (writeAnalyticsDay), so this is
// "the stored figures reflect events up to <this time>", and it only moves when a day is really written. createdAt is not
// used (a row keeps it for life), nor the request time. Rows from before notifyUnsubscribed existed are not finished
// summaries (see summarizedActivity) and are ignored. One MAX over this shop's rows; null when there is none yet.
export async function latestAnalyticsUpdate(shopId) {
  const { _max } = await prisma.analyticsDaily.aggregate({ _max: { updatedAt: true }, where: { shopId, notifyUnsubscribed: { not: null } } });
  return _max.updatedAt ? _max.updatedAt.toISOString() : null;
}

// What the Analytics screen shows, and nothing else: the window and previous-period event counts, the session
// cards, the two leaderboards. The counts and sessions come from the stored daily summaries (summarizedActivity), never
// from ActivityEvent; getAnalytics (above) is the live reference loader and getDashboard is untouched.
// The top customers still rank live activity (one grouped read of ActivityEvent for the period), the top products read
// the saved items. Every query is independent, so they all run at once.
export async function getAnalyticsOverview(shop, input = DEFAULT_DAYS, now = new Date()) {
  const period = resolvePeriod(input, now);
  const { since, until, days } = period;
  const { since: prevSince } = previousOf(period);
  const comparable = shop.installedAt <= prevSince; // tracking covers the whole previous period
  const [current, prior, topProducts, customers, lastUpdated] = await Promise.all([
    summarizedActivity(shop, since, until, now),
    comparable ? summarizedActivity(shop, prevSince, since, now) : Promise.resolve(null),
    topSavedProducts(shop.id, 5),
    topCustomers(shop.id, since, until, 5),
    latestAnalyticsUpdate(shop.id),
  ]);
  // A previous period with missing days would make every comparison look like growth: it is not offered.
  const previous = prior?.coverage.complete ? prior : null;
  return {
    days,
    period: publicPeriod(period),
    comparable,
    activity: { window: current.counts, previous: previous ? previous.counts : null },
    topProducts,
    topCustomers: customers,
    sessionActivity: {
      wishlist: { current: current.sessions.wishlist, previous: previous ? previous.sessions.wishlist : null },
      notifyMe: { current: current.sessions.notifyMe, previous: previous ? previous.sessions.notifyMe : null },
    },
    coverage: current.coverage,
    lastUpdated, // ISO time of the newest finished daily summary, or null; it travels with the figures (and so with their cache entry)
  };
}

export async function getWishlistOverview(shopId, input = DEFAULT_DAYS, now = new Date()) {
  const period = resolvePeriod(input, now);
  const { days } = period;
  const [totals, window] = await Promise.all([wishlistTotals(shopId), activityCounts(shopId, period.since, period.until)]);
  return { days, period: publicPeriod(period), totals, window: { added: window.WISHLIST_ADDED, removed: window.WISHLIST_REMOVED, clicked: window.WISHLIST_PRODUCT_CLICKED } };
}

const WISHLIST_ORDER = {
  saves: [{ _count: { id: "desc" } }, { variantGid: "asc" }],
  recent: [{ _max: { createdAt: "desc" } }, { variantGid: "asc" }],
};

// Saved products, one row per variant, searchable by the title stored with the wishlist item.
export async function getWishlistProducts(shopId, { q = "", sort = "saves", page = 1 } = {}) {
  const where = { shopId, ...(q ? { productTitle: { contains: q } } : {}) };
  const [groups, rows] = await Promise.all([
    prisma.wishlistItem.groupBy({ by: ["productGid", "variantGid"], where }).then((all) => all.length),
    prisma.wishlistItem.groupBy({
      by: ["productGid", "variantGid"],
      where,
      _count: { id: true },
      _max: { productTitle: true, createdAt: true },
      orderBy: WISHLIST_ORDER[sort] ?? WISHLIST_ORDER.saves,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  return {
    total: groups,
    rows: rows.map((row) => ({
      productGid: row.productGid,
      variantGid: row.variantGid,
      productId: numericId(row.productGid),
      variantId: numericId(row.variantGid),
      fallbackTitle: row._max.productTitle,
      saves: row._count.id,
      lastSavedAt: row._max.createdAt,
    })),
  };
}

// The Wishlist activity log, newest first. Customers are identified by id only.
// Events inside the date range (event time, UTC), optionally one kind of event.
export async function getWishlistActivity(shopId, { page = 1, days = DEFAULT_DAYS, type = "all" } = {}, now = new Date()) {
  const period = resolvePeriod(days, now);
  const where = { shopId, type: WISHLIST_TYPES.includes(type) ? type : { in: WISHLIST_TYPES }, occurredAt: range(period.since, period.until) };
  const [total, rows] = await Promise.all([
    prisma.activityEvent.count({ where }),
    prisma.activityEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, type: true, occurredAt: true, productGid: true, variantGid: true, actor: { select: { customerGid: true } } },
    }),
  ]);
  return { total, rows: rows.map((row) => ({ ...toEvent(row), customerId: numericId(row.actor.customerGid) })) };
}

// No recipient address, link token hash or message id is ever selected.
const deliverySelect = {
  id: true,
  subscriptionId: true,
  variantGid: true,
  restockCycle: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  sentAt: true,
  errorCode: true,
  createdAt: true,
};

const toDelivery = (row) => ({
  id: row.id,
  subscriptionId: row.subscriptionId,
  variantGid: row.variantGid,
  variantId: numericId(row.variantGid),
  restockCycle: row.restockCycle,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt,
  sentAt: row.sentAt,
  errorCode: row.errorCode,
  createdAt: row.createdAt,
});

export async function getNotifyOverview(shopId, input = DEFAULT_DAYS, now = new Date()) {
  const period = resolvePeriod(input, now);
  const { days } = period;
  const [subscriptions, deliveries, window, requested, skipped, problems] = await Promise.all([
    subscriptionCounts(shopId),
    deliveryCounts(shopId),
    activityCounts(shopId, period.since, period.until),
    prisma.notifySubscription.groupBy({
      by: ["productGid", "variantGid"],
      where: { shopId, status: "ACTIVE" },
      _count: { _all: true },
      orderBy: [{ _count: { variantGid: "desc" } }, { variantGid: "asc" }],
      take: 5,
    }),
    prisma.emailDelivery.groupBy({ by: ["errorCode"], where: { shopId, status: "SKIPPED" }, _count: { _all: true }, orderBy: { _count: { errorCode: "desc" } } }),
    prisma.emailDelivery.findMany({ where: { shopId, status: { in: ["FAILED", "UNKNOWN"] } }, orderBy: { updatedAt: "desc" }, take: 10, select: deliverySelect }),
  ]);
  return {
    days,
    period: publicPeriod(period),
    subscriptions,
    deliveries,
    window: { subscribed: window.NOTIFY_SUBSCRIBED, unsubscribed: window.NOTIFY_UNSUBSCRIBED, emailsSent: window.RESTOCK_EMAIL_SENT },
    requested: requested.map((row) => ({ productGid: row.productGid, variantGid: row.variantGid, productId: numericId(row.productGid), variantId: numericId(row.variantGid), subscribers: row._count._all })),
    skipReasons: skipped.map((row) => ({ reason: row.errorCode ?? "unknown", count: row._count._all })),
    problems: problems.map(toDelivery),
  };
}

// Subscriptions: product/variant, status and dates. No customer, email or consent details.
// Not limited by the date range: it lists every subscription, newest first, with the result of the
// latest restock email for each (the status of that email, never the recipient).
// Opted-out subscriptions are not listed (the unsubscribe itself is still recorded and processed elsewhere).
// Each row also carries `waitingCustomers`: the ACTIVE subscriptions for the same variant, counted with one grouped query.
export async function getSubscriptions(shopId, { status = "all", page = 1 } = {}) {
  const where = { shopId, status: status !== "all" ? status : { in: ["ACTIVE", "FULFILLED"] } };
  const [total, rows] = await Promise.all([
    prisma.notifySubscription.count({ where }),
    prisma.notifySubscription.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, productGid: true, variantGid: true, status: true, createdAt: true, updatedAt: true, unsubscribedAt: true },
    }),
  ]);
  const latest = new Map();
  const waiting = new Map();
  if (rows.length) {
    const grouped = await prisma.notifySubscription.groupBy({ by: ["variantGid"], where: { shopId, status: "ACTIVE", variantGid: { in: [...new Set(rows.map((row) => row.variantGid))] } }, _count: { _all: true } });
    for (const group of grouped) waiting.set(group.variantGid, group._count._all);
    const emails = await prisma.emailDelivery.findMany({
      where: { shopId, subscriptionId: { in: rows.map((row) => row.id) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { subscriptionId: true, status: true, restockCycle: true, sentAt: true, createdAt: true },
    });
    for (const email of emails) if (!latest.has(email.subscriptionId)) latest.set(email.subscriptionId, email);
  }
  return {
    total,
    rows: rows.map((row) => {
      const email = latest.get(row.id);
      return {
        ...row,
        productId: numericId(row.productGid),
        variantId: numericId(row.variantGid),
        waitingCustomers: waiting.get(row.variantGid) ?? 0,
        lastEmail: email ? { status: email.status, restockCycle: email.restockCycle, at: email.sentAt ?? email.createdAt } : null,
      };
    }),
  };
}

// Restock emails queued inside the date range (queued time, UTC), optionally one status.
// Each row also carries `emailsSent`: SENT emails for the same variant queued inside the same date range (whatever the
// status filter), counted with one grouped query.
export async function getDeliveries(shopId, { status = "all", page = 1, days = DEFAULT_DAYS } = {}, now = new Date()) {
  const period = resolvePeriod(days, now);
  const where = { shopId, createdAt: range(period.since, period.until), ...(status !== "all" ? { status } : {}) };
  const [total, rows] = await Promise.all([
    prisma.emailDelivery.count({ where }),
    prisma.emailDelivery.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: deliverySelect }),
  ]);
  const sent = new Map();
  if (rows.length) {
    const grouped = await prisma.emailDelivery.groupBy({ by: ["variantGid"], where: { shopId, status: "SENT", createdAt: range(period.since, period.until), variantGid: { in: [...new Set(rows.map((row) => row.variantGid))] } }, _count: { _all: true } });
    for (const group of grouped) sent.set(group.variantGid, group._count._all);
  }
  return { total, rows: rows.map((row) => ({ ...toDelivery(row), emailsSent: sent.get(row.variantGid) ?? 0 })) };
}

const CUSTOMER_ORDER = {
  recent: [{ lastSeenAt: "desc" }, { id: "desc" }],
  saved: [{ wishlistItems: { _count: "desc" } }, { lastSeenAt: "desc" }, { id: "desc" }],
};

// Customers who have used Wishlist or Notify Me: always logged-in customers, because every row comes
// from a verified customer id. Only the id, counts and dates are returned.
export async function getCustomersReport(shopId, { days = DEFAULT_DAYS, q = "", sort = "recent", page = 1 } = {}, now = new Date()) {
  const period = resolvePeriod(days, now);
  const { since, until } = period;
  const digits = /^[0-9]{1,20}$/.test(q) ? q : null;
  const where = { shopId, ...(q ? { customerGid: digits ? `gid://shopify/Customer/${digits}` : "" } : {}) };
  const [everyone, totalMatching, savedItems] = await Promise.all([
    prisma.actor.count({ where: { shopId } }),
    prisma.actor.count({ where }),
    prisma.wishlistItem.count({ where: { shopId } }),
  ]);

  let actors;
  if (sort === "activity") {
    // Ranked by events in the window, so only customers with activity in the window are listed.
    const ranked = await prisma.activityEvent.groupBy({
      by: ["actorId"],
      where: { shopId, occurredAt: range(since, until), ...(q ? { actor: where } : {}) },
      _count: { _all: true },
      orderBy: [{ _count: { actorId: "desc" } }, { actorId: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });
    actors = ranked.length ? await prisma.actor.findMany({ where: { shopId, id: { in: ranked.map((r) => r.actorId) } }, select: actorSelect }) : [];
    const order = new Map(ranked.map((r, i) => [r.actorId, i]));
    actors.sort((a, b) => order.get(a.id) - order.get(b.id));
  } else {
    actors = await prisma.actor.findMany({
      where,
      orderBy: CUSTOMER_ORDER[sort] ?? CUSTOMER_ORDER.recent,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: actorSelect,
    });
  }

  const ids = actors.map((actor) => actor.id);
  const events = ids.length
    ? await prisma.activityEvent.groupBy({ by: ["actorId"], where: { shopId, actorId: { in: ids }, occurredAt: range(since, until) }, _count: { _all: true } })
    : [];
  const recent = Object.fromEntries(events.map((row) => [row.actorId, row._count._all]));
  return {
    days: period.days,
    period: publicPeriod(period),
    everyone,
    savedItems,
    total: sort === "activity" ? await activeCustomerCount(shopId, since, until, q ? where : null) : totalMatching,
    customers: actors.map((actor) => ({
      customerId: numericId(actor.customerGid),
      lastSeenAt: actor.lastSeenAt,
      savedItems: actor._count.wishlistItems,
      activeSubscriptions: actor._count.subscriptions,
      recentActivity: recent[actor.id] ?? 0,
    })),
  };
}

const actorSelect = {
  id: true,
  customerGid: true,
  lastSeenAt: true,
  _count: { select: { wishlistItems: true, subscriptions: { where: { status: "ACTIVE" } } } },
};

async function activeCustomerCount(shopId, since, until, actorWhere) {
  const rows = await prisma.activityEvent.groupBy({
    by: ["actorId"],
    where: { shopId, occurredAt: range(since, until), ...(actorWhere ? { actor: actorWhere } : {}) },
  });
  return rows.length;
}

// ---------- Purchase attribution ----------

// The order permission is granted when the shop's offline session scope includes it.
export const hasOrderScope = (scope) => String(scope ?? "").split(",").map((item) => item.trim()).some((item) => item === "read_orders" || item === "read_all_orders");

const money = (decimal) => decimal.toFixed(2);

// Attributed orders and revenue for the date range, per feature and overall. Attribution rows aggregate
// line items by order, feature, and product; order counts and order value therefore use distinct orders,
// while revenue sums only the net value of the credited line items. Only ACTIVE attributions count.
//
// state: "needs_access"  the order permission has not been granted: orders cannot be collected
//        "waiting"       permission granted but no order has been received yet: no figure is shown
//        "ready"         order data exists: zero means a confirmed zero
export async function getAttribution(shopId, input = DEFAULT_DAYS, { scopeGranted = false, now = new Date() } = {}) {
  const period = resolvePeriod(input, now);
  const { since, days } = period;
  const base = { days, period: publicPeriod(period), since };
  const collected = await prisma.shopifyOrder.findFirst({ where: { shopId }, select: { id: true } }); // only "any order at all?" matters
  if (!collected) return { ...base, state: scopeGranted ? "waiting" : "needs_access" };

  const rows = await prisma.orderAttribution.findMany({
    where: { shopId, status: "ACTIVE", order: { placedAt: period.until ? { gte: since, lt: period.until } : { gte: since, lte: now } } },
    select: { orderId: true, feature: true, matchedProductGid: true, grossAmount: true, refundedAmount: true, currencyCode: true, order: { select: { totalPrice: true } } },
  });
  const currencies = [...new Set(rows.map((row) => row.currencyCode))];
  const mixedCurrency = currencies.length > 1;
  const blank = () => ({ orderIds: new Set(), orderValues: new Map(), revenue: new Prisma.Decimal(0) });
  const totals = { overall: blank(), WISHLIST: blank(), NOTIFY_ME: blank() };
  for (const row of rows) {
    for (const bucket of [totals.overall, totals[row.feature]]) {
      bucket.orderIds.add(row.orderId);
      bucket.orderValues.set(row.orderId, row.order.totalPrice);
      bucket.revenue = bucket.revenue.plus(row.grossAmount).minus(row.refundedAmount);
    }
  }
  // Net revenue per product the winning touch matched: the same rows as the totals above.
  const perProduct = new Map();
  for (const row of rows) {
    const entry = perProduct.get(row.matchedProductGid) ?? { orderIds: new Set(), revenue: new Prisma.Decimal(0) };
    entry.orderIds.add(row.orderId);
    entry.revenue = entry.revenue.plus(row.grossAmount).minus(row.refundedAmount);
    perProduct.set(row.matchedProductGid, entry);
  }
  const topProducts = mixedCurrency
    ? []
    : [...perProduct.entries()]
        .sort((a, b) => b[1].revenue.comparedTo(a[1].revenue) || b[1].orderIds.size - a[1].orderIds.size)
        .slice(0, 5)
        .map(([productGid, entry]) => ({ productGid, productId: numericId(productGid), orders: entry.orderIds.size, revenue: money(entry.revenue) }));
  const view = (bucket) => ({
    orders: bucket.orderIds.size,
    revenue: mixedCurrency ? null : money(bucket.revenue),
    orderValue: mixedCurrency ? null : money([...bucket.orderValues.values()].reduce((sum, amount) => sum.plus(amount), new Prisma.Decimal(0))),
  });
  return {
    ...base,
    state: "ready",
    currency: currencies[0] ?? null,
    mixedCurrency,
    overall: view(totals.overall),
    wishlist: view(totals.WISHLIST),
    notifyMe: view(totals.NOTIFY_ME),
    topProducts,
  };
}
