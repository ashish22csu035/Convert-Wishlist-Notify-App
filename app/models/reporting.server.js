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

async function activityCounts(shopId, from, to) {
  const rows = await prisma.activityEvent.groupBy({
    by: ["type"],
    where: { shopId, ...(from || to ? { occurredAt: range(from, to) } : {}) },
    _count: { _all: true },
  });
  return withAll(ACTIVITY_TYPES, countMap(rows, "type"));
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

export async function getWishlistOverview(shopId, input = DEFAULT_DAYS, now = new Date()) {
  const period = resolvePeriod(input, now);
  const { days } = period;
  const [totals, window] = await Promise.all([wishlistTotals(shopId), activityCounts(shopId, period.since, period.until)]);
  return { days, period: publicPeriod(period), totals, window: { added: window.WISHLIST_ADDED, removed: window.WISHLIST_REMOVED, clicked: window.WISHLIST_PRODUCT_CLICKED } };
}

const WISHLIST_ORDER = {
  saves: [{ _count: { id: "desc" } }, { variantGid: "asc" }],
  recent: [{ _max: { createdAt: "desc" } }, { variantGid: "asc" }],
  name: [{ _max: { productTitle: "asc" } }, { variantGid: "asc" }],
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
export async function getSubscriptions(shopId, { status = "all", page = 1 } = {}) {
  const where = { shopId, ...(status !== "all" ? { status } : {}) };
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
  if (rows.length) {
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
        lastEmail: email ? { status: email.status, restockCycle: email.restockCycle, at: email.sentAt ?? email.createdAt } : null,
      };
    }),
  };
}

// Restock emails queued inside the date range (queued time, UTC), optionally one status.
export async function getDeliveries(shopId, { status = "all", page = 1, days = DEFAULT_DAYS } = {}, now = new Date()) {
  const period = resolvePeriod(days, now);
  const where = { shopId, createdAt: range(period.since, period.until), ...(status !== "all" ? { status } : {}) };
  const [total, rows] = await Promise.all([
    prisma.emailDelivery.count({ where }),
    prisma.emailDelivery.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: deliverySelect }),
  ]);
  return { total, rows: rows.map(toDelivery) };
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
  const collected = await prisma.shopifyOrder.count({ where: { shopId } });
  if (collected === 0) return { ...base, state: scopeGranted ? "waiting" : "needs_access" };

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
