// Integration tests for the Wishlist App Proxy API.
//
// Run from the project root after `npm run build`:
//   node --test tests/wishlist-proxy.test.mjs
//
// The test starts the built server on port 3199 with a DUMMY app secret and signs
// requests exactly like Shopify's App Proxy does. It uses the real MySQL database
// from .env but only touches rows for two unique test shops, which are deleted
// at the end (cascade). The Shopify Session table is never written.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const SECRET = "dummy-secret-for-tests-only";
const RUN = Date.now().toString(36);
const SHOP_A = `kw-test-a-${RUN}.myshopify.com`;
const SHOP_B = `kw-test-b-${RUN}.myshopify.com`;
const SHOP_C = `kw-test-c-${RUN}.myshopify.com`;
const SHOP_D = `kw-test-d-${RUN}.myshopify.com`;
const SHOP_E = `kw-test-e-${RUN}.myshopify.com`;
const SHOP_F = `kw-test-f-${RUN}.myshopify.com`;
const SHOP_G = `kw-test-g-${RUN}.myshopify.com`;
const ALICE = "9000000001";
const BOB = "9000000002";
const PRODUCT = "7000000001";
const OTHER_PRODUCT = "7000000002";
const VARIANT_1 = "8000000001";
const VARIANT_2 = "8000000002";

let server;
let sessionCountBefore;

function sign(params) {
  const message = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce((acc, [key, value]) => `${acc}${key}=${value}`, "");
  return crypto.createHmac("sha256", SECRET).update(message).digest("hex");
}

function proxyUrl(path, { shop = SHOP_A, customer = "", signed = true, tamper, timestamp, base = BASE, query: extra = {} } = {}) {
  const params = {
    shop,
    logged_in_customer_id: customer,
    path_prefix: "/apps/konvert-notify",
    timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    ...extra,
  };
  const signature = sign(params);
  if (tamper) Object.assign(params, tamper);
  const query = new URLSearchParams(params);
  if (signed) query.set("signature", signature);
  return `${base}${path}?${query.toString()}`;
}

async function call(path, options = {}) {
  const { method = "GET", body, contentType = "application/json", ...auth } = options;
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = contentType;
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(proxyUrl(path, auth), init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, json, text, headers: response.headers };
}

const API = "/proxy/api/wishlist";
const NOTIFY_API = "/proxy/api/notify";
// A wishlist item is one VARIANT. Each test product gets its own default variant, like real products do.
const defaultVariant = (productId) => (productId === PRODUCT ? VARIANT_1 : "8" + String(productId).slice(1));
const add = (customer, extra = {}, auth = {}) => {
  const productId = extra.productId ?? PRODUCT;
  return call(API, {
    method: "POST",
    customer,
    ...auth,
    body: { op: "add", productId, variantId: defaultVariant(productId), handle: "test-board", title: "Test Board", ...extra },
  });
};
const cartAdd = (customer, productId = PRODUCT, variantId = defaultVariant(productId), auth = {}) =>
  call(API, { method: "POST", customer, ...auth, body: { op: "cart_add", productId, variantId } });
const remove = (customer, productId = PRODUCT, auth = {}, variantId = defaultVariant(productId)) =>
  call(API, { method: "POST", customer, ...auth, body: { op: "remove", productId, ...(variantId ? { variantId } : {}) } });
const notifyOpen = (customer, auth = {}) =>
  call(NOTIFY_API, { method: "POST", customer, ...auth, body: { op: "open" } });

async function actorFor(shopDomain, customerId) {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return null;
  return prisma.actor.findUnique({
    where: { shopId_customerGid: { shopId: shop.id, customerGid: `gid://shopify/Customer/${customerId}` } },
  });
}
const itemsFor = async (actor) =>
  actor ? prisma.wishlistItem.findMany({ where: { actorId: actor.id } }) : [];
const eventsFor = async (actor, type) =>
  actor ? prisma.activityEvent.findMany({ where: { actorId: actor.id, ...(type ? { type } : {}) } }) : [];

before(async () => {
  sessionCountBefore = await prisma.session.count();
  server = spawn(
    process.execPath,
    ["node_modules/@react-router/serve/bin.js", "build/server/index.js"],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: "production",
        SHOPIFY_API_KEY: "dummy-key",
        SHOPIFY_API_SECRET: SECRET,
        SHOPIFY_APP_URL: BASE,
        SCOPES: "write_products",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  await prisma.shop.deleteMany({ where: { domain: { in: [SHOP_A, SHOP_B, SHOP_C, SHOP_D, SHOP_E, SHOP_F, SHOP_G] } } });
  const leftovers = await prisma.shop.count({ where: { domain: { in: [SHOP_A, SHOP_B, SHOP_C, SHOP_D, SHOP_E, SHOP_F, SHOP_G] } } });
  const sessionCountAfter = await prisma.session.count();
  await prisma.$disconnect();
  server?.kill();
  assert.equal(leftovers, 0, "test shops were removed");
  assert.equal(sessionCountAfter, sessionCountBefore, "Session table untouched");
});

test("rejects requests without a valid Shopify signature", async () => {
  const missing = await call(API, { customer: ALICE, signed: false });
  assert.equal(missing.status, 400);

  const tampered = await call(API, { customer: ALICE, tamper: { logged_in_customer_id: BOB } });
  assert.equal(tampered.status, 400, "changing the customer id invalidates the signature");

  const wrongShop = await call(API, { customer: ALICE, tamper: { shop: SHOP_B } });
  assert.equal(wrongShop.status, 400, "changing the shop invalidates the signature");
});

test("logged-out visitors get a login_required answer and nothing is stored", async () => {
  const list = await call(API, { customer: "" });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, { loggedIn: false, items: [], count: 0 });

  const write = await add("");
  assert.equal(write.status, 401);
  assert.equal(write.json.error, "login_required");
  assert.equal(await prisma.shop.count({ where: { domain: SHOP_A } }), 0, "no shop row created");
});

test("a logged-in customer can add a product; it is stored with activity and a 30-minute session", async () => {
  const response = await add(ALICE);
  assert.equal(response.status, 200);
  assert.equal(response.json.saved, true);
  assert.equal(response.json.count, 1);

  const actor = await actorFor(SHOP_A, ALICE);
  assert.ok(actor, "actor created from the verified customer id");
  const rows = await itemsFor(actor);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].productGid, `gid://shopify/Product/${PRODUCT}`);
  assert.equal(rows[0].variantGid, `gid://shopify/ProductVariant/${VARIANT_1}`);

  const added = await eventsFor(actor, "WISHLIST_ADDED");
  assert.equal(added.length, 1);
  assert.equal(added[0].feature, "WISHLIST");

  const session = await prisma.browsingSession.findUnique({ where: { id: added[0].browsingSessionId } });
  assert.equal(session.expiresAt.getTime() - session.startedAt.getTime(), 30 * 60 * 1000);

  const list = await call(API, { customer: ALICE });
  assert.equal(list.json.loggedIn, true);
  assert.deepEqual(list.json.items, [
    { productId: PRODUCT, variantId: VARIANT_1, title: "Test Board", handle: "test-board" },
  ]);
});

