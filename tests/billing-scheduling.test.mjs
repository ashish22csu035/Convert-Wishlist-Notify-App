// Tests for scheduling the one-time plan recommendation lookups (enqueuePlanRecommendations in plan-recommendation.server.js, wired into
// runBillingJobs): who gets a lookup row, that a row is never duplicated or disturbed, that the batch is bounded, and that no analytics request is
// ever made when the source is off or access is missing. Missing analytics data is never a zero.
//
// Run: node --test tests/billing-scheduling.test.mjs
//
// NOTHING here calls Shopify: every Admin client is a stub that returns fixtures. Every test WRITES rows, so they only run when DATABASE_URL (set
// in the environment) names an isolated kw_*test* database with the migrations applied; otherwise they are skipped and say so.
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

const R = await import("../app/models/plan-recommendation.server.js");
const { createShopifyqlSessionSource } = await import("../app/models/session-source.server.js");
const { runBillingJobs } = await import("../app/worker/billing-jobs.server.js");
const { getBillingServices } = await import("../app/models/billing-services.server.js");

const NOW = new Date("2026-11-12T12:00:00.000Z");
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const RUN = Date.now().toString(36);
const quiet = { log() {}, error() {}, warn() {} };
const domains = [];
let seq = 3300000000;
const newShop = async (tag, over = {}) => {
  const domain = `kw-sc-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", ...over } });
};
after(async () => {
  if (prisma) {
    await prisma.session.deleteMany({ where: { shop: { in: domains } } });
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});
const session = (shop, scope, { isOnline = false } = {}) =>
  prisma.session.create({ data: { id: `${isOnline ? "online" : "offline"}_${shop.domain}`, shop: shop.domain, state: "test", isOnline, scope, accessToken: "dummy-not-a-real-token" } });
const withScope = async (tag, scope = "read_products,read_reports", over = {}) => {
  const shop = await newShop(tag, over);
  await session(shop, scope);
  return shop;
};
const rowOf = (shop) => prisma.planRecommendation.findUnique({ where: { shopId: shop.id } });
const rowCount = (shops) => prisma.planRecommendation.count({ where: { shopId: { in: shops.map((s) => s.id) } } });
const SOURCE = async () => ({ sessions: 1, periodStart: NOW, periodEnd: NOW }); // only its being a function matters to the enqueue
const enqueue = (shops, over = {}) => R.enqueuePlanRecommendations({ fetchSessions: SOURCE, now: NOW, shopIds: shops.map((s) => s.id), ...over });

// an Admin client per shop that counts its requests
const table = (rows) => ({ data: { shopifyqlQuery: { tableData: { columns: [{ name: "sessions" }], rows }, parseErrors: [] } } });
const adminStub = (answer, scope = "read_reports") => {
  const calls = new Map();
  const getAdmin = async (domain) => ({ scope, admin: { graphql: async (query) => { if (isTimezoneQuery(query)) return { json: async () => shopZoneAnswer("UTC") }; calls.set(domain, (calls.get(domain) ?? 0) + 1); const a = typeof answer === "function" ? answer(domain) : answer; if (a instanceof Error) throw a; return { json: async () => a }; } } });
  getAdmin.calls = calls;
  return getAdmin;
};
const jobsWith = (getAdmin, shops, extra = {}) => runBillingJobs({ services: { fetchSessions: createShopifyqlSessionSource({ getAdmin, now: () => NOW }) }, shopIds: shops.map((s) => s.id), log: quiet, ...extra });

dbTest("with no session source configured nothing is enqueued and nothing is fetched, even for a shop that has the scope", async () => {
  const shop = await withScope("off");
  assert.deepEqual(await R.enqueuePlanRecommendations({ fetchSessions: undefined, shopIds: [shop.id] }), { created: 0, rechecked: 0, skipped: "no_session_source" });
  assert.deepEqual(await R.enqueuePlanRecommendations({ fetchSessions: null, shopIds: [shop.id] }), { created: 0, rechecked: 0, skipped: "no_session_source" });
  const jobs = await runBillingJobs({ services: {}, shopIds: [shop.id], log: quiet });
  assert.equal(jobs.recommendations.skipped, "no_session_source");
  assert.equal("enqueued" in jobs.recommendations, false);
  assert.equal(await rowCount([shop]), 0);
  const configured = getBillingServices({}, { getAdmin: async () => ({}), log: quiet });
  assert.equal(configured.fetchSessions, null, "the source is off by default");
});

dbTest("only an ACTIVE shop whose OFFLINE session was granted read_reports gets a lookup row", async () => {
  const granted = await withScope("eligible");
  const noScope = await withScope("no-scope", "read_products,read_orders");
  const none = await newShop("no-session");
  const online = await newShop("online-only");
  await session(online, "read_reports", { isOnline: true });
  const lookalike = await withScope("lookalike", "write_reports,unread_reports,read_reports_extra");
  const gone = await withScope("uninstalled", "read_reports", { status: "UNINSTALLED" });
  const all = [granted, noScope, none, online, lookalike, gone];
  const summary = await enqueue(all);
  assert.deepEqual([summary.created, summary.rechecked], [1, 0]);
  assert.equal(await rowCount(all), 1);
  const row = await rowOf(granted);
  assert.deepEqual([row.status, row.attempts, row.sessions30d, row.recommendedPlan, row.nextAttemptAt.getTime(), row.errorCode], ["PENDING", 0, null, null, NOW.getTime(), null], "queued, with no count and no advice");
});

dbTest("running it again, or from several workers at once, never makes a second row", async () => {
  const shop = await withScope("dup");
  const total = [];
  total.push((await enqueue([shop])).created);
  total.push((await enqueue([shop])).created);
  const results = await Promise.all(Array.from({ length: 6 }, () => enqueue([shop])));
  total.push(...results.map((r) => r.created));
  assert.equal(total.reduce((a, b) => a + b, 0), 1, "exactly one creation in all");
  assert.equal(await prisma.planRecommendation.count({ where: { shopId: shop.id } }), 1);
});

dbTest("a shop that already has any row (pending, running, finished, failed, needing access) is never touched or duplicated", async () => {
  const mk = async (tag, data) => {
    const shop = await withScope(tag);
    await prisma.planRecommendation.create({ data: { shopId: shop.id, ...data } });
    return shop;
  };
  const shops = [
    await mk("row-pending", { status: "PENDING", attempts: 2, nextAttemptAt: new Date(NOW.getTime() + DAY), errorCode: "throttled" }),
    await mk("row-running", { status: "RUNNING", attempts: 1, leaseExpiresAt: new Date(NOW.getTime() + 5 * MIN) }),
    await mk("row-done", { status: "SUCCEEDED", sessions30d: 5000, recommendedPlan: "ADVANCE", fetchedAt: NOW, periodStart: new Date(NOW.getTime() - 30 * DAY), periodEnd: NOW }),
    await mk("row-failed", { status: "FAILED", attempts: 5, errorCode: "http_500", nextAttemptAt: null }),
    await mk("row-access", { status: "NEEDS_ACCESS", attempts: 1, errorCode: "access_denied" }),
  ];
  const before = JSON.stringify(await Promise.all(shops.map(rowOf)));
  const summary = await enqueue(shops);
  assert.deepEqual([summary.created, summary.rechecked], [0, 0]);
  assert.equal(JSON.stringify(await Promise.all(shops.map(rowOf))), before, "not one column changed, not even updatedAt");
  assert.equal(await rowCount(shops), 5);
});

dbTest("each run takes a bounded batch, oldest installs first, so a backlog is worked off over several runs", async () => {
  const shops = [];
  for (let i = 0; i < 7; i += 1) shops.push(await withScope(`batch-${i}`, "read_reports", { installedAt: new Date(NOW.getTime() - (100 - i) * DAY) }));
  assert.equal(R.ENQUEUE_BATCH, 25, "the default bound");
  assert.equal((await enqueue(shops, { limit: 3 })).created, 3);
  assert.deepEqual(await Promise.all(shops.map(async (s) => Boolean(await rowOf(s)))), [true, true, true, false, false, false, false], "the oldest three");
  assert.equal((await enqueue(shops, { limit: 3 })).created, 3);
  assert.equal((await enqueue(shops, { limit: 3 })).created, 1);
  assert.equal((await enqueue(shops, { limit: 3 })).created, 0);
  assert.equal(await rowCount(shops), 7);
});

dbTest("a lookup that stopped for a missing SCOPE is queued again once the scope is granted; no other stopped lookup is", async () => {
  const mkStopped = async (tag, scope, errorCode) => {
    const shop = await newShop(tag);
    if (scope) await session(shop, scope);
    await prisma.planRecommendation.create({ data: { shopId: shop.id, status: "NEEDS_ACCESS", attempts: 1, errorCode } });
    return shop;
  };
  const nowGranted = await mkStopped("recheck-granted", "read_reports", "scope_not_granted");
  const stillMissing = await mkStopped("recheck-missing", "read_products", "scope_not_granted");
  const deniedByShopify = await mkStopped("recheck-denied", "read_reports", "access_denied"); // the scope is there, Shopify refused: needs approval, not a retry
  const summary = await enqueue([nowGranted, stillMissing, deniedByShopify]);
  assert.deepEqual([summary.created, summary.rechecked], [0, 1]);
  const row = await rowOf(nowGranted);
  assert.deepEqual([row.status, row.attempts, row.errorCode, row.nextAttemptAt.getTime(), row.sessions30d], ["PENDING", 0, null, NOW.getTime(), null]);
  assert.deepEqual([(await rowOf(stillMissing)).status, (await rowOf(deniedByShopify)).status], ["NEEDS_ACCESS", "NEEDS_ACCESS"]);
  assert.equal((await enqueue([nowGranted, stillMissing, deniedByShopify])).rechecked, 0, "and not again");
});

dbTest("end to end: a shop with the scope is queued, looked up once and recommended; a shop without it is never asked about", async () => {
  const granted = await withScope("e2e-granted");
  const missing = await withScope("e2e-missing", "read_products");
  const getAdmin = adminStub(table([{ sessions: "100001" }]));
  const result = await jobsWith(getAdmin, [granted, missing]);
  assert.deepEqual([result.recommendations.enqueued.created, result.recommendations.succeeded], [1, 1]);
  const row = await rowOf(granted);
  assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan], ["SUCCEEDED", 100001, "ENTERPRISE"]);
  assert.equal(await rowOf(missing), null, "no row for the shop without access");
  assert.equal(getAdmin.calls.get(missing.domain), undefined, "no analytics request was made for it");
  assert.equal(getAdmin.calls.get(granted.domain), 1);
  await jobsWith(getAdmin, [granted, missing]);
  await jobsWith(getAdmin, [granted, missing]);
  assert.equal(getAdmin.calls.get(granted.domain), 1, "a finished lookup is never asked for again");
  assert.equal(await prisma.planRecommendation.count({ where: { shopId: granted.id } }), 1);
  assert.equal(await prisma.shopSubscription.count({ where: { shopId: granted.id } }), 0, "advice created no subscription");
});

dbTest("missing or unusable analytics data is a failure that is retried on the normal backoff, never a zero", async () => {
  const shop = await withScope("nodata");
  const getAdmin = adminStub(table([]));
  await jobsWith(getAdmin, [shop]);
  const row = await rowOf(shop);
  assert.deepEqual([row.status, row.errorCode, row.sessions30d, row.recommendedPlan, row.attempts], ["FAILED", "no_rows", null, null, 1]);
  assert.ok(row.nextAttemptAt.getTime() > Date.now() - 5000, "the retry is scheduled in the future");
  await jobsWith(getAdmin, [shop]);
  assert.equal(getAdmin.calls.get(shop.domain), 1, "not asked again before the retry is due, and no duplicate row is made");
  assert.equal(R.publicRecommendation(await rowOf(shop)), null);
  const odd = await withScope("oddvalue");
  await jobsWith(adminStub(table([{ sessions: null }])), [odd]);
  assert.deepEqual([(await rowOf(odd)).status, (await rowOf(odd)).sessions30d, (await rowOf(odd)).errorCode], ["FAILED", null, "invalid_value"]);
});

dbTest("when Shopify refuses access the shop needs access, is asked once, and is not asked again until something changes", async () => {
  const shop = await withScope("refused");
  const denied = Object.assign(new Error("denied"), { body: { errors: { graphQLErrors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] } } });
  const getAdmin = adminStub(denied);
  await jobsWith(getAdmin, [shop]);
  let row = await rowOf(shop);
  assert.deepEqual([row.status, row.errorCode, row.sessions30d, row.nextAttemptAt], ["NEEDS_ACCESS", "access_denied", null, null]);
  for (let i = 0; i < 3; i += 1) await jobsWith(getAdmin, [shop]);
  assert.equal(getAdmin.calls.get(shop.domain), 1, "no further analytics requests");
  row = await rowOf(shop);
  assert.deepEqual([row.status, row.attempts], ["NEEDS_ACCESS", 1]);
});

dbTest("a missing scope in the shop's session never reaches Shopify: nothing is queued and no request is made", async () => {
  const shop = await withScope("noscope-e2e", "read_products");
  const getAdmin = adminStub(table([{ sessions: "5" }]), "read_products");
  const result = await jobsWith(getAdmin, [shop]);
  assert.deepEqual([result.recommendations.enqueued.created, result.recommendations.claimed], [0, 0]);
  assert.equal(getAdmin.calls.size, 0);
  // even with a row that exists (queued while the scope was there, then revoked), the source itself refuses before any request
  await prisma.planRecommendation.create({ data: { shopId: shop.id, nextAttemptAt: new Date(Date.now() - MIN) } }); // due now by the real clock, which is what the worker uses
  await jobsWith(getAdmin, [shop]);
  assert.equal(getAdmin.calls.size, 0, "the source checks the stored scope before asking");
  assert.deepEqual([(await rowOf(shop)).status, (await rowOf(shop)).errorCode, (await rowOf(shop)).sessions30d], ["NEEDS_ACCESS", "scope_not_granted", null]);
});

dbTest("a large backlog is taken a batch at a time inside the step, which stays bounded", async () => {
  const shops = [];
  for (let i = 0; i < 30; i += 1) shops.push(await withScope(`backlog-${i}`, "read_reports", { installedAt: new Date(NOW.getTime() - (200 - i) * DAY) }));
  const getAdmin = adminStub(table([{ sessions: "10" }]));
  const started = Date.now();
  const first = await jobsWith(getAdmin, shops);
  assert.equal(first.recommendations.enqueued.created, 25, "one batch per run");
  assert.ok(first.recommendations.claimed <= 25);
  assert.ok(Date.now() - started < 20000);
  const second = await jobsWith(getAdmin, shops);
  assert.equal(second.recommendations.enqueued.created, 5);
  assert.equal(await rowCount(shops), 30);
  assert.equal([...getAdmin.calls.values()].every((n) => n === 1), true, "each shop was asked exactly once");
});

dbTest("even a stale candidate list cannot create a duplicate row or re-queue the wrong lookup: the writes themselves are guarded", async () => {
  const existing = await withScope("stale-existing");
  await prisma.planRecommendation.create({ data: { shopId: existing.id, status: "SUCCEEDED", sessions30d: 77, recommendedPlan: "ADVANCE", fetchedAt: NOW, periodStart: new Date(NOW.getTime() - 30 * DAY), periodEnd: NOW } });
  const denied = await withScope("stale-denied");
  await prisma.planRecommendation.create({ data: { shopId: denied.id, status: "NEEDS_ACCESS", attempts: 1, errorCode: "access_denied" } });
  const running = await withScope("stale-running");
  await prisma.planRecommendation.create({ data: { shopId: running.id, status: "RUNNING", attempts: 1, leaseExpiresAt: new Date(NOW.getTime() + 5 * MIN) } });
  // A database handle whose two candidate queries answer with a list that was true a moment ago (another worker has acted since).
  let call = 0;
  const stale = {
    $queryRaw: async () => {
      call += 1;
      return call === 1 ? [{ id: existing.id, scope: "read_reports" }] : [{ id: denied.id, scope: "read_reports" }, { id: running.id, scope: "read_reports" }];
    },
    planRecommendation: prisma.planRecommendation,
  };
  const before = JSON.stringify(await Promise.all([existing, denied, running].map(rowOf)));
  const summary = await R.enqueuePlanRecommendations({ fetchSessions: SOURCE, now: NOW, db: stale });
  assert.deepEqual([summary.created, summary.rechecked], [0, 0], "nothing created, nothing re-queued");
  assert.equal(JSON.stringify(await Promise.all([existing, denied, running].map(rowOf))), before, "no row changed");
  assert.equal(await rowCount([existing, denied, running]), 3);
});
