// The install-time trigger of the plan recommendation (app/models/install-recommendation.server.js, wired as the afterAuth hook in
// app/shopify.server.js) and its hand-over to the existing worker. Nothing here calls Shopify: the ShopifyQL admin client is a stub.
//
// Run: node --test tests/billing-install-trigger.test.mjs
// The database tests WRITE rows, so they run only when DATABASE_URL names an isolated kw_*test* database with the migrations applied;
// otherwise they are skipped and say so. Set REDIS_URL="" too.
import "./helpers/resolve-extensionless.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isTimezoneQuery, shopZoneAnswer } from "./helpers/shop-timezone.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

let dbName = "";
try {
  dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const dbTest = (name, fn) => test(name, { skip }, fn);
const prisma = skip ? null : new PrismaClient();

const { onShopAuthenticated } = await import("../app/models/install-recommendation.server.js");
const { createShopifyqlSessionSource } = await import("../app/models/session-source.server.js");
const { runBillingJobs } = await import("../app/worker/billing-jobs.server.js");

const quiet = { log() {}, error() {}, warn() {} };
const RUN = Date.now().toString(36);
const domains = [];
let seq = 0;
const newDomain = (tag) => {
  const domain = `kw-it-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return domain;
};
after(async () => {
  if (prisma) {
    await prisma.session.deleteMany({ where: { shop: { in: domains } } });
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});
const storeSession = (shop, scope) => prisma.session.create({ data: { id: `off_${shop}`, shop, state: "test", isOnline: false, scope, accessToken: "dummy-not-a-real-token" } });
const shopRow = (domain) => prisma.shop.findUnique({ where: { domain } });
const rowFor = (domain) => prisma.planRecommendation.findFirst({ where: { shop: { domain } } });
const SOURCE = async () => ({ sessions: 1, periodStart: new Date(), periodEnd: new Date() });
const services = { fetchSessions: SOURCE };
const authed = (domain) => ({ shop: domain, isOnline: false });

const table = (rows) => ({ data: { shopifyqlQuery: { tableData: { columns: [{ name: "sessions" }], rows }, parseErrors: [] } } });
const adminStub = (answer, scope = "read_reports") => {
  const getAdmin = async () => ({
    scope,
    admin: {
      graphql: async (query) => {
        if (isTimezoneQuery(query)) return { json: async () => shopZoneAnswer("UTC") };
        getAdmin.calls += 1;
        return { json: async () => answer };
      },
    },
  });
  getAdmin.calls = 0;
  return getAdmin;
};
const worker = (getAdmin, shop) => runBillingJobs({ services: { fetchSessions: createShopifyqlSessionSource({ getAdmin }) }, shopIds: [shop.id], log: quiet });

// ---------- pure ----------
test("no session source configured: nothing is scheduled and nothing is touched", async () => {
  let touched = 0;
  const probe = { ensure: async () => (touched += 1), enqueue: async () => (touched += 1), log: quiet };
  assert.deepEqual(await onShopAuthenticated(authed("a.myshopify.com"), { services: { fetchSessions: null }, ...probe }), { enqueued: false });
  assert.equal(touched, 0);
});

test("online sessions and sessions without a shop never schedule anything", async () => {
  let touched = 0;
  const probe = { ensure: async () => (touched += 1), enqueue: async () => (touched += 1), log: quiet };
  for (const session of [{ shop: "a.myshopify.com", isOnline: true }, { shop: "" }, {}, null, undefined, { shop: 5 }]) {
    assert.equal((await onShopAuthenticated(session, { services, ...probe })).enqueued, false);
  }
  assert.equal(touched, 0);
});

test("a failure while scheduling is swallowed and logged as a code only: authentication is never broken", async () => {
  const lines = [];
  const result = await onShopAuthenticated(
    { shop: "a.myshopify.com", isOnline: false, accessToken: "shpat_secret" },
    {
      services,
      ensure: async () => {
        throw Object.assign(new Error("connection string mysql://u:p@host leaked"), { code: "P1001" });
      },
      log: { error: (line) => lines.push(line) },
    },
  );
  assert.deepEqual(result, { enqueued: false, failed: true });
  assert.deepEqual(lines, ["[billing] could not schedule the plan recommendation after authentication: P1001"]);
  assert.doesNotMatch(lines.join(), /mysql|shpat|secret|leaked/);
});

test("the hook only schedules: it is wired in shopify.server.js, adds no webhook and makes no Shopify request itself", () => {
  const wiring = fs.readFileSync("app/shopify.server.js", "utf8");
  assert.match(wiring, /afterAuth:\s*async \(\{ session \}\) => \{\s*await onShopAuthenticated\(session\);/);
  const source = fs.readFileSync("app/models/install-recommendation.server.js", "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /graphql|fetch\(|registerWebhooks|admin\./);
  for (const toml of ["shopify.app.toml", "shopify.app.konvert-wishlist-notify.toml"]) {
    assert.doesNotMatch(fs.readFileSync(toml, "utf8"), /app\/installed/, `${toml}: no invented install webhook topic`);
  }
});

// ---------- database ----------
dbTest("an install creates the shop's one PENDING row; the same event again, or ten at once, never makes a second", async () => {
  const domain = newDomain("dup");
  await storeSession(domain, "read_products,read_reports");
  assert.equal((await onShopAuthenticated(authed(domain), { services, log: quiet })).enqueued, true);
  const row = await rowFor(domain);
  assert.deepEqual([row.status, row.attempts, row.sessions30d], ["PENDING", 0, null]);
  await Promise.all(Array.from({ length: 10 }, () => onShopAuthenticated(authed(domain), { services, log: quiet })));
  assert.equal(await prisma.planRecommendation.count({ where: { shop: { domain } } }), 1);
  assert.equal(await prisma.shop.count({ where: { domain } }), 1);
  assert.equal((await rowFor(domain)).id, row.id, "the same row");
});

dbTest("without the read_reports scope no row is made, so no analytics request can ever be made for the shop", async () => {
  const domain = newDomain("noscope");
  await storeSession(domain, "read_products,write_products");
  await onShopAuthenticated(authed(domain), { services, log: quiet });
  assert.equal(await rowFor(domain), null);
});

dbTest("a re-install keeps a finished result and does not queue a second lookup", async () => {
  const domain = newDomain("reinstall");
  await storeSession(domain, "read_reports");
  await onShopAuthenticated(authed(domain), { services, log: quiet });
  await prisma.planRecommendation.updateMany({
    where: { shop: { domain } },
    data: { status: "SUCCEEDED", sessions30d: 5, recommendedPlan: "ADVANCE", fetchedAt: new Date(), periodStart: new Date(Date.now() - 3e9), periodEnd: new Date(Date.now() - 1e9) },
  });
  await onShopAuthenticated(authed(domain), { services, log: quiet });
  const row = await rowFor(domain);
  assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan], ["SUCCEEDED", 5, "ADVANCE"]);
});

dbTest("a shop that waited for the scope is released when the next authentication carries it", async () => {
  const domain = newDomain("release");
  await storeSession(domain, "read_reports");
  await onShopAuthenticated(authed(domain), { services, log: quiet });
  await prisma.planRecommendation.updateMany({ where: { shop: { domain } }, data: { status: "NEEDS_ACCESS", errorCode: "scope_not_granted", nextAttemptAt: null } });
  await onShopAuthenticated(authed(domain), { services, log: quiet });
  const row = await rowFor(domain);
  assert.deepEqual([row.status, row.errorCode], ["PENDING", null]);
});

// ---------- install -> worker, end to end with a stubbed Shopify ----------
for (const [count, plan] of [[100001, "ENTERPRISE"], [100000, "ADVANCE"], [99999, "ADVANCE"]]) {
  dbTest(`install, then one worker run with ${count} sessions: stored as ${plan}, nothing else changed`, async () => {
    const domain = newDomain(`e2e${count}`);
    await storeSession(domain, "read_reports");
    await onShopAuthenticated(authed(domain), { services, log: quiet });
    const shop = await shopRow(domain);
    const getAdmin = adminStub(table([{ sessions: String(count) }]));
    const result = await worker(getAdmin, shop);
    assert.equal(result.recommendations.succeeded, 1);
    const row = await rowFor(domain);
    assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan, row.attempts], ["SUCCEEDED", count, plan, 0]);
    assert.equal(getAdmin.calls, 1);
    // a second install event and a second worker run ask Shopify nothing more
    await onShopAuthenticated(authed(domain), { services, log: quiet });
    await worker(getAdmin, shop);
    assert.equal(getAdmin.calls, 1, "no repeated analytics request");
    assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id, plan: { not: "BASIC" } } }), 0, "no subscription or plan was changed");
  });
}

dbTest("analytics that cannot be read after an install: no count, no recommendation, a bounded retry", async () => {
  const domain = newDomain("fail");
  await storeSession(domain, "read_reports");
  await onShopAuthenticated(authed(domain), { services, log: quiet });
  await worker(adminStub(table([])), await shopRow(domain));
  const row = await rowFor(domain);
  assert.deepEqual([row.status, row.sessions30d, row.recommendedPlan], ["FAILED", null, null], "no rows is unavailable data, never zero");
  assert.ok(row.nextAttemptAt && row.attempts === 1);
});
