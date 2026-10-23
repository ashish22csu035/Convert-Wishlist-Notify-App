// Tests for the merchant UX improvements (data side): date-range filtering of the activity tables,
// subscription last-email results, reason wording, the Settings preview
// matching the real email, saved settings really driving the worker, and revenue figures agreeing.
//
// Run: node --test tests/merchant-ux.test.mjs
//
// Uses the real MySQL database from .env; every row belongs to uniquely named test shops removed at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const DAY = 24 * 60 * 60 * 1000;
const domains = [];
let seq = 9700000000;
let reporting;
let settings;
let shared;
let format;
let emailBuilder;
let workerModule;
let appPrisma;

const makeShop = async (tag) => {
  const domain = `kw-ux-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: new Date(Date.now() - 400 * DAY) } });
};
const makeActor = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
const wishlistEvent = (shop, actor, type, occurredAt) =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type, feature: "WISHLIST", productGid: "gid://shopify/Product/1", variantGid: "gid://shopify/ProductVariant/11", occurredAt } });

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  reporting = await import("../app/models/reporting.server.js");
  settings = await import("../app/models/settings.server.js");
  shared = await import("../app/utils/settings-shared.js");
  format = await import("../app/utils/format.js");
  emailBuilder = await import("../app/models/restock-email.server.js");
  workerModule = await import("../app/worker/worker.server.js");
  appPrisma = (await import("../app/db.server.js")).default;
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

// ======================= date ranges and filters =======================
test("the Wishlist activity log is filtered by the date range (event time) and by event type", async () => {
  const shop = await makeShop("log");
  const actor = await makeActor(shop);
  const now = new Date();
  await wishlistEvent(shop, actor, "WISHLIST_ADDED", new Date(now.getTime() - 1 * DAY));
  await wishlistEvent(shop, actor, "WISHLIST_REMOVED", new Date(now.getTime() - 3 * DAY));
  await wishlistEvent(shop, actor, "WISHLIST_PRODUCT_CLICKED", new Date(now.getTime() - 20 * DAY));
  await wishlistEvent(shop, actor, "WISHLIST_ADDED", new Date(now.getTime() - 60 * DAY));

  const seven = await reporting.getWishlistActivity(shop.id, { days: 7 }, now);
  assert.deepEqual(seven.rows.map((r) => r.type), ["WISHLIST_ADDED", "WISHLIST_REMOVED"]);
  assert.equal(seven.total, 2, "the pager total agrees with the rows the range allows");
  const thirty = await reporting.getWishlistActivity(shop.id, { days: 30 }, now);
  assert.equal(thirty.total, 3);
  assert.equal((await reporting.getWishlistActivity(shop.id, { days: 90 }, now)).total, 4);

  const added = await reporting.getWishlistActivity(shop.id, { days: 90, type: "WISHLIST_ADDED" }, now);
  assert.deepEqual([added.total, added.rows.every((r) => r.type === "WISHLIST_ADDED")], [2, true]);
  assert.equal((await reporting.getWishlistActivity(shop.id, { days: 90, type: "NOTIFY_SUBSCRIBED" }, now)).total, 4, "an unknown type falls back to all Wishlist activity, never to other features");
});

test("email activity is filtered by the date range and by status, and the total matches", async () => {
  const shop = await makeShop("mail");
  const actor = await makeActor(shop);
  const variantGid = "gid://shopify/ProductVariant/777";
  const sub = await prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/7", variantGid, email: "x@example.invalid", consentedAt: new Date(), consentSource: "test" } });
  const make = (cycle, status, ageDays) => prisma.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: sub.id, restockCycle: cycle, variantGid, status, createdAt: new Date(Date.now() - ageDays * DAY) } });
  await make(1, "SENT", 1);
  await make(2, "FAILED", 2);
  await make(3, "SENT", 40);
  const week = await reporting.getDeliveries(shop.id, { days: 7 });
  assert.deepEqual([week.total, week.rows.length], [2, 2]);
  assert.equal((await reporting.getDeliveries(shop.id, { days: 90 })).total, 3);
  assert.equal((await reporting.getDeliveries(shop.id, { days: 90, status: "SENT" })).total, 2);
  assert.equal((await reporting.getDeliveries(shop.id, { days: 7, status: "SENT" })).total, 1);
});

test("subscriptions show the result of their latest email, never the recipient", async () => {
  const shop = await makeShop("subs");
  const a = await makeActor(shop);
  const b = await makeActor(shop);
  const variantGid = "gid://shopify/ProductVariant/888";
  const mk = (actor) => prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/8", variantGid, email: "secret.person@example.invalid", consentedAt: new Date(), consentSource: "test" } });
  const waiting = await mk(a);
  const notified = await mk(b);
  await prisma.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: notified.id, restockCycle: 1, variantGid, status: "FAILED" } });
  await prisma.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: notified.id, restockCycle: 2, variantGid, status: "SENT", sentAt: new Date() } });
  const list = await reporting.getSubscriptions(shop.id, {});
  const byId = Object.fromEntries(list.rows.map((r) => [r.id, r]));
  assert.equal(byId[waiting.id].lastEmail, null);
  assert.deepEqual([byId[notified.id].lastEmail.status, byId[notified.id].lastEmail.restockCycle], ["SENT", 2], "the latest email, not an earlier failed one");
  assert.equal(/secret\.person|@example/.test(JSON.stringify(list)), false);
});

// ======================= wording =======================
test("delivery reasons are plain language and never echo raw internal codes; every status has help text", () => {
  assert.equal(format.deliveryReason(null), null);
  assert.match(format.deliveryReason("out_of_stock_again"), /sold out again/);
  assert.match(format.deliveryReason("smtp_ECONNECTION"), /mail server/);
  assert.equal(format.deliveryReason("smtp_ECONNECTION").includes("ECONNECTION"), false);
  assert.equal(format.deliveryReason("some_new_internal_code"), "Could not be sent");
  for (const status of ["ACTIVE", "FULFILLED", "UNSUBSCRIBED", "PENDING", "SENDING", "SENT", "FAILED", "UNKNOWN", "SKIPPED"]) assert.ok(format.STATUS_HELP[status], status);
  assert.match(format.STATUS_HELP.SENT, /does not confirm/);
});

// ======================= settings =======================
test("validation is one set of rules for the screen and the server; unsaved changes are detected", () => {
  assert.equal(settings.validateSettings, shared.validateSettings, "the server module uses the shared validator");
  assert.deepEqual(shared.validateSettings({ wishlistEnabled: "on", notifyMeEnabled: "off" }).values, { wishlistEnabled: true, notifyMeEnabled: false });
  assert.deepEqual(Object.keys(shared.validateSettings({}).errors).sort(), ["notifyMeEnabled", "wishlistEnabled"]);
  const saved = { ...shared.DEFAULT_SETTINGS };
  assert.equal(shared.isDirty({ ...saved }, saved), false);
  assert.equal(shared.isDirty({ ...saved, notifyMeEnabled: false }, saved), true);
  assert.equal(shared.isDirty({ ...saved, wishlistEnabled: false }, saved), true);
});

test("saved settings drive the real worker: switched off skips the job, switched on sends with the saved wording", async () => {
  const shop = await makeShop("worker");
  const PRODUCT = { id: null, title: "Large", product: { title: "Test Board", handle: "test-board", onlineStoreUrl: "https://shop.example.invalid/products/test-board", status: "ACTIVE" } };
  const getAdmin = async () => ({ scope: "", admin: { async graphql(query, { variables }) { return { json: async () => ({ data: { node: { ...PRODUCT, id: variables.id } } }) }; } } });
  const transport = { calls: [], sendMail: async (mail) => { transport.calls.push(mail); return { accepted: [mail.to], rejected: [], messageId: mail.messageId }; } };
  const worker = () => workerModule.createWorker({ shopIds: [shop.id], ctx: { transport, config: { mailFrom: "sender@example.invalid", baseUrl: "https://app.example.invalid" }, getAdmin }, log: { log() {}, error() {} } });
  const queue = async () => {
    const actor = await makeActor(shop);
    const variantGid = `gid://shopify/ProductVariant/${(seq += 1)}`;
    await prisma.variantAvailability.create({ data: { shopId: shop.id, variantGid, productGid: "gid://shopify/Product/7", inventoryItemGid: `gid://shopify/InventoryItem/${seq}`, isInStock: true, restockCycle: 1 } });
    const sub = await prisma.notifySubscription.create({ data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/7", variantGid, email: "customer@example.invalid", baselineCycle: 0, consentedAt: new Date(), consentSource: "test" } });
    return prisma.emailDelivery.create({ data: { shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid, status: "PENDING", nextAttemptAt: new Date(Date.now() - 1000) } });
  };

  await settings.saveSettings(shop.domain, shared.validateSettings({ wishlistEnabled: "true", notifyMeEnabled: "false" }).values);
  const skipped = await queue();
  await worker().drain();
  const afterOff = await prisma.emailDelivery.findUnique({ where: { id: skipped.id } });
  assert.deepEqual([afterOff.status, afterOff.errorCode, transport.calls.length], ["SKIPPED", "notify_disabled", 0]);

  await settings.saveSettings(shop.domain, shared.validateSettings({ wishlistEnabled: "true", notifyMeEnabled: "true" }).values);
  // the saved email wording (a stored value, no longer edited on the Settings page) is still what the builder uses
  await prisma.shopSettings.update({ where: { shopId: shop.id }, data: { senderName: "Hat Shop", emailSubject: "Yay, {{product}}!", buttonLabel: "Grab it" } });
  const sent = await queue();
  await worker().drain();
  assert.equal((await prisma.emailDelivery.findUnique({ where: { id: sent.id } })).status, "SENT");
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].subject, "Yay, Test Board (Large)!");
  assert.match(transport.calls[0].text, /Grab it:/);
  assert.equal(transport.calls[0].from.name, "Hat Shop");
});
