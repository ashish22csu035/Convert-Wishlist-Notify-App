// Tests for the inventory_levels/update webhook (route + app/models/inventory-webhook.server.js).
//
// Run from the project root after `npm run build`:
//   node --test tests/inventory-webhook.test.mjs
//
// Two layers, and neither talks to real Shopify:
//  1. HTTP: the built server (dummy app secret, port 3196) receives webhooks signed the way Shopify
//     signs them (HMAC-SHA256, base64, over the raw body). This proves authentication, header checks,
//     routing and the retry statuses for real. The shop has no Shopify session here, so a tracked item
//     reaches the "Admin API unavailable" branch.
//  2. In-process: handleInventoryLevelWebhook against the real MySQL database with a FAKE Shopify Admin
//     client, to cover the restock logic. The Admin answers are invented by the tests.
// All rows belong to uniquely named test shops and their WebhookEvent rows; only those are deleted.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { GraphqlQueryError, HttpInternalError, HttpRequestError, HttpResponseError, HttpThrottlingError } from "@shopify/shopify-api";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const PORT = 3196;
const BASE = `http://localhost:${PORT}`;
const SECRET = "dummy-secret-for-tests-only";
const RUN = Date.now().toString(36);
const domains = [];
let seq = 9400000000;
let handle;
let clearShopCooldowns;
let fetchVariantForNotify;
let LookupError;
let appPrisma;
let server;
let serverOutput = ""; // everything the app server printed

async function makeShop(tag) {
  const domain = `kw-wh-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "XXX" } });
}

// A tracked variant: someone subscribed while it was out of stock. Returns ids to build webhooks from.
async function makeTracked(shop, { subs = 1, cycle = 0, inStock = false } = {}) {
  const n = (seq += 1);
  const variantGid = `gid://shopify/ProductVariant/${n}`;
  const itemId = String(n + 1000);
  await prisma.variantAvailability.create({
    data: { shopId: shop.id, variantGid, productGid: "gid://shopify/Product/7400000001", inventoryItemGid: `gid://shopify/InventoryItem/${itemId}`, isInStock: inStock, restockCycle: cycle },
  });
  const subscriptions = [];
  for (let i = 0; i < subs; i += 1) {
    const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
    subscriptions.push(
      await prisma.notifySubscription.create({
        data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/7400000001", variantGid, email: "customer@example.invalid", baselineCycle: cycle, consentedAt: new Date(), consentSource: "test" },
      }),
    );
  }
  return { variantGid, itemId, subscriptions };
}

const state = (shop, variantGid) => prisma.variantAvailability.findUnique({ where: { shopId_variantGid: { shopId: shop.id, variantGid } } });
const jobCount = (shop, variantGid) => prisma.emailDelivery.count({ where: { shopId: shop.id, variantGid } });
const events = (shop) => prisma.webhookEvent.findMany({ where: { shopDomain: shop.domain }, orderBy: { id: "asc" } });

// ---- HTTP helpers ------------------------------------------------------------------------

// The server's console output reaches the test through a pipe, which can lag when the machine is busy
// (the full suite runs many files at once). Wait until the expected lines are there instead of guessing a delay.
async function waitForOutput(...patterns) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (patterns.every((pattern) => pattern.test(serverOutput))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function signedRequest(body, { shop, secret = SECRET, topic = "inventory_levels/update", webhookId = `wh-${seq += 1}`, eventId, omit = [], hmac, method = "POST" }) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": hmac ?? crypto.createHmac("sha256", secret).update(raw).digest("base64"),
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": shop,
    "X-Shopify-API-Version": "2026-07",
    "X-Shopify-Webhook-Id": webhookId,
    "X-Shopify-Triggered-At": new Date().toISOString(),
  };
  if (eventId) headers["X-Shopify-Event-Id"] = eventId;
  for (const name of omit) delete headers[name];
  return fetch(`${BASE}/webhooks/inventory_levels/update`, { method, headers, body: method === "GET" ? undefined : raw });
}
const payloadFor = (itemId, available = 5) => ({ inventory_item_id: Number(itemId), location_id: 1, available, updated_at: new Date().toISOString() });

// ---- in-process helpers ------------------------------------------------------------------
const node = (variantGid, sellable) => ({
  id: variantGid, inventoryPolicy: "DENY", sellableOnlineQuantity: sellable,
  product: { id: "gid://shopify/Product/7400000001" }, inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true },
});
// A fake Admin API: `answer(variantGid)` returns the variant node (or null for "deleted"), or throws.
function fakeShopify(answer) {
  const log = { adminRequestedAt: [], variants: [] };
  return {
    log,
    deps: (extra = {}) => ({
      getAdmin: async () => ({
        scope: "read_customers",
        admin: {
          async graphql(query, { variables }) {
            // where the stock sits (only asked for variants Admin reports as sellable): answered "unknown", not logged as a variant read
            if (query.includes("StockTopology")) return { json: async () => ({ data: {} }) };
            log.adminRequestedAt.push(Date.now());
            log.variants.push(variables.id);
            const result = await answer(variables.id);
            return { json: async () => ({ data: { node: result } }) };
          },
        },
      }),
      ...extra,
    }),
  };
}
function spyRestock() {
  const calls = [];
  return { calls, restock: async (args) => { calls.push(args); return (await import("../app/models/restock.server.js")).processRestock(args); } };
}
const deliver = (shop, itemId, over = {}) =>
  handle({ shopDomain: shop.domain, topic: "INVENTORY_LEVELS_UPDATE", webhookId: `wh-${(seq += 1)}`, eventId: `ev-${(seq += 1)}`, triggeredAt: new Date().toISOString(), payload: payloadFor(itemId), ...over.input }, over.deps);

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.SHOPIFY_APP_URL = BASE;
  process.env.SCOPES = "write_products";
  ({ handleInventoryLevelWebhook: handle, clearShopCooldowns } = await import("../app/models/inventory-webhook.server.js"));
  appPrisma = (await import("../app/db.server.js")).default;
  ({ fetchVariantForNotify, LookupError } = await import("../app/models/shopify-lookup.server.js"));

  server = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => (serverOutput += c));
  server.stderr.on("data", (c) => (serverOutput += c));
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

after(async () => {
  // WebhookEvent keeps its rows when a shop is deleted (SetNull), so they are removed by test domain.
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: { in: domains } } });
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  const left = (await prisma.shop.count({ where: { domain: { in: domains } } })) + (await prisma.webhookEvent.count({ where: { shopDomain: { in: domains } } }));
  await prisma.$disconnect();
  await appPrisma.$disconnect();
  server?.kill();
  assert.equal(left, 0, "test rows were removed");
});

// ======================= HTTP: authentication and routing =======================
test("HTTP: a wrong or missing signature is rejected with 401 and nothing is stored", async () => {
  const shop = await makeShop("auth");
  const { itemId } = await makeTracked(shop);
  const body = payloadFor(itemId);
  assert.equal((await signedRequest(body, { shop: shop.domain, secret: "not-the-secret" })).status, 401);
  assert.equal((await signedRequest(body, { shop: shop.domain, hmac: "AAAA" })).status, 401);
  // A signature made for a different body does not authorise this one.
  const forged = await signedRequest(body, { shop: shop.domain, hmac: crypto.createHmac("sha256", SECRET).update("{}").digest("base64") });
  assert.equal(forged.status, 401);
  assert.deepEqual(await events(shop), []);
});

test("HTTP: missing required Shopify headers give 400; only POST is accepted", async () => {
  const shop = await makeShop("headers");
  const { itemId } = await makeTracked(shop);
  for (const header of ["X-Shopify-Topic", "X-Shopify-Shop-Domain", "X-Shopify-Webhook-Id", "X-Shopify-API-Version", "X-Shopify-Hmac-Sha256"]) {
    const response = await signedRequest(payloadFor(itemId), { shop: shop.domain, omit: [header] });
    assert.ok([400, 401].includes(response.status), `${header} missing -> ${response.status}`);
    assert.notEqual(response.status, 200);
  }
  // The route only has an action: a GET never reaches the handler (React Router answers 4xx).
  const get = await signedRequest(payloadFor(itemId), { shop: shop.domain, method: "GET" });
  assert.ok([400, 404, 405].includes(get.status), `GET -> ${get.status}`);
  assert.deepEqual(await events(shop), []);
});

test("HTTP: a signed body that is not JSON is a 400 (retrying cannot help)", async () => {
  const shop = await makeShop("nojson");
  assert.equal((await signedRequest("this is not json", { shop: shop.domain })).status, 400);
});

test("HTTP: an inventory item nobody subscribed to is acknowledged with 200 and writes nothing", async () => {
  const shop = await makeShop("untracked-http");
  const response = await signedRequest(payloadFor(123456789012), { shop: shop.domain });
  assert.equal(response.status, 200);
  assert.deepEqual(await events(shop), []);
  assert.equal(await prisma.variantAvailability.count({ where: { shopId: shop.id } }), 0);
  // an unknown shop is acknowledged too and creates nothing
  const unknown = `kw-wh-unknown-${RUN}.myshopify.com`;
  domains.push(unknown);
  assert.equal((await signedRequest(payloadFor(123456789012), { shop: unknown })).status, 200);
  assert.equal(await prisma.shop.count({ where: { domain: unknown } }), 0);
});

test("HTTP diagnostics: every delivery leaves one line that tells 'not delivered', 'rejected', 'ignored' and 'processed' apart, with no secrets", async () => {
  const shop = await makeShop("diag");
  const { itemId } = await makeTracked(shop);
  const webhookId = `wh-diag-${RUN}`;
  const badHmac = "QUJDRC1ub3QtYS1yZWFsLXNpZ25hdHVyZQ==";
  assert.equal((await signedRequest(payloadFor(itemId), { shop: shop.domain, hmac: badHmac })).status, 401);
  assert.equal((await signedRequest(payloadFor(99887766), { shop: shop.domain, webhookId })).status, 200); // untracked item
  await waitForOutput(/inventory webhook rejected before processing/, new RegExp(`inventory webhook handled .*"webhookId":"${webhookId}"`));
  assert.match(serverOutput, /inventory webhook rejected before processing {"status":401}/);
  assert.match(serverOutput, new RegExp(`inventory webhook handled .*"shop":"${shop.domain}".*"item":99887766.*"webhookId":"${webhookId}".*"outcome":"untracked","status":200`));
  assert.equal(serverOutput.includes(badHmac), false, "the signature is never logged");
  assert.equal(serverOutput.includes(SECRET), false, "the secret is never logged");
  assert.equal(/example.invalid/.test(serverOutput), false, "no customer data is logged");
});

test("HTTP: malformed payloads are acknowledged (they can never succeed) but change nothing", async () => {
  const shop = await makeShop("malformed-http");
  const { variantGid } = await makeTracked(shop);
  for (const body of [{}, { inventory_item_id: "abc" }, { inventory_item_id: -4 }, { inventory_item_id: null }, { inventory_item_id: [1] }, { available: 5 }, []]) {
    assert.equal((await signedRequest(body, { shop: shop.domain })).status, 200, JSON.stringify(body));
  }
  assert.deepEqual(await events(shop), []);
  assert.equal((await state(shop, variantGid)).restockCycle, 0);
});

