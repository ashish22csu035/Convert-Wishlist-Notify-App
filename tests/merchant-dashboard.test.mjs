// Tests for the merchant dashboard data layer (app/models/reporting.server.js, catalog.server.js,
// settings.server.js) and its pure display helpers (app/utils/format.js).
//
// Run: node --test tests/merchant-dashboard.test.mjs
//
// Uses the real MySQL database from .env, like the other model tests. Every row belongs to uniquely
// named test shops that are deleted at the end (cascade).
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
let reporting;
let settings;
let catalog;
let format;
let counter = 9500000000;

const makeShop = async (tag, installedAt = new Date(Date.now() - 400 * DAY)) => {
  const domain = `kw-dash-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "XXX", installedAt } });
};
const makeActor = (shop) => prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(counter += 1)}` } });
const event = (shop, actor, type, occurredAt = new Date(), productGid = "gid://shopify/Product/1") =>
  prisma.activityEvent.create({ data: { shopId: shop.id, actorId: actor.id, type, feature: type.startsWith("WISHLIST") ? "WISHLIST" : "NOTIFY_ME", productGid, occurredAt } });
const item = (shop, actor, product, variant, title, createdAt = new Date()) =>
  prisma.wishlistItem.create({ data: { shopId: shop.id, actorId: actor.id, productGid: `gid://shopify/Product/${product}`, variantGid: `gid://shopify/ProductVariant/${variant}`, productTitle: title, productHandle: title.toLowerCase(), createdAt } });

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  reporting = await import("../app/models/reporting.server.js");
  settings = await import("../app/models/settings.server.js");
  catalog = await import("../app/models/catalog.server.js");
  format = await import("../app/utils/format.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

test("parsers only accept offered values", () => {
  assert.equal(reporting.parseDays("7"), 7);
  for (const bad of ["", "1", "abc", "30; DROP", null, undefined, "-7"]) assert.equal(reporting.parseDays(bad), 30);
  assert.equal(reporting.parsePage("3"), 3);
  for (const bad of ["0", "-1", "x", "1e9", null, "99999999999"]) assert.equal(reporting.parsePage(bad), 1);
  assert.equal(reporting.parseChoice("saves", { saves: 1, name: 2 }, "name"), "saves");
  assert.equal(reporting.parseChoice("toString", { saves: 1 }, "saves"), "saves"); // not an inherited key
  assert.equal(reporting.cleanQuery("  hat\u0000\n  "), "hat");
});

test("windows are whole UTC days that include today", () => {
  const now = new Date("2026-10-21T15:30:00Z");
  assert.equal(reporting.sinceDays(1, now).toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(reporting.sinceDays(7, now).toISOString(), "2026-10-15T00:00:00.000Z");
});

test("an unknown shop has no row, so screens show 'no activity' rather than zeros", async () => {
  assert.equal(await reporting.getShopByDomain(`kw-dash-nobody-${RUN}.myshopify.com`), null);
});

test("dashboard: shop scoped, windowed, real daily series, zero kept distinct from unavailable", async () => {
  const mine = await makeShop("a");
  const other = await makeShop("b");
  const actor = await makeActor(mine);
  const second = await makeActor(mine);
  const stranger = await makeActor(other);
  const now = new Date();
  const old = new Date(now.getTime() - 60 * DAY);
  await event(mine, actor, "WISHLIST_ADDED", now);
  await event(mine, second, "WISHLIST_ADDED", now);
  await event(mine, actor, "WISHLIST_ADDED", old);
  await event(other, stranger, "WISHLIST_ADDED", now);
  await item(mine, actor, 1, 11, "Hat");

  const shop = await reporting.getShopByDomain(mine.domain);
  const d = await reporting.getDashboard(shop, 30, now);
  assert.equal(d.activity.window.WISHLIST_ADDED, 2);
  assert.equal(d.activity.allTime.WISHLIST_ADDED, 3);
  assert.equal(d.activity.window.NOTIFY_SUBSCRIBED, 0); // really zero
  assert.equal(d.wishlistUsers.current, 2);
  assert.deepEqual([d.wishlist.savedItems, d.wishlist.customers, d.wishlist.products], [1, 1, 1]);
  assert.match(d.unavailable.emailClicks, /not tracked/); // still unavailable, never shown as zero
  assert.equal("orders" in d.unavailable, false, "orders and revenue now come from collected order data");

  // series: one entry per UTC day of the window, today holds both events, nothing else is invented
  assert.equal(d.series.days.length, 30);
  assert.equal(d.series.days.at(-1), now.toISOString().slice(0, 10));
  assert.equal(d.series.values.WISHLIST_ADDED.at(-1), 2);
  assert.equal(d.series.values.wishlistUsers.at(-1), 2);
  assert.equal(d.series.values.WISHLIST_ADDED.reduce((a, b) => a + b, 0), 2);

  // tracking began long before the previous window, so a real comparison exists (previous period empty)
  assert.equal(d.comparable, true);
  assert.equal(d.activity.previous.WISHLIST_ADDED, 0);

  const theirs = await reporting.getDashboard(await reporting.getShopByDomain(other.domain), 30, now);
  assert.equal(theirs.wishlist.savedItems, 0);
  assert.equal(theirs.activity.window.WISHLIST_ADDED, 1);
});

test("dashboard: a shop tracked for less than two periods has no comparison and a shorter series", async () => {
  const shop = await makeShop("young", new Date(Date.now() - 3 * DAY));
  const actor = await makeActor(shop);
  await event(shop, actor, "WISHLIST_ADDED");
  const d = await reporting.getDashboard(await reporting.getShopByDomain(shop.domain), 30);
  assert.equal(d.comparable, false);
  assert.equal(d.activity.previous, null);
  assert.equal(d.wishlistUsers.previous, null);
  assert.equal(d.series.days.length, 4); // 3 days ago .. today: earlier days were not tracked, not "zero"
});

test("wishlist products: grouped per variant, ranked, searchable, sortable and paginated", async () => {
  const shop = await makeShop("w");
  const a = await makeActor(shop);
  const b = await makeActor(shop);
  await item(shop, a, 10, 101, "Popular hat");
  await item(shop, b, 10, 101, "Popular hat");
  await item(shop, a, 11, 111, "Rare scarf", new Date(Date.now() + 1000));
  for (let i = 0; i < 27; i += 1) await item(shop, a, 200 + i, 2000 + i, `Filler ${String(i).padStart(2, "0")}`);

  const first = await reporting.getWishlistProducts(shop.id, { sort: "saves", page: 1 });
  assert.equal(first.total, 29);
  assert.equal(first.rows.length, 25);
  assert.deepEqual([first.rows[0].productId, first.rows[0].fallbackTitle, first.rows[0].saves], ["10", "Popular hat", 2]);
  assert.equal((await reporting.getWishlistProducts(shop.id, { page: 2 })).rows.length, 4);

  assert.equal((await reporting.getWishlistProducts(shop.id, { sort: "recent" })).rows[0].productId, "11");
  assert.equal((await reporting.getWishlistProducts(shop.id, { sort: "name" })).rows[0].fallbackTitle, "Filler 00");

  const found = await reporting.getWishlistProducts(shop.id, { q: "scarf" });
  assert.deepEqual(found.rows.map((r) => r.productId), ["11"]);
  assert.equal((await reporting.getWishlistProducts(shop.id, { q: "no such thing" })).total, 0);

  const totals = (await reporting.getWishlistOverview(shop.id, 30)).totals;
  assert.deepEqual([totals.savedItems, totals.customers, totals.products], [30, 2, 29]);
});

test("wishlist activity log: newest first, paginated, customer id only", async () => {
  const shop = await makeShop("log");
  const actor = await makeActor(shop);
  const t = Date.now();
  await event(shop, actor, "WISHLIST_ADDED", new Date(t - 5000));
  await event(shop, actor, "WISHLIST_REMOVED", new Date(t - 1000));
  await event(shop, actor, "NOTIFY_SUBSCRIBED", new Date(t)); // not a wishlist activity
  const log = await reporting.getWishlistActivity(shop.id, {});
  assert.equal(log.total, 2);
  assert.deepEqual(log.rows.map((r) => r.type), ["WISHLIST_REMOVED", "WISHLIST_ADDED"]);
  assert.deepEqual(Object.keys(log.rows[0]).sort(), ["customerId", "id", "occurredAt", "productGid", "type", "variantGid"]);
});

test("notify: subscriptions and emails are filterable and never carry recipient data", async () => {
  const shop = await makeShop("n");
  const actor = await makeActor(shop);
  const variantGid = "gid://shopify/ProductVariant/777";
  const sub = await prisma.notifySubscription.create({
    data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/7", variantGid, email: "secret.customer@example.invalid", status: "ACTIVE", consentedAt: new Date(), consentSource: "test" },
  });
  await prisma.emailDelivery.createMany({
    data: [
      { shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid, status: "FAILED", attempts: 5, errorCode: "smtp_auth", outboundMessageId: `<${RUN}-1@x>`, linkTokenHash: "a".repeat(64) },
      { shopId: shop.id, subscriptionId: sub.id, restockCycle: 2, variantGid, status: "UNKNOWN", attempts: 1 },
      { shopId: shop.id, subscriptionId: sub.id, restockCycle: 3, variantGid, status: "SKIPPED", errorCode: "out_of_stock_again" },
      { shopId: shop.id, subscriptionId: sub.id, restockCycle: 4, variantGid, status: "SENT", attempts: 1, sentAt: new Date() },
    ],
  });
  const overview = await reporting.getNotifyOverview(shop.id, 30);
  assert.equal(overview.subscriptions.ACTIVE, 1);
  assert.deepEqual([overview.deliveries.FAILED, overview.deliveries.UNKNOWN, overview.deliveries.SKIPPED, overview.deliveries.SENT], [1, 1, 1, 1]);
  assert.deepEqual(overview.problems.map((j) => j.status).sort(), ["FAILED", "UNKNOWN"]);
  assert.deepEqual(overview.skipReasons, [{ reason: "out_of_stock_again", count: 1 }]);
  assert.deepEqual(overview.requested.map((r) => [r.productId, r.variantId, r.subscribers]), [["7", "777", 1]]);

  const failed = await reporting.getDeliveries(shop.id, { status: "FAILED" });
  assert.deepEqual([failed.total, failed.rows.length], [1, 1]);
  assert.equal((await reporting.getDeliveries(shop.id, {})).total, 4);
  assert.equal((await reporting.getSubscriptions(shop.id, { status: "FULFILLED" })).total, 0);
  const subs = await reporting.getSubscriptions(shop.id, { status: "ACTIVE" });
  assert.equal(subs.total, 1);

  const json = JSON.stringify([overview, failed, subs, await reporting.getDeliveries(shop.id, {})]);
  assert.equal(/secret\.customer|outboundMessageId|linkTokenHash|"email"|@example|<.*@x>/i.test(json), false);
});

test("customers: id-only rows, search by id, sorting, shop isolation", async () => {
  const shop = await makeShop("c");
  const other = await makeShop("c2");
  const busy = await makeActor(shop);
  const quiet = await makeActor(shop);
  await makeActor(other);
  await event(shop, busy, "WISHLIST_ADDED");
  await event(shop, busy, "WISHLIST_REMOVED");
  await event(shop, quiet, "WISHLIST_ADDED");
  await item(shop, quiet, 1, 11, "Hat");
  await item(shop, quiet, 2, 22, "Cap");
  await prisma.actor.update({ where: { id: busy.id }, data: { lastSeenAt: new Date(Date.now() + 5000) } });

  const recent = await reporting.getCustomersReport(shop.id, { sort: "recent" });
  assert.equal(recent.everyone, 2);
  assert.equal(recent.savedItems, 2);
  assert.equal(recent.customers[0].customerId, busy.customerGid.split("/").pop());
  assert.deepEqual(Object.keys(recent.customers[0]).sort(), ["activeSubscriptions", "customerId", "lastSeenAt", "recentActivity", "savedItems"]);

  assert.equal((await reporting.getCustomersReport(shop.id, { sort: "saved" })).customers[0].savedItems, 2);
  const byActivity = await reporting.getCustomersReport(shop.id, { sort: "activity" });
  assert.deepEqual(byActivity.customers.map((c) => c.recentActivity), [2, 1]);
  assert.equal(byActivity.total, 2);

  const found = await reporting.getCustomersReport(shop.id, { q: quiet.customerGid.split("/").pop() });
  assert.deepEqual([found.total, found.customers.length], [1, 1]);
  assert.equal((await reporting.getCustomersReport(shop.id, { q: "not-an-id" })).customers.length, 0);
  assert.equal((await reporting.getCustomersReport(other.id, { q: busy.customerGid.split("/").pop() })).customers.length, 0); // another shop's id
});

test("analytics adds leaderboards without any email or name", async () => {
  const shop = await makeShop("an");
  const actor = await makeActor(shop);
  await event(shop, actor, "WISHLIST_ADDED");
  await item(shop, actor, 5, 55, "Bag");
  const a = await reporting.getAnalytics(await reporting.getShopByDomain(shop.domain), 30);
  assert.deepEqual(a.topCustomers.map((c) => [c.activity, c.savedItems]), [[1, 1]]);
  assert.equal(/email|name/i.test(JSON.stringify(a.topCustomers)), false);
});

test("catalog lookup: real details when Shopify answers, ids only when it does not", async () => {
  const admin = {
    graphql: async () => ({
      json: async () => ({
        data: {
          shop: { currencyCode: "USD" },
          nodes: [
            { __typename: "Product", id: "gid://shopify/Product/1", title: "Hat", handle: "hat", featuredMedia: { preview: { image: { url: "https://cdn.example/hat.png" } } }, priceRangeV2: { minVariantPrice: { amount: "25.00" } } },
            { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/11", title: "Large", price: "30.00", product: { id: "gid://shopify/Product/1", title: "Hat", featuredMedia: null } },
            null,
          ],
        },
      }),
    }),
  };
  const c = await catalog.fetchCatalog(admin, { productGids: ["gid://shopify/Product/1", "gid://shopify/Product/2"], variantGids: ["gid://shopify/ProductVariant/11"] });
  assert.equal(c.available, true);
  assert.equal(c.currencyCode, "USD");
  assert.deepEqual(catalog.describeItem(c, { productGid: "gid://shopify/Product/1", variantGid: "gid://shopify/ProductVariant/11" }), { title: "Hat", variantTitle: "Large", imageUrl: "https://cdn.example/hat.png", price: "30.00", found: true });
  const gone = catalog.describeItem(c, { productGid: "gid://shopify/Product/2", fallbackTitle: "Old title" });
  assert.deepEqual([gone.title, gone.found, gone.imageUrl], ["Old title", false, null]);

  for (const broken of [{ graphql: async () => { throw new Error("down"); } }, { graphql: async () => ({ json: async () => ({ errors: [{ message: "x" }] }) }) }]) {
    const failed = await catalog.fetchCatalog(broken, { productGids: ["gid://shopify/Product/1"] });
    assert.equal(failed.available, false);
    assert.deepEqual(failed.products, {});
  }
  assert.equal((await catalog.fetchCatalog(admin, {})).available, false); // nothing asked for, nothing fetched
  assert.equal(catalog.describeItem(c, { productGid: "gid://shopify/Product/1", variantGid: null }).variantTitle, null);
});

test("Wishlist items card: Active is today's saved rows, All-time is every add; a removal changes only Active; shops are isolated", async () => {
  const mine = await makeShop("wi-a");
  const other = await makeShop("wi-b");
  const actor = await makeActor(mine);
  const stranger = await makeActor(other);
  const kept = await item(mine, actor, 1, 11, "Hat");
  const removed = await item(mine, actor, 2, 22, "Cap");
  await item(other, stranger, 3, 33, "Other shop item");
  for (const [shop, who, product] of [[mine, actor, 1], [mine, actor, 2], [other, stranger, 3]]) {
    await event(shop, who, "WISHLIST_ADDED", new Date(), `gid://shopify/Product/${product}`);
  }
  const load = async (shop) => reporting.getDashboard(await reporting.getShopByDomain(shop.domain), 30);
  const view = (d, mode) => format.wishlistItemsView(d, mode);

  let d = await load(mine);
  assert.deepEqual([view(d, "active").value, view(d, "all").value], [2, 2]);

  // The customer removes the Cap: exactly what removeFromWishlist does (delete the row, log a removal).
  await prisma.wishlistItem.delete({ where: { id: removed.id } });
  await event(mine, actor, "WISHLIST_REMOVED", new Date(), "gid://shopify/Product/2");
  d = await load(mine);
  assert.equal(view(d, "active").value, 1, "the removed item is no longer active");
  assert.equal(view(d, "all").value, 2, "its addition is still counted, and the removal event is not counted as an addition");
  assert.ok(kept.id);

  // The addition is outside the 30-day window but still counts all-time; Active ignores the range.
  await event(mine, actor, "WISHLIST_ADDED", new Date(Date.now() - 60 * DAY));
  const wide = await load(mine);
  assert.equal(view(wide, "all").value, 3);
  assert.equal(view(wide, "active").value, 1);
  assert.equal(wide.activity.window.WISHLIST_ADDED, 2, "the date-filtered figure is unchanged and separate");

  const theirs = await load(other);
  assert.deepEqual([view(theirs, "active").value, view(theirs, "all").value], [1, 1], "another shop's rows and events are not mixed in");
});

test("Wishlist items card: choosing a view reads one figure and leaves every other dashboard figure untouched; missing data is unavailable, not 0", async () => {
  const shop = await makeShop("wi-c");
  const actor = await makeActor(shop);
  await item(shop, actor, 1, 11, "Hat");
  await event(shop, actor, "WISHLIST_ADDED");
  const d = await reporting.getDashboard(await reporting.getShopByDomain(shop.domain), 30);
  const before = JSON.stringify(d);
  const active = format.wishlistItemsView(d, "active");
  const all = format.wishlistItemsView(d, "all");
  assert.equal(JSON.stringify(d), before, "nothing else in the dashboard data changes");
  assert.deepEqual(format.WISHLIST_ITEM_MODES.map((m) => m.key), ["active", "all"]);
  assert.equal(active.caption, "Currently saved by customers");
  assert.equal(all.caption, "Total wishlist additions, including items later removed");
  assert.equal(format.wishlistItemsView({}, "active").value, null);
  assert.equal(format.wishlistItemsView({ activity: { allTime: {} } }, "all").value, null);
  assert.equal(format.wishlistItemsView({ wishlist: { savedItems: 0 } }, "active").value, 0, "a real zero stays a zero");
});

test("display helpers: no invented numbers", () => {
  assert.equal(format.formatNumber(1234), "1,234");
  assert.equal(format.formatNumber(null), "Unavailable");
  assert.equal(format.formatMoney("25.5", "USD"), "$25.50");
  assert.equal(format.formatMoney(null, "USD"), null);
  assert.equal(format.formatMoney("", "USD"), null);
  assert.equal(format.deltaOf(15, 10), 50);
  assert.equal(format.deltaOf(5, 10), -50);
  assert.equal(format.deltaOf(5, 0), null); // nothing to compare against
  assert.equal(format.deltaOf(5, null), null);
  assert.equal(format.deltaOf(null, 5), null);
  const now = "2026-10-21T12:00:00Z";
  assert.equal(format.timeAgo("2026-10-21T11:59:30Z", now), "just now");
  assert.equal(format.timeAgo("2026-10-21T11:55:00Z", now), "5 minutes ago");
  assert.equal(format.timeAgo("2026-10-21T11:00:00Z", now), "1 hour ago");
  assert.equal(format.timeAgo("2026-10-19T12:00:00Z", now), "2 days ago");
  assert.equal(format.timeAgo("2026-09-01T12:00:00Z", now), "2026-09-01 12:00 UTC");
});

test("settings: defaults, validation, and an independent save round-trip creating the shop row if needed", async () => {
  assert.deepEqual(await settings.getSettings(null), { wishlistEnabled: true, notifyMeEnabled: true }, "no row: both features stay on");

  const bad = settings.validateSettings({ wishlistEnabled: "true" });
  assert.deepEqual(Object.keys(bad.errors), ["notifyMeEnabled"], "a missing switch is refused, never read as off");
  assert.deepEqual(Object.keys(settings.validateSettings({ wishlistEnabled: "maybe", notifyMeEnabled: "true" }).errors), ["wishlistEnabled"]);

  const domain = `kw-dash-s-${RUN}.myshopify.com`;
  domains.push(domain);
  const { values, errors } = settings.validateSettings({ wishlistEnabled: "false", notifyMeEnabled: "true" });
  assert.deepEqual(errors, {});
  await settings.saveSettings(domain, values);
  const shop = await reporting.getShopByDomain(domain);
  assert.deepEqual(await settings.getSettings(shop.id), { wishlistEnabled: false, notifyMeEnabled: true });
  assert.deepEqual(await settings.getFeatureFlags(domain), { wishlist: false, notifyMe: true });

  // the other switch alone: each saves independently, and the email columns are left as they were
  await prisma.shopSettings.update({ where: { shopId: shop.id }, data: { senderName: "Kept" } });
  await settings.saveSettings(domain, settings.validateSettings({ wishlistEnabled: "true", notifyMeEnabled: "false" }).values);
  assert.deepEqual(await settings.getFeatureFlags(domain), { wishlist: true, notifyMe: false });
  assert.equal((await prisma.shopSettings.findUnique({ where: { shopId: shop.id } })).senderName, "Kept");

  // an unknown shop reads as the default and nothing is created by reading
  const unknown = `kw-dash-unknown-${RUN}.myshopify.com`;
  assert.deepEqual(await settings.getFeatureFlags(unknown), { wishlist: true, notifyMe: true });
  assert.equal(await prisma.shop.count({ where: { domain: unknown } }), 0);
});