test("a confirmed My Wishlist cart add records a Wishlist event in the customer's Wishlist session", async () => {
  const actor = await actorFor(SHOP_A, ALICE);
  const before = new Date();
  const response = await cartAdd(ALICE);
  assert.equal(response.status, 200);
  assert.equal(response.json.recorded, true);

  const [event] = await eventsFor(actor, "WISHLIST_ADDED_TO_CART");
  assert.equal(event.feature, "WISHLIST");
  assert.equal(event.productGid, `gid://shopify/Product/${PRODUCT}`);
  assert.equal(event.variantGid, `gid://shopify/ProductVariant/${VARIANT_1}`);
  assert.ok(event.occurredAt >= before);
  assert.ok(event.browsingSessionId);
  const session = await prisma.browsingSession.findUnique({ where: { id: event.browsingSessionId } });
  assert.equal(session.actorId, actor.id);
  assert.equal(session.shopId, actor.shopId);

  const mismatched = await cartAdd(ALICE, OTHER_PRODUCT, VARIANT_1);
  assert.equal(mismatched.json.recorded, false);
  assert.equal((await eventsFor(actor, "WISHLIST_ADDED_TO_CART")).length, 1);
});

test("adding the same variant again does not duplicate it or its event; another variant of the same product is a separate entry", async () => {
  const again = await add(ALICE);
  assert.equal(again.status, 200);
  assert.equal(again.json.changed, false, "same variant: quiet no-op");
  assert.equal(again.json.count, 1);
  const actor = await actorFor(SHOP_A, ALICE);
  assert.equal((await itemsFor(actor)).length, 1);
  assert.equal((await eventsFor(actor, "WISHLIST_ADDED")).length, 1, "no second 'added' event");

  const other = await add(ALICE, { variantId: VARIANT_2 });
  assert.equal(other.status, 200);
  assert.equal(other.json.changed, true);
  assert.equal(other.json.count, 2);
  const rows = await itemsFor(actor);
  assert.deepEqual(rows.map((r) => r.variantGid).sort(), [`gid://shopify/ProductVariant/${VARIANT_1}`, `gid://shopify/ProductVariant/${VARIANT_2}`].sort());
  assert.equal(new Set(rows.map((r) => r.productGid)).size, 1, "both entries belong to the same product");
  assert.equal((await eventsFor(actor, "WISHLIST_ADDED")).length, 2);

  // removing one variant leaves the other untouched
  const removed = await remove(ALICE, PRODUCT, {}, VARIANT_2);
  assert.equal(removed.json.changed, true);
  const left = await itemsFor(actor);
  assert.equal(left.length, 1);
  assert.equal(left[0].variantGid, `gid://shopify/ProductVariant/${VARIANT_1}`);
  assert.equal((await eventsFor(actor, "WISHLIST_REMOVED")).length >= 1, true);
});

test("activity does not extend the browsing session", async () => {
  const actor = await actorFor(SHOP_A, ALICE);
  const before = await prisma.browsingSession.findMany({ where: { actorId: actor.id } });
  await add(ALICE, { productId: OTHER_PRODUCT, handle: "other-board", title: "Other Board" });
  const after = await prisma.browsingSession.findMany({ where: { actorId: actor.id } });
  assert.equal(after.length, 1, "same session reused");
  assert.equal(after[0].expiresAt.getTime(), before[0].expiresAt.getTime(), "expiry unchanged");
  await remove(ALICE, OTHER_PRODUCT);
});

test("an expired session is replaced by a new 30-minute session", async () => {
  const actor = await actorFor(SHOP_A, ALICE);
  await prisma.$executeRaw`UPDATE BrowsingSession SET startedAt = startedAt - INTERVAL 40 MINUTE, expiresAt = expiresAt - INTERVAL 40 MINUTE WHERE actorId = ${actor.id}`;
  await add(ALICE, { productId: OTHER_PRODUCT, handle: "other-board", title: "Other Board" });
  const sessions = await prisma.browsingSession.findMany({ where: { actorId: actor.id }, orderBy: { startedAt: "asc" } });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].expiresAt.getTime() - sessions[1].startedAt.getTime(), 30 * 60 * 1000);
  assert.ok(sessions[1].expiresAt > new Date());
  await remove(ALICE, OTHER_PRODUCT);
});

test("customers are isolated from each other", async () => {
  const bobList = await call(API, { customer: BOB });
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.json.items, [], "Bob sees nothing of Alice's wishlist");

  const bobRemove = await remove(BOB);
  assert.equal(bobRemove.status, 200);
  assert.equal((await itemsFor(await actorFor(SHOP_A, ALICE))).length, 1, "Alice's item survives Bob's remove");

  const bobAdd = await add(BOB);
  assert.equal(bobAdd.json.count, 1);
  assert.equal((await itemsFor(await actorFor(SHOP_A, ALICE))).length, 1);
  assert.equal((await itemsFor(await actorFor(SHOP_A, BOB))).length, 1);
});

