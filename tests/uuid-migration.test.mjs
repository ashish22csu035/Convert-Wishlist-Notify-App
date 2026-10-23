// Tests for the move of ten primary keys (and every foreign key that points at them) from INT to UUID v4.
//
// Run: node --test tests/uuid-migration.test.mjs
//
// Two parts, both on the real local MySQL server from .env:
//  1. A rehearsal of migration 20261022120000_uuid_primary_keys on a THROWAWAY database: the four earlier
//     migrations are applied, rows with numeric ids and every kind of relationship are inserted, the UUID
//     migration is applied, and every row, relationship, constraint and unique key is checked. The scratch
//     database is dropped at the end; the real database is not touched by this part.
//  2. The application's own behaviour on the migrated schema (generated UUID v4 ids, relations, the 30-minute
//     session rule), using uniquely named test shops that are deleted at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const RUN = Date.now().toString(36);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const baseUrl = /DATABASE_URL="([^"]+)"/.exec(fs.readFileSync(".env", "utf8"))[1];
const scratchName = `kw_uuid_mig_${RUN}`;
const scratchUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${scratchName}$1`);

const admin = new PrismaClient(); // the real database: used to create and drop the scratch one, and for part 2
let scratch;
const domains = [];

before(() => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
});

after(async () => {
  await admin.shop.deleteMany({ where: { domain: { in: domains } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${scratchName}\``);
  await scratch?.$disconnect();
  await admin.$disconnect();
});

// ---- helpers ---------------------------------------------------------------------------------------
const migrationDirs = () => fs.readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort();
function statements(file) {
  const text = fs.readFileSync(file, "utf8").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  return text.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}
const run = async (client, file) => {
  for (const statement of statements(file)) await client.$executeRawUnsafe(statement);
};
const q = (sql) => scratch.$queryRawUnsafe(sql);
const hash = (rows) => crypto.createHash("sha1").update(JSON.stringify(rows.map((r) => JSON.stringify(r, (k, v) => (typeof v === "bigint" ? Number(v) : v))).sort())).digest("hex");

const FINGERPRINTS = {
  shop: "SELECT domain, currencyCode, status FROM Shop",
  settings: "SELECT s.domain, t.wishlistEnabled, t.notifyMeEnabled, t.senderName FROM ShopSettings t JOIN Shop s ON s.id = t.shopId",
  actor: "SELECT s.domain, a.customerGid FROM Actor a JOIN Shop s ON s.id = a.shopId",
  session: "SELECT s.domain, a.customerGid, b.feature, b.startedAt, b.expiresAt FROM BrowsingSession b JOIN Actor a ON a.id = b.actorId AND a.shopId = b.shopId JOIN Shop s ON s.id = b.shopId",
  event: "SELECT s.domain, a.customerGid, e.type, e.feature, e.variantGid, b.startedAt bs, b.feature bf FROM ActivityEvent e JOIN Actor a ON a.id = e.actorId AND a.shopId = e.shopId JOIN Shop s ON s.id = e.shopId LEFT JOIN BrowsingSession b ON b.id = e.browsingSessionId",
  wishlist: "SELECT s.domain, a.customerGid, w.variantGid, w.productTitle FROM WishlistItem w JOIN Actor a ON a.id = w.actorId AND a.shopId = w.shopId JOIN Shop s ON s.id = w.shopId",
  subscription: "SELECT s.domain, a.customerGid, n.variantGid, n.email, n.status, n.baselineCycle FROM NotifySubscription n JOIN Actor a ON a.id = n.actorId AND a.shopId = n.shopId JOIN Shop s ON s.id = n.shopId",
  delivery: "SELECT s.domain, a.customerGid, n.variantGid, d.restockCycle, d.status, d.attempts, d.outboundMessageId, d.linkTokenHash FROM EmailDelivery d JOIN NotifySubscription n ON n.id = d.subscriptionId AND n.shopId = d.shopId JOIN Actor a ON a.id = n.actorId JOIN Shop s ON s.id = d.shopId",
  availability: "SELECT s.domain, v.variantGid, v.inventoryItemGid, v.isInStock, v.restockCycle FROM VariantAvailability v JOIN Shop s ON s.id = v.shopId",
  webhook: "SELECT w.shopDomain, w.topic, w.dedupeKey, w.webhookId, w.status, s.domain sd FROM WebhookEvent w LEFT JOIN Shop s ON s.id = w.shopId",
  order: "SELECT s.domain, o.orderGid, o.totalPrice FROM ShopifyOrder o JOIN Shop s ON s.id = o.shopId",
  line: "SELECT s.domain, o.orderGid, l.lineItemGid, l.variantGid, l.lineTotal FROM ShopifyOrderLineItem l JOIN ShopifyOrder o ON o.id = l.orderId AND o.shopId = l.shopId JOIN Shop s ON s.id = l.shopId",
  attribution: "SELECT s.domain, o.orderGid, t.feature, t.grossAmount, e.type et, e.occurredAt eo FROM OrderAttribution t JOIN ShopifyOrder o ON o.id = t.orderId AND o.shopId = t.shopId JOIN Shop s ON s.id = t.shopId LEFT JOIN ActivityEvent e ON e.id = t.touchEventId",
};
const TABLES = ["Shop", "ShopSettings", "Actor", "BrowsingSession", "ActivityEvent", "WishlistItem", "NotifySubscription", "EmailDelivery", "VariantAvailability", "WebhookEvent"];
const OTHER = ["ShopifyOrder", "ShopifyOrderLineItem", "OrderAttribution"];

