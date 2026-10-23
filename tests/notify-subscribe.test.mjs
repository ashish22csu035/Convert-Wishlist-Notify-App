// Tests for Notify Me subscription creation.
//
// Run from the project root after `npm run build`:
//   node --test tests/notify-subscribe.test.mjs
//
// Two layers:
//  - HTTP tests start the built server (dummy app secret, port 3197) and sign
//    requests like Shopify's App Proxy. No Shopify offline session exists for the
//    test shops, so these also prove the "Admin API unavailable" path.
//  - Model tests call subscribeToNotify with a FAKE Admin API client. They use the
//    real MySQL database from .env, but only rows of unique test shops, which
//    are deleted at the end. Nothing here talks to real Shopify; tests that need
//    real credentials/approval (live customer email) are NOT covered.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const PORT = 3197;
const BASE = `http://localhost:${PORT}`;
const SECRET = "dummy-secret-for-tests-only";
const RUN = Date.now().toString(36);
const SHOP_A = `kw-nt-a-${RUN}.myshopify.com`;
const SHOP_B = `kw-nt-b-${RUN}.myshopify.com`;
const SHOP_C = `kw-nt-c-${RUN}.myshopify.com`;
const SHOP_D = `kw-nt-d-${RUN}.myshopify.com`;
const SHOPS = [SHOP_A, SHOP_B, SHOP_C, SHOP_D];
const CUSTOMER = "9100000001";
const CUSTOMER_GID = `gid://shopify/Customer/${CUSTOMER}`;
const VARIANT = "8100000001";
const VARIANT_GID = `gid://shopify/ProductVariant/${VARIANT}`;
const PRODUCT_GID = "gid://shopify/Product/7100000001";
const EMAIL = "Buyer@Example.com";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let server;
let subscribeToNotify;
let listActiveSubscriptions;
let LookupError;

function sign(params) {
  const message = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce((acc, [key, value]) => `${acc}${key}=${value}`, "");
  return crypto.createHmac("sha256", SECRET).update(message).digest("hex");
}

