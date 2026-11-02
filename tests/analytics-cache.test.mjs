// Tests for the Analytics overview cache (app/models/analytics-cache.server.js) and for the worker invalidating it.
//
// Run: node --test tests/analytics-cache.test.mjs
// The first group needs no database (a fake cache and a stand-in report). The second group WRITES to the database in
// DATABASE_URL: run on a scratch database only. The last group also needs a disposable Redis (see cache-util.test.mjs)
// and is skipped without TEST_REDIS_URL.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const REAL = process.env.TEST_REDIS_URL;
const NOW = new Date("2026-10-22T10:00:00.000Z");
const at = (iso) => new Date(iso);
const domains = [];
let counter = 9970000000;
let capture = null;
let cacheModel;
let cacheUtil;
let reporting;
let worker;
let P;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  delete process.env.REDIS_URL; // the DB-backed tests below choose their own cache
  process.env.REDIS_KEY_PREFIX = `kwtest:${RUN}`;
  const prismaModule = require("@prisma/client");
  prismaModule.PrismaClient = class extends prismaModule.PrismaClient {
    constructor(options) {
      super({ ...options, log: [{ emit: "event", level: "query" }] });
      this.$on("query", (event) => capture?.push(event.query));
    }
  };
  cacheModel = await import("../app/models/analytics-cache.server.js");
  cacheUtil = await import("../app/utils/cache.server.js");
  reporting = await import("../app/models/reporting.server.js");
  worker = await import("../app/worker/analytics-daily.server.js");
  P = await import("../app/utils/period.js");
});

