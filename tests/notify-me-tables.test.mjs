// Tests for the Notify Me tables: Customers Waiting, Email count, the new status labels and the removed Unsubscribed option.
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

test("Email count is 1 per SENT delivery and 0 otherwise; product-level totals are never repeated on rows", async () => {
  const shop = await makeShop("sent");
  const a1 = await makeSub(shop, 10);
  const a2 = await makeSub(shop, 10);
  const b = await makeSub(shop, 11);
  const c = await makeSub(shop, 12);
  await makeMail(a1, 1, "SENT", 1);
  await makeMail(a1, 2, "SENT", 2); // a second restock cycle for the same subscription is a second email
  await makeMail(a2, 1, "SENT", 10); // outside 7 days
  await makeMail(a2, 2, "SENT", 60); // outside 30 days
  for (const [i, status] of ["PENDING", "SENDING", "FAILED", "UNKNOWN", "SKIPPED"].entries()) await makeMail(a2, 10 + i, status, 1);
  await makeMail(b, 1, "FAILED", 1);
  await makeMail(c, 1, "SENT", 1);

  const all = await reporting.getDeliveries(shop.id, { days: 30 });
  assert.equal(all.total, 10);
  assert.ok(all.rows.every((r) => r.emailCount === (r.status === "SENT" ? 1 : 0)), "1 for SENT, 0 for every other status");
  assert.ok(all.rows.every((r) => !("emailsSent" in r)), "no per-item total is attached to rows");
  const variant10 = all.rows.filter((r) => r.variantGid.endsWith("/10") && r.status === "SENT");
  assert.deepEqual(variant10.map((r) => r.emailCount), [1, 1, 1], "three sent emails for one variant: three rows of 1, not 3 three times");
  assert.equal(all.sentInRange, 4);
  assert.equal(all.rows.reduce((sum, r) => sum + r.emailCount, 0), all.sentInRange, "the column adds up to the total");

  const failedOnly = await reporting.getDeliveries(shop.id, { days: 30, status: "FAILED" });
  assert.equal(failedOnly.total, 2);
  assert.ok(failedOnly.rows.every((r) => r.emailCount === 0), "failed rows are not successful emails");
  assert.equal(failedOnly.sentInRange, 4, "the status filter does not inflate or shrink the total");
  const sentOnly = await reporting.getDeliveries(shop.id, { days: 30, status: "SENT" });
  assert.equal(sentOnly.rows.reduce((sum, r) => sum + r.emailCount, 0), 4);

  assert.equal((await reporting.getDeliveries(shop.id, { days: 90 })).sentInRange, 5, "the total follows the date range");
  assert.equal((await reporting.getDeliveries(shop.id, { days: 7 })).sentInRange, 3);
});

test("pagination keeps the overall total: fifteen sent deliveries add up to 15 across pages", async () => {
  const shop = await makeShop("page");
  const sub = await makeSub(shop, 20);
  for (let i = 1; i <= 30; i += 1) await makeMail(sub, i, i <= 15 ? "SENT" : "FAILED", 1);
  const page1 = await reporting.getDeliveries(shop.id, { days: 30, page: 1 });
  const page2 = await reporting.getDeliveries(shop.id, { days: 30, page: 2 });
  assert.equal(page1.total, 30);
  assert.ok(page1.rows.length > 0 && page2.rows.length > 0);
  assert.equal(page1.sentInRange, 15, "page 1 reports the whole-range total");
  assert.equal(page2.sentInRange, 15, "so does page 2");
  const ids = new Set([...page1.rows, ...page2.rows].map((r) => r.id));
  assert.equal(ids.size, page1.rows.length + page2.rows.length, "no delivery appears on two pages");
  const rest = await reporting.getDeliveries(shop.id, { days: 30, page: 3 });
  const sum = [...page1.rows, ...page2.rows, ...rest.rows].reduce((total, r) => total + r.emailCount, 0);
  assert.equal(sum, 15, "the Email count column across all pages adds up to the total");
});

const makeActor = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
const subFor = (shop, actor, variant, status = "FULFILLED") =>
  prisma.notifySubscription.create({
    data: { shopId: shop.id, actorId: actor.id, productGid: `gid://shopify/Product/${variant}`, variantGid: `gid://shopify/ProductVariant/${variant}`, email: "x@example.invalid", status, consentedAt: new Date(), consentSource: "test" },
  });

test("Customers notified counts distinct Actors with a SENT email: many products, cycles and deliveries are one customer", async () => {
  const shop = await makeShop("notified");
  const other = await makeShop("notified-other");
  const a = await makeActor(shop);
  const b = await makeActor(shop);
  const failedOnly = await makeActor(shop);
  const pendingOnly = await makeActor(shop);
  const a1 = await subFor(shop, a, 30);
  const a2 = await subFor(shop, a, 31);
  await makeMail(a1, 1, "SENT");
  await makeMail(a1, 2, "SENT"); // a second restock cycle, same Actor
  await makeMail(a2, 1, "SENT"); // a second product, same Actor
  await makeMail(await subFor(shop, b, 30), 1, "SENT"); // a different Actor counts separately
  for (const [actor, status] of [[failedOnly, "FAILED"], [pendingOnly, "PENDING"]]) await makeMail(await subFor(shop, actor, 32, "ACTIVE"), 1, status);
  for (const [i, status] of ["SENDING", "UNKNOWN", "SKIPPED"].entries()) await makeMail(a1, 10 + i, status);
  const stranger = await makeActor(other);
  await makeMail(await subFor(other, stranger, 30), 1, "SENT"); // another shop's customer

  assert.equal(await reporting.notifiedCustomerCount(shop.id), 2, "a and b only");
  assert.equal(await reporting.notifiedCustomerCount(other.id), 1);
  const overview = await reporting.getNotifyOverview(shop.id, 30);
  assert.equal(overview.customersNotified, 2);
  assert.equal(overview.subscriptions.FULFILLED, 3, "the old figure counted subscriptions, which is not the same thing");
  assert.equal(overview.deliveries.SENT, 4, "Emails sent is one per successful delivery, not per customer");
});