test("HTTP: a tracked item with Shopify unreachable answers 503, is marked FAILED, and the retry is accepted again", async () => {
  const shop = await makeShop("retry-http");
  const { itemId, variantGid } = await makeTracked(shop);
  const eventId = `ev-${(seq += 1)}`;

  const first = await signedRequest(payloadFor(itemId), { shop: shop.domain, eventId, webhookId: "wh-a" });
  assert.equal(first.status, 503, "the work could not be done, so Shopify is asked to retry");
  let [event] = await events(shop);
  assert.equal(event.status, "FAILED");
  assert.equal(event.errorCode, "shop_unavailable");
  assert.equal(event.attempts, 1);
  assert.equal(event.dedupeKey, eventId);

  // Shopify's retry (new webhook id, same event id) is the same event, claimed again.
  const second = await signedRequest(payloadFor(itemId), { shop: shop.domain, eventId, webhookId: "wh-b" });
  assert.equal(second.status, 503);
  const all = await events(shop);
  assert.equal(all.length, 1, "one row per event");
  assert.equal(all[0].attempts, 2);
  assert.equal(all[0].status, "FAILED");
  const row = await state(shop, variantGid);
  assert.equal(row.restockCycle, 0, "nothing was changed by a failed attempt");
  assert.equal(row.isInStock, false);
});

// ======================= in-process: restock logic =======================
test("a valid delivery for a tracked variant reads Shopify, calls processRestock with the exact arguments, and marks the event PROCESSED", async () => {
  const shop = await makeShop("valid");
  const { itemId, variantGid, subscriptions } = await makeTracked(shop, { subs: 2 });
  const shopify = fakeShopify((id) => node(id, 7));
  const spy = spyRestock();

  const before = Date.now();
  const result = await deliver(shop, itemId, { deps: shopify.deps({ restock: spy.restock }) });
  assert.deepEqual([result.status, result.outcome, result.results], [200, "processed", ["restocked"]]);

  assert.deepEqual(shopify.log.variants, [variantGid], "Shopify was asked about the exact tracked variant");
  assert.equal(spy.calls.length, 1);
  const [call] = spy.calls;
  assert.equal(call.shopDomain, shop.domain);
  assert.equal(call.variantGid, variantGid);
  assert.equal(call.inStock, true);
  assert.ok(call.observedAt instanceof Date);
  assert.ok(call.observedAt.getTime() >= before && call.observedAt.getTime() <= shopify.log.adminRequestedAt[0], "the observation time was taken BEFORE the Admin API read");

  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle], [true, 1]);
  assert.equal(await jobCount(shop, variantGid), subscriptions.length);
  const [event] = await events(shop);
  assert.equal(event.status, "PROCESSED");
  assert.equal(event.attempts, 1);
  assert.equal(event.resourceGid, `gid://shopify/InventoryItem/${itemId}`);
  assert.ok(event.processedAt);
  assert.equal(event.errorCode, null);
});

test("an untracked inventory item is ignored: no Shopify call, no restock, and no WebhookEvent row", async () => {
  const shop = await makeShop("untracked");
  await makeTracked(shop);
  const shopify = fakeShopify(() => assert.fail("Shopify must not be called"));
  const spy = spyRestock();
  const result = await deliver(shop, "555000111", { deps: shopify.deps({ restock: spy.restock }) });
  assert.deepEqual([result.status, result.outcome], [200, "untracked"]);
  assert.equal(shopify.log.variants.length, 0);
  assert.equal(spy.calls.length, 0);
  assert.deepEqual(await events(shop), []);
});

test("a duplicate delivery is acknowledged and processed once (same event id, even with a different webhook id)", async () => {
  const shop = await makeShop("dup");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 3 });
  const shopify = fakeShopify((id) => node(id, 4));
  const spy = spyRestock();
  const deps = shopify.deps({ restock: spy.restock });
  const input = { eventId: "ev-fixed", triggeredAt: new Date().toISOString(), payload: payloadFor(itemId) };

  const first = await deliver(shop, itemId, { input: { ...input, webhookId: "wh-1" }, deps });
  const again = await deliver(shop, itemId, { input: { ...input, webhookId: "wh-2" }, deps });
  const third = await deliver(shop, itemId, { input: { ...input, webhookId: "wh-3" }, deps });
  assert.equal(first.outcome, "processed");
  assert.deepEqual([again.status, again.outcome], [200, "duplicate"]);
  assert.equal(third.outcome, "duplicate");
  assert.equal(spy.calls.length, 1);
  assert.equal(shopify.log.variants.length, 1, "no second Shopify read for a duplicate");
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
  assert.equal(await jobCount(shop, variantGid), 3);
  assert.equal((await events(shop)).length, 1);
});

test("without an event id the webhook id is the deduplication key", async () => {
  const shop = await makeShop("dupid");
  const { itemId } = await makeTracked(shop);
  const shopify = fakeShopify((id) => node(id, 4));
  const deps = shopify.deps();
  const input = { eventId: undefined, webhookId: "only-wh" };
  assert.equal((await deliver(shop, itemId, { input, deps })).outcome, "processed");
  assert.equal((await deliver(shop, itemId, { input, deps })).outcome, "duplicate");
  assert.equal((await events(shop))[0].dedupeKey, "only-wh");
});

test("CONCURRENT duplicate deliveries (real MySQL): one does the work, the cycle rises once", async () => {
  for (let round = 0; round < 3; round += 1) {
    const shop = await makeShop(`conc${round}`);
    const { itemId, variantGid } = await makeTracked(shop, { subs: 4 });
    const shopify = fakeShopify(async (id) => { await new Promise((r) => setTimeout(r, 40)); return node(id, 6); });
    const spy = spyRestock();
    const deps = shopify.deps({ restock: spy.restock });
    const input = { eventId: `ev-conc-${round}-${RUN}`, payload: payloadFor(itemId), triggeredAt: new Date().toISOString() };

    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => deliver(shop, itemId, { input: { ...input, webhookId: `wh-${i}` }, deps })));
    assert.equal(results.filter((r) => r.outcome === "processed").length, 1, `round ${round}: ${results.map((r) => r.outcome)}`);
    assert.ok(results.every((r) => r.status === 200));
    assert.ok(results.every((r) => ["processed", "duplicate", "in_progress"].includes(r.outcome)));
    assert.equal(spy.calls.length, 1);
    assert.equal((await state(shop, variantGid)).restockCycle, 1);
    assert.equal(await jobCount(shop, variantGid), 4);
    assert.equal((await events(shop)).length, 1);
  }
});

test("an Admin API failure answers 503, marks FAILED, changes nothing, and the retry then succeeds exactly once", async () => {
  const shop = await makeShop("adminfail");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  let healthy = false;
  const shopify = fakeShopify((id) => { if (!healthy) throw new Error("network down"); return node(id, 9); });
  const spy = spyRestock();
  const deps = shopify.deps({ restock: spy.restock });
  const input = { eventId: "ev-retry", payload: payloadFor(itemId), triggeredAt: new Date().toISOString() };

  const failed = await deliver(shop, itemId, { input: { ...input, webhookId: "wh-1" }, deps });
  assert.deepEqual([failed.status, failed.outcome], [503, "failed"]);
  let [event] = await events(shop);
  assert.deepEqual([event.status, event.attempts], ["FAILED", 1]);
  assert.equal(event.processedAt, null, "not marked processed");
  assert.equal(spy.calls.length, 0);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [0, 0]);

  healthy = true; // Shopify's retry
  const retried = await deliver(shop, itemId, { input: { ...input, webhookId: "wh-2" }, deps });
  assert.deepEqual([retried.status, retried.outcome], [200, "processed"]);
  [event] = await events(shop);
  assert.deepEqual([event.status, event.attempts, event.errorCode], ["PROCESSED", 2, null]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 2]);

  const replay = await deliver(shop, itemId, { input: { ...input, webhookId: "wh-3" }, deps });
  assert.equal(replay.outcome, "duplicate");
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
});

test("Shopify answering with a GraphQL error is also a retryable failure, never a success", async () => {
  const shop = await makeShop("gqlerr");
  const { itemId } = await makeTracked(shop);
  const deps = { getAdmin: async () => ({ scope: "", admin: { graphql: async () => ({ json: async () => ({ errors: [{ message: "Throttled" }] }) }) } }) };
  const result = await deliver(shop, itemId, { deps });
  assert.equal(result.status, 503);
  assert.equal((await events(shop))[0].status, "FAILED");
});

test("a stuck RECEIVED event is only retaken after its lease expires; a fresh one is left to its owner", async () => {
  const shop = await makeShop("lease");
  const { itemId, variantGid } = await makeTracked(shop);
  const shopify = fakeShopify((id) => node(id, 3));
  const spy = spyRestock();
  const deps = shopify.deps({ restock: spy.restock });
  const input = { eventId: "ev-lease", payload: payloadFor(itemId), webhookId: "wh-x", triggeredAt: new Date().toISOString() };
  await prisma.webhookEvent.create({
    data: { shopDomain: shop.domain, shopId: shop.id, topic: "INVENTORY_LEVELS_UPDATE", dedupeKey: "ev-lease", webhookId: "wh-x", resourceGid: `gid://shopify/InventoryItem/${itemId}`, status: "RECEIVED", attempts: 1 },
  });

  assert.equal((await deliver(shop, itemId, { input, deps })).outcome, "in_progress", "another delivery is working on it");
  assert.equal(spy.calls.length, 0);

  await prisma.webhookEvent.updateMany({ where: { shopDomain: shop.domain }, data: { receivedAt: new Date(Date.now() - 5 * 60 * 1000) } });
  assert.equal((await deliver(shop, itemId, { input, deps })).outcome, "processed", "an abandoned event is taken over");
  const [event] = await events(shop);
  assert.deepEqual([event.status, event.attempts], ["PROCESSED", 2]);
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
});

test("one location's quantity going up does NOT restock a variant that is still unavailable overall", async () => {
  const shop = await makeShop("onelocation");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  // The webhook says 25 units are available at one location, but Shopify says the variant as a whole is not sellable.
  const shopify = fakeShopify((id) => node(id, 0));
  const result = await deliver(shop, itemId, { input: { payload: payloadFor(itemId, 25) }, deps: shopify.deps() });
  assert.deepEqual([result.status, result.results], [200, ["unchanged"]]);
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle], [false, 0]);
  assert.equal(await jobCount(shop, variantGid), 0);
});

test("the payload quantity is never trusted either way: 'available: 0' at one location still restocks a variant Shopify says is sellable", async () => {
  const shop = await makeShop("zeroloc");
  const { itemId, variantGid } = await makeTracked(shop);
  const shopify = fakeShopify((id) => node(id, 12));
  const result = await deliver(shop, itemId, { input: { payload: payloadFor(itemId, 0) }, deps: shopify.deps() });
  assert.deepEqual(result.results, ["restocked"]);
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
});

test("a variant that sells out again is recorded without raising the cycle", async () => {
  const shop = await makeShop("soldout");
  const { itemId, variantGid } = await makeTracked(shop, { cycle: 3, inStock: true });
  const shopify = fakeShopify((id) => node(id, 0));
  const result = await deliver(shop, itemId, { deps: shopify.deps() });
  assert.deepEqual(result.results, ["out_of_stock"]);
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle], [false, 3]);
});