test("identity and shop come only from the signed query, never from the request body", async () => {
  const response = await call(API, {
    method: "POST",
    customer: ALICE,
    body: {
      op: "add",
      productId: "7000000099",
      variantId: "8000000099",
      handle: "sneaky",
      title: "Sneaky",
      customerId: BOB,
      logged_in_customer_id: BOB,
      shop: SHOP_B,
      shopId: 1,
      actorId: 1,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await prisma.shop.count({ where: { domain: SHOP_B } }), 0, "body shop ignored");
  const bobItems = await itemsFor(await actorFor(SHOP_A, BOB));
  assert.equal(bobItems.some((i) => i.productGid.endsWith("/7000000099")), false, "Bob not affected");
  const aliceItems = await itemsFor(await actorFor(SHOP_A, ALICE));
  assert.equal(aliceItems.some((i) => i.productGid.endsWith("/7000000099")), true);
  await remove(ALICE, "7000000099");
});

test("the same customer id in a different shop is a separate customer", async () => {
  const other = await add(ALICE, {}, { shop: SHOP_B });
  assert.equal(other.json.count, 1);
  const shopA = await actorFor(SHOP_A, ALICE);
  const shopB = await actorFor(SHOP_B, ALICE);
  assert.notEqual(shopA.id, shopB.id);
  assert.notEqual(shopA.shopId, shopB.shopId);

  const listB = await call(API, { customer: ALICE, shop: SHOP_B });
  assert.equal(listB.json.items.length, 1);
  await remove(ALICE, PRODUCT, { shop: SHOP_B });
  assert.equal((await itemsFor(shopA)).length, 1, "shop A wishlist untouched");
});

test("ten simultaneous adds create exactly one row and one event", async () => {
  const actor = await actorFor(SHOP_A, BOB);
  await remove(BOB);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => add(BOB, { productId: "7000000050", handle: "race", title: "Race" })),
  );
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const rows = (await itemsFor(actor)).filter((i) => i.productGid.endsWith("/7000000050"));
  assert.equal(rows.length, 1);
  const events = (await eventsFor(actor, "WISHLIST_ADDED")).filter((e) => e.productGid.endsWith("/7000000050"));
  assert.equal(events.length, 1);
  await remove(BOB, "7000000050");
});

test("removing deletes the item and records one event; removing again records nothing", async () => {
  const actor = await actorFor(SHOP_A, ALICE);
  const removeEventsBefore = (await eventsFor(actor, "WISHLIST_REMOVED")).length;
  const first = await remove(ALICE);
  assert.equal(first.json.saved, false);
  assert.equal(first.json.count, 0);
  assert.equal((await itemsFor(actor)).length, 0);
  assert.equal((await eventsFor(actor, "WISHLIST_REMOVED")).length, removeEventsBefore + 1);

  const second = await remove(ALICE);
  assert.equal(second.status, 200);
  assert.equal((await eventsFor(actor, "WISHLIST_REMOVED")).length, removeEventsBefore + 1);
});

test("click events are only recorded for products on the customer's wishlist", async () => {
  const actor = await actorFor(SHOP_A, ALICE);
  await add(ALICE);
  const click = await call(API, { method: "POST", customer: ALICE, body: { op: "click", productId: PRODUCT, variantId: VARIANT_1 } });
  assert.equal(click.status, 200);
  assert.equal((await eventsFor(actor, "WISHLIST_PRODUCT_CLICKED")).length, 1);

  await call(API, { method: "POST", customer: ALICE, body: { op: "click", productId: "7000000077" } });
  assert.equal((await eventsFor(actor, "WISHLIST_PRODUCT_CLICKED")).length, 1, "unknown product ignored");
});

test("bad input is rejected", async () => {
  const wrongType = await call(API, {
    method: "POST", customer: ALICE, contentType: "text/plain",
    body: JSON.stringify({ op: "add", productId: PRODUCT, handle: "x", title: "x" }),
  });
  assert.equal(wrongType.status, 415, "form/text posts are refused (CSRF protection)");

  const badJson = await call(API, { method: "POST", customer: ALICE, body: "{not json" });
  assert.equal(badJson.status, 400);

  const noVariant = await call(API, { method: "POST", customer: ALICE, body: { op: "add", productId: PRODUCT, handle: "x", title: "x" } });
  assert.equal(noVariant.status, 400, "a wishlist item must be a specific variant");
  const badVariant = await call(API, { method: "POST", customer: ALICE, body: { op: "add", productId: PRODUCT, variantId: "not-a-number", handle: "x", title: "x" } });
  assert.equal(badVariant.status, 400);

  const badId = await call(API, { method: "POST", customer: ALICE, body: { op: "add", productId: "abc", variantId: VARIANT_1, handle: "x", title: "x" } });
  assert.equal(badId.status, 400);

  const badHandle = await call(API, { method: "POST", customer: ALICE, body: { op: "add", productId: PRODUCT, variantId: VARIANT_1, handle: "../etc/passwd", title: "x" } });
  assert.equal(badHandle.status, 400);

  const badOp = await call(API, { method: "POST", customer: ALICE, body: { op: "drop", productId: PRODUCT } });
  assert.equal(badOp.status, 400);
});

test("a wishlist is limited to 200 items", async () => {
  const actor = await actorFor(SHOP_A, BOB);
  const existing = await prisma.wishlistItem.count({ where: { actorId: actor.id } });
  await prisma.wishlistItem.createMany({
    data: Array.from({ length: 200 - existing }, (_, i) => ({
      shopId: actor.shopId,
      actorId: actor.id,
      productGid: `gid://shopify/Product/61${String(i).padStart(6, "0")}`,
      productTitle: "Filler",
      productHandle: "filler",
    })),
  });
  const full = await add(BOB, { productId: "7000000060", handle: "one-too-many", title: "One too many" });
  assert.equal(full.status, 409);
  assert.equal(full.json.error, "wishlist_full");
});

test("the My Wishlist page is served as Liquid, only through a valid signature", async () => {
  const page = await call("/proxy/my-wishlist", { customer: ALICE });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /application\/liquid/);
  assert.match(page.text, /data-kw-page/);
  assert.match(page.text, /Wishlisted products/);
  assert.match(page.text, /data-kw-page-count/, "item count slot for the script to fill");
  assert.match(page.text, /data-kw-select/, "Select button for bulk actions");
  assert.match(page.text, /data-kw-page-body/, "container the script renders the table into");
  assert.match(page.text, /\{% if customer %\}/);

  const unsigned = await call("/proxy/my-wishlist", { customer: ALICE, signed: false });
  assert.equal(unsigned.status, 400);
});