after(async () => {
  await cacheUtil.closeCache();
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

// ---------- helpers: a fake cache with a clock, and a stand-in report ----------
function fakeCache({ up = true } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  const versions = new Map();
  let clock = 0;
  const api = {
    store,
    sets: [],
    gets: 0,
    up,
    advance: (seconds) => { clock += seconds * 1000; },
    deps: {
      get: async (key) => {
        api.gets += 1;
        if (!api.up) return null;
        const entry = store.get(key);
        return entry && entry.expiresAt > clock ? entry.value : null;
      },
      set: async (key, value, ttl) => {
        if (!api.up) return false;
        api.sets.push({ key, ttl });
        store.set(key, { value, expiresAt: clock + ttl * 1000 });
        return true;
      },
      version: async (key) => (api.up ? String(versions.get(key) ?? 0) : null),
    },
    bump: async (key) => { versions.set(key, (versions.get(key) ?? 0) + 1); },
  };
  return api;
}
const overviewOf = (tag, over = {}) => ({
  days: 30,
  period: { kind: "preset", days: 30, from: null, to: null },
  comparable: true,
  activity: {
    window: { WISHLIST_ADDED: 3, WISHLIST_REMOVED: 1, WISHLIST_PRODUCT_CLICKED: 2, NOTIFY_SUBSCRIBED: 4, NOTIFY_UNSUBSCRIBED: 0, RESTOCK_EMAIL_SENT: 5 },
    previous: null,
  },
  topProducts: [{ productGid: "gid://shopify/Product/1", productId: "1", fallbackTitle: null, saves: 2 }],
  topCustomers: [{ customerId: "7", activity: 3, savedItems: 1, activeSubscriptions: 0 }],
  sessionActivity: { wishlist: { current: null, previous: null }, notifyMe: { current: 2, previous: null } },
  coverage: { expectedDays: 30, availableDays: 30, complete: true },
  lastUpdated: "2026-10-22T09:50:00.000Z",
  tag,
  ...over,
});
const strip = ({ tag, ...rest }) => rest; // the fixture's marker is not part of the real shape
const standIn = (results) => {
  const calls = [];
  const fn = async (shop, period) => { calls.push({ shop: shop.id, since: period.since.toISOString() }); const next = typeof results === "function" ? results(calls.length) : results; return strip(next); };
  fn.calls = calls;
  return fn;
};
const shopA = { id: "11111111-1111-1111-1111-111111111111" };
const shopB = { id: "22222222-2222-2222-2222-222222222222" };
const custom = (from, to) => P.customPeriod(from, to, NOW).period;
const ask = (cache, overview, shop, input = 30) => cacheModel.getCachedAnalyticsOverview(shop, input, NOW, { overview, ...cache.deps });

test("a miss runs the original report once and stores it for 300 seconds; the next request is a hit", async () => {
  const cache = fakeCache();
  const overview = standIn(overviewOf("a"));
  const first = await ask(cache, overview, shopA);
  assert.equal(overview.calls.length, 1);
  assert.deepEqual(cache.sets.map((s) => s.ttl), [300]);
  const second = await ask(cache, overview, shopA);
  assert.equal(overview.calls.length, 1, "the hit does not run the report");
  assert.deepEqual(second, first);
});

test("an entry expires after its TTL", async () => {
  const cache = fakeCache();
  const overview = standIn(overviewOf("a"));
  await ask(cache, overview, shopA);
  cache.advance(299);
  await ask(cache, overview, shopA);
  assert.equal(overview.calls.length, 1);
  cache.advance(2);
  await ask(cache, overview, shopA);
  assert.equal(overview.calls.length, 2, "recalculated after 300 s");
});

test("shops never share an entry", async () => {
  const cache = fakeCache();
  const overview = standIn((n) => overviewOf(`call${n}`, { days: 30 + n }));
  const a = await ask(cache, overview, shopA);
  const b = await ask(cache, overview, shopB);
  assert.equal(overview.calls.length, 2);
  assert.notEqual(a.days, b.days);
  assert.deepEqual(overview.calls.map((c) => c.shop), [shopA.id, shopB.id]);
  assert.ok([...cache.store.keys()].every((key) => key.includes(shopA.id) !== key.includes(shopB.id)));
  assert.equal((await ask(cache, overview, shopA)).days, a.days);
  assert.equal((await ask(cache, overview, shopB)).days, b.days);
});

test("different periods never share an entry: preset lengths, custom ranges and open versus bounded ends", async () => {
  const cache = fakeCache();
  const overview = standIn((n) => overviewOf(`call${n}`, { days: n }));
  const periods = [7, 30, 90, custom("2026-10-01", "2026-10-05"), custom("2026-10-01", "2026-10-06"), custom("2026-10-02", "2026-10-05")];
  const seen = [];
  for (const period of periods) seen.push((await ask(cache, overview, shopA, period)).days);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6], "six different periods, six calculations");
  for (const [i, period] of periods.entries()) assert.equal((await ask(cache, overview, shopA, period)).days, i + 1, "each is a hit on its own entry");
  const keys = [...cache.store.keys()];
  assert.equal(new Set(keys).size, 6);
  assert.ok(keys.some((key) => key.endsWith(":open")) && keys.some((key) => !key.endsWith(":open")));
  const key = cacheModel.analyticsCacheKey(shopA.id, "3", P.resolvePeriod(7, NOW));
  assert.match(key, /^kwtest:[^:]+:analytics:v1:11111111-1111-1111-1111-111111111111:3:2026-10-16T00:00:00\.000Z:open$/);
});

test("a new version makes the previous entries unreachable", async () => {
  const cache = fakeCache();
  const overview = standIn((n) => overviewOf(`call${n}`, { days: n }));
  await ask(cache, overview, shopA);
  await ask(cache, overview, shopA);
  assert.equal(overview.calls.length, 1);
  await cache.bump(cacheModel.analyticsVersionKey(shopA.id));
  assert.equal((await ask(cache, overview, shopA)).days, 2, "recalculated under the new version");
  await ask(cache, overview, shopB);
  assert.equal(overview.calls.length, 3);
  await cache.bump(cacheModel.analyticsVersionKey(shopA.id));
  await ask(cache, overview, shopB);
  assert.equal(overview.calls.length, 3, "another shop's version does not matter");
});