test("a variant deleted in Shopify is a finished (IGNORED) event, not a retry loop", async () => {
  const shop = await makeShop("deleted");
  const { itemId, variantGid } = await makeTracked(shop);
  const shopify = fakeShopify(() => null);
  const result = await deliver(shop, itemId, { deps: shopify.deps() });
  assert.deepEqual([result.status, result.outcome], [200, "ignored_variant"]);
  const [event] = await events(shop);
  assert.deepEqual([event.status, event.errorCode], ["IGNORED", "variant_not_found"]);
  assert.equal((await state(shop, variantGid)).restockCycle, 0);
});

test("invalid input is acknowledged without work: wrong topic, bad payload fields, bad shop, empty ids, inactive shop", async () => {
  const shop = await makeShop("invalid");
  const { itemId } = await makeTracked(shop);
  const shopify = fakeShopify(() => assert.fail("must not reach Shopify"));
  const deps = shopify.deps();
  const base = { shopDomain: shop.domain, topic: "INVENTORY_LEVELS_UPDATE", webhookId: "wh-i", eventId: "ev-i", triggeredAt: null, payload: payloadFor(itemId) };
  const cases = [
    { topic: "PRODUCTS_UPDATE" },
    { payload: {} },
    { payload: { inventory_item_id: "12abc" } },
    { payload: { inventory_item_id: 0 } },
    { payload: { inventory_item_id: 1.5 } },
    { payload: { inventory_item_id: "1; DROP TABLE" } },
    { payload: null },
    { payload: "text" },
    { shopDomain: "not a shop" },
    { shopDomain: null },
    { webhookId: "", eventId: "" },
    { eventId: "x".repeat(300) },
  ];
  for (const over of cases) {
    const result = await handle({ ...base, ...over }, deps);
    assert.deepEqual([result.status, result.outcome], [200, "ignored_invalid"], JSON.stringify(over).slice(0, 80));
  }
  assert.equal(shopify.log.variants.length, 0);
  assert.deepEqual(await events(shop), []);

  await prisma.shop.update({ where: { id: shop.id }, data: { status: "UNINSTALLED" } });
  assert.equal((await handle(base, deps)).outcome, "ignored_shop");
  assert.deepEqual(await events(shop), []);
});

// ======================= diagnosis of the first real webhook =======================
// The real Admin API node for the dev store's restocked variant (50522368770210) once it held 5 units,
// exactly as Shopify returned it. The mapping must read it as in stock.
const REAL_NODE_IN_STOCK = {
  id: "gid://shopify/ProductVariant/50522368770210",
  inventoryPolicy: "DENY",
  sellableOnlineQuantity: 5,
  inventoryQuantity: 5,
  availableForSale: true,
  product: { id: "gid://shopify/Product/10314221355170" },
  inventoryItem: { id: "gid://shopify/InventoryItem/52642432483490", tracked: true },
};
const adminReturning = (response) => ({ graphql: async () => ({ json: async () => response }) });

test("the real Shopify response shape for a restocked variant maps to in stock, and the answer keeps what Shopify said", async () => {
  const result = await fetchVariantForNotify(adminReturning({ data: { node: REAL_NODE_IN_STOCK } }), REAL_NODE_IN_STOCK.id);
  assert.equal(result.unavailable, false);
  assert.deepEqual(result.seen, { sellableOnlineQuantity: 5, inventoryQuantity: 5, availableForSale: true, inventoryPolicy: "DENY", tracked: true });
  // ...and the same node, sold out, maps to unavailable
  const out = { ...REAL_NODE_IN_STOCK, sellableOnlineQuantity: 0, inventoryQuantity: 0, availableForSale: false };
  assert.equal((await fetchVariantForNotify(adminReturning({ data: { node: out } }), out.id)).unavailable, true);
});

test("Shopify errors or an empty answer are never read as 'sold out' (they fail, so the webhook is retried)", async () => {
  const id = REAL_NODE_IN_STOCK.id;
  for (const response of [
    { errors: [{ message: "Throttled" }] },
    { errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }], data: { node: null } },
    { data: null },
    {},
  ]) {
    await assert.rejects(fetchVariantForNotify(adminReturning(response), id), (e) => e instanceof LookupError && ["shop_unavailable", "variant_not_found"].includes(e.code), JSON.stringify(response).slice(0, 60));
  }
  await assert.rejects(fetchVariantForNotify(adminReturning({ data: { node: null } }), id), (e) => e.code === "variant_not_found");
  await assert.rejects(fetchVariantForNotify(adminReturning({ data: { node: { ...REAL_NODE_IN_STOCK, id: "gid://shopify/ProductVariant/1" } } }), id), (e) => e.code === "variant_not_found", "an answer for a different variant is refused");
});

test("the real in-stock response restocks the real-shaped tracked row (cycle 0 -> 1, one job) and leaves a diagnostic line without secrets", async () => {
  const shop = await makeShop("realshape");
  const { itemId, variantGid, subscriptions } = await makeTracked(shop);
  const traceFile = path.join(os.tmpdir(), "kw-proxy-trace.log");
  const sizeBefore = fs.existsSync(traceFile) ? fs.statSync(traceFile).size : 0;
  const shopify = fakeShopify((id) => ({ ...REAL_NODE_IN_STOCK, id }));

  const result = await deliver(shop, itemId, { deps: shopify.deps() });
  assert.deepEqual(result.results, ["restocked"]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, subscriptions.length]);

  const added = fs.readFileSync(traceFile, "utf8").slice(sizeBefore);
  const line = added.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.stage === "inventory_webhook" && l.variant === variantGid.split("/").pop());
  assert.ok(line, "a diagnostic line was written for this event");
  assert.equal(line.sawUnavailable, false);
  assert.deepEqual(line.seen, { sellableOnlineQuantity: 5, inventoryQuantity: 5, availableForSale: true, inventoryPolicy: "DENY", tracked: true });
  assert.equal(line.outcome, "restocked");
  assert.equal(line.restockCycle, 1);
  assert.ok(Number.isFinite(line.msSinceTrigger) && Number.isFinite(line.readMs));
  assert.equal(/@|token|secret|email|shpat/i.test(JSON.stringify(line)), false, "nothing sensitive in the diagnostic line");
});

test("when Shopify itself still says sold out the line shows exactly that (this is what a stale read looks like in the log)", async () => {
  const shop = await makeShop("stale-read");
  const { itemId, variantGid } = await makeTracked(shop);
  const traceFile = path.join(os.tmpdir(), "kw-proxy-trace.log");
  const sizeBefore = fs.existsSync(traceFile) ? fs.statSync(traceFile).size : 0;
  const shopify = fakeShopify((id) => ({ ...REAL_NODE_IN_STOCK, id, sellableOnlineQuantity: 0, inventoryQuantity: 0, availableForSale: false }));
  const result = await deliver(shop, itemId, { input: { payload: payloadFor(itemId, 5) }, deps: shopify.deps() });
  assert.deepEqual(result.results, ["unchanged"]);
  const line = fs.readFileSync(traceFile, "utf8").slice(sizeBefore).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.stage === "inventory_webhook" && l.variant === variantGid.split("/").pop());
  assert.equal(line.payloadAvailable, 5, "the webhook said 5 at the location");
  assert.equal(line.sawUnavailable, true);
  assert.equal(line.seen.sellableOnlineQuantity, 0, "while the read said 0: the two disagree, visibly");
});

// ======================= first restock: Shopify's sellable quantity lags the webhook =======================
// Real trace (dev store, 1.7 s after the webhook): sellableOnlineQuantity -1 while inventoryQuantity 2 and
// availableForSale true. Reading only the sellable quantity classed that as "still sold out" and the event was
// recorded as processed with no job; only a second edit restocked. These tests pin the repaired behaviour.
const noWait = async () => {};
const LAGGING = (id) => ({ ...REAL_NODE_IN_STOCK, id, sellableOnlineQuantity: -1, inventoryQuantity: 2, availableForSale: true });
const SETTLED = (id, qty = 2) => ({ ...REAL_NODE_IN_STOCK, id, sellableOnlineQuantity: qty, inventoryQuantity: qty, availableForSale: qty > 0 });

test("FIRST restock with a lagging read: re-reads, restocks once, and queues one job per customer", async () => {
  const shop = await makeShop("lag-first");
  const { itemId, variantGid, subscriptions } = await makeTracked(shop, { subs: 2 });
  let reads = 0;
  const shopify = fakeShopify((id) => (++reads < 2 ? LAGGING(id) : SETTLED(id)));
  const result = await deliver(shop, itemId, { deps: shopify.deps({ sleep: noWait }) });
  assert.deepEqual([result.status, result.outcome, result.results], [200, "processed", ["restocked"]]);
  assert.equal(reads, 2, "the unsettled read was repeated");
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle], [true, 1]);
  const jobs = await prisma.emailDelivery.findMany({ where: { shopId: shop.id, variantGid } });
  assert.deepEqual(jobs.map((j) => j.status), ["PENDING", "PENDING"]);
  assert.deepEqual(jobs.map((j) => j.subscriptionId).sort(), subscriptions.map((s) => s.id).sort(), "each customer has their own job");
  assert.ok(jobs.every((j) => j.restockCycle === 1));
});

test("a read that stays inconsistent is a retryable failure (503, FAILED, nothing changed); the retry then restocks once", async () => {
  const shop = await makeShop("lag-retry");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 1 });
  let settled = false;
  const shopify = fakeShopify((id) => (settled ? SETTLED(id) : LAGGING(id)));
  const input = { eventId: "ev-lag", payload: payloadFor(itemId), triggeredAt: new Date().toISOString() };
  const deps = shopify.deps({ sleep: noWait });

  const first = await deliver(shop, itemId, { input: { ...input, webhookId: "w1" }, deps });
  assert.deepEqual([first.status, first.outcome], [503, "failed"]);
  const [event] = await events(shop);
  assert.deepEqual([event.status, event.errorCode], ["FAILED", "inventory_not_settled"]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [0, 0]);

  settled = true;
  const retry = await deliver(shop, itemId, { input: { ...input, webhookId: "w2" }, deps });
  assert.deepEqual([retry.status, retry.outcome], [200, "processed"]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 1]);
  assert.equal((await deliver(shop, itemId, { input: { ...input, webhookId: "w3" }, deps })).outcome, "duplicate");
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
});