async function snapshot() {
  const out = { counts: {}, prints: {} };
  for (const t of [...TABLES, ...OTHER]) out.counts[t] = Number((await q(`SELECT COUNT(*) n FROM \`${t}\``))[0].n);
  for (const [name, sql] of Object.entries(FINGERPRINTS)) out.prints[name] = hash(await q(sql));
  return out;
}

// ======================= 1. rehearsal of the migration on legacy data =======================
let before_;
let mapping;

test("rehearsal: the earlier migrations build the legacy (INT id) schema and legacy rows with every relationship are inserted", async () => {
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${scratchName}\``);
  scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
  const dirs = migrationDirs();
  const uuidMigration = dirs.find((d) => d.endsWith("_uuid_primary_keys"));
  assert.ok(uuidMigration, "the migration exists");
  for (const dir of dirs.filter((d) => d !== uuidMigration)) await run(scratch, `prisma/migrations/${dir}/migration.sql`);
  assert.match((await q("SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Shop' AND COLUMN_NAME = 'id'"))[0].t, /^int/, "legacy ids are integers");

  const x = (sql) => scratch.$executeRawUnsafe(sql);
  for (const [i, domain] of ["one", "two"].entries()) {
    await x(`INSERT INTO Shop (domain, currencyCode, updatedAt) VALUES ('${domain}.myshopify.com', 'USD', NOW(3))`);
    const shopId = Number((await q(`SELECT id FROM Shop WHERE domain = '${domain}.myshopify.com'`))[0].id);
    await x(`INSERT INTO ShopSettings (shopId, notifyMeEnabled, senderName, updatedAt) VALUES (${shopId}, ${i === 0}, 'Sender ${domain}', NOW(3))`);
    for (const c of [1, 2]) {
      await x(`INSERT INTO Actor (shopId, customerGid) VALUES (${shopId}, 'gid://shopify/Customer/${i}${c}')`);
      const actorId = Number((await q(`SELECT id FROM Actor WHERE shopId = ${shopId} AND customerGid = 'gid://shopify/Customer/${i}${c}'`))[0].id);
      for (const feature of ["WISHLIST", "NOTIFY_ME"]) {
        await x(`INSERT INTO BrowsingSession (shopId, actorId, feature, startedAt, expiresAt) VALUES (${shopId}, ${actorId}, '${feature}', '2026-10-0${c} 10:00:00.000', '2026-10-0${c} 10:30:00.000')`);
        const sessionId = Number((await q(`SELECT MAX(id) id FROM BrowsingSession`))[0].id);
        const type = feature === "WISHLIST" ? "WISHLIST_ADDED" : "NOTIFY_SUBSCRIBED";
        for (let e = 0; e < 3; e += 1) await x(`INSERT INTO ActivityEvent (shopId, actorId, browsingSessionId, type, feature, variantGid, occurredAt) VALUES (${shopId}, ${actorId}, ${sessionId}, '${type}', '${feature}', 'gid://shopify/ProductVariant/${e}', '2026-10-0${c} 10:0${e}:00.000')`);
      }
      await x(`INSERT INTO ActivityEvent (shopId, actorId, type, feature, variantGid) VALUES (${shopId}, ${actorId}, 'RESTOCK_EMAIL_SENT', 'NOTIFY_ME', 'gid://shopify/ProductVariant/0')`); // no session: sent by the worker
      await x(`INSERT INTO WishlistItem (shopId, actorId, productGid, variantGid, productTitle, productHandle) VALUES (${shopId}, ${actorId}, 'gid://shopify/Product/1', 'gid://shopify/ProductVariant/${c}', 'Hat ${c}', 'hat')`);
      await x(`INSERT INTO NotifySubscription (shopId, actorId, productGid, variantGid, email, consentedAt, consentSource, updatedAt) VALUES (${shopId}, ${actorId}, 'gid://shopify/Product/1', 'gid://shopify/ProductVariant/9', 'c${i}${c}@example.invalid', NOW(3), 'test', NOW(3))`);
      const subId = Number((await q("SELECT MAX(id) id FROM NotifySubscription"))[0].id);
      for (const cycle of [1, 2]) await x(`INSERT INTO EmailDelivery (shopId, subscriptionId, restockCycle, variantGid, status, outboundMessageId, updatedAt) VALUES (${shopId}, ${subId}, ${cycle}, 'gid://shopify/ProductVariant/9', 'SENT', '<m${i}${c}${cycle}@x>', NOW(3))`);
    }
    await x(`INSERT INTO VariantAvailability (shopId, variantGid, productGid, inventoryItemGid, isInStock) VALUES (${shopId}, 'gid://shopify/ProductVariant/9', 'gid://shopify/Product/1', 'gid://shopify/InventoryItem/9', 1)`);
    await x(`INSERT INTO WebhookEvent (shopDomain, shopId, topic, dedupeKey, webhookId) VALUES ('${domain}.myshopify.com', ${shopId}, 'INVENTORY_LEVELS_UPDATE', 'ev-${i}', 'wh-${i}')`);
    await x(`INSERT INTO ShopifyOrder (shopId, orderGid, orderName, placedAt, financialStatus, currencyCode, totalPrice, shopifyUpdatedAt, updatedAt) VALUES (${shopId}, 'gid://shopify/Order/${i}', '#${i}', NOW(3), 'PAID', 'USD', 25, NOW(3), NOW(3))`);
    const orderId = Number((await q("SELECT MAX(id) id FROM ShopifyOrder"))[0].id);
    await x(`INSERT INTO ShopifyOrderLineItem (shopId, orderId, lineItemGid, productGid, variantGid, quantity, lineTotal) VALUES (${shopId}, ${orderId}, 'gid://shopify/LineItem/${i}', 'gid://shopify/Product/1', 'gid://shopify/ProductVariant/9', 1, 25)`);
    const eventId = Number((await q(`SELECT MIN(id) id FROM ActivityEvent WHERE shopId = ${shopId} AND type = 'NOTIFY_SUBSCRIBED'`))[0].id);
    await x(`INSERT INTO OrderAttribution (shopId, orderId, feature, touchEventId, touchedAt, matchedProductGid, grossAmount, currencyCode) VALUES (${shopId}, ${orderId}, 'NOTIFY_ME', ${eventId}, NOW(3), 'gid://shopify/Product/1', 25, 'USD')`);
  }
  await x("INSERT INTO WebhookEvent (shopDomain, shopId, topic, dedupeKey, webhookId) VALUES ('gone.myshopify.com', NULL, 'ORDERS_PAID', 'ev-x', 'wh-x')"); // a webhook whose shop is unknown (shopId NULL)
  before_ = await snapshot();
  assert.deepEqual(before_.counts, { Shop: 2, ShopSettings: 2, Actor: 4, BrowsingSession: 8, ActivityEvent: 28, WishlistItem: 4, NotifySubscription: 4, EmailDelivery: 8, VariantAvailability: 2, WebhookEvent: 3, ShopifyOrder: 2, ShopifyOrderLineItem: 2, OrderAttribution: 2 });
});

