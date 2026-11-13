// Tests for the session analytics source behind the plan recommendation (session-source.server.js) and how it drives the existing
// recommendation job: thresholds, the requested range, and the rule that missing, unauthorised, malformed or timed-out data is never a zero.
// (Subscription verification has its own file: tests/billing-partner.test.mjs.)
//
// Run: node --test tests/billing-integration.test.mjs
//
// NOTHING here calls Shopify: every Admin client is a stub that returns fixtures. The pure tests run anywhere. The database tests WRITE
// rows, so they only run when DATABASE_URL (set in the environment) names an isolated kw_*test* database with the migrations applied;
// otherwise they are skipped and say so.
import { isTimezoneQuery, shopZoneAnswer } from "./helpers/shop-timezone.mjs";
import "./helpers/resolve-extensionless.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const dbUrl = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const dbTest = (name, fn) => test(name, { skip }, fn);
const prisma = skip ? null : new PrismaClient();

const { getEntitlements } = await import("../app/models/entitlements.server.js");
const { SESSION_WINDOW_DAYS, buildSessionsQuery, createShopifyqlSessionSource, parseSessionsResponse, parseTimezoneResponse, sessionRange, validTimeZone } = await import("../app/models/session-source.server.js");
const { getBillingServices } = await import("../app/models/billing-services.server.js");
const R = await import("../app/models/plan-recommendation.server.js");

const NOW = new Date("2026-11-11T12:00:00.000Z");
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const RUN = Date.now().toString(36);
const quiet = { log() {}, error() {} };
const domains = [];
let seq = 6600000000;
const newShop = async (tag) => {
  const domain = `kw-bi-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});

const adminReturning = (body, { scope = "read_products,read_reports", shopAnswer = shopZoneAnswer("UTC") } = {}) => {
  const calls = [];
  const getAdmin = async () => ({ scope, admin: { graphql: async (query, options) => { if (isTimezoneQuery(query)) return { json: async () => shopAnswer }; calls.push({ query, options }); return { json: async () => (typeof body === "function" ? body() : body) }; } } });
  getAdmin.calls = calls;
  return getAdmin;
};
const adminThrowing = (thrown, scope = "read_reports") => async () => ({ scope, admin: { graphql: async () => { throw thrown; } } });
const httpError = (code) => Object.assign(new Error("http"), { response: { code } });
const graphQlDenied = () => Object.assign(new Error("denied"), { body: { errors: { graphQLErrors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] } } });
const SHOP = { domain: "example.myshopify.com" };

// ======================= session source: pure =======================
test("the requested range is the 30 complete days before today in the store's time zone, explicit and recorded", () => {
  const range = sessionRange(NOW, "UTC");
  assert.deepEqual([range.start.toISOString(), range.end.toISOString()], ["2026-10-12T00:00:00.000Z", "2026-11-11T00:00:00.000Z"]);
  assert.equal((range.end.getTime() - range.start.getTime()) / DAY, SESSION_WINDOW_DAYS);
  assert.equal(buildSessionsQuery(range), "FROM sessions SHOW sessions WITH TIMEZONE 'UTC' SINCE 2026-10-12 UNTIL 2026-11-10", "both ends inclusive: 30 days");
  assert.doesNotMatch(buildSessionsQuery(range), /human_or_bot_session|WHERE/i, "no bot filter");
  assert.equal(buildSessionsQuery(sessionRange(new Date("2028-03-01T05:00:00.000Z"), "UTC")), "FROM sessions SHOW sessions WITH TIMEZONE 'UTC' SINCE 2028-01-31 UNTIL 2028-02-29");
  assert.throws(() => sessionRange(NOW), TypeError, "no zone, no range: UTC is never assumed");
});

// [zone, the moment of the lookup, inclusive first day, inclusive last day, periodStart, periodEnd]. periodEnd is the instant the store's local TODAY begins.
const WINDOWS = [
  ["America/New_York", "2026-11-12T03:00:00Z", "2026-10-12", "2026-11-10", "2026-10-12T04:00:00.000Z", "2026-11-11T05:00:00.000Z"], // 22:00 on Nov 11 there: today is still the 11th, UTC is already the 12th
  ["Pacific/Kiritimati", "2026-11-13T05:00:00Z", "2026-10-14", "2026-11-12", "2026-10-13T10:00:00.000Z", "2026-11-12T10:00:00.000Z"], // UTC+14: already the 13th there
  ["Asia/Kolkata", "2028-03-01T00:30:00Z", "2028-01-31", "2028-02-29", "2028-01-30T18:30:00.000Z", "2028-02-29T18:30:00.000Z"], // leap day, +05:30
  ["UTC", "2027-01-01T00:00:00Z", "2026-12-02", "2026-12-31", "2026-12-02T00:00:00.000Z", "2027-01-01T00:00:00.000Z"], // year end
  ["Pacific/Auckland", "2027-01-01T10:00:00Z", "2026-12-02", "2026-12-31", "2026-12-01T11:00:00.000Z", "2026-12-31T11:00:00.000Z"], // NZDT +13
  ["America/Los_Angeles", "2026-03-01T06:00:00Z", "2026-01-29", "2026-02-27", "2026-01-29T08:00:00.000Z", "2026-02-28T08:00:00.000Z"], // month end after February
];
test("the window is exactly 30 complete local calendar dates for different zones, month, year and leap-day boundaries", () => {
  for (const [zone, at, first, last, start, end] of WINDOWS) {
    const range = sessionRange(new Date(at), zone);
    assert.deepEqual([range.firstDay, range.lastDay, range.start.toISOString(), range.end.toISOString()], [first, last, start, end], `${zone} ${at}`);
    const days = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY + 1;
    assert.equal(days, 30, `${zone}: 30 inclusive dates`);
    assert.ok(range.end.getTime() <= new Date(at).getTime(), `${zone}: today (the store's local date) is excluded`);
  }
});