// Regression: a real store has an offline Session row. Shopify's appProxy
// authentication used to load it and try to refresh an expired token over the
// network; any failure there became an unhandled 500 ("error in the
// third-party application") on every storefront request.
test("storefront requests still work when the stored offline session is expired and cannot be refreshed", async () => {
  const sessionId = `offline_${SHOP_C}`;
  await prisma.session.create({
    data: {
      id: sessionId,
      shop: SHOP_C,
      state: "test",
      isOnline: false,
      accessToken: "shpat_dummy_not_a_real_token",
      expires: new Date(Date.now() - 60 * 60 * 1000),
      refreshToken: "dummy-refresh-token",
      refreshTokenExpires: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  try {
    const page = await call("/proxy/my-wishlist", { customer: ALICE, shop: SHOP_C });
    assert.equal(page.status, 200, "My Wishlist page renders");
    assert.match(page.headers.get("content-type"), /application\/liquid/);

    const saved = await add(ALICE, {}, { shop: SHOP_C });
    assert.equal(saved.status, 200, "add works");
    assert.equal(saved.json.count, 1);

    const list = await call(API, { customer: ALICE, shop: SHOP_C });
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);

    const unsigned = await call(API, { customer: ALICE, shop: SHOP_C, signed: false });
    assert.equal(unsigned.status, 400, "still rejects unsigned requests");
  } finally {
    await prisma.session.delete({ where: { id: sessionId } });
  }
});

test("responses carry a request id, and a stale signed timestamp is rejected", async () => {
  const ok = await call(API, { customer: ALICE });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("x-kw-request-id") ?? "", /^[0-9a-f]{8}$/);

  const old = Math.floor(Date.now() / 1000) - 3600;
  const stale = await call(API, { customer: ALICE, timestamp: old });
  assert.equal(stale.status, 400, "a correctly signed but old request is refused");
});

// Regression for an unexplained 500 on GET /apps/konvert-notify/api/wishlist:
// when the database is unreachable the route must answer with a JSON 500 that
// carries a request id, log a sanitised line, and keep secrets out of the log.
test("GET wishlist: a database failure gives a diagnosable 500 and a log without secrets", async () => {
  const port = 3198;
  const base = `http://localhost:${port}`;
  const dbPassword = "TopSecretDbPassword";
  let output = "";
  const broken = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "production",
      SHOPIFY_API_KEY: "dummy-key",
      SHOPIFY_API_SECRET: SECRET,
      SHOPIFY_APP_URL: base,
      SCOPES: "write_products",
      DATABASE_URL: `mysql://kw_user:${dbPassword}@127.0.0.1:1/nodb`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  broken.stdout.on("data", (c) => (output += c));
  broken.stderr.on("data", (c) => (output += c));
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      try { await fetch(base + "/"); break; } catch {
        if (Date.now() > deadline) throw new Error("server did not start:\n" + output);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const loggedOut = await fetch(proxyUrl(API, { customer: "", base }));
    assert.equal(loggedOut.status, 200, "logged-out GET needs no database");

    const response = await fetch(proxyUrl(API, { customer: ALICE, base }));
    assert.equal(response.status, 500);
    const json = await response.json();
    assert.equal(json.error, "server_error");
    assert.match(json.requestId, /^[0-9a-f]{8}$/);
    assert.equal(response.headers.get("x-kw-request-id"), json.requestId);

    await new Promise((r) => setTimeout(r, 300));
    assert.match(output, new RegExp("GET wishlist failed.*" + json.requestId), "failure logged with request id");
    assert.match(output, /PrismaClient|P1001|Can't reach|Authentication/i, "error class or code logged");
    // Only the app's own log lines are checked: react-router-serve's access log
    // prints the full request URL (signature and customer id) and is not ours.
    const ours = output
      .split(String.fromCharCode(10))
      .filter((line) => line.includes("[wishlist]"))
      .join(" ");
    assert.ok(ours.length > 0);
    for (const secret of [dbPassword, SECRET, ALICE, "signature="]) {
      assert.equal(ours.includes(secret), false, "app log must not contain " + secret.slice(0, 6) + "...");
    }
  } finally {
    broken.kill();
  }
});

// Inventory endpoint used by the My Wishlist quantity selector.
test("the inventory endpoint needs a valid signature and a logged-in customer, and validates ids", async () => {
  const INVENTORY = "/proxy/api/inventory";
  const withIds = (ids, auth = {}) => call(INVENTORY, { ...auth, query: { ids } });

  const unsigned = await withIds("1", { customer: ALICE, signed: false });
  assert.equal(unsigned.status, 400);

  const loggedOut = await withIds("1", { customer: "" });
  assert.equal(loggedOut.status, 401);
  assert.equal(loggedOut.json.error, "login_required");

  for (const bad of ["", "abc", "1,gid://shopify/ProductVariant/2", Array.from({ length: 51 }, (_, i) => i + 1).join(",")]) {
    const response = await withIds(bad, { customer: ALICE });
    assert.equal(response.status, 400, "rejects ids: " + bad.slice(0, 20));
  }
});

test("when Shopify's Admin API cannot be used the inventory endpoint degrades to 'unavailable' instead of failing", async () => {
  // The test shops have no offline Admin session, so the lookup cannot run.
  const response = await call("/proxy/api/inventory", { customer: ALICE, query: { ids: "8000000001,8000000002" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { variants: {}, unavailable: true });
  assert.match(response.headers.get("x-kw-request-id") ?? "", /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// Browsing sessions are feature-specific. Wishlist operations open or reuse
// WISHLIST sessions; only a Notify Me interaction opens or reuses NOTIFY_ME.
// Ordinary storefront requests never create an Actor or a session.
// ---------------------------------------------------------------------------
const CAROL = "9000000003";
const DAVE = "9000000004";
const openPage = (customer, auth = {}, body = { op: "open" }) => call(API, { method: "POST", customer, ...auth, body });
const sessionsFor = async (actor, feature = "WISHLIST") =>
  actor ? prisma.browsingSession.findMany({ where: { actorId: actor.id, feature }, orderBy: { startedAt: "asc" } }) : [];
const allSessionsFor = async (actor) =>
  actor ? prisma.browsingSession.findMany({ where: { actorId: actor.id }, orderBy: { startedAt: "asc" } }) : [];
const THIRTY_MIN = 30 * 60 * 1000;
const rowsFor = async (shopDomain) => {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return { shop: 0, actors: 0, sessions: 0, events: 0 };
  return {
    shop: 1,
    actors: await prisma.actor.count({ where: { shopId: shop.id } }),
    sessions: await prisma.browsingSession.count({ where: { shopId: shop.id } }),
    events: await prisma.activityEvent.count({ where: { shopId: shop.id } }),
  };
};

test("ordinary storefront requests create no shop, actor or session, even for a logged-in customer", async () => {
  // Every storefront page makes at most this one read-only request for a logged-in customer.
  const list = await call(API, { customer: ALICE, shop: SHOP_E });
  assert.equal(list.status, 200);
  assert.equal(list.json.loggedIn, true);
  // The My Wishlist Liquid page itself is also read-only; only the page script's "open" call opens a session.
  const page = await call("/proxy/my-wishlist", { customer: ALICE, shop: SHOP_E });
  assert.equal(page.status, 200);
  const loggedOutList = await call(API, { customer: "", shop: SHOP_E });
  assert.equal(loggedOutList.status, 200);
  assert.deepEqual(await rowsFor(SHOP_E), { shop: 0, actors: 0, sessions: 0, events: 0 });
});

test("open: an invalid signature or a logged-out visitor cannot create a session", async () => {
  const unsigned = await openPage(ALICE, { shop: SHOP_E, signed: false });
  assert.equal(unsigned.status, 400);
  const tampered = await openPage(ALICE, { shop: SHOP_E, tamper: { logged_in_customer_id: BOB } });
  assert.equal(tampered.status, 400, "changing the customer id invalidates the signature");
  const wrongShop = await openPage(ALICE, { shop: SHOP_E, tamper: { shop: SHOP_D } });
  assert.equal(wrongShop.status, 400, "changing the shop invalidates the signature");

  const loggedOut = await openPage("", { shop: SHOP_E });
  assert.equal(loggedOut.status, 401);
  assert.equal(loggedOut.json.error, "login_required");

  assert.deepEqual(await rowsFor(SHOP_E), { shop: 0, actors: 0, sessions: 0, events: 0 });
  assert.deepEqual(await rowsFor(SHOP_D), { shop: 0, actors: 0, sessions: 0, events: 0 }, "nothing leaked into the other shop either");
});

test("open: opening My Wishlist creates a fixed 30-minute session and no activity event", async () => {
  const response = await openPage(ALICE, { shop: SHOP_D });
  assert.equal(response.status, 200);
  assert.deepEqual({ ok: response.json.ok, opened: response.json.opened }, { ok: true, opened: true });

  const actor = await actorFor(SHOP_D, ALICE);
  assert.ok(actor, "actor created from the verified customer id");
  const sessions = await sessionsFor(actor);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].expiresAt.getTime() - sessions[0].startedAt.getTime(), THIRTY_MIN);
  assert.equal((await eventsFor(actor)).length, 0, "no fake add/remove/click event just to open a session");
  assert.equal((await itemsFor(actor)).length, 0, "and no wishlist row");
});

test("open: opening the page again reuses the session and never extends it", async () => {
  const actor = await actorFor(SHOP_D, ALICE);
  const [before] = await sessionsFor(actor);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await openPage(ALICE, { shop: SHOP_D })).status, 200);

  const after = await sessionsFor(actor);
  assert.equal(after.length, 1, "no second session");
  assert.equal(after[0].id, before.id);
  assert.equal(after[0].expiresAt.getTime(), before.expiresAt.getTime(), "expiresAt unchanged by activity");
  assert.equal(after[0].startedAt.getTime(), before.startedAt.getTime());
  assert.equal((await eventsFor(actor)).length, 0);
});

test("one session serves open, add, click and remove within 30 minutes; only real wishlist actions are events", async () => {
  const actor = await actorFor(SHOP_D, ALICE);
  const [session] = await sessionsFor(actor);

  assert.equal((await add(ALICE, {}, { shop: SHOP_D })).status, 200);
  const click = await call(API, { method: "POST", customer: ALICE, shop: SHOP_D, body: { op: "click", productId: PRODUCT, variantId: VARIANT_1 } });
  assert.equal(click.status, 200);
  assert.equal((await remove(ALICE, PRODUCT, { shop: SHOP_D })).status, 200);

  assert.equal((await sessionsFor(actor)).length, 1, "still exactly one session");
  const events = await eventsFor(actor);
  assert.deepEqual(events.map((e) => e.type).sort(), ["WISHLIST_ADDED", "WISHLIST_PRODUCT_CLICKED", "WISHLIST_REMOVED"]);
  assert.ok(events.every((e) => e.browsingSessionId === session.id), "every event belongs to that session");
});

test("a first-ever remove (nothing to remove) still opens a session, without an event", async () => {
  const response = await remove(CAROL, PRODUCT, { shop: SHOP_D });
  assert.equal(response.status, 200);
  assert.equal(response.json.changed, false);
  const actor = await actorFor(SHOP_D, CAROL);
  assert.equal((await sessionsFor(actor)).length, 1);
  assert.equal((await eventsFor(actor)).length, 0);
});

test("after the 30 minutes have passed the next wishlist action starts a new session; the old one is never revived", async () => {
  const actor = await actorFor(SHOP_D, ALICE);
  await prisma.$executeRaw`UPDATE BrowsingSession SET startedAt = startedAt - INTERVAL 40 MINUTE, expiresAt = expiresAt - INTERVAL 40 MINUTE WHERE actorId = ${actor.id}`;
  const [expired] = await sessionsFor(actor);

  assert.equal((await add(ALICE, {}, { shop: SHOP_D })).status, 200);
  const sessions = await sessionsFor(actor);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].expiresAt.getTime(), expired.expiresAt.getTime(), "the expired session is not extended");
  assert.equal(sessions[1].expiresAt.getTime() - sessions[1].startedAt.getTime(), THIRTY_MIN);
  assert.ok(sessions[1].expiresAt > new Date(), "the new session is live");
  const added = (await eventsFor(actor, "WISHLIST_ADDED")).at(-1);
  assert.equal(added.browsingSessionId, sessions[1].id, "the new add belongs to the new session");
  await remove(ALICE, PRODUCT, { shop: SHOP_D });
});

test("concurrent mixed wishlist requests create exactly one session", async () => {
  const jobs = [
    ...Array.from({ length: 4 }, () => openPage(DAVE, { shop: SHOP_D })),
    ...Array.from({ length: 3 }, (_, i) => add(DAVE, { productId: `70000001${i}`, handle: `race-${i}`, title: "Race" }, { shop: SHOP_D })),
    ...Array.from({ length: 3 }, () => remove(DAVE, PRODUCT, { shop: SHOP_D })),
  ];
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const actor = await actorFor(SHOP_D, DAVE);
  assert.equal((await sessionsFor(actor)).length, 1, "no duplicate sessions");
  assert.equal((await eventsFor(actor, "WISHLIST_ADDED")).length, 3);
});

test("identity and shop come only from the signed query, and shops/customers stay isolated", async () => {
  const response = await openPage(ALICE, { shop: SHOP_D }, {
    op: "open",
    customerId: "9000000099",
    logged_in_customer_id: "9000000099",
    shop: SHOP_E,
    shopId: 1,
    actorId: 1,
  });
  assert.equal(response.status, 200);
  assert.equal(await actorFor(SHOP_D, "9000000099"), null, "body customer id ignored");
  assert.equal((await rowsFor(SHOP_E)).shop, 0, "body shop ignored");

  const other = await openPage(ALICE, { shop: SHOP_E });
  assert.equal(other.status, 200);
  const inD = await actorFor(SHOP_D, ALICE);
  const inE = await actorFor(SHOP_E, ALICE);
  assert.notEqual(inD.id, inE.id, "same customer id in another shop is a different actor");
  assert.equal((await sessionsFor(inE)).length, 1);
  assert.equal((await sessionsFor(inD)).length, 2, "the other shop's activity did not touch this shop's sessions");
});

test("open: only POST with JSON is accepted, and a GET never opens a session", async () => {
  const before = (await rowsFor(SHOP_D)).sessions;
  const wrongType = await call(API, { method: "POST", customer: ALICE, shop: SHOP_D, contentType: "text/plain", body: JSON.stringify({ op: "open" }) });
  assert.equal(wrongType.status, 415);
  const get = await call(API, { method: "GET", customer: ALICE, shop: SHOP_D });
  assert.equal(get.status, 200);
  assert.equal((await rowsFor(SHOP_D)).sessions, before);
});

test("Notify Me session opening requires a valid signed logged-in customer", async () => {
  const unsigned = await notifyOpen(ALICE, { shop: SHOP_F, signed: false });
  assert.equal(unsigned.status, 400);
  const loggedOut = await notifyOpen("", { shop: SHOP_F });
  assert.equal(loggedOut.status, 401);
  assert.equal(loggedOut.json.error, "login_required");
  assert.deepEqual(await rowsFor(SHOP_F), { shop: 0, actors: 0, sessions: 0, events: 0 });
});

test("Notify Me and Wishlist sessions are independent and fixed to their feature", async () => {
  const customer = "9000000098";
  const notify = await notifyOpen(customer, { shop: SHOP_E });
  assert.equal(notify.status, 200);
  assert.deepEqual(
    { ok: notify.json.ok, opened: notify.json.opened },
    { ok: true, opened: true },
  );

  assert.equal((await openPage(customer, { shop: SHOP_E })).status, 200);
  const actor = await actorFor(SHOP_E, customer);
  const sessions = await allSessionsFor(actor);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((session) => session.feature).sort(), ["NOTIFY_ME", "WISHLIST"]);
  assert.ok(
    sessions.every((session) => session.expiresAt.getTime() - session.startedAt.getTime() === THIRTY_MIN),
  );
  assert.equal((await eventsFor(actor)).length, 0, "opening either page creates no fake activity");

  const notifySession = (await sessionsFor(actor, "NOTIFY_ME"))[0];
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await notifyOpen(customer, { shop: SHOP_E })).status, 200);
  const reused = (await sessionsFor(actor, "NOTIFY_ME"))[0];
  assert.equal(reused.id, notifySession.id);
  assert.equal(reused.expiresAt.getTime(), notifySession.expiresAt.getTime());
  assert.equal((await allSessionsFor(actor)).length, 2, "Notify Me did not reuse the Wishlist session");
});

