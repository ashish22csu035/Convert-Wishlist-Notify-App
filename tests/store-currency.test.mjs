// Pure tests (no database): Wishlist sort options and store-currency display of attributed revenue.
import test from "node:test";
import assert from "node:assert/strict";
import { WISHLIST_SORTS } from "../app/utils/dashboard-constants.js";
import { attributionView, formatMoney, validCurrency } from "../app/utils/format.js";
import { fetchShopCurrency } from "../app/models/catalog.server.js";

const report = (currency, revenue = "3001.80") => ({
  state: "ready",
  currency,
  overall: { orders: 2, revenue, orderValue: "4000.00" },
  wishlist: { orders: 2, revenue, orderValue: "4000.00" },
  notifyMe: { orders: 0, revenue: "0.00", orderValue: "0.00" },
});
const adminWith = (body) => ({ graphql: async () => ({ json: async () => body }) });
const nbsp = (text) => text.replace(/ /g, " ");

test("the Wishlist sort dropdown offers only Most saved and Recently saved", () => {
  assert.deepEqual(Object.entries(WISHLIST_SORTS), [["saves", "Most saved"], ["recent", "Recently saved"]]);
});

test("the old Name (A–Z) sort value falls back to Most saved", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/routes/app.wishlist.jsx", import.meta.url), "utf8");
  assert.match(route, /parseChoice\(params\.get\("sort"\), WISHLIST_SORTS, "saves"\)/);
  const model = await readFile(new URL("../app/models/reporting.server.js", import.meta.url), "utf8");
  assert.match(model, /WISHLIST_ORDER\[sort\] \?\? WISHLIST_ORDER\.saves/);
  assert.doesNotMatch(model, /\bname: \[\{ _max/);
  // parseChoice only accepts own keys, so "name" and prototype names are rejected.
  assert.equal(Object.hasOwn(WISHLIST_SORTS, "name"), false);
  assert.equal(Object.hasOwn(WISHLIST_SORTS, "toString"), false);
});

test("money is formatted in USD, INR, GBP and EUR with the same amount", () => {
  assert.equal(formatMoney("3001.8", "USD"), "$3,001.80");
  assert.equal(nbsp(formatMoney("3001.8", "INR")), "₹3,001.80");
  assert.equal(formatMoney("3001.8", "GBP"), "£3,001.80");
  assert.equal(nbsp(formatMoney("3001.8", "EUR")), "€3,001.80");
  assert.equal(formatMoney("0", "GBP"), "£0.00");
  assert.equal(formatMoney(0, "USD"), "$0.00");
  assert.equal(formatMoney(null, "USD"), null);
  assert.equal(formatMoney("abc", "USD"), null);
});

test("two stores show the same amount in their own currency on the card both dashboards use", () => {
  const display = (store, key = 1) => attributionView({ ...report(null) }, 30, store).options[key].display;
  assert.equal(display("USD"), "$3,001.80");
  assert.equal(nbsp(display("INR")), "₹3,001.80");
  assert.equal(display("GBP"), "£3,001.80");
  // Full order value uses the same currency.
  assert.ok(attributionView(report(null), 30, "GBP").options[1].details.includes("Full order value: £4,000.00"));
});

test("the currency the orders were recorded in is what the amounts are labelled with", () => {
  assert.equal(attributionView(report("GBP"), 30, "USD").options[1].display, "£3,001.80");
});

test("a missing currency never turns into USD", () => {
  for (const missing of [null, undefined, "", "XXX", "dollars"]) {
    const display = attributionView(report(null), 30, missing).options[1].display;
    assert.equal(display, "3,001.80 (currency unavailable)", String(missing));
    assert.doesNotMatch(display, /\$|USD/);
  }
  assert.equal(formatMoney("5", undefined), "5.00 (currency unavailable)");
  assert.equal(formatMoney("5", "ZZ"), "5.00 (currency unavailable)");
  assert.equal(validCurrency("usd"), "USD");
  assert.equal(validCurrency("XXX"), null);
});

test("fetchShopCurrency reads the authenticated shop's code and returns null on any failure", async () => {
  assert.equal(await fetchShopCurrency(adminWith({ data: { shop: { currencyCode: "INR" } } })), "INR");
  assert.equal(await fetchShopCurrency(adminWith({ data: { shop: { currencyCode: "XXX" } } })), null);
  assert.equal(await fetchShopCurrency(adminWith({ errors: [{ message: "denied" }] })), null);
  assert.equal(await fetchShopCurrency({ graphql: async () => { throw new Error("down"); } }), null);
  assert.equal(await fetchShopCurrency(null), null);
});

test("both dashboard routes pass the authenticated store's currency into the revenue card", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["app/routes/app.wishlist.jsx", "app/routes/app.notify-me.jsx"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /fetchShopCurrency\(admin\)/, file);
    assert.match(source, /attributionView\(data\.attribution, period, data\.storeCurrency\)/, file);
  }
});