async function post(body, { shop = SHOP_A, customer = CUSTOMER, signed = true, tamper } = {}) {
  const params = {
    shop,
    logged_in_customer_id: customer,
    path_prefix: "/apps/konvert-notify",
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signature = sign(params);
  if (tamper) Object.assign(params, tamper);
  const query = new URLSearchParams(params);
  if (signed) query.set("signature", signature);
  const response = await fetch(`${BASE}/proxy/api/notify?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, json, text };
}

// Fake Admin API: answers the two queries the lookup module sends.
function fakeAdmin({ variant, customer, errors } = {}) {
  return {
    async graphql(query, { variables }) {
      const data = query.includes("NotifyVariant")
        ? { node: variant === undefined ? null : variant }
        : { customer: customer === undefined ? null : customer };
      return { json: async () => (errors ? { errors } : { data }) };
    },
  };
}
const soldOut = (over = {}) => ({
  id: VARIANT_GID,
  inventoryPolicy: "DENY",
  sellableOnlineQuantity: 0,
  product: { id: PRODUCT_GID },
  inventoryItem: { id: "gid://shopify/InventoryItem/6100000001", tracked: true },
  ...over,
});
const customerRecord = { id: CUSTOMER_GID, defaultEmailAddress: { emailAddress: EMAIL } };
const deps = (admin, scope = "read_customers,read_inventory") => ({
  getAdmin: async () => ({ admin, scope }),
});
const identity = (shopDomain = SHOP_A) => ({ shopDomain, customerGid: CUSTOMER_GID });
const subscribe = (admin, opts = {}) =>
  subscribeToNotify(identity(opts.shop), VARIANT_GID, deps(admin, opts.scope));

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => error instanceof LookupError && error.code === code);
}
// GET /proxy/api/notify?ids=... (signed like Shopify's App Proxy does)
async function get(ids, { shop = SHOP_A, customer = CUSTOMER, signed = true, tamper } = {}) {
  const params = {
    shop,
    logged_in_customer_id: customer,
    path_prefix: "/apps/konvert-notify",
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  if (ids !== undefined) params.ids = ids;
  const signature = sign(params);
  if (tamper) Object.assign(params, tamper);
  const query = new URLSearchParams(params);
  if (signed) query.set("signature", signature);
  const response = await fetch(`${BASE}/proxy/api/notify?${query}`);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, json, text };
}
const shopRow = (domain) => prisma.shop.findUnique({ where: { domain } });
async function subsFor(domain) {
  const shop = await shopRow(domain);
  return shop ? prisma.notifySubscription.findMany({ where: { shopId: shop.id } }) : [];
}

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.SHOPIFY_APP_URL = BASE;
  process.env.SCOPES = "write_products";
  ({ subscribeToNotify, listActiveSubscriptions } = await import("../app/models/notify.server.js"));
  ({ LookupError } = await import("../app/models/shopify-lookup.server.js"));

  server = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
});

after(async () => {
  // Cascades to actors, sessions, events, subscriptions and availability of these shops only.
  await prisma.shop.deleteMany({ where: { domain: { in: SHOPS } } });
  const leftovers = await prisma.shop.count({ where: { domain: { in: SHOPS } } });
  await prisma.$disconnect();
  server?.kill();
  assert.equal(leftovers, 0, "test shops were removed");
});

test("rejects missing or tampered App Proxy signatures", async () => {
  const unsigned = await post({ op: "subscribe", variantId: VARIANT }, { signed: false });
  assert.equal(unsigned.status, 400);
  const tampered = await post({ op: "subscribe", variantId: VARIANT }, { tamper: { logged_in_customer_id: "1" } });
  assert.equal(tampered.status, 400);
  const otherShop = await post({ op: "subscribe", variantId: VARIANT }, { tamper: { shop: SHOP_B } });
  assert.equal(otherShop.status, 400);
  assert.equal(await prisma.shop.count({ where: { domain: { in: SHOPS } } }), 0);
});

test("logged-out visitors get login_required and nothing is stored", async () => {
  const traceFile = path.join(os.tmpdir(), "kw-proxy-trace.log");
  const traceBefore = fs.existsSync(traceFile) ? fs.statSync(traceFile).size : 0;
  const response = await post({ op: "subscribe", variantId: VARIANT }, { customer: "" });
  assert.equal(response.status, 401);
  assert.equal(response.json.error, "login_required");
  const added = fs.readFileSync(traceFile, "utf8").slice(traceBefore);
  assert.match(added, /"status":401,.*"error":"login_required"/, "the diagnostics log records the reason code of a refusal");
  assert.equal(await prisma.shop.count({ where: { domain: { in: SHOPS } } }), 0);
});

test("malformed variant ids are rejected before any lookup or write", async () => {
  for (const variantId of [undefined, "", "abc", "1; DROP", "gid://shopify/Product/1", {}, ["1"]]) {
    const response = await post({ op: "subscribe", variantId });
    assert.equal(response.status, 400, JSON.stringify(variantId));
    assert.equal(response.json.error, "invalid_request");
  }
  assert.equal(await prisma.shop.count({ where: { domain: { in: SHOPS } } }), 0);
});

test("without a Shopify offline session the request fails safely and stores nothing", async () => {
  const response = await post({ op: "subscribe", variantId: VARIANT });
  assert.equal(response.status, 503);
  assert.equal(response.json.error, "shop_unavailable");
  assert.equal(await prisma.shop.count({ where: { domain: { in: SHOPS } } }), 0);
});

test("a browser-supplied email, customer or shop in the body is ignored", async () => {
  const response = await post({
    op: "subscribe",
    variantId: VARIANT,
    email: "evil@example.com",
    customerId: "1",
    shop: SHOP_B,
  });
  assert.equal(response.status, 503, "still resolved only from the signed query");
  assert.equal(await prisma.shop.count({ where: { domain: SHOP_B } }), 0);
});

test("variant that belongs to another shop (not found in this shop) is refused", async () => {
  await rejects(subscribe(fakeAdmin({ variant: null, customer: customerRecord })), "variant_not_found");
  await rejects(
    subscribe(fakeAdmin({ variant: soldOut({ id: "gid://shopify/ProductVariant/1" }), customer: customerRecord })),
    "variant_not_found",
  );
  assert.equal(await shopRow(SHOP_A), null, "nothing written");
});

test("a variant that is available for sale is refused, however the browser claims", async () => {
  for (const variant of [
    soldOut({ sellableOnlineQuantity: 5 }),
    soldOut({ inventoryPolicy: "CONTINUE" }),
    soldOut({ inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: false } }),
  ]) {
    await rejects(subscribe(fakeAdmin({ variant, customer: customerRecord })), "variant_available");
  }
  assert.equal(await shopRow(SHOP_A), null, "nothing written");
});

test("missing customer-data scope, approval, customer or email are refused with safe codes", async () => {
  const admin = fakeAdmin({ variant: soldOut(), customer: customerRecord });
  await rejects(subscribe(admin, { scope: "write_products" }), "customer_data_unavailable");
  await rejects(subscribe(fakeAdminDenied()), "customer_data_unavailable");
  await rejects(subscribe(fakeAdmin({ variant: soldOut(), customer: null })), "customer_not_found");
  await rejects(
    subscribe(fakeAdmin({ variant: soldOut(), customer: { id: CUSTOMER_GID, defaultEmailAddress: null } })),
    "customer_email_unavailable",
  );
  assert.equal(await shopRow(SHOP_A), null, "nothing written");
});

function fakeAdminDenied() {
  return {
    async graphql(query) {
      if (query.includes("NotifyVariant")) return { json: async () => ({ data: { node: soldOut() } }) };
      return { json: async () => ({ errors: [{ message: "x", extensions: { code: "ACCESS_DENIED" } }] }) };
    },
  };
}

test("creates a subscription with the verified identity, Admin-API email, session and event", async () => {
  const result = await subscribe(fakeAdmin({ variant: soldOut(), customer: customerRecord }));
  assert.deepEqual(result, { subscribed: true, changed: true });

  const shop = await shopRow(SHOP_A);
  const [sub] = await subsFor(SHOP_A);
  assert.equal(sub.email, "buyer@example.com");
  assert.equal(sub.status, "ACTIVE");
  assert.equal(sub.variantGid, VARIANT_GID);
  assert.equal(sub.productGid, PRODUCT_GID);
  assert.equal(sub.baselineCycle, 0);

  const availability = await prisma.variantAvailability.findFirst({ where: { shopId: shop.id, variantGid: VARIANT_GID } });
  assert.equal(availability.isInStock, false);

  const events = await prisma.activityEvent.findMany({ where: { shopId: shop.id } });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "NOTIFY_SUBSCRIBED");
  assert.equal(events[0].feature, "NOTIFY_ME");
  const session = await prisma.browsingSession.findUnique({ where: { id: events[0].browsingSessionId } });
  assert.equal(session.feature, "NOTIFY_ME");
  assert.equal(await prisma.browsingSession.count({ where: { shopId: shop.id, feature: "WISHLIST" } }), 0);
});

test("repeated clicks and concurrent clicks keep one active subscription and one event", async () => {
  const admin = fakeAdmin({ variant: soldOut(), customer: customerRecord });
  const again = await subscribe(admin);
  assert.deepEqual(again, { subscribed: true, changed: false });
  await Promise.all([subscribe(admin), subscribe(admin), subscribe(admin)]);

  const shop = await shopRow(SHOP_A);
  assert.equal((await subsFor(SHOP_A)).length, 1);
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id, type: "NOTIFY_SUBSCRIBED" } }), 1);
  assert.equal(await prisma.browsingSession.count({ where: { shopId: shop.id, feature: "NOTIFY_ME" } }), 1, "session reused");
});

test("resubscribing after fulfilment reactivates the row for the new restock cycle", async () => {
  const shop = await shopRow(SHOP_A);
  const [sub] = await subsFor(SHOP_A);
  // Simulates the later restock phase: variant restocked (cycle 1), subscription fulfilled, then sold out again.
  await prisma.variantAvailability.update({
    where: { shopId_variantGid: { shopId: shop.id, variantGid: VARIANT_GID } },
    data: { restockCycle: 1, isInStock: true },
  });
  await prisma.notifySubscription.update({ where: { id: sub.id }, data: { status: "FULFILLED" } });

  const result = await subscribe(fakeAdmin({ variant: soldOut(), customer: customerRecord }));
  assert.deepEqual(result, { subscribed: true, changed: true });

  const rows = await subsFor(SHOP_A);
  assert.equal(rows.length, 1, "still one row per customer and variant");
  assert.equal(rows[0].id, sub.id);
  assert.equal(rows[0].status, "ACTIVE");
  assert.equal(rows[0].baselineCycle, 1);
  const availability = await prisma.variantAvailability.findFirst({ where: { shopId: shop.id, variantGid: VARIANT_GID } });
  assert.equal(availability.isInStock, false);
  assert.equal(availability.restockCycle, 1, "cycle counter untouched");
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id, type: "NOTIFY_SUBSCRIBED" } }), 2);
});

test("an unsubscribed customer can subscribe again", async () => {
  const [sub] = await subsFor(SHOP_A);
  await prisma.notifySubscription.update({ where: { id: sub.id }, data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() } });
  await subscribe(fakeAdmin({ variant: soldOut(), customer: customerRecord }));
  const [after] = await subsFor(SHOP_A);
  assert.equal(after.status, "ACTIVE");
  assert.equal(after.unsubscribedAt, null);
});

test("subscriptions are scoped to the authenticated shop", async () => {
  await subscribe(fakeAdmin({ variant: soldOut(), customer: customerRecord }), { shop: SHOP_B });
  assert.equal((await subsFor(SHOP_B)).length, 1);
  assert.equal((await subsFor(SHOP_A)).length, 1);
});

// ---- subscription status (what the storefront asks on every page) ----------------------
const OTHER_VARIANT = "8100000999";
const OTHER_GID = `gid://shopify/ProductVariant/${OTHER_VARIANT}`;

test("status lookup: only this shop's, this customer's ACTIVE subscription to the exact variant", async () => {
  assert.deepEqual(await listActiveSubscriptions(identity(SHOP_A), [VARIANT_GID, OTHER_GID]), [VARIANT]);
  assert.deepEqual(await listActiveSubscriptions(identity(SHOP_A), [OTHER_GID]), [], "a different variant is not subscribed");
  assert.deepEqual(
    await listActiveSubscriptions({ shopDomain: SHOP_A, customerGid: "gid://shopify/Customer/9100000002" }, [VARIANT_GID]),
    [],
    "another customer of the same shop sees nothing",
  );
  assert.deepEqual(await listActiveSubscriptions(identity(SHOP_C), [VARIANT_GID]), [], "a shop with no data sees nothing");
  assert.equal(await shopRow(SHOP_C), null, "a status lookup never creates a shop, customer or session");

  const [sub] = await subsFor(SHOP_A);
  await prisma.notifySubscription.update({ where: { id: sub.id }, data: { status: "FULFILLED" } });
  assert.deepEqual(await listActiveSubscriptions(identity(SHOP_A), [VARIANT_GID]), [], "a completed subscription is not 'on the list'");
  await prisma.notifySubscription.update({ where: { id: sub.id }, data: { status: "ACTIVE" } });
  assert.deepEqual(await listActiveSubscriptions(identity(SHOP_A), [VARIANT_GID]), [VARIANT]);
});

test("status endpoint: signed and logged-in only, validated input, and it reports the state a click created", async () => {
  assert.equal((await get(VARIANT, { signed: false })).status, 400, "unsigned");
  assert.equal((await get(VARIANT, { tamper: { logged_in_customer_id: "1" } })).status, 400, "customer id tampered");
  assert.equal((await get(VARIANT, { tamper: { shop: SHOP_B } })).status, 400, "shop tampered");
  assert.equal((await get(VARIANT, { tamper: { ids: OTHER_VARIANT } })).status, 400, "ids are part of the signature");

  const loggedOut = await get(VARIANT, { customer: "" });
  assert.equal(loggedOut.status, 401);
  assert.equal(loggedOut.json.error, "login_required");

  for (const ids of [undefined, "", "abc", "1,x", "1;DROP", Array.from({ length: 51 }, (_, i) => i + 1).join(",")]) {
    const bad = await get(ids);
    assert.equal(bad.status, 400, String(ids));
    assert.equal(bad.json.error, "invalid_request");
  }

  // The subscription made earlier through the model is reported through the signed endpoint.
  const yes = await get(`${VARIANT},${OTHER_VARIANT}`);
  assert.equal(yes.status, 200);
  assert.deepEqual(yes.json, { subscribed: [VARIANT] }, "exact variant only, and no email or other customer data");
  assert.equal(JSON.stringify(yes.json).includes("@"), false);
  const otherCustomer = await get(VARIANT, { customer: "9100000002" });
  assert.deepEqual(otherCustomer.json, { subscribed: [] });
  const otherShop = await get(VARIANT, { shop: SHOP_C });
  assert.deepEqual(otherShop.json, { subscribed: [] });
  assert.equal(await shopRow(SHOP_C), null, "reading status creates nothing");
});

test("an already-available variant is refused and leaves stock records, subscriptions and events untouched", async () => {
  const shop = await prisma.shop.create({ data: { domain: SHOP_C, currencyCode: "XXX" } });
  const inStockAt = new Date("2026-01-01T00:00:00.000Z");
  await prisma.variantAvailability.create({
    data: {
      shopId: shop.id, variantGid: VARIANT_GID, productGid: PRODUCT_GID,
      inventoryItemGid: "gid://shopify/InventoryItem/6100000001", isInStock: true, restockCycle: 3, lastSyncedAt: inStockAt,
    },
  });
  const before = await prisma.variantAvailability.findFirst({ where: { shopId: shop.id } });

  await rejects(
    subscribeToNotify(identity(SHOP_C), VARIANT_GID, deps(fakeAdmin({ variant: soldOut({ sellableOnlineQuantity: 18 }), customer: customerRecord }))),
    "variant_available",
  );

  const after = await prisma.variantAvailability.findFirst({ where: { shopId: shop.id } });
  assert.deepEqual(after, before, "stock fields, restock cycle and sync time are exactly as they were");
  assert.equal(await prisma.notifySubscription.count({ where: { shopId: shop.id } }), 0);
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id } }), 0);
  assert.equal(await prisma.browsingSession.count({ where: { shopId: shop.id } }), 0);
  assert.equal(await prisma.actor.count({ where: { shopId: shop.id } }), 0, "not even a customer record is created");
});

