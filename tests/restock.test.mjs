// Tests for restock processing (app/models/restock.server.js).
//
// Run: node --test tests/restock.test.mjs
//
// These use the REAL MySQL database from .env (no mocks for the database, so the concurrency
// tests exercise InnoDB's actual row locking and unique keys). Shopify itself is not involved:
// the tests play the part of a caller that has already read the variant's current availability.
// Every row belongs to a uniquely named test shop; the shops are deleted at the end (cascade) and
// nothing else is touched.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const domains = [];
let customerCounter = 9300000000;
let variantCounter = 8300000000;
let processRestock;
let subscribeToNotify;
let LookupError;
let appPrisma;

const T0 = Date.now() - 60 * 60 * 1000; // an hour ago: all observation times below are relative to this
const at = (ms) => new Date(T0 + ms);

async function makeShop(tag) {
  const domain = `kw-rs-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "XXX" } });
}
const newVariantGid = () => `gid://shopify/ProductVariant/${(variantCounter += 1)}`;

async function makeVariant(shop, { inStock = false, cycle = 0 } = {}) {
  const variantGid = newVariantGid();
  await prisma.variantAvailability.create({
    data: {
      shopId: shop.id, variantGid, productGid: "gid://shopify/Product/7300000001",
      inventoryItemGid: `gid://shopify/InventoryItem/${variantGid.split("/").pop()}`, isInStock: inStock, restockCycle: cycle,
    },
  });
  return variantGid;
}

async function makeSub(shop, variantGid, { status = "ACTIVE", baseline = 0 } = {}) {
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(customerCounter += 1)}` } });
  return prisma.notifySubscription.create({
    data: {
      shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/7300000001", variantGid,
      email: "customer@example.invalid", status, baselineCycle: baseline, consentedAt: new Date(), consentSource: "test",
    },
  });
}

const availability = (shop, variantGid) => prisma.variantAvailability.findUnique({ where: { shopId_variantGid: { shopId: shop.id, variantGid } } });
const jobs = (shop, variantGid) => prisma.emailDelivery.findMany({ where: { shopId: shop.id, variantGid }, orderBy: [{ restockCycle: "asc" }, { subscriptionId: "asc" }] });
const restock = (shop, variantGid, inStock, observedAt) => processRestock({ shopDomain: shop.domain, variantGid, inStock, observedAt });

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  ({ processRestock } = await import("../app/models/restock.server.js"));
  ({ subscribeToNotify } = await import("../app/models/notify.server.js"));
  ({ LookupError } = await import("../app/models/shopify-lookup.server.js"));
  appPrisma = (await import("../app/db.server.js")).default;
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  const left = await prisma.shop.count({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
  assert.equal(left, 0, "test shops were removed");
});

test("first restock: cycle goes 0 -> 1 and exactly the eligible subscriptions get one PENDING job each", async () => {
  const shop = await makeShop("first");
  const other = await makeShop("first-other");
  const variantGid = await makeVariant(shop);
  const a = await makeSub(shop, variantGid);
  const b = await makeSub(shop, variantGid);
  const done = await makeSub(shop, variantGid, { status: "FULFILLED" });
  const gone = await makeSub(shop, variantGid, { status: "UNSUBSCRIBED" });
  const elsewhere = await makeSub(shop, await makeVariant(shop), {}); // another variant of the same shop
  // The same variant id in another shop is a different record and must not be touched.
  await prisma.variantAvailability.create({ data: { shopId: other.id, variantGid, productGid: "gid://shopify/Product/1", inventoryItemGid: "gid://shopify/InventoryItem/1", isInStock: false } });
  const foreign = await makeSub(other, variantGid);

  const result = await restock(shop, variantGid, true, at(1000));
  assert.deepEqual(result, { outcome: "restocked", restockCycle: 1, jobsCreated: 2 });

  const row = await availability(shop, variantGid);
  assert.equal(row.isInStock, true);
  assert.equal(row.restockCycle, 1);
  assert.equal(row.sourceUpdatedAt.getTime(), at(1000).getTime());

  const created = await jobs(shop, variantGid);
  assert.deepEqual(created.map((j) => j.subscriptionId).sort(), [a.id, b.id].sort());
  assert.ok(created.every((j) => j.status === "PENDING" && j.restockCycle === 1 && j.attempts === 0 && j.variantGid === variantGid));
  assert.ok(created.every((j) => j.nextAttemptAt instanceof Date), "due immediately");
  for (const skipped of [done, gone, elsewhere, foreign]) {
    assert.equal(await prisma.emailDelivery.count({ where: { subscriptionId: skipped.id } }), 0, `subscription ${skipped.id} is not eligible`);
  }
  assert.equal((await availability(other, variantGid)).restockCycle, 0, "the other shop's record is untouched");
});

test("a duplicate event changes nothing: same cycle, same jobs", async () => {
  const shop = await makeShop("dup");
  const variantGid = await makeVariant(shop);
  await makeSub(shop, variantGid);
  await makeSub(shop, variantGid);
  await restock(shop, variantGid, true, at(1000));

  for (const when of [1000, 2000, 90000]) {
    assert.equal((await restock(shop, variantGid, true, at(when))).outcome, "unchanged", `replay at ${when}`);
  }
  assert.equal((await availability(shop, variantGid)).restockCycle, 1);
  assert.equal((await jobs(shop, variantGid)).length, 2);
});

test("an older observation arriving late is ignored (no regression, no extra cycle)", async () => {
  const shop = await makeShop("stale");
  const variantGid = await makeVariant(shop);
  await makeSub(shop, variantGid);
  await restock(shop, variantGid, true, at(5000)); // the newer reading ("in stock") is applied first

  assert.equal((await restock(shop, variantGid, false, at(3000))).outcome, "stale", "an older 'out of stock' must not undo it");
  const row = await availability(shop, variantGid);
  assert.equal(row.isInStock, true);
  assert.equal(row.restockCycle, 1);
  assert.equal(row.sourceUpdatedAt.getTime(), at(5000).getTime(), "the newest observation time is kept");
  assert.equal((await restock(shop, variantGid, true, at(4000))).outcome, "stale");
  assert.equal((await jobs(shop, variantGid)).length, 1);
});

test("in stock -> out of stock updates availability and does NOT raise the cycle or create jobs", async () => {
  const shop = await makeShop("out");
  const variantGid = await makeVariant(shop, { inStock: true, cycle: 4 });
  await makeSub(shop, variantGid, { baseline: 0 });

  assert.deepEqual(await restock(shop, variantGid, false, at(1000)), { outcome: "out_of_stock" });
  const row = await availability(shop, variantGid);
  assert.equal(row.isInStock, false);
  assert.equal(row.restockCycle, 4);
  assert.equal((await jobs(shop, variantGid)).length, 0);
  assert.equal((await restock(shop, variantGid, false, at(2000))).outcome, "unchanged", "a repeated out-of-stock event is a no-op");
  assert.equal((await availability(shop, variantGid)).restockCycle, 4);
});

test("repeated restocks: each out -> in change is one new cycle, and baselineCycle decides who is eligible", async () => {
  const shop = await makeShop("repeat");
  const variantGid = await makeVariant(shop);
  const early = await makeSub(shop, variantGid, { baseline: 0 });

  assert.equal((await restock(shop, variantGid, true, at(1000))).restockCycle, 1);
  assert.equal((await restock(shop, variantGid, false, at(2000))).outcome, "out_of_stock");
  // Someone subscribes while it is out of stock for the second time: they wait after cycle 1.
  const late = await makeSub(shop, variantGid, { baseline: 1 });
  const second = await restock(shop, variantGid, true, at(3000));
  assert.deepEqual(second, { outcome: "restocked", restockCycle: 2, jobsCreated: 2 });
  // A subscriber who already has a cycle-2 baseline (subscribed after this restock) gets nothing for it.
  const newest = await makeSub(shop, variantGid, { baseline: 2 });

  const all = await jobs(shop, variantGid);
  assert.deepEqual(
    all.map((j) => [j.subscriptionId, j.restockCycle]),
    [[early.id, 1], [early.id, 2], [late.id, 2]].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)), // subscription ids are UUIDs: compare as strings
    "one job per subscription per cycle; the early subscriber has a job for each cycle it has not yet been emailed for",
  );
  assert.equal(await prisma.emailDelivery.count({ where: { subscriptionId: newest.id } }), 0);
  assert.equal((await availability(shop, variantGid)).restockCycle, 2);
});

test("many eligible subscriptions each get exactly one job", async () => {
  const shop = await makeShop("many");
  const variantGid = await makeVariant(shop);
  const subs = [];
  for (let i = 0; i < 12; i += 1) subs.push(await makeSub(shop, variantGid));
  const result = await restock(shop, variantGid, true, at(1000));
  assert.equal(result.jobsCreated, 12);
  const created = await jobs(shop, variantGid);
  assert.equal(created.length, 12);
  assert.equal(new Set(created.map((j) => j.subscriptionId)).size, 12);
  assert.deepEqual(new Set(created.map((j) => j.subscriptionId)), new Set(subs.map((s) => s.id)));
});

test("CONCURRENT identical events (real MySQL): the cycle rises once and jobs are created once", async () => {
  for (let round = 0; round < 4; round += 1) {
    const shop = await makeShop(`conc${round}`);
    const variantGid = await makeVariant(shop);
    for (let i = 0; i < 5; i += 1) await makeSub(shop, variantGid);

    const results = await Promise.all(Array.from({ length: 16 }, () => restock(shop, variantGid, true, at(1000))));
    const outcomes = results.map((r) => r.outcome);
    assert.equal(outcomes.filter((o) => o === "restocked").length, 1, `round ${round}: exactly one winner (${outcomes.join(",")})`);
    assert.ok(outcomes.every((o) => o === "restocked" || o === "unchanged"));
    assert.equal((await availability(shop, variantGid)).restockCycle, 1, "cycle incremented exactly once");
    assert.equal((await jobs(shop, variantGid)).length, 5, "exactly one job per subscription");
  }
});

test("CONCURRENT events with different timestamps always end in the state of the newest observation", async () => {
  for (let round = 0; round < 4; round += 1) {
    const shop = await makeShop(`order${round}`);
    const variantGid = await makeVariant(shop);
    await makeSub(shop, variantGid);
    // Observations: out(1s), in(2s), out(3s), in(4s). Shuffled arrival order, all at once.
    const events = [[false, 1000], [true, 2000], [false, 3000], [true, 4000]];
    const shuffled = round % 2 ? [...events].reverse() : [events[2], events[0], events[3], events[1]];
    await Promise.all(shuffled.map(([inStock, ms]) => restock(shop, variantGid, inStock, at(ms))));
    const row = await availability(shop, variantGid);
    assert.equal(row.isInStock, true, "the newest observation (in stock at 4s) wins");
    assert.equal(row.sourceUpdatedAt.getTime(), at(4000).getTime());
    assert.ok(row.restockCycle >= 1 && row.restockCycle <= 2);
    // Whatever order they arrived in, no subscription has two jobs for one cycle (the unique key) and
    // every job belongs to a cycle that actually happened.
    const created = await jobs(shop, variantGid);
    assert.equal(new Set(created.map((j) => `${j.subscriptionId}:${j.restockCycle}`)).size, created.length);
    assert.ok(created.every((j) => j.restockCycle <= row.restockCycle));
  }
});

test("a variant nobody subscribed to, or an unknown or inactive shop, is ignored without creating anything", async () => {
  const shop = await makeShop("ignore");
  const before = await prisma.variantAvailability.count({ where: { shopId: shop.id } });
  assert.deepEqual(await restock(shop, newVariantGid(), true, at(1000)), { outcome: "untracked" });
  assert.equal(await prisma.variantAvailability.count({ where: { shopId: shop.id } }), before, "no availability row was invented");
  assert.deepEqual(await processRestock({ shopDomain: `kw-rs-nobody-${RUN}.myshopify.com`, variantGid: newVariantGid(), inStock: true, observedAt: at(1) }), { outcome: "unknown_shop" });

  const gone = await makeShop("uninstalled");
  const variantGid = await makeVariant(gone);
  await makeSub(gone, variantGid);
  await prisma.shop.update({ where: { id: gone.id }, data: { status: "UNINSTALLED" } });
  assert.deepEqual(await restock(gone, variantGid, true, at(1000)), { outcome: "unknown_shop" });
  assert.equal((await availability(gone, variantGid)).restockCycle, 0);
  assert.equal((await jobs(gone, variantGid)).length, 0);
});

test("invalid input is rejected before touching the database", async () => {
  const shop = await makeShop("input");
  await assert.rejects(processRestock({ shopDomain: shop.domain, variantGid: newVariantGid(), inStock: "yes", observedAt: at(1) }), TypeError);
  await assert.rejects(processRestock({ shopDomain: shop.domain, variantGid: newVariantGid(), inStock: true, observedAt: "now" }), TypeError);
  await assert.rejects(processRestock({ shopDomain: shop.domain, variantGid: newVariantGid(), inStock: true, observedAt: new Date("nope") }), TypeError);
});

// ---- the subscribe path follows the same ordering rule -------------------------------------
const soldOutNode = (variantGid) => ({
  id: variantGid, inventoryPolicy: "DENY", sellableOnlineQuantity: 0,
  product: { id: "gid://shopify/Product/7300000001" }, inventoryItem: { id: "gid://shopify/InventoryItem/6300000001", tracked: true },
});
const adminFor = (variantGid, onCall) => ({
  getAdmin: async () => {
    if (onCall) await onCall();
    return {
      scope: "read_customers",
      admin: {
        async graphql(query) {
          const data = query.includes("NotifyVariant")
            ? { node: soldOutNode(variantGid) }
            : { customer: { id: "gid://shopify/Customer/1", defaultEmailAddress: { emailAddress: "customer@example.invalid" } } };
          return { json: async () => ({ data }) };
        },
      },
    };
  },
});

test("a restock processed after the subscriber's stock check wins: the subscription is refused and the restock is not undone", async () => {
  const shop = await makeShop("race");
  const variantGid = await makeVariant(shop);
  await makeSub(shop, variantGid); // someone else already waiting
  const identity = { shopDomain: shop.domain, customerGid: `gid://shopify/Customer/${(customerCounter += 1)}` };

  // The restock is observed AFTER this request first asked Shopify about stock (but before it saved anything).
  const deps = adminFor(variantGid, () => restock(shop, variantGid, true, new Date(Date.now() + 50)));
  await assert.rejects(subscribeToNotify(identity, variantGid, deps), (e) => e instanceof LookupError && e.code === "variant_available");

  const row = await availability(shop, variantGid);
  assert.equal(row.isInStock, true, "the later 'in stock' observation was not overwritten by the older 'sold out' reading");
  assert.equal(row.restockCycle, 1);
  assert.equal(await prisma.notifySubscription.count({ where: { shopId: shop.id } }), 1, "no new subscription was recorded");
  assert.equal(await prisma.actor.count({ where: { shopId: shop.id, customerGid: identity.customerGid } }), 0);
});

test("subscribing after a restock cycle waits for the NEXT restock, and then gets a job for it only", async () => {
  const shop = await makeShop("sub-cycle");
  const variantGid = await makeVariant(shop);
  await restock(shop, variantGid, true, at(1000)); // cycle 1 (nobody was subscribed)
  await restock(shop, variantGid, false, at(2000)); // sold out again
  const identity = { shopDomain: shop.domain, customerGid: `gid://shopify/Customer/${(customerCounter += 1)}` };
  await subscribeToNotify(identity, variantGid, adminFor(variantGid));

  const sub = await prisma.notifySubscription.findFirst({ where: { shopId: shop.id, variantGid } });
  assert.equal(sub.baselineCycle, 1);
  assert.equal((await availability(shop, variantGid)).isInStock, false);
  assert.equal((await jobs(shop, variantGid)).length, 0, "no job for the restock that already happened");

  const next = await restock(shop, variantGid, true, new Date(Date.now() + 1000));
  assert.deepEqual(next, { outcome: "restocked", restockCycle: 2, jobsCreated: 1 });
  assert.deepEqual((await jobs(shop, variantGid)).map((j) => [j.subscriptionId, j.restockCycle]), [[sub.id, 2]]);
});