test("an event that stays unresolved is retried a bounded number of times, then flagged: it never guesses a state and never loops", async () => {
  const shop = await makeShop("lag-permanent");
  const { itemId, variantGid } = await makeTracked(shop);
  const { MAX_EVENT_ATTEMPTS, UNRESOLVED_CODE, recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  await prisma.webhookEvent.create({
    data: { shopDomain: shop.domain, shopId: shop.id, topic: "INVENTORY_LEVELS_UPDATE", dedupeKey: "ev-perm", webhookId: "w", resourceGid: `gid://shopify/InventoryItem/${itemId}`, status: "FAILED", attempts: MAX_EVENT_ATTEMPTS - 1, errorCode: "inventory_not_settled", receivedAt: new Date(Date.now() - 3600 * 1000) },
  });
  // stock only at a non-online location: sellable 0 but availableForSale true. Never "in stock", never "sold out".
  const shopify = fakeShopify((id) => ({ ...REAL_NODE_IN_STOCK, id, sellableOnlineQuantity: 0, inventoryQuantity: 4, availableForSale: true }));
  const result = await deliver(shop, itemId, { input: { eventId: "ev-perm" }, deps: shopify.deps({ sleep: noWait }) });
  assert.deepEqual([result.status, result.outcome], [200, "unresolved"], "200 stops Shopify's redeliveries (the webhook is not at risk of removal)");
  const [event] = await events(shop);
  assert.deepEqual([event.status, event.errorCode, event.attempts], ["FAILED", UNRESOLVED_CODE, MAX_EVENT_ATTEMPTS]);
  const row = await state(shop, variantGid);
  assert.deepEqual([row.restockCycle, row.isInStock, await jobCount(shop, variantGid)], [0, false, 0]);

  const reads = shopify.log.variants.length;
  assert.deepEqual(await recoverInventoryEvents({ shopDomains: [shop.domain], deps: shopify.deps({ sleep: noWait }) }), { found: 0, processed: 0, ignored: 0, skipped: 0, failed: 0 });
  assert.equal(shopify.log.variants.length, reads, "a flagged event is not replayed");
});

test("recovery: a failed event is replayed from the stored event, restocks once, and cannot be replayed twice", async () => {
  const shop = await makeShop("recover");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  let healthy = false;
  const shopify = fakeShopify((id) => { if (!healthy) throw new Error("network down"); return SETTLED(id, 5); });
  const deps = shopify.deps({ sleep: noWait });
  const first = await deliver(shop, itemId, { input: { eventId: "ev-rec" }, deps });
  assert.equal(first.status, 503);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [0, 0]);

  // too fresh: Shopify's own redelivery gets the first chance
  assert.equal((await recoverInventoryEvents({ shopDomains: [shop.domain], deps })).found, 0);

  healthy = true;
  const later = () => new Date(Date.now() + 10 * 60 * 1000);
  const summary = await recoverInventoryEvents({ shopDomains: [shop.domain], deps, now: later });
  assert.deepEqual(summary, { found: 1, processed: 1, ignored: 0, skipped: 0, failed: 0 });
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 2]);
  assert.equal((await events(shop))[0].status, "PROCESSED");
  assert.deepEqual(await recoverInventoryEvents({ shopDomains: [shop.domain], deps, now: later }), { found: 0, processed: 0, ignored: 0, skipped: 0, failed: 0 });
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
});

test("a database failure while queueing jobs rolls the whole restock back: no half-applied state", async () => {
  const shop = await makeShop("txfail");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  const realTransaction = appPrisma.$transaction.bind(appPrisma);
  appPrisma.$transaction = (fn, options) =>
    realTransaction((tx) => fn(new Proxy(tx, { get: (target, key) => (key === "emailDelivery" ? { createMany: async () => { throw new Error("db down"); } } : target[key]) })), options);
  let result;
  try {
    result = await deliver(shop, itemId, { deps: fakeShopify((id) => SETTLED(id)).deps({ sleep: noWait }) });
  } finally {
    appPrisma.$transaction = realTransaction;
  }
  assert.deepEqual([result.status, result.outcome], [503, "failed"]);
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle, await jobCount(shop, variantGid)], [false, 0, 0], "availability was not updated without its jobs");
  const [event] = await events(shop);
  assert.equal(event.status, "FAILED");
  // the retry then succeeds completely
  const retry = await deliver(shop, itemId, { input: { eventId: event.dedupeKey }, deps: fakeShopify((id) => SETTLED(id)).deps({ sleep: noWait }) });
  assert.equal(retry.outcome, "processed");
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 2]);
});

test("out-of-order observations: an older read applied late cannot undo a newer state", async () => {
  const shop = await makeShop("ooo");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 1 });
  const t0 = Date.now();
  const at = (ms) => ({ now: () => new Date(t0 + ms) });
  // the newer observation (in stock) is applied first, then an older one (sold out) arrives late
  assert.deepEqual((await deliver(shop, itemId, { deps: fakeShopify((id) => SETTLED(id, 5)).deps({ sleep: noWait, ...at(2000) }) })).results, ["restocked"]);
  assert.deepEqual((await deliver(shop, itemId, { deps: fakeShopify((id) => SETTLED(id, 0)).deps({ sleep: noWait, ...at(1000) }) })).results, ["stale"]);
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle, await jobCount(shop, variantGid)], [true, 1, 1]);
});

test("the availability classifier: lagging fields are unsettled, genuine states are never mistaken", async () => {
  const { classifyAvailability: c } = await import("../app/utils/inventory.server.js");
  const v = (over) => ({ inventoryPolicy: "DENY", inventoryItem: { tracked: true }, ...over });
  assert.equal(c(v({ sellableOnlineQuantity: 3, availableForSale: true })), "available");
  assert.equal(c(v({ sellableOnlineQuantity: 0, availableForSale: false })), "unavailable");
  assert.equal(c(v({ sellableOnlineQuantity: -1, availableForSale: false })), "unavailable");
  assert.equal(c(v({ sellableOnlineQuantity: -1, availableForSale: true })), "unsettled", "negative is not clamped into evidence");
  assert.equal(c(v({ sellableOnlineQuantity: 6, availableForSale: false })), "unsettled", "stale-high is not 'in stock'");
  assert.equal(c(v({ sellableOnlineQuantity: 0, availableForSale: true })), "unsettled", "stock elsewhere is neither 'sold out' nor 'in stock'");
  assert.equal(c(v({ inventoryPolicy: "CONTINUE", sellableOnlineQuantity: 0, availableForSale: true })), "available");
  assert.equal(c(v({ inventoryItem: { tracked: false }, sellableOnlineQuantity: 0, availableForSale: true })), "available");
  assert.equal(c(v({ sellableOnlineQuantity: 4 })), "available", "no verdict reported: the quantity decides");
  assert.equal(c(v({ sellableOnlineQuantity: 0 })), "unavailable");
});

test("the exact inventory item id selects the intended variant and shop only", async () => {
  const shopA = await makeShop("map-a");
  const shopB = await makeShop("map-b");
  const a = await makeTracked(shopA, { subs: 1 });
  const b = await makeTracked(shopB, { subs: 1 });
  const other = await makeTracked(shopA, { subs: 1 });
  const shopify = fakeShopify((id) => SETTLED(id, 5));
  const result = await deliver(shopA, a.itemId, { deps: shopify.deps({ sleep: noWait }) });
  assert.deepEqual(result.results, ["restocked"]);
  assert.deepEqual(shopify.log.variants, [a.variantGid], "only the variant behind this inventory item was read");
  assert.equal((await state(shopA, a.variantGid)).restockCycle, 1);
  assert.equal((await state(shopA, other.variantGid)).restockCycle, 0, "a sibling variant of the same shop is untouched");
  assert.equal((await state(shopB, b.variantGid)).restockCycle, 0, "another shop is untouched");
  // the same item id reported for the other shop's domain does not match shop A's variant
  assert.equal((await deliver(shopB, a.itemId, { deps: fakeShopify(() => assert.fail("no read")).deps() })).outcome, "untracked");
});

test("lifecycle: repeated in-stock updates add nothing; a later out -> in change is exactly one new cycle", async () => {
  const shop = await makeShop("lifecycle");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  const send = (qty) => deliver(shop, itemId, { deps: fakeShopify((id) => SETTLED(id, qty)).deps({ sleep: noWait }) });

  assert.deepEqual((await send(5)).results, ["restocked"]);
  for (const qty of [6, 7, 3]) assert.deepEqual((await send(qty)).results, ["unchanged"]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 2]);

  assert.deepEqual((await send(0)).results, ["out_of_stock"]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 2], "going out of stock queues nothing");
  assert.deepEqual((await send(4)).results, ["restocked"]);
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle, await jobCount(shop, variantGid)], [true, 2, 4]);
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id, restockCycle: 2, status: "PENDING" } }), 2);
});

test("an event for an inventory item the app does not track changes nothing and never asks Shopify", async () => {
  const shop = await makeShop("wrong-item");
  const { variantGid } = await makeTracked(shop);
  const shopify = fakeShopify(() => assert.fail("must not be called"));
  const result = await deliver(shop, "424242424242", { deps: shopify.deps() });
  assert.equal(result.outcome, "untracked");
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [0, 0]);
});

test("the worker sends the jobs created by a first restock, once each, through the existing safeguards", async () => {
  const shop = await makeShop("worker-first");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  const result = await deliver(shop, itemId, { deps: fakeShopify((id) => SETTLED(id)).deps({ sleep: noWait }) });
  assert.equal(result.outcome, "processed");

  const { claimNext, processJob } = await import("../app/models/email-delivery.server.js");
  const sent = [];
  const transport = { sendMail: async (mail) => { sent.push(mail); return { accepted: [mail.to], rejected: [], messageId: mail.messageId }; } };
  const productNode = (id) => ({ id, title: "Large", product: { title: "Test Board", handle: "test-board", onlineStoreUrl: "https://shop.example.invalid/products/test-board", status: "ACTIVE" } });
  const ctx = {
    transport,
    config: { mailFrom: "sender@example.invalid", baseUrl: "https://app.example.invalid" },
    getAdmin: async () => ({ scope: "", admin: { graphql: async (q, { variables }) => ({ json: async () => ({ data: { node: productNode(variables.id) } }) }) } }),
  };
  const outcomes = [];
  for (let job = await claimNext({ shopIds: [shop.id] }); job; job = await claimNext({ shopIds: [shop.id] })) outcomes.push(await processJob(job, ctx));
  assert.deepEqual(outcomes, ["SENT", "SENT"]);
  assert.equal(sent.length, 2);
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id, variantGid, status: "SENT" } }), 2);
  assert.equal(await claimNext({ shopIds: [shop.id] }), null, "nothing left to send");
});

test("one worker run recovers a failed inventory event first, then sends the jobs it created (fake Shopify and SMTP only)", async () => {
  const shop = await makeShop("worker-recover");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  const { createWorker } = await import("../app/worker/worker.server.js");
  let healthy = false;
  const shopify = fakeShopify((id) => { if (!healthy) throw new Error("network down"); return SETTLED(id, 5); });
  assert.equal((await deliver(shop, itemId, { deps: shopify.deps({ sleep: noWait }) })).status, 503);
  assert.equal(await jobCount(shop, variantGid), 0, "no job exists before recovery");

  healthy = true;
  const sent = [];
  const product = (id) => ({ id, title: "Large", product: { title: "Test Board", handle: "test-board", onlineStoreUrl: "https://shop.example.invalid/products/test-board", status: "ACTIVE" } });
  const worker = createWorker({
    shopIds: [shop.id],
    log: { log() {}, error() {} },
    recover: () => recoverInventoryEvents({ shopDomains: [shop.domain], deps: shopify.deps({ sleep: noWait }), now: () => new Date(Date.now() + 600000) }),
    ctx: {
      transport: { sendMail: async (mail) => { sent.push(mail); return { accepted: [mail.to], rejected: [], messageId: mail.messageId }; } },
      config: { mailFrom: "sender@example.invalid", baseUrl: "https://app.example.invalid" },
      getAdmin: async () => ({ scope: "", admin: { graphql: async (q, { variables }) => ({ json: async () => ({ data: { node: product(variables.id) } }) }) } }),
    },
  });
  const { handled, outcomes } = await worker.drain();
  assert.deepEqual([handled, outcomes.SENT], [2, 2]);
  assert.equal(sent.length, 2);
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
});