test("daylight saving: the stored instants are the real local midnights, so the span is 30 wall-clock days, not 720 hours", () => {
  // New York springs forward on 2026-03-08 (clocks 02:00 -> 03:00): a lookup on 2026-03-09 spans the change.
  const spring = sessionRange(new Date("2026-03-09T12:00:00Z"), "America/New_York");
  assert.deepEqual([spring.firstDay, spring.lastDay, spring.start.toISOString(), spring.end.toISOString()], ["2026-02-07", "2026-03-08", "2026-02-07T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  assert.equal((spring.end - spring.start) / (60 * 60 * 1000), 29 * 24 + 23, "one hour shorter than 30 x 24 h");
  // ... and falls back on 2026-11-01 (02:00 -> 01:00).
  const fall = sessionRange(new Date("2026-11-02T12:00:00Z"), "America/New_York");
  assert.deepEqual([fall.firstDay, fall.lastDay, fall.start.toISOString(), fall.end.toISOString()], ["2026-10-03", "2026-11-01", "2026-10-03T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  assert.equal((fall.end - fall.start) / (60 * 60 * 1000), 30 * 24 + 1, "one hour longer");
  // A zone whose clocks skip midnight itself (Sao Paulo, 2018-11-04 00:00 -> 01:00): the day starts at the first valid instant.
  const gap = sessionRange(new Date("2018-12-04T12:00:00Z"), "America/Sao_Paulo");
  assert.equal(gap.firstDay, "2018-11-04");
  assert.equal(gap.start.toISOString(), "2018-11-04T03:00:00.000Z");
});

test("the local date, not the UTC date, decides what 'today' is", () => {
  const at = new Date("2026-11-12T23:30:00Z"); // 18:30 Nov 12 in New York, 05:00 Nov 13 in Kolkata, already Nov 13 in Tokyo
  assert.equal(sessionRange(at, "America/New_York").lastDay, "2026-11-11");
  assert.equal(sessionRange(at, "Asia/Kolkata").lastDay, "2026-11-12");
  assert.equal(sessionRange(at, "Asia/Tokyo").lastDay, "2026-11-12");
  assert.equal(sessionRange(at, "America/New_York").timeZone, "America/New_York");
});

test("the zone is validated and can never change the query's shape", () => {
  for (const bad of [undefined, null, "", "Not/AZone", "UTC' SINCE -9999d --", "America/New_York'", "a b", 5, "../x", "Mars/Olympus"]) {
    assert.equal(validTimeZone(bad), null, String(bad));
    assert.throws(() => sessionRange(NOW, bad), TypeError, String(bad));
  }
  for (const good of ["UTC", "America/New_York", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) assert.equal(validTimeZone(good), good);
});

test("the store's time zone answer: a zone, or a failure that is never UTC", () => {
  const flat = (json) => {
    try {
      return parseTimezoneResponse(json);
    } catch (error) {
      return `${error.kind}:${error.code}:${error.retryable}`;
    }
  };
  assert.equal(flat(shopZoneAnswer("Europe/Berlin")), "Europe/Berlin");
  assert.equal(flat(shopZoneAnswer(null)), "transient:timezone_unavailable:true");
  assert.equal(flat(shopZoneAnswer("")), "transient:timezone_unavailable:true");
  assert.equal(flat({ data: { shop: null } }), "transient:timezone_unavailable:true");
  assert.equal(flat({ data: {} }), "transient:timezone_unavailable:true");
  assert.equal(flat(shopZoneAnswer("Nowhere/Land")), "transient:invalid_timezone:false");
  assert.equal(flat(shopZoneAnswer(42)), "transient:invalid_timezone:false");
  assert.equal(flat({ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }), "permission:access_denied:true");
  assert.equal(flat({ errors: [{ extensions: { code: "THROTTLED" } }] }), "transient:throttled:true");
  assert.equal(flat(null), "transient:invalid_response:true");
});

const table = (rows, columns = [{ name: "sessions", dataType: "INTEGER", displayName: "Sessions" }]) => ({ data: { shopifyqlQuery: { tableData: { columns, rows }, parseErrors: [] } } });
const failureOf = (json) => {
  try {
    return `value:${parseSessionsResponse(json)}`;
  } catch (error) {
    return `${error.kind}:${error.code}:${error.retryable}`;
  }
};

test("a valid answer is a count; everything else is a coded failure and never a zero", () => {
  assert.equal(failureOf(table([{ sessions: "100001" }])), "value:100001");
  assert.equal(failureOf(table([{ sessions: 100000 }])), "value:100000");
  assert.equal(failureOf(table([{ sessions: "0" }])), "value:0", "a real zero arrives as a row and is a real zero");
  assert.equal(failureOf(table([{ sessions: "12.0" }])), "value:12");
  assert.equal(failureOf(table([])), "transient:no_rows:true", "no rows is unavailable data, NOT zero");
  assert.equal(failureOf(table([{ sessions: "1" }, { sessions: "2" }])), "transient:unexpected_rows:false");
  assert.equal(failureOf(table([{ other: "5" }], [{ name: "other" }])), "transient:missing_column:false");
  for (const odd of [null, undefined, "", "abc", "-5", "1.5", "1e3", { x: 1 }, NaN, "9999999999999999999999"]) assert.equal(failureOf(table([{ sessions: odd }])), "transient:invalid_value:false", String(odd));
  assert.equal(failureOf({ data: { shopifyqlQuery: { tableData: null, parseErrors: ["Column Not Found"] } } }), "transient:parse_error:false");
  assert.equal(failureOf({ data: { shopifyqlQuery: null } }), "transient:no_data:true");
  assert.equal(failureOf({ data: { shopifyqlQuery: { tableData: { columns: null, rows: null }, parseErrors: [] } } }), "transient:no_data:true");
  assert.equal(failureOf({ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }), "permission:access_denied:true");
  assert.equal(failureOf({ errors: [{ extensions: { code: "THROTTLED" } }] }), "transient:throttled:true");
  assert.equal(failureOf(null), "transient:invalid_response:true");
});

test("the session source never asks Shopify without the read_reports scope, and classifies every failure", async () => {
  const noScope = adminReturning(table([{ sessions: "5" }]), { scope: "read_products,read_orders" });
  const missing = await createShopifyqlSessionSource({ getAdmin: noScope, now: () => NOW })({ shopDomain: SHOP.domain }).catch((error) => error);
  assert.deepEqual([missing.kind, missing.code], ["permission", "scope_not_granted"]);
  assert.equal(noScope.calls.length, 0, "no request was sent");

  const flat = async (getAdmin) => {
    try {
      return `value:${(await createShopifyqlSessionSource({ getAdmin, now: () => NOW })({ shopDomain: SHOP.domain })).sessions}`;
    } catch (error) {
      return `${error.kind}:${error.code}`;
    }
  };
  assert.equal(await flat(adminThrowing(graphQlDenied())), "permission:access_denied");
  assert.equal(await flat(adminThrowing(httpError(403))), "permission:http_403");
  assert.equal(await flat(adminThrowing(httpError(429))), "transient:throttled");
  assert.equal(await flat(adminThrowing(httpError(500))), "transient:http_500");
  assert.equal(await flat(async () => { throw new Error("no session"); }), "transient:admin_session_unavailable");
  assert.equal(await flat(adminReturning(table([]))), "transient:no_rows");
  assert.equal(await flat(adminReturning(table([{ sessions: "250000" }]))), "value:250000");
  assert.throws(() => createShopifyqlSessionSource({}), TypeError);
});

test("the session source asks for the store's zone first, then sends exactly the requested range and returns the same range with the count", async () => {
  const getAdmin = adminReturning(table([{ sessions: "4321" }]), { shopAnswer: shopZoneAnswer("America/New_York") });
  const answer = await createShopifyqlSessionSource({ getAdmin, now: () => NOW })({ shopDomain: SHOP.domain });
  assert.deepEqual([answer.sessions, answer.periodStart.toISOString(), answer.periodEnd.toISOString()], [4321, "2026-10-12T04:00:00.000Z", "2026-11-11T05:00:00.000Z"]);
  assert.equal(getAdmin.calls.length, 1, "one analytics request (the zone lookup is separate and not counted)");
  assert.equal(getAdmin.calls[0].options.variables.query, "FROM sessions SHOW sessions WITH TIMEZONE 'America/New_York' SINCE 2026-10-12 UNTIL 2026-11-10");
  assert.match(getAdmin.calls[0].query, /shopifyqlQuery/);
  assert.doesNotMatch(getAdmin.calls[0].query, /mutation/i);
});

test("no usable store zone means no analytics request and no number: unavailable (retried) or invalid (permanent), never UTC", async () => {
  const run = async (shopAnswer) => {
    const getAdmin = adminReturning(table([{ sessions: "250000" }]), { shopAnswer });
    try {
      await createShopifyqlSessionSource({ getAdmin, now: () => NOW })({ shopDomain: SHOP.domain });
      return { outcome: "value", requests: getAdmin.calls.length };
    } catch (error) {
      return { outcome: `${error.kind}:${error.code}:${error.retryable}`, requests: getAdmin.calls.length };
    }
  };
  assert.deepEqual(await run(shopZoneAnswer(null)), { outcome: "transient:timezone_unavailable:true", requests: 0 });
  assert.deepEqual(await run({ data: { shop: null } }), { outcome: "transient:timezone_unavailable:true", requests: 0 });
  assert.deepEqual(await run(shopZoneAnswer("Mars/Olympus")), { outcome: "transient:invalid_timezone:false", requests: 0 });
  assert.deepEqual(await run({ errors: [{ extensions: { code: "THROTTLED" } }] }), { outcome: "transient:throttled:true", requests: 0 });
  assert.deepEqual(await run({ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }), { outcome: "permission:access_denied:true", requests: 0 });
});

test("the session source is off unless SESSION_ANALYTICS_SOURCE=shopifyql, and no other value switches it on", () => {
  const off = (env) => getBillingServices(env, { getAdmin: async () => ({}), log: { warn() {} } }).fetchSessions;
  assert.equal(off({}), null);
  assert.equal(off({ SESSION_ANALYTICS_SOURCE: "browsing_sessions" }), null);
  assert.equal(off({ SESSION_ANALYTICS_SOURCE: "" }), null);
  assert.equal(typeof off({ SESSION_ANALYTICS_SOURCE: " ShopifyQL " }), "function");
  assert.equal(getBillingServices().fetchSessions, null, "the real environment of this test run switches nothing on");
});

// ======================= database: session recommendations end to end =======================
const recRow = (shop) => prisma.planRecommendation.findUnique({ where: { shopId: shop.id } });
const recommend = async (tag, getAdmin, extra = {}) => {
  const shop = await newShop(tag);
  await R.ensurePlanRecommendation(shop.id, { now: new Date(NOW.getTime() - MIN) });
  const summary = await R.runPlanRecommendations({ fetchSessions: createShopifyqlSessionSource({ getAdmin, now: () => NOW }), now: () => NOW, shopIds: [shop.id], log: quiet, ...extra });
  return { shop, summary, row: await recRow(shop) };
};

dbTest("the stored period is the store's local window, whatever the zone, and a missing zone stores no count", async () => {
  const stored = await recommend("zone-ny", adminReturning(table([{ sessions: "100001" }]), { shopAnswer: shopZoneAnswer("America/New_York") }));
  assert.deepEqual([stored.row.status, stored.row.sessions30d, stored.row.recommendedPlan], ["SUCCEEDED", 100001, "ENTERPRISE"]);
  assert.deepEqual([stored.row.periodStart.toISOString(), stored.row.periodEnd.toISOString()], ["2026-10-12T04:00:00.000Z", "2026-11-11T05:00:00.000Z"]);
  const missing = await recommend("zone-none", adminReturning(table([{ sessions: "100001" }]), { shopAnswer: shopZoneAnswer(null) }));
  assert.deepEqual([missing.row.status, missing.row.errorCode, missing.row.sessions30d, missing.row.recommendedPlan, missing.row.periodStart], ["FAILED", "timezone_unavailable", null, null, null]);
  assert.equal(missing.row.nextAttemptAt.getTime() - NOW.getTime(), MIN, "retried on the existing backoff");
  const invalid = await recommend("zone-bad", adminReturning(table([{ sessions: "5" }]), { shopAnswer: shopZoneAnswer("Mars/Olympus") }));
  assert.deepEqual([invalid.row.status, invalid.row.errorCode, invalid.row.nextAttemptAt], ["FAILED", "invalid_timezone", null], "a permanent failure is not retried");
});

dbTest("recommendations follow the thresholds exactly, the stored period is the requested range, and advice never changes entitlements", async () => {
  for (const [sessions, plan] of [["100001", "ENTERPRISE"], ["100000", "ADVANCE"], ["99999", "ADVANCE"], ["0", "ADVANCE"]]) {
    const { row, summary, shop } = await recommend(`rec-${sessions}`, adminReturning(table([{ sessions }])));
    assert.equal(summary.succeeded, 1);
    assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan], ["SUCCEEDED", Number(sessions), plan], sessions);
    assert.deepEqual([row.periodStart.toISOString(), row.periodEnd.toISOString()], ["2026-10-12T00:00:00.000Z", "2026-11-11T00:00:00.000Z"]);
    assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC", "advice is not proof of payment");
    assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id } }), 0, "and creates no subscription");
  }
});

