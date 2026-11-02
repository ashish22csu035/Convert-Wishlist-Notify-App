// Tests for the Notify Me tables: Customers Waiting, Emails Sent, the new status labels and the removed Unsubscribed option.
//
// Run: node --test tests/notify-me-tables.test.mjs
//
// Uses the database from DATABASE_URL (run it against a scratch database); every row belongs to uniquely named test shops removed at the end.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const DAY = 24 * 60 * 60 * 1000;
const domains = [];
let seq = 9800000000;
let reporting;
let constants;
let format;
let appPrisma;

const makeShop = async (tag) => {
  const domain = `kw-nm-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: new Date(Date.now() - 400 * DAY) } });
};
const makeSub = async (shop, variant, status = "ACTIVE") => {
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
  return prisma.notifySubscription.create({
    data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid: `gid://shopify/ProductVariant/${variant}`, email: "x@example.invalid", status, consentedAt: new Date(), consentSource: "test" },
  });
};
const makeMail = (sub, cycle, status, ageDays = 1) =>
  prisma.emailDelivery.create({ data: { shopId: sub.shopId, subscriptionId: sub.id, restockCycle: cycle, variantGid: sub.variantGid, status, createdAt: new Date(Date.now() - ageDays * DAY) } });

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  reporting = await import("../app/models/reporting.server.js");
  constants = await import("../app/utils/dashboard-constants.js");
  format = await import("../app/utils/format.js");
  appPrisma = (await import("../app/db.server.js")).default;
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test("Customers Waiting counts only ACTIVE subscriptions, per variant, and the same number is on every row of that variant", async () => {
  const shop = await makeShop("wait");
  const other = await makeShop("wait-other");
  await makeSub(shop, 1);
  await makeSub(shop, 1);
  await makeSub(shop, 1, "FULFILLED");
  await makeSub(shop, 1, "UNSUBSCRIBED");
  await makeSub(shop, 2, "FULFILLED"); // a variant nobody is waiting for: zero
  await makeSub(shop, 3);
  await makeSub(other, 1); // another shop's customers are never counted
  const list = await reporting.getSubscriptions(shop.id, {});
  const waiting = (variant) => list.rows.filter((r) => r.variantGid.endsWith(`/${variant}`)).map((r) => r.waitingCustomers);
  assert.deepEqual(waiting(1), [2, 2, 2], "three listed rows (2 waiting + 1 notified), all showing 2 waiting; the notified one is not counted and the unsubscribed one is not listed");
  assert.deepEqual(waiting(2), [0]);
  assert.deepEqual(waiting(3), [1], "variants are not combined");
  assert.equal(list.total, 5);
  const filtered = await reporting.getSubscriptions(shop.id, { status: "FULFILLED" });
  assert.deepEqual(filtered.rows.filter((r) => r.variantGid.endsWith("/1")).map((r) => r.waitingCustomers), [2], "the count does not depend on the status filter");
});

test("Unsubscribed subscriptions are not listed or counted on the page, but stay in the database", async () => {
  const shop = await makeShop("unsub");
  const gone = await makeSub(shop, 5, "UNSUBSCRIBED");
  await makeSub(shop, 5);
  assert.equal((await reporting.getSubscriptions(shop.id, {})).total, 1);
  assert.equal((await reporting.getSubscriptions(shop.id, { status: "ACTIVE" })).total, 1);
  assert.equal(await prisma.notifySubscription.count({ where: { id: gone.id, status: "UNSUBSCRIBED" } }), 1);
});

