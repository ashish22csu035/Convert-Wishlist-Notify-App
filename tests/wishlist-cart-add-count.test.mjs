// How many "Wishlist Add to cart" events the server records for the My Wishlist page's cart actions, and that Checkout initiated
// is still counted once per checkout.
//
// Run: node --test tests/wishlist-cart-add-count.test.mjs
//
// No database: app/models/wishlist.server.js is bundled with an in-memory stand-in for Prisma (a transaction is serialised per customer, like the
// real per-customer row lock). The checkout test uses a fake client with the one table it writes. The storefront half of the
// bulk action (which products are reported, and that a refused one is not) is tested against the real extras script in
// tests/wishlist-page.test.mjs.
import "./helpers/resolve-extensionless.mjs";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

// ---------- in-memory Prisma ----------
function makeDb() {
  const db = { shops: [], actors: [], sessions: [], items: [], events: [], n: 0, lock: Promise.resolve() };
  const id = (prefix) => `${prefix}-${++db.n}`;
  const match = (row, where = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("gte" in value) return row[key] >= value.gte;
        if ("gt" in value) return row[key] > value.gt;
        return true;
      }
      return row[key] === value;
    });
  const tx = {
    shop: { upsert: async ({ where, create }) => db.shops.find((s) => s.domain === where.domain) ?? (db.shops.push({ id: id("shop"), status: "ACTIVE", ...create }), db.shops.at(-1)) },
    actor: {
      upsert: async ({ where, create }) => {
        const key = where.shopId_customerGid;
        return db.actors.find((a) => a.shopId === key.shopId && a.customerGid === key.customerGid) ?? (db.actors.push({ id: id("actor"), ...create }), db.actors.at(-1));
      },
    },
    $queryRaw: async () => [],
    browsingSession: {
      findFirst: async ({ where }) => db.sessions.find((s) => s.actorId === where.actorId && s.feature === where.feature) ?? null,
      create: async ({ data }) => (db.sessions.push({ id: id("session"), ...data }), db.sessions.at(-1)),
    },
    wishlistItem: {
      findFirst: async ({ where }) => db.items.find((i) => match(i, where)) ?? null,
      count: async ({ where }) => db.items.filter((i) => match(i, where)).length,
      create: async ({ data }) => (db.items.push({ id: id("item"), ...data }), db.items.at(-1)),
      delete: async ({ where }) => void (db.items = db.items.filter((i) => i.id !== where.id)),
    },
    activityEvent: {
      findFirst: async ({ where }) => db.events.find((e) => match(e, where)) ?? null,
      create: async ({ data }) => (db.events.push({ id: id("event"), occurredAt: new Date(), ...data }), db.events.at(-1)),
    },
  };
  // The real code runs each request in a transaction that holds the customer's row lock: one at a time.
  db.$transaction = (work) => {
    const run = db.lock.then(() => work(tx));
    db.lock = run.then(() => {}, () => {});
    return run;
  };
  return Object.assign(db, tx, { __tx: tx });
}

let current;
globalThis.__kwCartDb = null;
let wishlist;
before(async () => {
  const outDir = path.resolve("node_modules/.cache/kw-cart-add-test");
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `wishlist-${Date.now().toString(36)}.mjs`);
  await build({
    entryPoints: ["app/models/wishlist.server.js"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(b) {
          b.onResolve({ filter: /db\.server$/ }, () => ({ path: "fake-db", namespace: "stub" }));
          b.onResolve({ filter: /^@prisma\/client$/ }, () => ({ path: "prisma-client", namespace: "stub" }));
          b.onLoad({ filter: /^fake-db$/, namespace: "stub" }, () => ({ contents: "export default { $transaction: (...a) => globalThis.__kwCartDb.$transaction(...a) };", loader: "js" }));
          b.onLoad({ filter: /^prisma-client$/, namespace: "stub" }, () => ({ contents: "export const Prisma = { TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' } };", loader: "js" }));
        },
      },
    ],
  });
  wishlist = await import(pathToFileURL(outfile).href);
});

const SHOP = "alpha-store.myshopify.com";
const identity = { shopDomain: SHOP, customerGid: "gid://shopify/Customer/1" };
const product = (n) => ({ productGid: `gid://shopify/Product/${n}`, variantGid: `gid://shopify/ProductVariant/${n}1` });
const cartEvents = () => current.events.filter((e) => e.type === "WISHLIST_ADDED_TO_CART");

async function setup(count) {
  current = makeDb();
  globalThis.__kwCartDb = current;
  for (let n = 1; n <= count; n += 1) await wishlist.addToWishlist(identity, { ...product(n), title: `P${n}`, handle: `p${n}` });
}

// The bulk action: the My Wishlist page reports each product it added, one request each (sequential, as the page does).
const bulk = async (numbers) => {
  for (const n of numbers) await wishlist.recordWishlistCartAdd(identity, product(n));
};

test("one Wishlist product added to the cart counts 1", async () => {
  await setup(1);
  await bulk([1]);
  assert.equal(cartEvents().length, 1);
  assert.deepEqual(cartEvents().map((e) => e.variantGid), [product(1).variantGid]);
});