// ======================= stock held only at a third-party fulfillment location (the 3p Fulfilled Snowboard) =======================
// Admin reports 18 sellable and "available for sale" for variant 50522368999586, the storefront shows it sold out.
// Admin's word alone must never turn a subscription into a restock email.
const FS_VARIANT = "50522368999586";
const FS_GID = `gid://shopify/ProductVariant/${FS_VARIANT}`;
const fsNode = (id) => ({ ...SETTLED(id, 18), product: { id: "gid://shopify/Product/7400000001", handle: "the-3p-fulfilled-snowboard" } });
const thirdPartyOnly = async () => ({ thirdPartyOnly: true });
const storefront = (answer) => {
  const asked = [];
  return {
    asked,
    deps: (extra = {}) => ({
      sleep: noWait,
      purchasable: async (input) => (await import("../app/models/shopify-lookup.server.js")).resolveStorefrontPurchasable(input, { stockTopology: thirdPartyOnly, storefrontCheck: async (...args) => { asked.push(args); return typeof answer === "function" ? answer() : answer; } }),
      ...extra,
    }),
  };
};
async function makeFsShop(tag, { subs = 1 } = {}) {
  const shop = await makeShop(tag);
  const tracked = await makeTracked(shop, { subs });
  return { shop, ...tracked };
}

test("3p variant, storefront unreadable: repeated inventory webhooks never restock, never queue a job, and never loop", async () => {
  const { shop, itemId, variantGid } = await makeFsShop("fs-unread");
  const shopify = fakeShopify(fsNode);
  const probe = storefront(null);
  for (let i = 0; i < 4; i += 1) {
    const result = await deliver(shop, itemId, { deps: shopify.deps(probe.deps()) });
    assert.deepEqual([result.status, result.outcome, result.results], [200, "processed", ["storefront_unconfirmed"]]);
  }
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle, await jobCount(shop, variantGid)], [false, 0, 0], "still waiting; no cycle, no email job");
  assert.deepEqual((await events(shop)).map((e) => e.status), ["PROCESSED", "PROCESSED", "PROCESSED", "PROCESSED"], "each event is finished, not retried");
  assert.equal(probe.asked.length, 4);
  assert.deepEqual(probe.asked[0], [shop.domain, "the-3p-fulfilled-snowboard", variantGid.split("/").pop()], "the storefront was asked about this exact variant");
});

test("3p variant, storefront readable and in stock: a genuine restock happens once, duplicates and later edits add nothing", async () => {
  const { shop, itemId, variantGid, subscriptions } = await makeFsShop("fs-live", { subs: 2 });
  const shopify = fakeShopify(fsNode);
  const probe = storefront(true);
  const input = { eventId: "ev-fs-1", payload: payloadFor(itemId), triggeredAt: new Date().toISOString() };
  const first = await deliver(shop, itemId, { input: { ...input, webhookId: "w1" }, deps: shopify.deps(probe.deps()) });
  assert.deepEqual(first.results, ["restocked"]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, subscriptions.length], "one job per customer");
  assert.equal((await deliver(shop, itemId, { input: { ...input, webhookId: "w2" }, deps: shopify.deps(probe.deps()) })).outcome, "duplicate", "the same delivery again");
  for (let i = 0; i < 3; i += 1) assert.deepEqual((await deliver(shop, itemId, { deps: shopify.deps(probe.deps()) })).results, ["unchanged"], "later edits while in stock");
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, subscriptions.length]);
});

test("3p variant, storefront readable and sold out: Admin's 'available' changes nothing", async () => {
  const { shop, itemId, variantGid } = await makeFsShop("fs-soldout");
  const result = await deliver(shop, itemId, { deps: fakeShopify(fsNode).deps(storefront(false).deps()) });
  assert.deepEqual(result.results, ["unchanged"]);
  assert.deepEqual([(await state(shop, variantGid)).isInStock, (await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [false, 0, 0]);
});

test("a variant whose stock is at an ordinary location is still restocked on Admin's word, and the storefront is not consulted", async () => {
  const { shop, itemId, variantGid } = await makeFsShop("fs-ordinary");
  const probe = storefront(false);
  const deps = probe.deps({ purchasable: async (input) => (await import("../app/models/shopify-lookup.server.js")).resolveStorefrontPurchasable(input, { stockTopology: async () => ({ thirdPartyOnly: false }), storefrontCheck: async () => { probe.asked.push("asked"); return false; } }) });
  assert.deepEqual((await deliver(shop, itemId, { deps: fakeShopify(fsNode).deps(deps) })).results, ["restocked"]);
  assert.equal(probe.asked.length, 0);
  assert.equal((await state(shop, variantGid)).restockCycle, 1);
});

test("end to end: subscribing with the browser's claim and then receiving inventory webhooks cannot produce a false restock email", async () => {
  const shop = await makeShop("fs-e2e");
  const { subscribeToNotify } = await import("../app/models/notify.server.js");
  const { resolveStorefrontPurchasable } = await import("../app/models/shopify-lookup.server.js");
  const variantNode = (id) => ({ ...fsNode(id), inventoryItem: { id: "gid://shopify/InventoryItem/9400000777", tracked: true } });
  const customer = { id: "gid://shopify/Customer/9400000555", defaultEmailAddress: { emailAddress: "buyer@example.invalid" } };
  const admin = { async graphql(query, { variables } = {}) { return { json: async () => ({ data: query.includes("NotifyVariant") ? { node: variantNode(variables.id) } : query.includes("StockTopology") ? {} : { customer } }) }; } };
  const unreadable = { stockTopology: thirdPartyOnly, storefrontCheck: async () => null };

  const result = await subscribeToNotify({ shopDomain: shop.domain, customerGid: customer.id }, FS_GID, { getAdmin: async () => ({ admin, scope: "read_customers" }), sleep: noWait, storefrontSoldOut: true, purchasable: (input) => resolveStorefrontPurchasable(input, unreadable) });
  assert.deepEqual(result, { subscribed: true, changed: true });
  const row = await state(shop, FS_GID);
  assert.deepEqual([row.isInStock, row.restockCycle, row.inventoryItemGid], [false, 0, "gid://shopify/InventoryItem/9400000777"]);
  const sub = await prisma.notifySubscription.findFirst({ where: { shopId: shop.id, variantGid: FS_GID } });
  assert.equal(sub.status, "ACTIVE");

  // the very next inventory webhooks for that item (what used to send the false email)
  const shopify = fakeShopify(variantNode);
  const deps = shopify.deps({ sleep: noWait, purchasable: (input) => resolveStorefrontPurchasable(input, unreadable) });
  for (let i = 0; i < 3; i += 1) assert.deepEqual((await deliver(shop, "9400000777", { deps })).results, ["storefront_unconfirmed"]);
  assert.deepEqual([(await state(shop, FS_GID)).isInStock, (await state(shop, FS_GID)).restockCycle, await jobCount(shop, FS_GID)], [false, 0, 0]);
  assert.equal((await prisma.notifySubscription.findUnique({ where: { id: sub.id } })).status, "ACTIVE", "still waiting, not fulfilled");
});

test("duplicate email prevention: after the one genuine restock the worker sends once, and later edits and a second worker run send nothing more", async () => {
  const { shop, itemId, variantGid } = await makeFsShop("fs-mail", { subs: 2 });
  const shopify = fakeShopify(fsNode);
  const probe = storefront(true);
  await deliver(shop, itemId, { deps: shopify.deps(probe.deps()) });
  const { createWorker } = await import("../app/worker/worker.server.js");
  const sent = [];
  const product = (id) => ({ id, title: "Large", product: { title: "3p Board", handle: "the-3p-fulfilled-snowboard", onlineStoreUrl: "https://shop.example.invalid/products/the-3p-fulfilled-snowboard", status: "ACTIVE" } });
  const worker = () => createWorker({
    shopIds: [shop.id], log: { log() {}, error() {} },
    ctx: {
      transport: { sendMail: async (mail) => { sent.push(mail); return { accepted: [mail.to], rejected: [], messageId: mail.messageId }; } },
      config: { mailFrom: "sender@example.invalid", baseUrl: "https://app.example.invalid" },
      getAdmin: async () => ({ scope: "", admin: { graphql: async (q, { variables }) => ({ json: async () => ({ data: { node: product(variables.id) } }) }) } }),
    },
  });
  assert.equal((await worker().drain()).outcomes.SENT, 2);
  for (let i = 0; i < 3; i += 1) await deliver(shop, itemId, { deps: shopify.deps(probe.deps()) }); // more inventory edits while in stock
  assert.equal(Object.keys((await worker().drain()).outcomes).length, 0, "nothing left to send");
  assert.equal(sent.length, 2, "one email per customer, ever");
  assert.equal(await jobCount(shop, variantGid), 2);
});

// ======================= recovery: stored-event validation and honest summary =======================
const seedEvent = (shop, over) =>
  prisma.webhookEvent.create({
    data: { shopDomain: shop.domain, shopId: shop.id, topic: "INVENTORY_LEVELS_UPDATE", dedupeKey: `ev-${(seq += 1)}`, webhookId: "w", status: "RECEIVED", attempts: 0, receivedAt: new Date(Date.now() - 3600 * 1000), ...over },
  });
const quiet = () => { const orig = console.warn; console.warn = () => {}; return () => { console.warn = orig; }; };

test("recovery: events with a missing, malformed or non-numeric resourceGid are ignored with a code, never replayed, never counted as processed", async () => {
  const shop = await makeShop("rec-invalid");
  const { variantGid } = await makeTracked(shop);
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  const bad = [null, "k", "gid://shopify/Product/123", "gid://shopify/InventoryItem/abc", "gid://shopify/InventoryItem/0", "gid://shopify/InventoryItem/12/34", "gid://shopify/InventoryItem/"];
  for (const resourceGid of bad) await seedEvent(shop, { resourceGid });
  const shopify = fakeShopify((id) => SETTLED(id, 5));
  const restore = quiet();
  let summary;
  try {
    summary = await recoverInventoryEvents({ shopDomains: [shop.domain], deps: shopify.deps({ sleep: noWait }) });
  } finally {
    restore();
  }
  assert.deepEqual(summary, { found: bad.length, processed: 0, ignored: bad.length, skipped: 0, failed: 0 });
  assert.equal(shopify.log.variants.length, 0, "Shopify is not asked about a malformed record");
  for (const e of await events(shop)) assert.deepEqual([e.status, e.errorCode, e.processedAt instanceof Date], ["IGNORED", "invalid_resource", true]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [0, 0]);
  // retired rows are not selected again
  assert.deepEqual(await recoverInventoryEvents({ shopDomains: [shop.domain], deps: shopify.deps({ sleep: noWait }) }), { found: 0, processed: 0, ignored: 0, skipped: 0, failed: 0 });
});

test("recovery: a valid stored item is rebuilt and handled, counted as processed, and creates the jobs exactly once", async () => {
  const shop = await makeShop("rec-valid");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 2 });
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  await seedEvent(shop, { resourceGid: `gid://shopify/InventoryItem/${itemId}`, status: "FAILED", attempts: 1, errorCode: "network" });
  const deps = fakeShopify((id) => SETTLED(id, 5)).deps({ sleep: noWait });
  assert.deepEqual(await recoverInventoryEvents({ shopDomains: [shop.domain], deps }), { found: 1, processed: 1, ignored: 0, skipped: 0, failed: 0 });
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 2]);
  await recoverInventoryEvents({ shopDomains: [shop.domain], deps });
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 2], "no duplicate cycle or email job");
});