test("subscribing to a sold-out variant never marks it in stock or moves the restock cycle", async () => {
  const shop = await shopRow(SHOP_C);
  const before = await prisma.variantAvailability.findFirst({ where: { shopId: shop.id } });
  await subscribe(fakeAdmin({ variant: soldOut(), customer: customerRecord }), { shop: SHOP_C });
  const after = await prisma.variantAvailability.findFirst({ where: { shopId: shop.id } });
  assert.equal(after.isInStock, false, "only ever set to out of stock, verified against Shopify first");
  assert.equal(after.restockCycle, before.restockCycle, "restock cycle untouched");
  assert.equal(after.inventoryItemGid, before.inventoryItemGid);
  assert.equal((await subsFor(SHOP_C))[0].baselineCycle, 3, "the subscription waits for the NEXT restock after cycle 3");
});

test("Shopify fields that contradict each other are never proof of either state: re-read, then retry later", async () => {
  const sleep = async () => {};
  const staleHigh = soldOut({ sellableOnlineQuantity: 6, inventoryQuantity: 0, availableForSale: false }); // seen live right after stock went to 0
  const settled = soldOut({ sellableOnlineQuantity: 0, inventoryQuantity: 0, availableForSale: false });
  const subscribeWith = (admin) => subscribeToNotify(identity(), VARIANT_GID, { ...deps(admin), sleep });

  // still contradictory after the bounded re-reads: refused as retryable, never treated as in stock or sold out
  await rejects(subscribeWith(fakeAdmin({ variant: staleHigh, customer: customerRecord })), "inventory_unsettled");

  // the lagging field catches up on the second read: accepted
  let reads = 0;
  const admin = {
    async graphql(query) {
      if (query.includes("NotifyVariant")) return { json: async () => ({ data: { node: ++reads < 2 ? staleHigh : settled } }) };
      return { json: async () => ({ data: { customer: customerRecord } }) };
    },
  };
  assert.equal((await subscribeWith(admin)).subscribed, true);
  assert.equal(reads, 2);
  // a variant whose fields agree it is available is still refused
  await rejects(subscribeWith(fakeAdmin({ variant: soldOut({ sellableOnlineQuantity: 6, inventoryQuantity: 6, availableForSale: true }), customer: customerRecord })), "variant_available");
});