dbTest("missing, unauthorised, malformed and timed-out analytics data is never a zero and never a recommendation", async () => {
  const cases = [
    ["noscope", adminReturning(table([{ sessions: "5" }]), { scope: "read_products" }), "NEEDS_ACCESS", "scope_not_granted"],
    ["denied", adminThrowing(graphQlDenied()), "NEEDS_ACCESS", "access_denied"],
    ["norows", adminReturning(table([])), "FAILED", "no_rows"],
    ["badvalue", adminReturning(table([{ sessions: "n/a" }])), "FAILED", "invalid_value"],
    ["null", adminReturning(table([{ sessions: null }])), "FAILED", "invalid_value"],
    ["parse", adminReturning({ data: { shopifyqlQuery: { tableData: null, parseErrors: ["bad"] } } }), "FAILED", "parse_error"],
    ["server", adminThrowing(httpError(500)), "FAILED", "http_500"],
    ["nosession", async () => { throw new Error("no session"); }, "FAILED", "admin_session_unavailable"],
  ];
  for (const [tag, getAdmin, status, code] of cases) {
    const { row } = await recommend(`bad-${tag}`, getAdmin);
    assert.deepEqual([row.status, row.errorCode, row.sessions30d, row.recommendedPlan], [status, code, null, null], tag);
    assert.equal(R.publicRecommendation(row), null);
  }
  const hung = await recommend("bad-timeout", async () => ({ scope: "read_reports", admin: { graphql: () => new Promise(() => {}) } }), { fetchTimeoutMs: 40 });
  assert.deepEqual([hung.row.status, hung.row.errorCode, hung.row.sessions30d, hung.row.attempts], ["FAILED", "timeout", null, 1]);
  const retryable = await recommend("bad-retry", adminReturning(table([])));
  assert.equal(retryable.row.nextAttemptAt.getTime() - NOW.getTime(), MIN, "a retryable failure follows the existing backoff");
  const permanent = await recommend("bad-parse2", adminReturning({ data: { shopifyqlQuery: { tableData: null, parseErrors: ["bad"] } } }));
  assert.equal(permanent.row.nextAttemptAt, null, "a permanent failure is not retried");
});

dbTest("a failed refresh keeps the previous valid recommendation", async () => {
  const { shop } = await recommend("keep", adminReturning(table([{ sessions: "250000" }])));
  await R.requestRecommendationRecheck(shop.id, { now: new Date(NOW.getTime() - MIN) });
  await R.runPlanRecommendations({ fetchSessions: createShopifyqlSessionSource({ getAdmin: adminThrowing(httpError(503)), now: () => NOW }), now: () => NOW, shopIds: [shop.id], log: quiet });
  const row = await recRow(shop);
  assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan], ["FAILED", 250000, "ENTERPRISE"]);
});