test("the database rejects an activity event whose feature differs from its session", async () => {
  const customer = "9000000097";
  assert.equal((await notifyOpen(customer, { shop: SHOP_E })).status, 200);
  assert.equal((await openPage(customer, { shop: SHOP_E })).status, 200);
  const actor = await actorFor(SHOP_E, customer);
  const shop = await prisma.shop.findUnique({ where: { domain: SHOP_E } });
  const wishlistSession = (await sessionsFor(actor, "WISHLIST"))[0];

  await assert.rejects(
    prisma.activityEvent.create({
      data: {
        shopId: shop.id,
        actorId: actor.id,
        browsingSessionId: wishlistSession.id,
        type: "NOTIFY_SUBSCRIBED",
        feature: "NOTIFY_ME",
      },
    }),
    (error) => error.code === "P2003",
    "the composite foreign key enforces session/event feature agreement",
  );
});

test("the old general 'visit' operation no longer exists", async () => {
  const response = await openPage(ALICE, { shop: SHOP_D }, { op: "visit" });
  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------------------
// Wishlist items are specific VARIANTS. Uniqueness is per customer + variant, and
// older rows saved without a variant (variantGid NULL) stay valid.
// ---------------------------------------------------------------------------
const CAROL_V = "9000000005";
const PRODUCT_A = "7100000001";
const SMALL = "8100000001";
const LARGE = "8100000002";
const gid = (type, id) => `gid://shopify/${type}/${id}`;
const addVariant = (customer, variantId, productId = PRODUCT_A, auth = { shop: SHOP_D }) =>
  add(customer, { productId, variantId, handle: "product-a", title: "Product A" }, auth);
const removeVariant = (customer, variantId, productId = PRODUCT_A, auth = { shop: SHOP_D }) => remove(customer, productId, auth, variantId);
const listFor = (customer, auth = { shop: SHOP_D }) => call(API, { customer, ...auth });

test("variants: the same customer can save two variants of one product as separate entries", async () => {
  assert.equal((await addVariant(CAROL_V, SMALL)).json.changed, true);
  const large = await addVariant(CAROL_V, LARGE);
  assert.equal(large.status, 200);
  assert.equal(large.json.changed, true);
  assert.equal(large.json.count, 2);

  const actor = await actorFor(SHOP_D, CAROL_V);
  const rows = await itemsFor(actor);
  assert.deepEqual(rows.map((r) => r.variantGid).sort(), [gid("ProductVariant", SMALL), gid("ProductVariant", LARGE)]);
  assert.equal(new Set(rows.map((r) => r.productGid)).size, 1, "one product, two variants");

  const list = await listFor(CAROL_V);
  assert.deepEqual(list.json.items.map((i) => i.variantId).sort(), [SMALL, LARGE]);
  assert.equal(list.json.count, 2);
  assert.equal((await eventsFor(actor, "WISHLIST_ADDED")).length, 2, "each variant logs its own add");
});

test("variants: the same variant cannot be saved twice by the same customer", async () => {
  const again = await addVariant(CAROL_V, SMALL);
  assert.equal(again.status, 200);
  assert.equal(again.json.changed, false);
  assert.equal(again.json.count, 2, "still two entries");

  const actor = await actorFor(SHOP_D, CAROL_V);
  assert.equal((await itemsFor(actor)).length, 2);
  assert.equal((await eventsFor(actor, "WISHLIST_ADDED")).length, 2, "no extra event for the repeat");
});

test("variants: concurrent saves of the same variant create exactly one row", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => addVariant(CAROL_V, "8100000009", "7100000009")));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const actor = await actorFor(SHOP_D, CAROL_V);
  const rows = (await itemsFor(actor)).filter((r) => r.variantGid === gid("ProductVariant", "8100000009"));
  assert.equal(rows.length, 1);
  assert.equal((await eventsFor(actor, "WISHLIST_ADDED")).filter((e) => e.variantGid === gid("ProductVariant", "8100000009")).length, 1);
  await removeVariant(CAROL_V, "8100000009", "7100000009");
});