test("recovery: a retriable failure is counted as failed and the event stays eligible", async () => {
  const shop = await makeShop("rec-fail");
  const { itemId } = await makeTracked(shop);
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  const row = await seedEvent(shop, { resourceGid: `gid://shopify/InventoryItem/${itemId}`, status: "FAILED", attempts: 1, errorCode: "network" });
  const deps = fakeShopify(() => { throw new Error("network down"); }).deps({ sleep: noWait });
  const restore = console.error; console.error = () => {};
  let summary;
  try { summary = await recoverInventoryEvents({ shopDomains: [shop.domain], deps }); } finally { console.error = restore; }
  assert.deepEqual(summary, { found: 1, processed: 0, ignored: 0, skipped: 0, failed: 1 });
  const after = await prisma.webhookEvent.findUnique({ where: { id: row.id } });
  assert.deepEqual([after.status, after.attempts], ["FAILED", 2]);
});

test("recovery: an untracked item is closed as IGNORED (not counted as processed) so it is not retried forever", async () => {
  const shop = await makeShop("rec-untracked");
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  const row = await seedEvent(shop, { resourceGid: "gid://shopify/InventoryItem/777000111" });
  const deps = fakeShopify((id) => SETTLED(id, 5)).deps({ sleep: noWait });
  assert.deepEqual(await recoverInventoryEvents({ shopDomains: [shop.domain], deps }), { found: 1, processed: 0, ignored: 1, skipped: 0, failed: 0 });
  const after = await prisma.webhookEvent.findUnique({ where: { id: row.id } });
  assert.deepEqual([after.status, after.errorCode], ["IGNORED", "untracked"]);
});

test("recovery: closing a row is conditional: a row claimed or finished meanwhile is left alone", async () => {
  const shop = await makeShop("rec-race");
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  const row = await seedEvent(shop, { resourceGid: null });
  // another process claims the row between the recovery's read and its update
  const realFindMany = appPrisma.webhookEvent.findMany.bind(appPrisma.webhookEvent);
  appPrisma.webhookEvent.findMany = async (args) => {
    const found = await realFindMany(args);
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "PROCESSED", attempts: 1, processedAt: new Date() } });
    return found;
  };
  const restore = quiet();
  let summary;
  try {
    summary = await recoverInventoryEvents({ shopDomains: [shop.domain], deps: fakeShopify((id) => SETTLED(id)).deps({ sleep: noWait }) });
  } finally {
    appPrisma.webhookEvent.findMany = realFindMany;
    restore();
  }
  assert.deepEqual(summary, { found: 1, processed: 0, ignored: 0, skipped: 1, failed: 0 });
  const after = await prisma.webhookEvent.findUnique({ where: { id: row.id } });
  assert.deepEqual([after.status, after.errorCode], ["PROCESSED", null], "the other process's result is not overwritten");
});

test("recovery: a stored ignored_invalid result is never counted as processed", async () => {
  const shop = { id: null, domain: `not-a-shop-${RUN}` }; // unusable shop domain: the handler answers 200 ignored_invalid
  domains.push(shop.domain);
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  await seedEvent(shop, { resourceGid: "gid://shopify/InventoryItem/42" });
  const restore = quiet();
  let summary;
  try { summary = await recoverInventoryEvents({ shopDomains: [shop.domain], deps: fakeShopify((id) => SETTLED(id)).deps({ sleep: noWait }) }); } finally { restore(); }
  assert.deepEqual([summary.processed, summary.ignored], [0, 1]);
});

// ======================= Admin GraphQL accounting in the "[restock] inventory event" log =======================
// Measurement only: every admin.graphql request of ONE event is counted and timed, retries and repeated reads
// included. A fake clock that advances 5 ms per reading makes a request that runs alone last exactly 5 ms; the two
// stock-topology requests are issued together, so their readings interleave (start, start, end, end) and each lasts 10 ms.
const steppingClock = () => { let t = 0; return () => (t += 5); };
const eventLines = (spy) => spy.mock.calls.filter((c) => c.arguments[0] === "[restock] inventory event" || c.arguments[0] === "[restock] inventory event failed").map((c) => ({ label: c.arguments[0], ...JSON.parse(c.arguments[1]) }));

test("graphql accounting: a lagging read is re-read and every request is counted and timed on the event's log line", async () => {
  const shop = await makeShop("gql-count");
  const { itemId, variantGid } = await makeTracked(shop);
  let reads = 0;
  const shopify = fakeShopify((id) => (++reads < 2 ? LAGGING(id) : SETTLED(id)));
  const log = mock.method(console, "log", () => {});
  try {
    const result = await deliver(shop, itemId, { input: { eventId: "ev-gql-count" }, deps: shopify.deps({ sleep: noWait, clock: steppingClock() }) });
    assert.equal(result.outcome, "processed");
    const [line] = eventLines(log).filter((l) => l.event === "ev-gql-count");
    // two availability reads (the second is the repeated read) + the two stock-topology requests; sleeps and database work are not counted
    assert.deepEqual(line.graphqlCalls.map((c) => c.kind), ["NotifyVariant", "NotifyVariant", "StockTopologyLevels", "StockTopologyServices"]);
    assert.equal(line.graphqlCount, 4);
    assert.deepEqual(line.graphqlCalls.map((c) => c.ms), [5, 5, 10, 10]);
    assert.equal(line.graphqlMs, 30, "the total is the sum of the individual waits");
    assert.equal(/token|secret|@|shpat/i.test(JSON.stringify(line)), false);
  } finally { log.mock.restore(); }
  assert.equal((await state(shop, variantGid)).restockCycle, 1, "behaviour is unchanged");
});

test("graphql accounting: a request that throws is still counted and timed, on the failure line", async () => {
  const shop = await makeShop("gql-fail");
  const { itemId } = await makeTracked(shop);
  const shopify = fakeShopify(() => { throw new Error("Throttled"); });
  const errors = mock.method(console, "error", () => {});
  try {
    const result = await deliver(shop, itemId, { input: { eventId: "ev-gql-fail" }, deps: shopify.deps({ sleep: noWait, clock: steppingClock() }) });
    assert.deepEqual([result.status, result.outcome], [503, "failed"]);
    const [line] = eventLines(errors).filter((l) => l.event === "ev-gql-fail");
    assert.equal(line.label, "[restock] inventory event failed");
    assert.deepEqual([line.graphqlCount, line.graphqlMs, line.graphqlCalls.map((c) => c.kind)], [1, 5, ["NotifyVariant"]]);
  } finally { errors.mock.restore(); }
});

test("graphql accounting: an event with several tracked variants reports all of its requests", async () => {
  const shop = await makeShop("gql-multi");
  const first = await makeTracked(shop);
  const second = await makeTracked(shop);
  // both variants hang off the same inventory item
  await prisma.variantAvailability.update({ where: { shopId_variantGid: { shopId: shop.id, variantGid: second.variantGid } }, data: { inventoryItemGid: `gid://shopify/InventoryItem/${first.itemId}` } });
  const shopify = fakeShopify((id) => SETTLED(id));
  const log = mock.method(console, "log", () => {});
  try {
    await deliver(shop, first.itemId, { input: { eventId: "ev-gql-multi" }, deps: shopify.deps({ sleep: noWait, clock: steppingClock() }) });
    const lines = eventLines(log).filter((l) => l.event === "ev-gql-multi");
    assert.deepEqual(lines.map((l) => l.graphqlCount), [3, 6], "cumulative for the event: the last line is the total");
    assert.deepEqual(lines.map((l) => l.graphqlMs), [25, 50]);
  } finally { log.mock.restore(); }
});

test("graphql accounting: concurrent events keep independent counters", async () => {
  const shopA = await makeShop("gql-conc-a");
  const shopB = await makeShop("gql-conc-b");
  const a = await makeTracked(shopA);
  const b = await makeTracked(shopB);
  let readsA = 0;
  const lagging = fakeShopify((id) => (++readsA < 3 ? LAGGING(id) : SETTLED(id))); // event A: 3 availability reads + 2 topology
  const plain = fakeShopify((id) => SETTLED(id)); // event B: 1 availability read + 2 topology
  const log = mock.method(console, "log", () => {});
  try {
    await Promise.all([
      deliver(shopA, a.itemId, { input: { eventId: "ev-conc-a" }, deps: lagging.deps({ sleep: async () => { await new Promise((r) => setTimeout(r, 5)); }, clock: steppingClock() }) }),
      deliver(shopB, b.itemId, { input: { eventId: "ev-conc-b" }, deps: plain.deps({ sleep: noWait, clock: steppingClock() }) }),
    ]);
    const lines = eventLines(log);
    const lineA = lines.find((l) => l.event === "ev-conc-a");
    const lineB = lines.find((l) => l.event === "ev-conc-b");
    assert.deepEqual([lineA.graphqlCount, lineA.graphqlMs], [5, 35]);
    assert.deepEqual([lineB.graphqlCount, lineB.graphqlMs], [3, 25]);
  } finally { log.mock.restore(); }
});

// ======================= Shopify throttling =======================
// The installed @shopify/shopify-api never retries (the app passes no `tries`) and throws HTTP 429 as an
// HttpThrottlingError (Retry-After in seconds) and a GraphQL THROTTLED answer as a GraphqlQueryError. These tests use
// the library's own error classes, so they pin the real shapes. A throttle is still a plain retryable failure for
// Shopify (503) and keeps the code "shop_unavailable" for callers; it only adds `throttled` / `retryAfterMs`.
const http429 = (retryAfter) => new HttpThrottlingError({ message: "Shopify is throttling requests", code: 429, statusText: "Too Many Requests", body: {}, headers: {}, retryAfter });
const gqlThrottled = () => new GraphqlQueryError({ message: "Throttled", response: { status: 200 }, headers: {}, body: { errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } } });
const gqlOther = () => new GraphqlQueryError({ message: "Something else", response: { status: 200 }, headers: {}, body: { errors: { graphQLErrors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] } } });
const httpFailure = (code) => new HttpResponseError({ message: `status ${code}`, code, statusText: "x", body: {}, headers: {} });
const httpServerError = () => new HttpInternalError({ message: "boom", code: 500, statusText: "x", body: {}, headers: {} });
const queryName = (query) => /query (\w+)/.exec(query)?.[1];
// An Admin whose answers are chosen per query name; `calls` lists every request in order.
function scriptedAdmin(handler) {
  const calls = [];
  return {
    calls,
    deps: (extra = {}) => ({
      getAdmin: async () => ({ scope: "", admin: { async graphql(query, options) { calls.push(queryName(query)); return handler(queryName(query), options?.variables, calls.length); } } }),
      sleep: noWait,
      ...extra,
    }),
  };
}
const answerNode = (nodeFor) => (variables) => ({ json: async () => ({ data: { node: nodeFor(variables.id) } }) });
const lookupAdmin = (error) => ({ async graphql() { throw error; } });
const silenceErrors = () => mock.method(console, "error", () => {});