test("the last-updated time is cached WITH the figures: a hit shows the time its figures were calculated, a new version shows the new one", async () => {
  const cache = fakeCache();
  const overview = standIn((n) => overviewOf(`call${n}`, { lastUpdated: n === 1 ? "2026-10-22T09:40:00.000Z" : "2026-10-22T09:50:00.000Z", days: n }));
  const first = await ask(cache, overview, shopA);
  const hit = await ask(cache, overview, shopA);
  assert.equal(first.lastUpdated, "2026-10-22T09:40:00.000Z");
  assert.deepEqual([hit.lastUpdated, hit.days], ["2026-10-22T09:40:00.000Z", 1], "same entry: the old figures and the old time, together");
  await cache.bump(cacheModel.analyticsVersionKey(shopA.id)); // the worker wrote summaries
  const fresh = await ask(cache, overview, shopA);
  assert.deepEqual([fresh.lastUpdated, fresh.days], ["2026-10-22T09:50:00.000Z", 2], "recalculated: new figures and new time together");
  const none = await cacheModel.getCachedAnalyticsOverview(shopB, 30, NOW, { overview: standIn(overviewOf("n", { lastUpdated: null })), ...cache.deps });
  assert.strictEqual(none.lastUpdated, null, "no summaries yet stays null, never a made-up time");
});

test("an entry without lastUpdated (written before it existed) or with an unreadable one is a miss", async () => {
  const good = strip(overviewOf("g"));
  const { lastUpdated: _gone, ...old } = good;
  assert.equal(cacheModel.isOverview(good), true);
  assert.equal(cacheModel.isOverview(old), false);
  assert.equal(cacheModel.isOverview({ ...good, lastUpdated: "yesterday" }), false);
  assert.equal(cacheModel.isOverview({ ...good, lastUpdated: 12345 }), false);
  assert.equal(cacheModel.isOverview({ ...good, lastUpdated: null }), true);
});

test("the JSON round trip keeps the response exactly, nulls included", async () => {
  const cache = fakeCache();
  const original = strip(overviewOf("x", { activity: { window: overviewOf("x").activity.window, previous: null }, sessionActivity: { wishlist: { current: null, previous: null }, notifyMe: { current: 0, previous: 4 } } }));
  const overview = async () => original;
  const first = await ask(cache, overview, shopA);
  const second = await ask(cache, overview, shopA);
  assert.deepEqual(second, original);
  assert.deepEqual(first, original);
  assert.strictEqual(second.activity.previous, null);
  assert.strictEqual(second.sessionActivity.wishlist.current, null);
  assert.strictEqual(second.sessionActivity.notifyMe.current, 0, "zero stays zero");
  const withPrevious = strip(overviewOf("y", { comparable: true, activity: { window: original.activity.window, previous: { ...original.activity.window, WISHLIST_ADDED: 9 } } }));
  assert.ok(cacheModel.isOverview(JSON.parse(JSON.stringify(withPrevious))));
});

test("an unreadable entry or one with the wrong shape is a miss, never an error", async () => {
  const good = strip(overviewOf("g"));
  const broken = [
    "not json",
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...good, extra: 1 }),
    JSON.stringify({ ...good, days: "30" }),
    JSON.stringify({ ...good, activity: { window: { ...good.activity.window, WISHLIST_ADDED: "3" }, previous: null } }),
    JSON.stringify({ ...good, activity: { window: { WISHLIST_ADDED: 1 }, previous: null } }),
    JSON.stringify({ ...good, sessionActivity: { wishlist: { current: 1 }, notifyMe: { current: 1, previous: 1 } } }),
    JSON.stringify({ ...good, topProducts: {} }),
    JSON.stringify({ ...good, coverage: { expectedDays: 1, availableDays: 1 } }),
  ];
  for (const text of broken) {
    const cache = fakeCache();
    const overview = standIn(overviewOf("fresh"));
    const key = cacheModel.analyticsCacheKey(shopA.id, "0", P.resolvePeriod(30, NOW));
    cache.store.set(key, { value: text, expiresAt: Infinity });
    const got = await ask(cache, overview, shopA);
    assert.equal(overview.calls.length, 1, `treated as a miss: ${text.slice(0, 40)}`);
    assert.deepEqual(got, strip(overviewOf("fresh")));
    assert.notEqual(cache.store.get(key).value, text, "and replaced by the fresh result");
  }
});