test("Notify Me switched off: new subscriptions are refused by the server; existing subscriptions and history stay; switching on restores the flow", async () => {
  const sleep = async () => {};
  const subscribeD = () => subscribeToNotify({ shopDomain: SHOP_D, customerGid: CUSTOMER_GID }, VARIANT_GID, { ...deps(fakeAdmin({ variant: soldOut(), customer: customerRecord })), sleep });
  assert.equal((await subscribeD()).subscribed, true);
  const shop = await shopRow(SHOP_D);
  const snapshot = async () => ({
    subs: await prisma.notifySubscription.findMany({ where: { shopId: shop.id }, orderBy: { id: "asc" } }),
    events: await prisma.activityEvent.count({ where: { shopId: shop.id } }),
  });
  const before = await snapshot();
  assert.equal(before.subs.length, 1);

  const { saveSettings, validateSettings } = await import("../app/models/settings.server.js");
  await saveSettings(SHOP_D, validateSettings({ wishlistEnabled: "true", notifyMeEnabled: "false" }).values);

  const refused = await post({ op: "subscribe", variantId: VARIANT }, { shop: SHOP_D });
  assert.deepEqual([refused.status, refused.json.error], [403, "feature_disabled"], "refused before any Shopify lookup");
  const opened = await post({ op: "open" }, { shop: SHOP_D });
  assert.deepEqual([opened.status, opened.json.error], [403, "feature_disabled"]);
  assert.deepEqual(await snapshot(), before, "the existing subscription and the history are exactly as they were");
  assert.deepEqual((await get(VARIANT, { shop: SHOP_D })).json.subscribed, [VARIANT], "the customer's own status can still be read");
  assert.equal((await get(undefined, { shop: SHOP_D })).status, 400, "reads stay validated");

  await saveSettings(SHOP_D, validateSettings({ wishlistEnabled: "true", notifyMeEnabled: "true" }).values);
  const again = await post({ op: "subscribe", variantId: VARIANT }, { shop: SHOP_D });
  assert.notEqual(again.json?.error, "feature_disabled", "the switch no longer blocks it (here it fails later, without a Shopify session)");
  assert.deepEqual(await snapshot(), before, "nothing was recreated or lost");
  assert.equal((await subscribeD()).changed, false, "the same subscription is still the active one");
});