test("throttling is told apart from other failures, and every failure keeps the same code and status", async () => {
  const { fetchProductForEmail, fetchVariantForNotify: fetchVariant } = await import("../app/models/shopify-lookup.server.js");
  const caught = async (error) => { try { await fetchProductForEmail(lookupAdmin(error), "gid://shopify/ProductVariant/1"); } catch (e) { return e; } return assert.fail("expected a failure"); };
  const throttled = [[http429(2), 2000], [http429(0.5), 500], [http429(undefined), null], [http429(99999), 5 * 60 * 1000], [gqlThrottled(), null]];
  for (const [error, wait] of throttled) {
    const e = await caught(error);
    assert.deepEqual([e instanceof LookupError, e.code, e.status, e.throttled, e.retryAfterMs], [true, "shop_unavailable", 503, true, wait]);
  }
  // a THROTTLED entry in an ordinary answer (what a client that returns errors instead of throwing gives)
  const answered = { async graphql() { return { json: async () => ({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }) }; } };
  const viaAnswer = await fetchVariant(answered, "gid://shopify/ProductVariant/1").catch((e) => e);
  assert.deepEqual([viaAnswer.code, viaAnswer.throttled], ["shop_unavailable", true]);

  const notThrottled = [httpFailure(401), httpFailure(403), httpFailure(404), httpServerError(), new HttpRequestError("socket hang up"), new TypeError("fetch failed"), gqlOther()];
  for (const error of notThrottled) {
    const e = await caught(error);
    assert.deepEqual([e.code, e.status, e.throttled ?? false], ["shop_unavailable", 503, false], error.constructor.name);
  }
  const plain = await fetchVariant({ async graphql() { return { json: async () => ({ errors: [{ message: "Throttled" }] }) }; } }, "gid://shopify/ProductVariant/1").catch((e) => e);
  assert.equal(plain.throttled ?? false, false, "a message alone is not the THROTTLED code");
});

test("stock topology: a throttled read fails (never 'unknown'); any other failure is still 'unknown'", async () => {
  const { fetchStockTopology } = await import("../app/models/shopify-lookup.server.js");
  for (const error of [http429(1), gqlThrottled()]) {
    await assert.rejects(fetchStockTopology(lookupAdmin(error), "gid://shopify/ProductVariant/1"), (e) => e instanceof LookupError && e.throttled === true);
  }
  const throttledAnswer = { async graphql() { return { json: async () => ({ errors: [{ extensions: { code: "THROTTLED" } }] }) }; } };
  await assert.rejects(fetchStockTopology(throttledAnswer, "gid://shopify/ProductVariant/1"), (e) => e.throttled === true);
  for (const error of [httpFailure(403), gqlOther(), new TypeError("fetch failed")]) {
    assert.deepEqual(await fetchStockTopology(lookupAdmin(error), "gid://shopify/ProductVariant/1"), { thirdPartyOnly: null });
  }
});

test("a throttled availability read: one request (no tight retry loop), 503 for Shopify, event FAILED, nothing advanced; the retry then restocks once", async () => {
  for (const [name, error] of [["429", http429(3)], ["graphql", gqlThrottled()]]) {
    const shop = await makeShop(`thr-${name}`);
    const { itemId, variantGid } = await makeTracked(shop, { subs: 1 });
    let throttled = true;
    const admin = scriptedAdmin((query, variables) => { if (throttled) throw error; return answerNode((id) => SETTLED(id))(variables); });
    const input = { eventId: `ev-thr-${name}` };
    const quiet = silenceErrors();
    let first;
    try { first = await deliver(shop, itemId, { input, deps: admin.deps() }); } finally { quiet.mock.restore(); }
    assert.deepEqual([first.status, first.outcome], [503, "throttled"]);
    assert.deepEqual(admin.calls, ["NotifyVariant"], "asked once; neither a re-read nor a topology request follows a throttle");
    const [event] = await events(shop);
    assert.deepEqual([event.status, event.errorCode, event.attempts], ["FAILED", "shopify_throttled", 1]);
    const row = await state(shop, variantGid);
    assert.deepEqual([row.isInStock, row.restockCycle, row.sourceUpdatedAt, await jobCount(shop, variantGid)], [false, 0, null, 0], "no state was advanced");

    throttled = false;
    clearShopCooldowns(); // this test is about the retry itself; the cool-down has its own tests
    const retry = await deliver(shop, itemId, { input, deps: admin.deps() });
    assert.deepEqual([retry.status, retry.outcome, retry.results], [200, "processed", ["restocked"]]);
    assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 1]);
  }
});

test("a throttled stock-topology read does not let Admin's word confirm a restock; a non-throttle topology failure still does", async () => {
  const shop = await makeShop("thr-topology");
  const throttledOne = await makeTracked(shop, { subs: 1 });
  const admin = scriptedAdmin((query, variables) => {
    if (query === "StockTopologyLevels") throw http429(1);
    if (query === "StockTopologyServices") return { json: async () => ({ data: {} }) };
    return answerNode((id) => SETTLED(id))(variables);
  });
  const quiet = silenceErrors();
  let result;
  try { result = await deliver(shop, throttledOne.itemId, { deps: admin.deps() }); } finally { quiet.mock.restore(); }
  assert.deepEqual([result.status, result.outcome], [503, "throttled"]);
  const row = await state(shop, throttledOne.variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle, await jobCount(shop, throttledOne.variantGid)], [false, 0, 0], "availability was not confirmed, so nothing changed");

  clearShopCooldowns();
  const unknownOne = await makeTracked(shop, { subs: 1 });
  const denied = scriptedAdmin((query, variables) => {
    if (query.startsWith("StockTopology")) throw httpFailure(403);
    return answerNode((id) => SETTLED(id))(variables);
  });
  assert.deepEqual((await deliver(shop, unknownOne.itemId, { deps: denied.deps() })).results, ["restocked"], "unchanged: unknown topology is still settled by Admin");
});

test("auth, server and network failures are NOT treated as throttling: same 503, same code, nothing advanced", async () => {
  const failures = [["401", httpFailure(401)], ["403", httpFailure(403)], ["500", httpServerError()], ["network", new HttpRequestError("socket hang up")]];
  for (const [name, error] of failures) {
    const shop = await makeShop(`thr-other-${name}`);
    const { itemId, variantGid } = await makeTracked(shop);
    const admin = scriptedAdmin(() => { throw error; });
    const quiet = silenceErrors();
    let result;
    try { result = await deliver(shop, itemId, { deps: admin.deps() }); } finally { quiet.mock.restore(); }
    assert.deepEqual([result.status, result.outcome], [503, "failed"], name);
    const [event] = await events(shop);
    assert.deepEqual([event.status, event.errorCode], ["FAILED", "shop_unavailable"], name);
    assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [0, 0]);
  }
});

test("throttling stays bounded: the event is flagged after MAX_EVENT_ATTEMPTS and Shopify is then told 200", async () => {
  const { MAX_EVENT_ATTEMPTS, UNRESOLVED_CODE } = await import("../app/models/inventory-webhook.server.js");
  const shop = await makeShop("thr-bounded");
  const { itemId, variantGid } = await makeTracked(shop);
  const admin = scriptedAdmin(() => { throw http429(1); });
  const quiet = silenceErrors();
  const statuses = [];
  try {
    for (let i = 0; i < MAX_EVENT_ATTEMPTS; i += 1) statuses.push((clearShopCooldowns(), await deliver(shop, itemId, { input: { eventId: "ev-thr-bounded" }, deps: admin.deps() })).status);
  } finally { quiet.mock.restore(); }
  assert.deepEqual(statuses, [...Array(MAX_EVENT_ATTEMPTS - 1).fill(503), 200]);
  assert.equal(admin.calls.length, MAX_EVENT_ATTEMPTS, "one request per attempt");
  const [event] = await events(shop);
  assert.deepEqual([event.status, event.errorCode, event.attempts], ["FAILED", UNRESOLVED_CODE, MAX_EVENT_ATTEMPTS]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [0, 0]);
});

test("recovery stops its batch at the first throttle: the other events keep their attempts for a later run", async () => {
  const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
  const shop = await makeShop("thr-recover");
  const tracked = [await makeTracked(shop), await makeTracked(shop), await makeTracked(shop)];
  for (const [i, t] of tracked.entries()) {
    await seedEvent(shop, { resourceGid: `gid://shopify/InventoryItem/${t.itemId}`, status: "FAILED", attempts: 1, errorCode: "shop_unavailable", receivedAt: new Date(Date.now() - 3600 * 1000 - i * 1000) });
  }
  const admin = scriptedAdmin(() => { throw http429(1); });
  const quiet = silenceErrors();
  let summary;
  try { summary = await recoverInventoryEvents({ shopDomains: [shop.domain], deps: admin.deps(), now: () => new Date(Date.now() + 10 * 60 * 1000) }); } finally { quiet.mock.restore(); }
  assert.deepEqual(summary, { found: 3, processed: 0, ignored: 0, skipped: 0, failed: 1, throttled: 1 });
  assert.equal(admin.calls.length, 1, "Shopify was asked once, not three times");
  const rows = await events(shop);
  assert.deepEqual(rows.map((r) => r.attempts).sort(), [1, 1, 2], "only one event spent an attempt");
  assert.ok(rows.every((r) => r.status === "FAILED"), "all stay eligible");
});

// ======================= Per-shop Shopify cool-down =======================
// After Shopify throttles a shop, that shop's inventory events (live webhooks and recovery) do not ask the Admin API
// until the cool-down ends. A deferred event spends no attempt, is never finished, and stays eligible. The clock is
// injected (deps.now), so nothing sleeps. State is process memory only (documented in the module).
const clockAt = (start = Date.now()) => {
  let t = start;
  return { now: () => new Date(t), advance: (ms) => { t += ms; }, ms: () => t };
};
const SECOND = 1000;
const eventRow = async (shop, key) => (await events(shop)).find((e) => e.dedupeKey === key);