test("Redis down from the start, or failing after it worked: the report is calculated and nothing throws", async () => {
  const down = fakeCache({ up: false });
  const overview = standIn(overviewOf("d"));
  assert.deepEqual(await ask(down, overview, shopA), strip(overviewOf("d")));
  assert.deepEqual([overview.calls.length, down.sets.length, down.gets], [1, 0, 0], "no cache use at all when the version cannot be read");
  const flaky = fakeCache();
  await ask(flaky, overview, shopA);
  flaky.up = false; // Redis disappears after the entry was stored
  const again = await ask(flaky, overview, shopA);
  assert.equal(overview.calls.length, 3, "1 for the cache that was down, 1 to fill the flaky one, 1 after it went down");
  assert.deepEqual(again, strip(overviewOf("d")));
  const failingGet = { overview, version: async () => "0", get: async () => null, set: async () => false };
  assert.deepEqual(await cacheModel.getCachedAnalyticsOverview(shopA, 30, NOW, failingGet), strip(overviewOf("d")), "a store that fails is not an error");
  assert.deepEqual(await cacheModel.getCachedAnalyticsOverview({ domain: "x" }, 30, NOW, { overview, ...flaky.deps }), strip(overviewOf("d")), "no shop id: no cache involved");
});

test("a request that began before an invalidation cannot fill the cache the later requests read", async () => {
  const cache = fakeCache();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const results = ["stale", "fresh"];
  let started = 0;
  const overview = async () => { const mine = results[started]; started += 1; if (mine === "stale") await gate; return strip(overviewOf(mine, { days: mine === "stale" ? 1 : 2 })); };
  const slow = ask(cache, overview, shopA); // reads version 0, then waits inside the report
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cache.bump(cacheModel.analyticsVersionKey(shopA.id)); // the worker writes new summaries
  const later = await ask(cache, overview, shopA); // reads version 1, calculates fresh data
  release();
  await slow; // the old request now stores its (old) result under the OLD version's key
  assert.equal(later.days, 2);
  const third = await ask(cache, overview, shopA);
  assert.equal(third.days, 2, "later requests get the fresh result, not the one that started earlier");
  assert.equal(started, 2, "and the third request was a hit");
});