test("rehearsal: applying the UUID migration keeps every row and every relationship", async () => {
  const uuidMigration = migrationDirs().find((d) => d.endsWith("_uuid_primary_keys"));
  await run(scratch, `prisma/migrations/${uuidMigration}/migration.sql`);
  const after_ = await snapshot();
  assert.deepEqual(after_.counts, before_.counts, "row counts are identical");
  assert.deepEqual(after_.prints, before_.prints, "every relationship resolves to the same natural data as before (shop, customer, session, event, subscription, delivery, order, attribution)");
});

test("rehearsal: the ten ids and every foreign key are now CHAR(36) UUID v4, unique, and the Shopify-owned ids are unchanged", async () => {
  for (const t of TABLES) {
    const r = (await q(`SELECT COUNT(*) n, COUNT(DISTINCT id) d, SUM(id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') v4 FROM \`${t}\``))[0];
    assert.deepEqual([Number(r.n), Number(r.d), Number(r.v4)], [before_.counts[t], before_.counts[t], before_.counts[t]], `${t}: every id is a distinct UUID v4`);
  }
  const types = Object.fromEntries((await q("SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) c, COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()")).map((r) => [r.c.toLowerCase(), r.t]));
  for (const col of ["shop.id", "shopsettings.id", "shopsettings.shopid", "actor.id", "actor.shopid", "browsingsession.id", "browsingsession.shopid", "browsingsession.actorid", "activityevent.id", "activityevent.shopid", "activityevent.actorid", "activityevent.browsingsessionid", "wishlistitem.id", "wishlistitem.shopid", "wishlistitem.actorid", "notifysubscription.id", "notifysubscription.shopid", "notifysubscription.actorid", "emaildelivery.id", "emaildelivery.shopid", "emaildelivery.subscriptionid", "variantavailability.id", "variantavailability.shopid", "webhookevent.id", "webhookevent.shopid", "shopifyorder.shopid", "shopifyorderlineitem.shopid", "orderattribution.shopid", "orderattribution.toucheventid"]) {
    assert.equal(types[col], "char(36)", col);
  }
  for (const col of ["shopifyorder.id", "shopifyorderlineitem.id", "shopifyorderlineitem.orderid", "orderattribution.id", "orderattribution.orderid"]) assert.match(types[col], /^int/, `${col} keeps its own integer key`);
  assert.equal(types["session.id"].startsWith("varchar"), true, "the Shopify auth Session table is untouched");
  // Shopify identifiers are untouched
  assert.equal(Number((await q("SELECT COUNT(*) n FROM Actor WHERE customerGid LIKE 'gid://shopify/Customer/%'"))[0].n), 4);
  assert.equal(Number((await q("SELECT COUNT(*) n FROM WebhookEvent WHERE webhookId IN ('wh-0', 'wh-1', 'wh-x') AND dedupeKey IN ('ev-0', 'ev-1', 'ev-x')"))[0].n), 3, "webhook ids and dedupe keys are not regenerated");
  assert.equal((await q("SELECT shopId FROM WebhookEvent WHERE dedupeKey = 'ev-x'"))[0].shopId, null, "a webhook without a shop keeps a NULL shop");
});