test("variants: removing one variant leaves the other variants of the product untouched", async () => {
  const actor = await actorFor(SHOP_D, CAROL_V);
  const removed = await removeVariant(CAROL_V, SMALL);
  assert.equal(removed.json.changed, true);
  assert.equal(removed.json.count, 1);

  const rows = await itemsFor(actor);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].variantGid, gid("ProductVariant", LARGE), "Large is still saved");
  const removedEvents = await eventsFor(actor, "WISHLIST_REMOVED");
  assert.equal(removedEvents.at(-1).variantGid, gid("ProductVariant", SMALL), "the event names the exact variant");

  const again = await removeVariant(CAROL_V, SMALL);
  assert.equal(again.json.changed, false, "removing a variant that is not saved changes nothing");
  assert.equal((await itemsFor(actor)).length, 1);
});

test("variants: customers and shops stay isolated for the same variant id", async () => {
  await addVariant(CAROL_V, SMALL); // Carol: Small + Large again
  const otherCustomer = await addVariant(DAVE, SMALL);
  assert.equal(otherCustomer.json.changed, true, "another customer can save the same variant");
  const otherShop = await addVariant(CAROL_V, SMALL, PRODUCT_A, { shop: SHOP_E });
  assert.equal(otherShop.json.changed, true, "the same customer id in another shop is a different customer");

  assert.equal((await removeVariant(DAVE, SMALL)).json.changed, true);
  assert.equal((await listFor(CAROL_V)).json.items.length, 2, "Carol's wishlist untouched by Dave");
  assert.equal((await listFor(CAROL_V, { shop: SHOP_E })).json.items.length, 1, "the other shop's entry untouched");
  await removeVariant(CAROL_V, SMALL, PRODUCT_A, { shop: SHOP_E });
});