// ---------- database-backed (scratch database only) ----------
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
async function seedShop(tag) {
  const domain = `kw-cache-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  const shop = await prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-09-15T00:00:00Z") } });
  const actor = await actorOf(shop);
  for (let d = 10; d <= 22; d += 1) {
    const iso = `2026-10-${d}T08:00:00Z`;
    const s = await prisma.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature: "WISHLIST", startedAt: at(iso), expiresAt: new Date(at(iso).getTime() + 1800000) } });
    for (const type of ["WISHLIST_ADDED", "WISHLIST_PRODUCT_CLICKED"]) {
      await prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: s.id, type, feature: "WISHLIST", productGid: "gid://shopify/Product/1", occurredAt: new Date(at(iso).getTime() + 60000) } });
    }
  }
  await prisma.wishlistItem.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid: "gid://shopify/ProductVariant/11", productTitle: "P", productHandle: "p" } });
  return prisma.shop.findUnique({ where: { id: shop.id } });
}
const quiet = { log() {}, error() {} };
const fill = (shop, over = {}) => worker.runAnalyticsDaily({ now: () => NOW, shopIds: [shop.id], backfillPerShop: 500, log: quiet, ...over });
const statementsOf = async (fn) => {
  capture = [];
  try {
    return { value: await fn(), statements: capture };
  } finally {
    capture = null;
  }
};
const touchesReports = (sql) => /AnalyticsDaily|WishlistItem|ActivityEvent/.test(sql);

test("with the real report: a hit sends no AnalyticsDaily, WishlistItem or ActivityEvent query and returns the same response", async () => {
  const shop = await seedShop("hit");
  await fill(shop, { invalidate: async () => {} });
  const cache = fakeCache();
  const uncached = await reporting.getAnalyticsOverview(shop, 30, NOW);
  const miss = await statementsOf(() => cacheModel.getCachedAnalyticsOverview(shop, 30, NOW, cache.deps));
  assert.ok(miss.statements.some((sql) => /AnalyticsDaily/.test(sql)) && miss.statements.some((sql) => /WishlistItem/.test(sql)) && miss.statements.some((sql) => /ActivityEvent/.test(sql)), "the miss ran the reports");
  assert.deepEqual(miss.value, uncached, "same response as without the cache");
  const hit = await statementsOf(() => cacheModel.getCachedAnalyticsOverview(shop, 30, NOW, cache.deps));
  assert.deepEqual(hit.statements.filter(touchesReports), []);
  assert.equal(hit.statements.length, 0, "no SQL at all on a hit");
  assert.deepEqual(hit.value, uncached, "the response, dates and nulls included, is unchanged");
  assert.deepEqual(Object.keys(hit.value), Object.keys(uncached));
  assert.ok(cacheModel.isOverview(uncached), "the validator accepts the real shape");
});

test("worker: the shop's version is bumped once, after its summaries were written, and not when nothing was written", async () => {
  const shop = await seedShop("invalidate");
  const calls = [];
  const rowsAtCall = [];
  const invalidate = async (shopId) => { calls.push(shopId); rowsAtCall.push(await prisma.analyticsDaily.count({ where: { shopId } })); };
  const first = await fill(shop, { invalidate });
  assert.ok(first.written > 0);
  assert.deepEqual(calls, [shop.id], "once for the shop, not once per day");
  assert.equal(rowsAtCall[0], first.written, "all rows were written before the bump");
  const same = await fill(shop, { invalidate }); // the same clock: every recalculation is 'already newer'
  assert.deepEqual([same.written, same.stale > 0, calls.length], [0, true, 1], "nothing written, no bump");
  const later = await fill(shop, { invalidate, now: () => new Date(NOW.getTime() + 600000) });
  assert.ok(later.written > 0 && calls.length === 2);
});

test("worker: an invalidation that throws, or Redis not configured or down, does not fail the analytics work", async () => {
  const shop = await seedShop("invalidate-fail");
  const summary = await fill(shop, { invalidate: async () => { throw new Error("redis exploded"); } });
  assert.deepEqual([summary.failed > 0, summary.written > 0], [false, true]);
  const other = await seedShop("invalidate-unset");
  delete process.env.REDIS_URL;
  const unset = await fill(other); // the real invalidateAnalytics with no REDIS_URL
  assert.deepEqual([unset.failed, unset.written > 0], [0, true]);
  const down = await seedShop("invalidate-down");
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  process.env.CACHE_BACKOFF_MS = "0";
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await fill(down);
    assert.deepEqual([result.failed, result.written > 0], [0, true]);
  } finally {
    console.warn = warn;
    delete process.env.REDIS_URL;
    await cacheUtil.closeCache();
  }
});

test("real Redis end to end: store, hit, worker invalidation across clients, and the TTL", { skip: !REAL && "set TEST_REDIS_URL (see cache-util.test.mjs)" }, async () => {
  process.env.REDIS_URL = REAL;
  process.env.CACHE_BACKOFF_MS = "0";
  const shop = await seedShop("real");
  const { default: Redis } = await import("ioredis");
  const direct = new Redis(REAL);
  try {
    await fill(shop, { invalidate: async () => {} });
    const first = await cacheModel.getCachedAnalyticsOverview(shop, 30, NOW);
    const key = cacheModel.analyticsCacheKey(shop.id, "0", P.resolvePeriod(30, NOW));
    const ttl = await direct.ttl(key);
    assert.ok(ttl > 0 && ttl <= 300, `ttl ${ttl}`);
    const hit = await statementsOf(() => cacheModel.getCachedAnalyticsOverview(shop, 30, NOW));
    assert.equal(hit.statements.length, 0);
    assert.deepEqual(hit.value, first);
    // the worker (a different client in production) bumps the version: the old entry is no longer read
    await fill(shop, { now: () => new Date(NOW.getTime() + 600000) });
    assert.equal(await direct.get(cacheModel.analyticsVersionKey(shop.id)), "1");
    const afterBump = await statementsOf(() => cacheModel.getCachedAnalyticsOverview(shop, 30, new Date(NOW.getTime() + 600000)));
    assert.ok(afterBump.statements.some(touchesReports), "a miss under the new version");
    assert.ok(await direct.exists(key), "the old entry still sits there until it expires, unreachable");
  } finally {
    await direct.del(cacheModel.analyticsVersionKey(shop.id), cacheModel.analyticsCacheKey(shop.id, "0", P.resolvePeriod(30, NOW)), cacheModel.analyticsCacheKey(shop.id, "1", P.resolvePeriod(30, new Date(NOW.getTime() + 600000))));
    direct.disconnect();
    delete process.env.REDIS_URL;
    await cacheUtil.closeCache();
  }
});