test("rehearsal: the old-to-new mapping is kept and complete", async () => {
  mapping = await q("SELECT tableName, oldId, newId FROM IdMapping");
  const perTable = {};
  for (const row of mapping) perTable[row.tableName] = (perTable[row.tableName] ?? 0) + 1;
  assert.deepEqual(perTable, Object.fromEntries(TABLES.map((t) => [t, before_.counts[t]])), "one mapping row per migrated row");
  assert.equal(new Set(mapping.map((m) => m.newId)).size, mapping.length, "no UUID is used twice");
  assert.ok(mapping.every((m) => UUID_V4.test(m.newId)));
  for (const t of TABLES) assert.equal(Number((await q(`SELECT COUNT(*) n FROM \`${t}\` x JOIN IdMapping m ON m.tableName = '${t}' AND m.newId = x.id`))[0].n), before_.counts[t], `${t}: every row is in the mapping`);
});

test("rehearsal: foreign keys, unique keys and CHECK constraints are all enforced after the migration", async () => {
  const x = (sql) => scratch.$executeRawUnsafe(sql);
  const [shop] = await q("SELECT id FROM Shop ORDER BY domain LIMIT 1");
  const [actor] = await q(`SELECT id FROM Actor WHERE shopId = '${shop.id}' LIMIT 1`);
  const nobody = "00000000-0000-4000-8000-000000000000";
  // foreign keys
  await assert.rejects(x(`INSERT INTO Actor (id, shopId, customerGid) VALUES (UUID(), '${nobody}', 'gid://shopify/Customer/777')`), /foreign key/i);
  await assert.rejects(x(`INSERT INTO BrowsingSession (id, shopId, actorId, feature, startedAt, expiresAt) VALUES (UUID(), '${shop.id}', '${nobody}', 'WISHLIST', '2026-10-01 10:00:00.000', '2026-10-01 10:30:00.000')`), /foreign key/i);
  // an actor of shop one cannot own a row of shop two (composite key)
  const [other] = await q(`SELECT id FROM Shop WHERE id <> '${shop.id}' LIMIT 1`);
  await assert.rejects(x(`INSERT INTO WishlistItem (id, shopId, actorId, productGid, variantGid, productTitle, productHandle) VALUES (UUID(), '${other.id}', '${actor.id}', 'p', 'v', 't', 'h')`), /foreign key/i);
  // unique keys
  await assert.rejects(x(`INSERT INTO Actor (id, shopId, customerGid) SELECT UUID(), shopId, customerGid FROM Actor WHERE id = '${actor.id}'`), /duplicate/i);
  await assert.rejects(x(`INSERT INTO WishlistItem (id, shopId, actorId, productGid, variantGid, productTitle, productHandle) SELECT UUID(), shopId, actorId, productGid, variantGid, productTitle, productHandle FROM WishlistItem WHERE actorId = '${actor.id}' LIMIT 1`), /duplicate/i);
  await assert.rejects(x(`INSERT INTO EmailDelivery (id, shopId, subscriptionId, restockCycle, variantGid, updatedAt) SELECT UUID(), shopId, subscriptionId, restockCycle, variantGid, NOW(3) FROM EmailDelivery LIMIT 1`), /duplicate/i);
  // CHECK constraints
  await assert.rejects(x(`INSERT INTO BrowsingSession (id, shopId, actorId, feature, startedAt, expiresAt) VALUES (UUID(), '${shop.id}', '${actor.id}', 'WISHLIST', '2026-10-01 10:00:00.000', '2026-10-01 11:00:00.000')`), /check/i);
  await assert.rejects(x(`UPDATE ShopifyOrder SET totalPrice = -1 LIMIT 1`), /check/i);
  // an activity event cannot point at a session of another feature
  const [session] = await q(`SELECT id FROM BrowsingSession WHERE shopId = '${shop.id}' AND actorId = '${actor.id}' AND feature = 'WISHLIST' LIMIT 1`);
  await assert.rejects(x(`INSERT INTO ActivityEvent (id, shopId, actorId, browsingSessionId, type, feature) VALUES (UUID(), '${shop.id}', '${actor.id}', '${session.id}', 'NOTIFY_SUBSCRIBED', 'NOTIFY_ME')`), /foreign key/i);
  // cascade: deleting a shop removes its dependants, and leaves a webhook of that shop with a NULL shop
  const dependants = async () => Number((await q("SELECT (SELECT COUNT(*) FROM Actor) + (SELECT COUNT(*) FROM ActivityEvent) + (SELECT COUNT(*) FROM EmailDelivery) + (SELECT COUNT(*) FROM OrderAttribution) n"))[0].n);
  const total = await dependants();
  await x(`DELETE FROM Shop WHERE id = '${shop.id}'`);
  assert.equal(await dependants(), total / 2, "half of the dependants belonged to that shop");
  assert.equal(Number((await q("SELECT COUNT(*) n FROM WebhookEvent WHERE shopId IS NULL"))[0].n), 2, "its webhook row stays, with no shop");
});

