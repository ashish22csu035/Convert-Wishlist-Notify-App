import { cacheBump, cacheGet, cacheSet, cacheVersion, keyPrefix } from "../utils/cache.server";
import { resolvePeriod } from "../utils/period";
import { getAnalyticsOverview } from "./reporting.server";

// Redis cache for the Analytics overview (getAnalyticsOverview) and nothing else: authentication, attribution, the Shopify
// catalog and the funnels stay outside it. The overview holds only numbers, strings, booleans and nulls, so it survives
// JSON unchanged.
//
// Key:  <prefix>:analytics:v1:<shopId>:<version>:<period since>:<period until | open>
//   - shopId is the shop the authenticated session resolved to on the server, never a request parameter.
//   - the period's real boundaries are in the key (a "last 30 days" window moves at UTC midnight, so its key does too).
//   - <version> is the shop's counter <prefix>:analytics:ver:<shopId>. The analytics worker bumps it after it writes
//     summaries, which makes every older key unreachable at once (no key scanning). They expire by TTL.
// The version is read BEFORE the report is calculated and the result is stored under that version. A request that began
// before a bump can therefore only write to a key that no request after the bump will read.
// Anything that goes wrong in Redis means "calculate it": the cache can never make the page fail or lie.
export const ANALYTICS_CACHE_TTL_SECONDS = 300;

export const analyticsVersionKey = (shopId) => `${keyPrefix()}:analytics:ver:${shopId}`;

export function analyticsCacheKey(shopId, version, period) {
  return `${keyPrefix()}:analytics:v1:${shopId}:${version}:${period.since.toISOString()}:${period.until ? period.until.toISOString() : "open"}`;
}

// Called by the analytics worker after it has written a shop's summaries. Never throws.
export async function invalidateAnalytics(shopId) {
  try {
    await cacheBump(analyticsVersionKey(shopId));
  } catch {
    /* an invalidation that cannot be made is covered by the TTL */
  }
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isCount = (value) => isNumber(value) || value === null;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasSame = (value, keys) => isObject(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const COUNT_KEYS = ["WISHLIST_ADDED", "WISHLIST_REMOVED", "WISHLIST_PRODUCT_CLICKED", "NOTIFY_SUBSCRIBED", "NOTIFY_UNSUBSCRIBED", "RESTOCK_EMAIL_SENT"];
const isCounts = (value) => hasSame(value, COUNT_KEYS) && COUNT_KEYS.every((key) => isNumber(value[key]));
const isSessionPair = (value) => hasSame(value, ["current", "previous"]) && isCount(value.current) && isCount(value.previous);

// The exact shape getAnalyticsOverview returns. Anything else read from Redis is ignored.
export function isOverview(value) {
  return (
    hasSame(value, ["activity", "comparable", "coverage", "days", "lastUpdated", "period", "sessionActivity", "topCustomers", "topProducts"]) &&
    (value.lastUpdated === null || (typeof value.lastUpdated === "string" && !Number.isNaN(Date.parse(value.lastUpdated)))) &&
    isNumber(value.days) &&
    typeof value.comparable === "boolean" &&
    isObject(value.period) &&
    hasSame(value.activity, ["previous", "window"]) &&
    isCounts(value.activity.window) &&
    (value.activity.previous === null || isCounts(value.activity.previous)) &&
    hasSame(value.sessionActivity, ["notifyMe", "wishlist"]) &&
    isSessionPair(value.sessionActivity.wishlist) &&
    isSessionPair(value.sessionActivity.notifyMe) &&
    hasSame(value.coverage, ["availableDays", "complete", "expectedDays"]) &&
    isNumber(value.coverage.expectedDays) &&
    isNumber(value.coverage.availableDays) &&
    typeof value.coverage.complete === "boolean" &&
    Array.isArray(value.topProducts) &&
    Array.isArray(value.topCustomers)
  );
}

// Same arguments and result as getAnalyticsOverview. `deps` is for the tests (a fake cache, a stand-in report).
export async function getCachedAnalyticsOverview(shop, input, now = new Date(), deps = {}) {
  const { overview = getAnalyticsOverview, get = cacheGet, set = cacheSet, version = cacheVersion } = deps;
  const period = resolvePeriod(input, now);
  const current = shop?.id ? await version(analyticsVersionKey(shop.id)) : null;
  if (current === null) return overview(shop, period, now); // no shop id, or Redis not usable: no cache involved at all

  const key = analyticsCacheKey(shop.id, current, period);
  const cached = await get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (isOverview(parsed)) return parsed;
    } catch {
      /* unreadable entry: treated as a miss */
    }
  }
  const result = await overview(shop, period, now);
  await set(key, JSON.stringify(result), ANALYTICS_CACHE_TTL_SECONDS); // a failed store is not an error
  return result;
}