// ======================= a variant the Admin API reports as stocked but the storefront shows as sold out =======================
// Real values read from the dev store for "The 3p Fulfilled Snowboard" (stock held only at a third-party
// fulfillment-service location): Admin says 18 sellable and available for sale, tracked, overselling denied.
const FS_VARIANT = "50522368999586";
const FS_GID = `gid://shopify/ProductVariant/${FS_VARIANT}`;
const fsVariant = (over = {}) => soldOut({ id: FS_GID, sellableOnlineQuantity: 18, inventoryQuantity: 18, availableForSale: true, product: { id: PRODUCT_GID, handle: "the-3p-fulfilled-snowboard" }, ...over });
const who = (n) => ({ shopDomain: SHOP_B, customerGid: `gid://shopify/Customer/91000007${n}` });
const noWait = async () => {};
const onlyThirdParty = async () => ({ thirdPartyOnly: true }); // verified: every stocked location is a third-party fulfillment location
const subscribeFs = (admin, who_, options = {}) => subscribeToNotify(who_, FS_GID, { ...deps(admin), sleep: noWait, stockTopology: onlyThirdParty, ...options });
const fsRows = async (customerGid) => {
  const shop = await shopRow(SHOP_B);
  const actor = shop && (await prisma.actor.findUnique({ where: { shopId_customerGid: { shopId: shop.id, customerGid } } }));
  return { shop, actor, subs: actor ? await prisma.notifySubscription.findMany({ where: { actorId: actor.id, variantGid: FS_GID } }) : [] };
};