test("rehearsal: the migration generates version-4 ids itself (RANDOM_BYTES), not MySQL's version-1 UUID()", () => {
  const sql = fs.readFileSync(`prisma/migrations/${migrationDirs().find((d) => d.endsWith("_uuid_primary_keys"))}/migration.sql`, "utf8");
  assert.ok(sql.includes("RANDOM_BYTES"));
  assert.equal(/SET `uuid` = UUID\(\)/.test(sql), false);
  assert.equal(/DROP TABLE|DROP DATABASE|TRUNCATE/i.test(sql), false, "nothing is dropped and re-created");
  assert.ok(sql.includes("CREATE TABLE `IdMapping`"));
});

// ======================= 2. the application on the migrated schema =======================
const makeShop = async (tag) => {
  const domain = `kw-uuid-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return admin.shop.create({ data: { domain, currencyCode: "USD" } });
};

test("new rows get UUID v4 ids from the application: unique, not derived from anything, and in the right type", async () => {
  const shop = await makeShop("ids");
  const actors = [];
  for (let i = 0; i < 25; i += 1) actors.push(await admin.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${i}` } }));
  const ids = [shop.id, ...actors.map((a) => a.id)];
  for (const id of ids) assert.match(id, UUID_V4);
  assert.equal(new Set(ids).size, ids.length, "all unique");
  assert.equal(ids.some((id) => id.includes(shop.domain) || id.includes("myshopify")), false, "not derived from the shop domain");
  // not sequential and not time ordered
  const sorted = [...actors.map((a) => a.id)].sort();
  assert.notDeepEqual(actors.map((a) => a.id), sorted, "ids are not increasing in creation order");
  // the other nine migrated models generate them too
  const actor = actors[0];
  const session = await admin.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature: "WISHLIST", startedAt: new Date("2026-10-01T10:00:00Z"), expiresAt: new Date("2026-10-01T10:30:00Z") } });
  const event = await admin.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: session.id, type: "WISHLIST_ADDED", feature: "WISHLIST" } });
  const item = await admin.wishlistItem.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid: "gid://shopify/ProductVariant/1", productTitle: "t", productHandle: "h" } });
  const sub = await admin.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid: "gid://shopify/ProductVariant/1", email: "c@example.invalid", consentedAt: new Date(), consentSource: "test" } });
  const delivery = await admin.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid: "gid://shopify/ProductVariant/1" } });
  const stock = await admin.variantAvailability.create({ data: { shopId: shop.id, variantGid: "gid://shopify/ProductVariant/1", productGid: "gid://shopify/Product/1", inventoryItemGid: "gid://shopify/InventoryItem/1", isInStock: false } });
  const hook = await admin.webhookEvent.create({ data: { shopDomain: shop.domain, shopId: shop.id, topic: "INVENTORY_LEVELS_UPDATE", dedupeKey: "k", webhookId: "w" } });
  const settings = await admin.shopSettings.create({ data: { shopId: shop.id } });
  for (const row of [session, event, item, sub, delivery, stock, hook, settings]) assert.match(row.id, UUID_V4);
  assert.equal(hook.webhookId, "w", "Shopify's webhook id and dedupe key are stored as given");
});