test("a bulk action with 2 products counts 2, and with 3 counts 3 (one event per product)", async () => {
  await setup(2);
  await bulk([1, 2]);
  assert.equal(cartEvents().length, 2);
  assert.deepEqual(cartEvents().map((e) => e.variantGid).sort(), [product(1).variantGid, product(2).variantGid]);

  await setup(3);
  await bulk([1, 2, 3]);
  assert.equal(cartEvents().length, 3);
});

test("the bulk reports can also arrive at the same moment (parallel requests) and still count one each", async () => {
  await setup(3);
  await Promise.all([1, 2, 3].map((n) => wishlist.recordWishlistCartAdd(identity, product(n))));
  assert.equal(cartEvents().length, 3);
});

test("a product the cart refused is never reported, so it is not counted; a report for something not on the Wishlist records nothing", async () => {
  await setup(3);
  await bulk([1, 3]); // product 2 was refused by the cart: the page sends nothing for it
  assert.deepEqual(cartEvents().map((e) => e.variantGid).sort(), [product(1).variantGid, product(3).variantGid]);

  await setup(1);
  const result = await wishlist.recordWishlistCartAdd(identity, product(9)); // not saved
  assert.equal(result.recorded, false);
  assert.equal(cartEvents().length, 0);
  const wrongProduct = await wishlist.recordWishlistCartAdd(identity, { productGid: "gid://shopify/Product/77", variantGid: product(1).variantGid });
  assert.equal(wrongProduct.recorded, false, "the variant must belong to the product that is reported");
  assert.equal(cartEvents().length, 0);
});

test("the same report twice (a retry, a double click, a second tab) counts once; different products still count separately", async () => {
  await setup(2);
  await wishlist.recordWishlistCartAdd(identity, product(1));
  const again = await wishlist.recordWishlistCartAdd(identity, product(1));
  assert.deepEqual(again, { recorded: false, duplicate: true });
  await Promise.all([wishlist.recordWishlistCartAdd(identity, product(1)), wishlist.recordWishlistCartAdd(identity, product(1))]);
  assert.equal(cartEvents().length, 1, "three more reports of product 1, still one event");
  await wishlist.recordWishlistCartAdd(identity, product(2));
  assert.equal(cartEvents().length, 2, "product 2 is its own addition");
});

test("a later, genuinely new addition of the same variant (after the window) counts again", async () => {
  await setup(1);
  await wishlist.recordWishlistCartAdd(identity, product(1));
  cartEvents()[0].occurredAt = new Date(Date.now() - wishlist.CART_ADD_DEDUPE_MS - 1000);
  await wishlist.recordWishlistCartAdd(identity, product(1));
  assert.equal(cartEvents().length, 2);
});

test("other customers and other event types are separate: Notify Me cart events are neither counted nor affected", async () => {
  await setup(1);
  current.events.push({ id: "n1", type: "NOTIFY_ADDED_TO_CART", actorId: "x", variantGid: product(1).variantGid, occurredAt: new Date() });
  await wishlist.recordWishlistCartAdd(identity, product(1));
  assert.equal(cartEvents().length, 1, "a Notify Me cart event for the same variant does not suppress the Wishlist one");
  assert.equal(current.events.filter((e) => e.type === "NOTIFY_ADDED_TO_CART").length, 1, "and none was added or removed");

  const other = { shopDomain: SHOP, customerGid: "gid://shopify/Customer/2" };
  await wishlist.addToWishlist(other, { ...product(1), title: "P1", handle: "p1" });
  await wishlist.recordWishlistCartAdd(other, product(1));
  assert.equal(cartEvents().length, 2, "another customer's addition of the same variant counts for them");
});

// ---------- Checkout initiated: one per checkout ----------
test("one checkout holding several products from the Wishlist is one Checkout initiated, however many were added to the cart", async () => {
  process.env.SHOPIFY_API_KEY ||= "dummy-key";
  process.env.SHOPIFY_API_SECRET ||= "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL ||= "http://localhost:1";
  process.env.SCOPES ||= "write_products";
  const { attributeCheckoutWithReason, parseCheckout } = await import("../app/models/checkout-webhook.server.js"); // loads the Prisma client but never queries it
  const snapshot = new Date("2026-10-08T12:00:00Z");
  const touch = (n, minutes) => ({ id: `e${n}`, type: "WISHLIST_ADDED_TO_CART", feature: "WISHLIST", occurredAt: new Date(snapshot.getTime() - minutes * 60000), productGid: `gid://shopify/Product/${n}`, variantGid: `gid://shopify/ProductVariant/${n}1` });
  const writes = [];
  const client = {
    actor: { findUnique: async () => ({ id: "a1" }) },
    activityEvent: { findMany: async () => [touch(1, 5), touch(2, 4), touch(3, 3)] },
    checkoutAttribution: { upsert: async (args) => void writes.push(args.where.shopId_checkoutKey_feature) },
  };
  const checkout = parseCheckout({ token: "tok-1", created_at: snapshot.toISOString(), customer: { id: 5 }, line_items: [1, 2, 3].map((n) => ({ product_id: n, variant_id: Number(`${n}1`) })) });
  const result = await attributeCheckoutWithReason(client, "shop-1", checkout, { snapshot });
  assert.equal(result.features, 1);
  assert.equal(writes.length, 1, "three products, three cart additions, ONE checkout row");
  assert.deepEqual(writes[0], { shopId: "shop-1", checkoutKey: "tok-1", feature: "WISHLIST" });
});