test("3p-fulfilled variant: Admin says available and the browser makes no claim -> refused, nothing is written", async () => {
  const me = who(1);
  await rejects(subscribeFs(fakeAdmin({ variant: fsVariant(), customer: customerRecord }), me), "variant_available");
  assert.equal((await fsRows(me.customerGid)).actor, null, "no actor, session, subscription or event was created");
});

test("3p-fulfilled variant: the storefront shows it sold out -> the subscription is created with UUID relations, once", async () => {
  const me = who(2);
  const admin = fakeAdmin({ variant: fsVariant(), customer: customerRecord });
  const calls = [];
  const check = async (...args) => { calls.push(args); return false; }; // the public storefront confirms "Sold out"
  const first = await subscribeFs(admin, me, { storefrontSoldOut: true, storefrontCheck: check });
  assert.deepEqual(first, { subscribed: true, changed: true });
  assert.deepEqual(calls, [[SHOP_B, "the-3p-fulfilled-snowboard", FS_VARIANT]], "the server asked the public storefront about this exact variant");

  const { shop, actor, subs } = await fsRows(me.customerGid);
  assert.equal(subs.length, 1);
  const [sub] = subs;
  assert.match(sub.id, UUID_V4);
  assert.deepEqual([sub.status, sub.shopId, sub.actorId, sub.baselineCycle, sub.productGid], ["ACTIVE", shop.id, actor.id, 0, PRODUCT_GID]);
  assert.equal(sub.email, "buyer@example.com", "the verified customer's email, from the Admin API");

  // availability is recorded as OUT of stock for the storefront (that is what the customer is waiting for), cycle untouched
  const availability = await prisma.variantAvailability.findUnique({ where: { shopId_variantGid: { shopId: shop.id, variantGid: FS_GID } } });
  assert.match(availability.id, UUID_V4);
  assert.deepEqual([availability.isInStock, availability.restockCycle, availability.inventoryItemGid], [false, 0, "gid://shopify/InventoryItem/6100000001"]);

  // repeated clicks: the same row, no second subscription, no second event
  assert.deepEqual(await subscribeFs(admin, me, { storefrontSoldOut: true, storefrontCheck: check }), { subscribed: true, changed: false });
  assert.equal((await fsRows(me.customerGid)).subs.length, 1);
  assert.equal(await prisma.activityEvent.count({ where: { actorId: actor.id, variantGid: FS_GID } }), 1);

  // the page after a refresh reads the persisted state, not a browser memory
  assert.deepEqual(await listActiveSubscriptions({ shopDomain: SHOP_B, customerGid: me.customerGid }, [FS_GID]), [FS_VARIANT]);
});

test("3p-fulfilled variant: a password-protected or unreachable storefront cannot be read, so the browser's own sold-out observation stands", async () => {
  const me = who(3);
  const result = await subscribeFs(fakeAdmin({ variant: fsVariant(), customer: customerRecord }), me, { storefrontSoldOut: true, storefrontCheck: async () => null });
  assert.deepEqual(result, { subscribed: true, changed: true });
  assert.equal((await fsRows(me.customerGid)).subs.length, 1);
});

test("a claim of 'sold out' never beats a public storefront that says the variant is available", async () => {
  const me = who(4);
  await rejects(subscribeFs(fakeAdmin({ variant: fsVariant(), customer: customerRecord }), me, { storefrontSoldOut: true, storefrontCheck: async () => true }), "variant_available");
  assert.equal((await fsRows(me.customerGid)).actor, null, "nothing written");
});