test("actor -> session -> events: one session's UUID retrieves its whole activity timeline", async () => {
  const shop = await makeShop("timeline");
  const actor = await admin.actor.create({ data: { shopId: shop.id, customerGid: "gid://shopify/Customer/55" } });
  const mk = (feature, startIso) => {
    const startedAt = new Date(startIso);
    return admin.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature, startedAt, expiresAt: new Date(startedAt.getTime() + 30 * 60 * 1000) } });
  };
  const first = await mk("WISHLIST", "2026-10-01T10:10:00Z");
  const second = await mk("WISHLIST", "2026-10-01T10:00:00Z"); // a different visit by the same customer
  const types = ["WISHLIST_ADDED", "WISHLIST_PRODUCT_CLICKED", "WISHLIST_REMOVED"];
  for (const [i, type] of types.entries()) await admin.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: first.id, type, feature: "WISHLIST", occurredAt: new Date(`2026-10-01T10:1${i}:30Z`) } });
  await admin.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: second.id, type: "WISHLIST_ADDED", feature: "WISHLIST", occurredAt: new Date("2026-10-01T10:29:00Z") } });
  await admin.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type: "RESTOCK_EMAIL_SENT", feature: "NOTIFY_ME" } }); // outside any session

  const timeline = await admin.activityEvent.findMany({ where: { browsingSessionId: first.id }, orderBy: { occurredAt: "asc" } });
  assert.deepEqual(timeline.map((e) => e.type), types, "the session's own events, in order");
  assert.ok(timeline.every((e) => e.actorId === actor.id && e.shopId === shop.id));
  const withSession = await admin.browsingSession.findUnique({ where: { id: first.id }, include: { events: true, actor: true } });
  assert.equal(withSession.events.length, 3);
  assert.equal(withSession.actor.customerGid, "gid://shopify/Customer/55", "the actor still maps to the customer, and the session id is a different value");
  assert.notEqual(withSession.id, withSession.actor.id);
  assert.equal(await admin.activityEvent.count({ where: { browsingSessionId: second.id } }), 1);
  assert.equal(await admin.activityEvent.count({ where: { shopId: shop.id, browsingSessionId: null } }), 1);
});