test("variants: an add without a variant is refused", async () => {
  const response = await call(API, { method: "POST", customer: CAROL_V, shop: SHOP_D, body: { op: "add", productId: PRODUCT_A, handle: "product-a", title: "A" } });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "invalid_request");
});

test("legacy rows saved before items were variant-specific (no variant) stay valid, listed and removable", async () => {
  const actor = await actorFor(SHOP_D, CAROL_V);
  const shop = await prisma.shop.findUnique({ where: { domain: SHOP_D } });
  // two legacy rows (variantGid NULL): MySQL's unique index allows any number of NULLs
  await prisma.wishlistItem.createMany({
    data: ["7100000020", "7100000021"].map((id) => ({
      shopId: shop.id, actorId: actor.id, productGid: gid("Product", id), variantGid: null, productTitle: "Legacy " + id, productHandle: "legacy-" + id,
    })),
  });

  const list = await listFor(CAROL_V);
  const legacy = list.json.items.filter((i) => i.variantId === null);
  assert.equal(legacy.length, 2, "listed, with variantId null so the client never guesses a variant");
  assert.ok(list.json.items.some((i) => i.variantId === LARGE), "variant entries are unaffected");

  // saving a specific variant of a legacy product adds a separate, explicit entry
  const explicit = await addVariant(CAROL_V, "8100000020", "7100000020");
  assert.equal(explicit.json.changed, true);
  assert.equal((await itemsFor(actor)).filter((r) => r.productGid === gid("Product", "7100000020")).length, 2, "legacy row kept next to the explicit one");

  // a request without a variant removes only the legacy row, never a variant entry
  const removedLegacy = await remove(CAROL_V, "7100000020", { shop: SHOP_D }, null);
  assert.equal(removedLegacy.json.changed, true);
  const remaining = (await itemsFor(actor)).filter((r) => r.productGid === gid("Product", "7100000020"));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].variantGid, gid("ProductVariant", "8100000020"));

  // a variant removal never touches a legacy row
  const stillThere = (await itemsFor(actor)).filter((r) => r.variantGid === null);
  assert.equal(stillThere.length, 1);
  await removeVariant(CAROL_V, "8100000020", "7100000020");
  assert.equal((await remove(CAROL_V, "7100000021", { shop: SHOP_D }, null)).json.changed, true);
});

test("the database itself refuses a duplicate (customer, variant) and has no product-level uniqueness left", async () => {
  const actor = await actorFor(SHOP_D, CAROL_V);
  const shop = await prisma.shop.findUnique({ where: { domain: SHOP_D } });
  const row = (variantGid) => ({ shopId: shop.id, actorId: actor.id, productGid: gid("Product", PRODUCT_A), variantGid, productTitle: "A", productHandle: "a" });
  await assert.rejects(
    prisma.wishlistItem.create({ data: row(gid("ProductVariant", LARGE)) }),
    (error) => error.code === "P2002",
    "unique(actorId, variantGid) blocks a direct duplicate insert",
  );

  const indexes = await prisma.$queryRaw`SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'WishlistItem' GROUP BY INDEX_NAME, NON_UNIQUE`;
  const byName = Object.fromEntries(indexes.map((i) => [i.name, Number(i.nonUnique)]));
  assert.equal(byName.WishlistItem_actorId_variantGid_key, 0, "variant-level unique index exists");
  assert.equal("WishlistItem_actorId_productGid_key" in byName, false, "the old product-level unique index is gone");
  assert.equal(byName.WishlistItem_actorId_productGid_idx, 1, "a plain lookup index replaced it");
});

// ---------------------------------------------------------------------------
// Saving a variant is not buying it: availability and stock never decide whether a
// wishlist save is accepted. (The storefront reports them; the server does not look.)
// ---------------------------------------------------------------------------
const OOS_PRODUCT = "7200000001";
const OOS_VARIANT = "8200000001"; // sold out: DENY policy, zero sellable
const IN_VARIANT = "8200000002";  // in stock