test("the claim is only honoured where stock and storefront can disagree: tracked inventory that denies overselling", async () => {
  const me = who(5);
  let asked = 0;
  const check = async () => { asked += 1; return false; };
  for (const variant of [
    fsVariant({ inventoryPolicy: "CONTINUE" }),
    fsVariant({ inventoryItem: { id: "gid://shopify/InventoryItem/6100000001", tracked: false } }),
  ]) {
    await rejects(subscribeFs(fakeAdmin({ variant, customer: customerRecord }), me, { storefrontSoldOut: true, storefrontCheck: check }), "variant_available");
  }
  assert.equal(asked, 0, "the storefront was not even asked");
  assert.equal((await fsRows(me.customerGid)).actor, null);
});

test("when the Admin API itself says sold out the claim is irrelevant and the storefront is not asked", async () => {
  const me = who(6);
  let asked = 0;
  const sold = fsVariant({ sellableOnlineQuantity: 0, inventoryQuantity: 0, availableForSale: false });
  assert.equal((await subscribeFs(fakeAdmin({ variant: sold, customer: customerRecord }), me, { storefrontSoldOut: true, storefrontCheck: async () => { asked += 1; return true; } })).subscribed, true);
  assert.equal(asked, 0);
});

test("contradictory quantities with a conclusive verdict: sold out by availableForSale and no sellable stock is subscribable; a stale-high read is retried, not trusted", async () => {
  const conclusive = fsVariant({ sellableOnlineQuantity: -1, inventoryQuantity: null, availableForSale: false });
  assert.equal((await subscribeFs(fakeAdmin({ variant: conclusive, customer: customerRecord }), who(7))).subscribed, true);
  const unresolved = fsVariant({ sellableOnlineQuantity: 6, inventoryQuantity: 0, availableForSale: false }); // Shopify's fields disagree and stay that way
  await rejects(subscribeFs(fakeAdmin({ variant: unresolved, customer: customerRecord }), who(8), { storefrontSoldOut: true, storefrontCheck: async () => false }), "inventory_unsettled");
  assert.equal((await fsRows(who(8).customerGid)).actor, null, "truly unresolved availability stores nothing, even with a claim");
});

test("null quantity fields: an untracked variant is available (refused); nothing is invented from a missing number", async () => {
  const untracked = fsVariant({ sellableOnlineQuantity: null, inventoryQuantity: null, availableForSale: true, inventoryItem: { id: "gid://shopify/InventoryItem/6100000001", tracked: false } });
  await rejects(subscribeFs(fakeAdmin({ variant: untracked, customer: customerRecord }), who(9)), "variant_available");
});

test("the storefront probe reads only a clear answer for the exact variant, and anything else is 'unknown', never 'sold out'", async () => {
  const { fetchStorefrontAvailability } = await import("../app/models/shopify-lookup.server.js");
  const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error("not json"); return body; } });
  const product = { variants: [{ id: Number(FS_VARIANT), available: false }, { id: 7, available: true }] };
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", FS_VARIANT, { fetchImpl: reply(200, product) }), false);
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", "7", { fetchImpl: reply(200, product) }), true);
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", "8", { fetchImpl: reply(200, product) }), null, "a variant the page does not list");
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", FS_VARIANT, { fetchImpl: reply(302, undefined) }), null, "a password page redirects");
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", FS_VARIANT, { fetchImpl: reply(200, undefined) }), null, "not JSON");
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", FS_VARIANT, { fetchImpl: reply(200, { variants: [{ id: Number(FS_VARIANT) }] }) }), null, "no availability flag");
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", FS_VARIANT, { fetchImpl: async () => { throw new Error("down"); } }), null);
  assert.equal(await fetchStorefrontAvailability(SHOP_B, null, FS_VARIANT, { fetchImpl: reply(200, product) }), null, "no handle");
  assert.equal(await fetchStorefrontAvailability(SHOP_B, "h", "abc", { fetchImpl: reply(200, product) }), null, "not a variant id");
  let url;
  await fetchStorefrontAvailability(SHOP_B, "the-3p-fulfilled-snowboard", FS_VARIANT, { fetchImpl: async (u) => { url = u; return { ok: false }; } });
  assert.equal(url, `https://${SHOP_B}/products/the-3p-fulfilled-snowboard.js`, "only the verified shop's own storefront is contacted");
});

test("the route passes the browser's claim on only when it is exactly true, and the storefront script sends it only for a sold-out variant", () => {
  const route = fs.readFileSync("app/routes/proxy.api.notify.jsx", "utf8");
  assert.match(route, /subscribeToNotify\(identity, variantGid, \{ storefrontSoldOut: body\.storefrontSoldOut === true \}\)/);
  const script = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");
  assert.match(script, /storefrontSoldOut: Boolean\(notifyStock && notifyStock\[key\] === false\)/);
});