test("the fixed 30-minute session rule and the composite keys still hold on UUID keys", async () => {
  const shop = await makeShop("rules");
  const other = await makeShop("rules2");
  const actor = await admin.actor.create({ data: { shopId: shop.id, customerGid: "gid://shopify/Customer/66" } });
  await assert.rejects(
    admin.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature: "WISHLIST", startedAt: new Date("2026-10-01T10:00:00Z"), expiresAt: new Date("2026-10-01T11:00:00Z") } }),
    "a session that is not exactly 30 minutes long is refused by the database",
  );
  await assert.rejects(admin.wishlistItem.create({ data: { shopId: other.id, actorId: actor.id, productGid: "p", variantGid: "v", productTitle: "t", productHandle: "h" } }), "a row cannot mix an actor of one shop with another shop");
  const s = await admin.browsingSession.create({ data: { shopId: shop.id, actorId: actor.id, feature: "NOTIFY_ME", startedAt: new Date("2026-10-01T10:00:00Z"), expiresAt: new Date("2026-10-01T10:30:00Z") } });
  await assert.rejects(admin.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, browsingSessionId: s.id, type: "WISHLIST_ADDED", feature: "WISHLIST" } }), "an event cannot join a session of the other feature");
});

test("the real database was migrated: every migrated id is a UUID, the mapping exists, and the migration is recorded as applied", async () => {
  const applied = await admin.$queryRawUnsafe("SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name LIKE '%uuid_primary_keys'");
  assert.equal(applied.length, 1);
  assert.ok(applied[0].finished_at, "finished, not failed or rolled back");
  for (const t of TABLES) {
    const bad = await admin.$queryRawUnsafe(`SELECT COUNT(*) n FROM \`${t}\` WHERE id NOT REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`);
    assert.equal(Number(bad[0].n), 0, `${t}: no id that is not a UUID v4`);
  }
  assert.ok(Number((await admin.$queryRawUnsafe("SELECT COUNT(*) n FROM IdMapping"))[0].n) >= 1, "the old-to-new id mapping is kept");
  const orphans = await admin.$queryRawUnsafe("SELECT (SELECT COUNT(*) FROM ActivityEvent e LEFT JOIN BrowsingSession b ON b.id = e.browsingSessionId WHERE e.browsingSessionId IS NOT NULL AND b.id IS NULL) + (SELECT COUNT(*) FROM EmailDelivery d LEFT JOIN NotifySubscription n ON n.id = d.subscriptionId WHERE n.id IS NULL) + (SELECT COUNT(*) FROM OrderAttribution t WHERE t.touchEventId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ActivityEvent e WHERE e.id = t.touchEventId)) n");
  assert.equal(Number(orphans[0].n), 0, "no foreign key points nowhere");
});
