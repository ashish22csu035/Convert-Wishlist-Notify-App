// Tests for maskedCustomerEmails (app/models/customer-emails.server.js): batching, masking, the Notify Me fallback, shop scoping.
//
// Run: node --test --test-force-exit tests/customer-emails.test.mjs
// The data tests WRITE to the database in DATABASE_URL, so they run only on a database named kw_*test*; anything else skips.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const dbName = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
  } catch {
    return "";
  }
})();
const SCRATCH = /^kw_.*test/.test(dbName);
const skip = SCRATCH ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName}"): database tests skipped`;

const prisma = SCRATCH ? new PrismaClient() : null;
const RUN = Date.now().toString(36);
const domains = [];
let lib;

before(async () => {
  if (!SCRATCH) return;
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "read_customers";
  lib = await import("../app/models/customer-emails.server.js");
});

after(async () => {
  if (!SCRATCH) return;
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

const hide = (local, domain) => `${local[0]}${"*".repeat(local.length - 1)}@${domain}`; // the rule, written out independently
const shopify = (emailsById, { fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    graphql: async (query, { variables }) => {
      calls.push(variables.ids);
      if (fail) throw new Error("shopify down");
      return { json: async () => ({ data: { nodes: variables.ids.map((id) => (emailsById[id.split("/").pop()] === undefined ? null : { id, defaultEmailAddress: emailsById[id.split("/").pop()] === null ? null : { emailAddress: emailsById[id.split("/").pop()] } })) } }) };
    },
  };
};

async function seedShop(tag) {
  const domain = `kw-ce-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
}
let n = 7100000000;
async function subscribe(shop, customerId, email, createdAt) {
  const actor = await prisma.actor.upsert({ where: { shopId_customerGid: { shopId: shop.id, customerGid: `gid://shopify/Customer/${customerId}` } }, update: {}, create: { shopId: shop.id, customerGid: `gid://shopify/Customer/${customerId}` } });
  n += 1;
  return prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid: `gid://shopify/ProductVariant/${n}`, email, consentedAt: new Date(), consentSource: "test", createdAt } });
}

test("one request for a whole page of customers; masked emails only; nothing invented", { skip }, async () => {
  const shop = await seedShop("batch");
  const admin = shopify({ 101: "ashishmehta425@gmail.com", 102: "john@example.com", 103: null });
  const result = await lib.maskedCustomerEmails(admin, shop.id, ["101", "102", "103", "104", "101"]);
  assert.equal(admin.calls.length, 1, "no request per row");
  assert.deepEqual(admin.calls[0], ["gid://shopify/Customer/101", "gid://shopify/Customer/102", "gid://shopify/Customer/103", "gid://shopify/Customer/104"], "duplicates are asked once");
  assert.deepEqual(result, { 101: hide("ashishmehta425", "gmail.com"), 102: hide("john", "example.com") }, "103 has no email and 104 does not exist: they are absent, not made up");
  assert.equal(JSON.stringify(result).includes("ashishmehta425@"), false, "the full address is never returned");
});

test("large pages are split into groups of 100, never one request per customer", { skip }, async () => {
  const shop = await seedShop("chunk");
  const ids = Array.from({ length: 230 }, (_, i) => String(5000 + i));
  const admin = shopify(Object.fromEntries(ids.map((id) => [id, `user${id}@example.com`])));
  const result = await lib.maskedCustomerEmails(admin, shop.id, ids);
  assert.deepEqual(admin.calls.map((c) => c.length), [100, 100, 30]);
  assert.equal(Object.keys(result).length, 230);
});

test("when Shopify gives no email, the address from the customer's Notify Me sign-up is used (newest first), masked", { skip }, async () => {
  const shop = await seedShop("fallback");
  await subscribe(shop, "201", "old.address@example.com", new Date("2026-01-01T00:00:00Z"));
  await subscribe(shop, "201", "new.address@example.org", new Date("2026-06-01T00:00:00Z"));
  await subscribe(shop, "202", "second@example.com", new Date("2026-03-01T00:00:00Z"));
  for (const admin of [shopify({}), shopify({}, { fail: true }), null]) {
    const result = await lib.maskedCustomerEmails(admin, shop.id, ["201", "202", "203"]);
    assert.deepEqual(result, { 201: hide("new.address", "example.org"), 202: hide("second", "example.com") }, "203 has nothing anywhere: it keeps showing the customer id");
  }
});

test("Shopify's answer wins over the sign-up address", { skip }, async () => {
  const shop = await seedShop("wins");
  await subscribe(shop, "301", "typed.at.signup@example.com", new Date());
  const result = await lib.maskedCustomerEmails(shopify({ 301: "account@shop.com" }), shop.id, ["301"]);
  assert.deepEqual(result, { 301: hide("account", "shop.com") });
});

test("another shop's sign-ups are never used", { skip }, async () => {
  const a = await seedShop("iso-a");
  const b = await seedShop("iso-b");
  await subscribe(b, "401", "belongs.to.b@example.com", new Date());
  assert.deepEqual(await lib.maskedCustomerEmails(null, a.id, ["401"]), {});
  assert.deepEqual(await lib.maskedCustomerEmails(null, b.id, ["401"]), { 401: hide("belongs.to.b", "example.com") });
});

test("bad input is ignored: no ids, no shop, non-numeric ids make no request", { skip }, async () => {
  const admin = shopify({ 1: "x@y.com" });
  assert.deepEqual(await lib.maskedCustomerEmails(admin, "shop", []), {});
  assert.deepEqual(await lib.maskedCustomerEmails(admin, null, ["1"]), {});
  assert.deepEqual(await lib.maskedCustomerEmails(admin, "shop-id", ["abc", "gid://shopify/Customer/1", ""]), {});
  assert.equal(admin.calls.length, 0);
});