test("Customers notified ignores the date range (all time)", async () => {
  const shop = await makeShop("notified-old");
  const actor = await makeActor(shop);
  await makeMail(await subFor(shop, actor, 40), 1, "SENT", 400);
  assert.equal((await reporting.getNotifyOverview(shop.id, 7)).customersNotified, 1);
});

test("Emails sent counts each successful delivery once, and duplicate attempts cannot add a second one", async () => {
  const shop = await makeShop("dedupe");
  const sub = await subFor(shop, await makeActor(shop), 50);
  await makeMail(sub, 1, "SENT");
  await assert.rejects(makeMail(sub, 1, "SENT"), "UNIQUE(subscriptionId, restockCycle) rejects a duplicate delivery");
  await makeMail(sub, 2, "FAILED");
  const overview = await reporting.getNotifyOverview(shop.id, 30);
  assert.equal(overview.deliveries.SENT, 1);
  assert.equal(overview.deliveries.FAILED, 1);
});

test("the KPI and the Email activity table reconcile: the Email count column adds up to sentInRange, and all time matches the KPI", async () => {
  const shop = await makeShop("reconcile");
  const other = await makeShop("reconcile-other");
  const actor = await makeActor(shop);
  const s1 = await subFor(shop, actor, 60);
  const s2 = await subFor(shop, await makeActor(shop), 60);
  const s3 = await subFor(shop, actor, 61);
  await makeMail(s1, 1, "SENT");
  await makeMail(s1, 2, "SENT");
  await makeMail(s2, 1, "SENT");
  await makeMail(s3, 1, "SENT");
  await makeMail(s3, 2, "FAILED");
  await makeMail(s3, 3, "SENT", 60); // outside 30 days, inside all time
  await makeMail(await subFor(other, await makeActor(other), 60), 1, "SENT"); // other shop

  const overview = await reporting.getNotifyOverview(shop.id, 30);
  const table = await reporting.getDeliveries(shop.id, { days: 30 });
  assert.equal(overview.deliveries.SENT, 5, "all time");
  assert.equal(table.sentInRange, 4, "within 30 days");
  assert.equal(table.sentInRange, table.rows.filter((r) => r.status === "SENT").length, "one SENT row per successful delivery");
  assert.equal((await reporting.getDeliveries(shop.id, { days: 30, status: "FAILED" })).sentInRange, 4, "the status filter does not change the total");
  assert.equal(table.rows.reduce((sum, r) => sum + r.emailCount, 0), table.sentInRange, "the Email count column adds up to the total");
  assert.equal((await reporting.getDeliveries(shop.id, { days: 90 })).sentInRange, overview.deliveries.SENT);
});

test("the Email activity filter offers only All, Queued and Sent, and the status paragraphs are gone from that tab", () => {
  assert.deepEqual(constants.DELIVERY_FILTERS, { all: "All", PENDING: "Queued", SENT: "Sent" });
  const page = fs.readFileSync("app/routes/app.notify-me.jsx", "utf8");
  assert.match(page, /<s-table-header format="numeric">Email count<\/s-table-header>/);
  assert.match(page, /tab === "emails" \? null : \(/, "the legend and the long note are shown on the Subscriptions tab only");
  assert.equal(/Each row represents|Add the Email count column|Showing emails queued|this item|Emails Sent/.test(page), false, "the Email activity explanations are removed");
  assert.match(page, /o\.customersNotified/);
});

test("filtering by Queued or Sent returns only those records, All returns every record, and totals are unchanged", async () => {
  const shop = await makeShop("filters");
  const sub = await makeSub(shop, 70);
  const statuses = ["PENDING", "PENDING", "SENDING", "SENT", "SENT", "SENT", "FAILED", "UNKNOWN", "SKIPPED"];
  for (const [i, status] of statuses.entries()) await makeMail(sub, i + 1, status, 1);
  const all = await reporting.getDeliveries(shop.id, { days: 30, status: "all" });
  const queued = await reporting.getDeliveries(shop.id, { days: 30, status: "PENDING" });
  const sent = await reporting.getDeliveries(shop.id, { days: 30, status: "SENT" });
  assert.equal(all.total, 9, "All still lists failed, unknown, skipped and sending records");
  assert.deepEqual([queued.total, queued.rows.every((r) => r.status === "PENDING")], [2, true]);
  assert.deepEqual([sent.total, sent.rows.every((r) => r.status === "SENT")], [3, true]);
  assert.deepEqual([all.sentInRange, queued.sentInRange, sent.sentInRange], [3, 3, 3]);
  assert.equal(all.rows.reduce((n, r) => n + r.emailCount, 0), 3);
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id } }), 9, "no record was changed or hidden in the database");
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
  assert.ok(page.includes("Customers Waiting") && page.includes("Email count"));
  assert.equal(/Unsubscribed|opted out/i.test(page), false, "nothing about Unsubscribed on the page");
  assert.match(page, /accepted by the mail server/);
});

test("backend unsubscribe processing is untouched", () => {
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /enum SubscriptionStatus \{\s*ACTIVE\s*FULFILLED\s*UNSUBSCRIBED\s*\}/);
});