test("an ordinary variant (stock not only at a third-party location) ignores the browser's claim, and the storefront is not asked", async () => {
  let asked = 0;
  const check = async () => { asked += 1; return false; };
  for (const [n, topology] of [[10, { thirdPartyOnly: false }], [11, { thirdPartyOnly: null }]]) {
    await rejects(subscribeFs(fakeAdmin({ variant: fsVariant(), customer: customerRecord }), who(n), { storefrontSoldOut: true, storefrontCheck: check, stockTopology: async () => topology }), "variant_available");
    assert.equal((await fsRows(who(n).customerGid)).actor, null);
  }
  assert.equal(asked, 0);
});

test("where the stock sits: only locations of third-party fulfillment services count, and anything unclear is 'unknown'", async () => {
  const { fetchStockTopology } = await import("../app/models/shopify-lookup.server.js");
  const level = (location, available) => ({ location: { id: `gid://shopify/Location/${location}` }, quantities: [{ name: "available", quantity: available }] });
  const services = [{ type: "MANUAL", location: { id: "gid://shopify/Location/1" } }, { type: "THIRD_PARTY", location: { id: "gid://shopify/Location/3" } }];
  const admin = (levels, svc = services, { levelErrors, serviceErrors, hasNext = false } = {}) => ({
    async graphql(query) {
      if (query.includes("StockTopologyLevels")) return { json: async () => ({ errors: levelErrors, data: { node: { inventoryItem: { inventoryLevels: { pageInfo: { hasNextPage: hasNext }, nodes: levels } } } } }) };
      return { json: async () => ({ errors: serviceErrors, data: { shop: { fulfillmentServices: svc } } }) };
    },
  });
  assert.deepEqual(await fetchStockTopology(admin([level(3, 18)]), FS_GID), { thirdPartyOnly: true }, "the exact variant's situation");
  assert.deepEqual(await fetchStockTopology(admin([level(3, 18), level(1, 5)]), FS_GID), { thirdPartyOnly: false }, "stock at an ordinary location too");
  assert.deepEqual(await fetchStockTopology(admin([level(1, 18)]), FS_GID), { thirdPartyOnly: false });
  assert.deepEqual(await fetchStockTopology(admin([level(3, 0), level(1, 4)]), FS_GID), { thirdPartyOnly: false }, "empty third-party stock does not count");
  assert.deepEqual(await fetchStockTopology(admin([level(3, 0)]), FS_GID), { thirdPartyOnly: null }, "no stock anywhere: nothing to say");
  assert.deepEqual(await fetchStockTopology(admin([level(3, 18)], services, { levelErrors: [{ message: "denied" }] }), FS_GID), { thirdPartyOnly: null });
  assert.deepEqual(await fetchStockTopology(admin([level(3, 18)], services, { serviceErrors: [{ message: "denied" }] }), FS_GID), { thirdPartyOnly: null });
  assert.deepEqual(await fetchStockTopology(admin([level(3, 18)], undefined, { hasNext: true }), FS_GID), { thirdPartyOnly: null }, "more than one page of locations");
  assert.deepEqual(await fetchStockTopology({ graphql: async () => { throw new Error("down"); } }, FS_GID), { thirdPartyOnly: null });
});

test("resolveStorefrontPurchasable: Admin decides everywhere except third-party-only stock, where only a readable storefront can", async () => {
  const { resolveStorefrontPurchasable } = await import("../app/models/shopify-lookup.server.js");
  const variant = { seen: { tracked: true, inventoryPolicy: "DENY" }, productHandle: "h" };
  const run = (v, topology, answer) => resolveStorefrontPurchasable({ admin: {}, shopDomain: SHOP_B, variant: v, variantGid: FS_GID }, { stockTopology: async () => topology, storefrontCheck: async () => answer });
  assert.deepEqual(await run(variant, { thirdPartyOnly: false }, false), { purchasable: true, basis: "admin" });
  assert.deepEqual(await run(variant, { thirdPartyOnly: null }, false), { purchasable: true, basis: "admin" });
  assert.deepEqual(await run(variant, { thirdPartyOnly: true }, true), { purchasable: true, basis: "storefront" });
  assert.deepEqual(await run(variant, { thirdPartyOnly: true }, false), { purchasable: false, basis: "storefront" });
  assert.deepEqual(await run(variant, { thirdPartyOnly: true }, null), { purchasable: null, basis: "storefront_unreadable" });
  assert.deepEqual(await run({ ...variant, seen: { tracked: false, inventoryPolicy: "DENY" } }, { thirdPartyOnly: true }, false), { purchasable: true, basis: "admin" }, "untracked inventory is never overridden");
  assert.deepEqual(await run({ ...variant, seen: { tracked: true, inventoryPolicy: "CONTINUE" } }, { thirdPartyOnly: true }, false), { purchasable: true, basis: "admin" }, "overselling allowed is never overridden");
});