test("cool-down: a throttle starts it; another event of the shop makes no Admin request, spends no attempt, and is kept FAILED (no lease left behind)", async () => {
  clearShopCooldowns();
  const shop = await makeShop("cd-set");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 1 });
  const clock = clockAt();
  const admin = scriptedAdmin(() => { throw http429(30); });
  const quiet = silenceErrors();
  try {
    const first = await deliver(shop, itemId, { input: { eventId: "cd-set-1" }, deps: admin.deps({ now: clock.now }) });
    assert.deepEqual([first.status, first.outcome], [503, "throttled"]);
    assert.equal(admin.calls.length, 1);

    clock.advance(10 * SECOND); // still inside the 30 s Retry-After
    const second = await deliver(shop, itemId, { input: { eventId: "cd-set-2" }, deps: admin.deps({ now: clock.now }) });
    assert.deepEqual([second.status, second.outcome], [503, "deferred"], "retryable, not a success");
    // the SAME event redelivered during the cool-down
    const again = await deliver(shop, itemId, { input: { eventId: "cd-set-1" }, deps: admin.deps({ now: clock.now }) });
    assert.deepEqual([again.status, again.outcome], [503, "deferred"]);
    assert.equal(admin.calls.length, 1, "zero Admin requests while the shop cools down");
  } finally { quiet.mock.restore(); }

  const one = await eventRow(shop, "cd-set-1");
  const two = await eventRow(shop, "cd-set-2");
  assert.deepEqual([one.status, one.attempts, one.errorCode], ["FAILED", 1, "shopify_throttled"], "the throttled event keeps its single attempt");
  assert.deepEqual([two.status, two.attempts, two.errorCode], ["FAILED", 0, "shopify_throttled"], "the deferred new event is stored with no attempt spent");
  assert.equal((await events(shop)).filter((e) => e.status === "RECEIVED").length, 0, "nothing is held by a lease");
  const row = await state(shop, variantGid);
  assert.deepEqual([row.isInStock, row.restockCycle, await jobCount(shop, variantGid)], [false, 0, 0], "nothing advanced");
});

test("cool-down: a deferral after the event was claimed gives the claim and its attempt back (no lease left behind)", async () => {
  clearShopCooldowns();
  const { startShopCooldown } = await import("../app/models/inventory-webhook.server.js");
  const shop = await makeShop("cd-release");
  const { itemId } = await makeTracked(shop);
  await seedEvent(shop, { resourceGid: `gid://shopify/InventoryItem/${itemId}`, status: "FAILED", attempts: 2, errorCode: "shop_unavailable", dedupeKey: "cd-release-1", receivedAt: new Date(Date.now() - 3600 * 1000) });
  const admin = scriptedAdmin(() => { throw new Error("must not be asked"); });
  // The shop starts cooling down while this delivery is claiming its event: the 2nd clock read is the check after the claim.
  let reads = 0;
  const now = () => { reads += 1; if (reads === 2) startShopCooldown(shop.domain, 30 * SECOND); return new Date(); };
  const result = await deliver(shop, itemId, { input: { eventId: "cd-release-1" }, deps: admin.deps({ now }) });
  assert.deepEqual([result.status, result.outcome], [503, "deferred"]);
  assert.equal(admin.calls.length, 0);
  const row = await eventRow(shop, "cd-release-1");
  assert.deepEqual([row.status, row.attempts, row.errorCode], ["FAILED", 2, "shopify_throttled"], "FAILED again, the attempt it took is returned, claimable at once");
  clearShopCooldowns();
});

test("cool-down: after it ends the deferred events process and the restock happens exactly once", async () => {
  clearShopCooldowns();
  const shop = await makeShop("cd-expire");
  const { itemId, variantGid } = await makeTracked(shop, { subs: 1 });
  const clock = clockAt();
  let healthy = false;
  const admin = scriptedAdmin((query, variables) => { if (!healthy) throw http429(30); return answerNode((id) => SETTLED(id))(variables); });
  const quiet = silenceErrors();
  try {
    assert.equal((await deliver(shop, itemId, { input: { eventId: "cd-exp-1" }, deps: admin.deps({ now: clock.now }) })).outcome, "throttled");
    assert.equal((await deliver(shop, itemId, { input: { eventId: "cd-exp-2" }, deps: admin.deps({ now: clock.now }) })).outcome, "deferred");
  } finally { quiet.mock.restore(); }
  healthy = true;
  clock.advance(29 * SECOND);
  assert.equal((await deliver(shop, itemId, { input: { eventId: "cd-exp-2" }, deps: admin.deps({ now: clock.now }) })).outcome, "deferred", "not before the wait is over");
  assert.equal(admin.calls.length, 1);

  clock.advance(2 * SECOND); // 31 s after the throttle
  const one = await deliver(shop, itemId, { input: { eventId: "cd-exp-1" }, deps: admin.deps({ now: clock.now }) });
  const two = await deliver(shop, itemId, { input: { eventId: "cd-exp-2" }, deps: admin.deps({ now: clock.now }) });
  assert.deepEqual([one.status, one.outcome, one.results], [200, "processed", ["restocked"]]);
  assert.deepEqual([two.status, two.outcome, two.results], [200, "processed", ["unchanged"]]);
  assert.deepEqual([(await state(shop, variantGid)).restockCycle, await jobCount(shop, variantGid)], [1, 1], "one restock, one email job");
  const rows = [await eventRow(shop, "cd-exp-1"), await eventRow(shop, "cd-exp-2")];
  assert.deepEqual(rows.map((r) => [r.status, r.attempts]), [["PROCESSED", 2], ["PROCESSED", 1]], "the deferrals cost no attempt");
});

test("cool-down: one shop's cool-down does not affect another shop", async () => {
  clearShopCooldowns();
  const slow = await makeShop("cd-a");
  const other = await makeShop("cd-b");
  const a = await makeTracked(slow);
  const b = await makeTracked(other);
  const clock = clockAt();
  const quiet = silenceErrors();
  try {
    const throttled = scriptedAdmin(() => { throw http429(60); });
    assert.equal((await deliver(slow, a.itemId, { deps: throttled.deps({ now: clock.now }) })).outcome, "throttled");
    const healthy = scriptedAdmin((query, variables) => answerNode((id) => SETTLED(id))(variables));
    const result = await deliver(other, b.itemId, { deps: healthy.deps({ now: clock.now }) });
    assert.deepEqual([result.status, result.outcome, result.results], [200, "processed", ["restocked"]]);
    assert.ok(healthy.calls.length > 0, "the other shop did ask Shopify");
    assert.equal((await deliver(slow, a.itemId, { deps: healthy.deps({ now: clock.now }) })).outcome, "deferred", "the cooling shop still waits");
  } finally { quiet.mock.restore(); }
});

test("cool-down: only a throttle starts one; auth, server, network and not-settled failures do not", async () => {
  clearShopCooldowns();
  const failures = [["401", httpFailure(401)], ["403", httpFailure(403)], ["500", httpServerError()], ["network", new HttpRequestError("socket hang up")], ["graphql-other", gqlOther()]];
  const quiet = silenceErrors();
  try {
    for (const [name, error] of failures) {
      const shop = await makeShop(`cd-no-${name}`);
      const { itemId } = await makeTracked(shop);
      const admin = scriptedAdmin(() => { throw error; });
      assert.equal((await deliver(shop, itemId, { deps: admin.deps() })).outcome, "failed", name);
      assert.equal(admin.calls.length, 1, name);
      assert.equal((await deliver(shop, itemId, { deps: admin.deps() })).outcome, "failed", `${name}: the next event is attempted, not deferred`);
      assert.equal(admin.calls.length, 2, name);
    }
  } finally { quiet.mock.restore(); }
});

test("cool-down: Retry-After missing, invalid, zero or oversized gives 1 minute (default) or at most 5 minutes (cap)", async () => {
  const { cooldownMsOf, COOLDOWN_DEFAULT_MS, COOLDOWN_MAX_MS } = await import("../app/models/inventory-webhook.server.js");
  assert.deepEqual([COOLDOWN_DEFAULT_MS, COOLDOWN_MAX_MS], [60 * SECOND, 300 * SECOND]);
  for (const bad of [undefined, null, NaN, "abc", 0, -5, ""]) assert.equal(cooldownMsOf(bad), 60 * SECOND, `default for ${String(bad)}`);
  assert.equal(cooldownMsOf(2 * SECOND), 2 * SECOND);
  assert.equal(cooldownMsOf(300 * SECOND), 300 * SECOND);
  for (const big of [300 * SECOND + 1, 99999 * SECOND, Infinity]) assert.equal(cooldownMsOf(big), 300 * SECOND, `cap for ${String(big)}`);

  // End to end, through the real error shapes: how long the shop really waits.
  const cases = [["missing", () => http429(undefined), 60], ["zero", () => http429(0), 60], ["invalid", () => http429(NaN), 60], ["graphql", gqlThrottled, 60], ["short", () => http429(20), 20], ["oversized", () => http429(99999), 300]];
  const quiet = silenceErrors();
  try {
    for (const [name, make, waitSeconds] of cases) {
      clearShopCooldowns();
      const shop = await makeShop(`cd-len-${name}`);
      const { itemId } = await makeTracked(shop);
      const clock = clockAt();
      const admin = scriptedAdmin(() => { throw make(); });
      assert.equal((await deliver(shop, itemId, { deps: admin.deps({ now: clock.now }) })).outcome, "throttled", name);
      clock.advance((waitSeconds - 1) * SECOND);
      assert.equal((await deliver(shop, itemId, { deps: admin.deps({ now: clock.now }) })).outcome, "deferred", `${name}: still waiting 1 s before the end`);
      assert.equal(admin.calls.length, 1, name);
      clock.advance(2 * SECOND);
      assert.equal((await deliver(shop, itemId, { deps: admin.deps({ now: clock.now }) })).outcome, "throttled", `${name}: asked again once ${waitSeconds} s have passed`);
      assert.equal(admin.calls.length, 2, name);
    }
  } finally { quiet.mock.restore(); }
});

test("cool-down: recovery respects it, asks Shopify nothing, spends no attempt however often it runs, and resumes afterwards", async () => {
  clearShopCooldowns();
  const { recoverInventoryEvents, startShopCooldown } = await import("../app/models/inventory-webhook.server.js");
  const shop = await makeShop("cd-recover");
  const tracked = [await makeTracked(shop), await makeTracked(shop)];
  for (const [i, t] of tracked.entries()) {
    await seedEvent(shop, { resourceGid: `gid://shopify/InventoryItem/${t.itemId}`, status: "FAILED", attempts: 1, errorCode: "shop_unavailable", dedupeKey: `cd-rec-${i}`, receivedAt: new Date(Date.now() - 3600 * 1000 - i * 1000) });
  }
  const clock = clockAt();
  startShopCooldown(shop.domain, 120 * SECOND, clock.ms());
  const admin = scriptedAdmin((query, variables) => answerNode((id) => SETTLED(id))(variables));
  const run = () => recoverInventoryEvents({ shopDomains: [shop.domain], deps: admin.deps({ now: clock.now }), now: () => new Date(clock.ms() + 10 * 60 * 1000) });

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await run(), { found: 2, processed: 0, ignored: 0, skipped: 0, failed: 0, deferred: 2 }, `run ${i + 1}`);
    clock.advance(10 * SECOND);
  }
  assert.equal(admin.calls.length, 0, "Shopify was never asked");
  assert.deepEqual((await events(shop)).map((e) => [e.status, e.attempts]), [["FAILED", 1], ["FAILED", 1]], "no attempt spent, nothing claimed");

  clock.advance(120 * SECOND);
  assert.deepEqual(await run(), { found: 2, processed: 2, ignored: 0, skipped: 0, failed: 0 });
  assert.ok((await events(shop)).every((e) => e.status === "PROCESSED" && e.attempts === 2));
  for (const t of tracked) assert.deepEqual([(await state(shop, t.variantGid)).restockCycle, await jobCount(shop, t.variantGid)], [1, 1]);
});
