// The two Notify Me subscription numbers on the Analytics page must agree: the "Notify Me subscriptions" KPI (a date range)
// and the Product funnel's "Total subscriptions" (all time) both count NOTIFY_SUBSCRIBED sign-up events from the same daily
// summary, so the all-time figure can never be below the date-ranged one. A customer who signs up again for a variant after it
// was fulfilled or cancelled REUSES the subscription row (unique shop + customer + variant) but is a new sign-up: counting rows
// gave 2 where the KPI gave 3.
//
// Run: node --test tests/notify-subscription-counts.test.mjs   (WRITES to DATABASE_URL: scratch database only)
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const RUN = Date.now().toString(36);
const domains = [];
const at = (iso) => new Date(iso);
const NOW = at("2026-11-16T12:00:00Z");
let counter = 9800000000;
let worker;
let reporting;
let P;
let tick = 0;

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  worker = await import("../app/worker/analytics-daily.server.js");
  reporting = await import("../app/models/reporting.server.js");
  P = await import("../app/utils/period.js");
});
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const makeShop = async (tag) => {
  const domain = `kw-subs-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: at("2026-08-01T00:00:00Z") } });
};
const actorOf = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
// One sign-up: the subscription row and its event, as subscribeToNotify writes them.
async function signUp(shop, actor, variant, iso, status = "ACTIVE") {
  const variantGid = `gid://shopify/ProductVariant/${variant}`;
  const existing = await prisma.notifySubscription.findFirst({ where: { shopId: shop.id, actorId: actor.id, variantGid } });
  if (existing) await prisma.notifySubscription.update({ where: { id: existing.id }, data: { status, unsubscribedAt: null } });
  else await prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid, email: "never.shown@example.invalid", status, consentedAt: at(iso), consentSource: "test", createdAt: at(iso) } });
  await prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type: "NOTIFY_SUBSCRIBED", feature: "NOTIFY_ME", productGid: "gid://shopify/Product/1", variantGid, occurredAt: at(iso) } });
}
// each run is a little later than the last (a summary row only replaces an older one, like the real worker every 10 minutes)
const refresh = (shop) => worker.runAnalyticsDaily({ now: () => new Date(NOW.getTime() + (tick += 1000)), shopIds: [shop.id], backfillPerShop: 400, log: { log() {}, error() {} }, invalidate: async () => {} });
// The two numbers as the page reads them: the KPI (date range, summed from the same daily rows) and the funnel's all-time stage.
async function numbers(shop) {
  const ref = await reporting.getShopByDomain(shop.domain);
  const range = P.presetPeriod(30, NOW);
  const kpi = (await reporting.getAnalyticsOverview(ref, range, NOW)).activity.window.NOTIFY_SUBSCRIBED;
  const funnel = (await reporting.getFunnelSummary(ref, range, NOW)).allTime.notifySubscriptions;
  return { kpi, funnel };
}

test("three sign-ups in the last 30 days: the KPI and the all-time funnel stage are both 3", async () => {
  const shop = await makeShop("three");
  for (const [variant, iso] of [[1, "2026-11-10T10:00:00Z"], [2, "2026-11-12T10:00:00Z"], [3, "2026-11-15T10:00:00Z"]]) await signUp(shop, await actorOf(shop), variant, iso);
  await refresh(shop);
  assert.deepEqual(await numbers(shop), { kpi: 3, funnel: 3 });
});

test("the reported case: a customer signs up again for a variant after it was fulfilled: 3 sign-ups, 2 rows, and both numbers say 3", async () => {
  const shop = await makeShop("resubscribe");
  const a = await actorOf(shop);
  await signUp(shop, a, 1, "2026-11-10T10:00:00Z");
  await prisma.notifySubscription.updateMany({ where: { shopId: shop.id }, data: { status: "FULFILLED" } });
  await signUp(shop, a, 1, "2026-11-14T10:00:00Z"); // reuses the row, writes a new event
  await signUp(shop, a, 2, "2026-11-15T10:00:00Z");
  assert.equal(await prisma.notifySubscription.count({ where: { shopId: shop.id } }), 2, "two rows");
  await refresh(shop);
  assert.deepEqual(await numbers(shop), { kpi: 3, funnel: 3 });
});

test("historical sign-ups count in the all-time stage but not in the last-30-days KPI, so all-time is never below the KPI", async () => {
  const shop = await makeShop("history");
  await signUp(shop, await actorOf(shop), 1, "2026-08-20T10:00:00Z"); // outside 30 days
  await signUp(shop, await actorOf(shop), 2, "2026-10-01T10:00:00Z"); // outside 30 days
  await signUp(shop, await actorOf(shop), 3, "2026-11-14T10:00:00Z");
  await refresh(shop);
  const { kpi, funnel } = await numbers(shop);
  assert.deepEqual([kpi, funnel], [1, 3]);
  assert.ok(funnel >= kpi);
});

test("cancelled, fulfilled and active sign-ups are all sign-ups (the status only says what happened afterwards)", async () => {
  const shop = await makeShop("status");
  for (const [variant, status] of [[1, "ACTIVE"], [2, "FULFILLED"], [3, "UNSUBSCRIBED"]]) await signUp(shop, await actorOf(shop), variant, "2026-11-12T10:00:00Z", status);
  await refresh(shop);
  assert.deepEqual(await numbers(shop), { kpi: 3, funnel: 3 });
});

test("another shop's sign-ups never change this shop's numbers", async () => {
  const mine = await makeShop("mine");
  const other = await makeShop("other");
  await signUp(mine, await actorOf(mine), 1, "2026-11-12T10:00:00Z");
  for (const variant of [1, 2, 3, 4]) await signUp(other, await actorOf(other), variant, "2026-11-13T10:00:00Z");
  await refresh(mine);
  await refresh(other);
  assert.deepEqual(await numbers(mine), { kpi: 1, funnel: 1 });
  assert.deepEqual(await numbers(other), { kpi: 4, funnel: 4 });
});

test("repeated aggregation does not inflate either number", async () => {
  const shop = await makeShop("repeat");
  await signUp(shop, await actorOf(shop), 1, "2026-11-12T10:00:00Z");
  await signUp(shop, await actorOf(shop), 2, "2026-11-15T10:00:00Z");
  const seen = [];
  for (let run = 0; run < 3; run += 1) {
    await refresh(shop);
    seen.push(await numbers(shop));
  }
  assert.deepEqual(seen, [{ kpi: 2, funnel: 2 }, { kpi: 2, funnel: 2 }, { kpi: 2, funnel: 2 }]);
});

test("no sign-ups: both numbers are a confirmed zero", async () => {
  const shop = await makeShop("empty");
  await refresh(shop);
  assert.deepEqual(await numbers(shop), { kpi: 0, funnel: 0 });
});