test("Emails Sent counts only SENT deliveries per variant inside the date range, whatever the status filter", async () => {
  const shop = await makeShop("sent");
  const a1 = await makeSub(shop, 10);
  const a2 = await makeSub(shop, 10);
  const b = await makeSub(shop, 11);
  const c = await makeSub(shop, 12);
  await makeMail(a1, 1, "SENT", 1);
  await makeMail(a1, 2, "SENT", 2); // a second restock cycle for the same subscription counts as a second email
  await makeMail(a2, 1, "SENT", 3);
  await makeMail(a2, 2, "SENT", 60); // outside 30 days
  for (const [i, status] of ["PENDING", "SENDING", "FAILED", "UNKNOWN", "SKIPPED"].entries()) await makeMail(a2, 10 + i, status, 1);
  await makeMail(b, 1, "FAILED", 1);
  await makeMail(c, 1, "SENT", 1);

  const all = await reporting.getDeliveries(shop.id, { days: 30 });
  const sentFor = (rows, variant) => [...new Set(rows.filter((r) => r.variantGid.endsWith(`/${variant}`)).map((r) => r.emailsSent))];
  assert.deepEqual(sentFor(all.rows, 10), [3], "3 sent in the window; the 60-day-old one and the other statuses are not counted");
  assert.deepEqual(sentFor(all.rows, 11), [0], "zero is a real number");
  assert.deepEqual(sentFor(all.rows, 12), [1], "variants are separate");

  const failedOnly = await reporting.getDeliveries(shop.id, { days: 30, status: "FAILED" });
  assert.deepEqual(sentFor(failedOnly.rows, 10), [3], "a Failed filter still shows the product's sent count");
  assert.equal(failedOnly.total, 2);

  const wide = await reporting.getDeliveries(shop.id, { days: 90 });
  assert.deepEqual(sentFor(wide.rows, 10), [4], "the count follows the page's date range");
  assert.deepEqual(sentFor((await reporting.getDeliveries(shop.id, { days: 7 })).rows, 10), [3]);
  assert.equal(all.total, 10,"the row total is unchanged by the new count");
});

test("pagination still works with the new counts", async () => {
  const shop = await makeShop("page");
  const sub = await makeSub(shop, 20);
  for (let i = 1; i <= 30; i += 1) await makeMail(sub, i, i <= 3 ? "SENT" : "FAILED", 1);
  const page1 = await reporting.getDeliveries(shop.id, { days: 30, page: 1 });
  const page2 = await reporting.getDeliveries(shop.id, { days: 30, page: 2 });
  assert.equal(page1.total, 30);
  assert.ok(page1.rows.length > 0 && page2.rows.length > 0);
  assert.ok([...page1.rows, ...page2.rows].every((r) => r.emailsSent === 3));
});

test("labels: Waiting for restock / Email sent, no Unsubscribed option or explanation, mail-server wording kept", () => {
  assert.deepEqual(constants.SUBSCRIPTION_FILTERS, { all: "All", ACTIVE: "Waiting for restock", FULFILLED: "Email sent" });
  assert.equal(Object.keys(constants.SUBSCRIPTION_FILTERS).includes("UNSUBSCRIBED"), false);
  assert.match(format.STATUS_HELP.FULFILLED, /accepted by the mail server/);
  assert.match(format.STATUS_HELP.FULFILLED, /does not confirm/);
  assert.match(format.STATUS_HELP.SENT, /does not confirm/);
  assert.equal(constants.DELIVERY_FILTERS.SENT, "Sent");

  const ui = fs.readFileSync("app/components/merchant-ui.jsx", "utf8");
  assert.match(ui, /ACTIVE: \["info", "Waiting for restock"\]/);
  assert.match(ui, /FULFILLED: \["success", "Email sent"\]/);
  const page = fs.readFileSync("app/routes/app.notify-me.jsx", "utf8");
  assert.ok(page.includes("Customers Waiting") && page.includes("Emails Sent"));
  assert.equal(/Unsubscribed|opted out/i.test(page), false, "nothing about Unsubscribed on the page");
  assert.match(page, /accepted by the mail server, not confirmed delivered or opened/);
});

test("backend unsubscribe processing is untouched", () => {
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /enum SubscriptionStatus \{\s*ACTIVE\s*FULFILLED\s*UNSUBSCRIBED\s*\}/);
});