test("an out-of-stock variant is saved exactly like an in-stock one: availability never enters the save", async () => {
  // The body may claim whatever it likes about stock; none of it is read, stored or trusted.
  const soldOut = await call(API, {
    method: "POST", customer: CAROL_V, shop: SHOP_D,
    body: { op: "add", productId: OOS_PRODUCT, variantId: OOS_VARIANT, handle: "out-of-stock-board", title: "Out of Stock Board", available: false, availableForSale: false, inventoryQuantity: 0 },
  });
  assert.equal(soldOut.status, 200);
  assert.equal(soldOut.json.saved, true);
  assert.equal(soldOut.json.changed, true);

  const inStock = await call(API, {
    method: "POST", customer: CAROL_V, shop: SHOP_D,
    body: { op: "add", productId: OOS_PRODUCT, variantId: IN_VARIANT, handle: "out-of-stock-board", title: "Out of Stock Board", available: true, inventoryQuantity: 5 },
  });
  assert.equal(inStock.status, 200);
  assert.equal(inStock.json.changed, true);

  const actor = await actorFor(SHOP_D, CAROL_V);
  const rows = (await itemsFor(actor)).filter((r) => r.productGid === gid("Product", OOS_PRODUCT));
  assert.deepEqual(rows.map((r) => r.variantGid).sort(), [gid("ProductVariant", OOS_VARIANT), gid("ProductVariant", IN_VARIANT)].sort(), "both variants saved, as separate entries");
  assert.equal(Object.keys(rows[0]).some((k) => /avail|stock|inventory/i.test(k)), false, "no availability or stock column exists on a wishlist item");

  // listing reports them like any other item; nothing marks one as purchasable
  const list = await listFor(CAROL_V);
  const listed = list.json.items.filter((i) => i.productId === OOS_PRODUCT);
  assert.deepEqual(listed.map((i) => i.variantId).sort(), [OOS_VARIANT, IN_VARIANT].sort());
  assert.equal(listed.every((i) => !("available" in i) && !("inventory" in i)), true);

  // a repeat of the sold-out variant is still a quiet no-op, and removal still isolates variants
  const again = await call(API, { method: "POST", customer: CAROL_V, shop: SHOP_D, body: { op: "add", productId: OOS_PRODUCT, variantId: OOS_VARIANT, handle: "out-of-stock-board", title: "Out of Stock Board" } });
  assert.equal(again.json.changed, false);
  assert.equal((await removeVariant(CAROL_V, OOS_VARIANT, OOS_PRODUCT)).json.changed, true);
  const left = (await itemsFor(actor)).filter((r) => r.productGid === gid("Product", OOS_PRODUCT));
  assert.deepEqual(left.map((r) => r.variantGid), [gid("ProductVariant", IN_VARIANT)], "the in-stock variant is untouched");
  await removeVariant(CAROL_V, IN_VARIANT, OOS_PRODUCT);
});

// ======================= merchant switches (Settings) =======================
test("features endpoint: signed, works for logged-out visitors, creates nothing, and follows the saved switches", async () => {
  const unsigned = await call("/proxy/api/features", { shop: SHOP_G, signed: false });
  assert.equal(unsigned.status, 400);
  const fresh = await call("/proxy/api/features", { shop: SHOP_G });
  assert.deepEqual([fresh.status, fresh.json], [200, { wishlist: true, notifyMe: true }], "a shop with no settings keeps both features on");
  assert.equal(await prisma.shop.count({ where: { domain: SHOP_G } }), 0, "reading the switches creates nothing");
});

test("Wishlist switched off: new saves, opens and clicks are refused; stored items stay; removing works; Notify Me is independent; switching on restores", async () => {
  const keep = await add(ALICE, { productId: PRODUCT }, { shop: SHOP_G });
  const other = await add(ALICE, { productId: "7000000099" }, { shop: SHOP_G });
  assert.deepEqual([keep.status, other.status], [200, 200]);
  const actor = await actorFor(SHOP_G, ALICE);
  const shop = await prisma.shop.findUnique({ where: { domain: SHOP_G } });
  const eventsBefore = await prisma.activityEvent.count({ where: { shopId: shop.id } });

  await prisma.shopSettings.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id, wishlistEnabled: false }, update: { wishlistEnabled: false } });
  assert.deepEqual((await call("/proxy/api/features", { shop: SHOP_G })).json, { wishlist: false, notifyMe: true }, "only Wishlist is off");

  const blocked = [
    await add(ALICE, { productId: "7000000098" }, { shop: SHOP_G }),
    await call(API, { method: "POST", customer: ALICE, shop: SHOP_G, body: { op: "open" } }),
    await call(API, { method: "POST", customer: ALICE, shop: SHOP_G, body: { op: "click", productId: PRODUCT, variantId: defaultVariant(PRODUCT) } }),
  ];
  for (const response of blocked) assert.deepEqual([response.status, response.json.error], [403, "feature_disabled"]);
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id } }), eventsBefore, "refused requests record nothing");
  assert.equal((await itemsFor(actor)).length, 2, "the stored items are untouched");
  assert.equal((await call(API, { customer: ALICE, shop: SHOP_G })).json.count, 2, "the list can still be read");

  assert.equal((await remove(ALICE, "7000000099", { shop: SHOP_G })).status, 200, "customers can still remove what they saved");
  assert.equal((await itemsFor(actor)).length, 1);

  const notify = await notifyOpen(ALICE, { shop: SHOP_G });
  assert.equal(notify.status, 200, "Notify Me is not affected by the Wishlist switch");

  await prisma.shopSettings.update({ where: { shopId: shop.id }, data: { wishlistEnabled: true } });
  assert.equal((await add(ALICE, { productId: "7000000097" }, { shop: SHOP_G })).status, 200, "switching on restores saving");
  assert.equal((await itemsFor(actor)).length, 2, "the item saved before the switch-off is still there");
  assert.equal((await call(API, { method: "POST", customer: ALICE, shop: SHOP_G, body: { op: "open" } })).status, 200);
});

test("Notify Me switched off blocks only Notify Me writes on the server; Wishlist keeps working", async () => {
  const shop = await prisma.shop.findUnique({ where: { domain: SHOP_G } });
  await prisma.shopSettings.update({ where: { shopId: shop.id }, data: { notifyMeEnabled: false } });
  const body = { op: "subscribe", variantId: "8100000555" };
  const subscribe = await call(NOTIFY_API, { method: "POST", customer: ALICE, shop: SHOP_G, body });
  assert.deepEqual([subscribe.status, subscribe.json.error], [403, "feature_disabled"]);
  const open = await notifyOpen(ALICE, { shop: SHOP_G });
  assert.deepEqual([open.status, open.json.error], [403, "feature_disabled"]);
  assert.equal(await prisma.notifySubscription.count({ where: { shopId: shop.id } }), 0);
  assert.equal((await add(ALICE, { productId: "7000000096" }, { shop: SHOP_G })).status, 200, "Wishlist is unaffected");
  assert.deepEqual((await call("/proxy/api/features", { shop: SHOP_G })).json, { wishlist: true, notifyMe: false });
  await prisma.shopSettings.update({ where: { shopId: shop.id }, data: { notifyMeEnabled: true } });
  assert.equal((await notifyOpen(ALICE, { shop: SHOP_G })).status, 200, "switching on restores it");
});
