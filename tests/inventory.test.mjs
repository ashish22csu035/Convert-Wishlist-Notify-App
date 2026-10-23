// Unit tests for the storefront inventory rules (app/utils/inventory.server.js).
// Run: node --test tests/inventory.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REPORTED, MAX_VARIANTS_PER_REQUEST, parseVariantIds, sellableCap } from "../app/utils/inventory.server.js";

const variant = (over = {}) => ({
  inventoryPolicy: "DENY",
  sellableOnlineQuantity: 6,
  inventoryItem: { tracked: true },
  ...over,
});

test("tracked inventory that denies overselling is limited to the sellable quantity", () => {
  assert.equal(sellableCap(variant()), 6);
  assert.equal(sellableCap(variant({ sellableOnlineQuantity: 1 })), 1);
});

test("zero or negative sellable inventory means a limit of 0 (sold out), never negative", () => {
  assert.equal(sellableCap(variant({ sellableOnlineQuantity: 0 })), 0);
  assert.equal(sellableCap(variant({ sellableOnlineQuantity: -1 })), 0);
});

test("stores that continue selling when out of stock are not limited", () => {
  assert.equal(sellableCap(variant({ inventoryPolicy: "CONTINUE", sellableOnlineQuantity: 0 })), null);
  assert.equal(sellableCap(variant({ inventoryPolicy: "CONTINUE", sellableOnlineQuantity: -5 })), null);
});

test("untracked inventory is not limited", () => {
  assert.equal(sellableCap(variant({ inventoryItem: { tracked: false }, sellableOnlineQuantity: 0 })), null);
});

test("missing or unreadable data never turns into a limit", () => {
  assert.equal(sellableCap(null), null);
  assert.equal(sellableCap({}), null);
  assert.equal(sellableCap(variant({ sellableOnlineQuantity: undefined })), null);
  assert.equal(sellableCap(variant({ sellableOnlineQuantity: "6" })), null);
  assert.equal(sellableCap(variant({ inventoryPolicy: undefined })), null);
});

test("large stock is reported as at most the selector maximum", () => {
  assert.equal(sellableCap(variant({ sellableOnlineQuantity: 100000 })), MAX_REPORTED);
});

test("variant id lists are validated", () => {
  assert.deepEqual(parseVariantIds("1,2,3"), ["1", "2", "3"]);
  assert.deepEqual(parseVariantIds(" 1 , 1 ,2"), ["1", "2"], "trims and de-duplicates");
  assert.equal(parseVariantIds(""), null);
  assert.equal(parseVariantIds(null), null);
  assert.equal(parseVariantIds("abc"), null);
  assert.equal(parseVariantIds("1,gid://shopify/ProductVariant/2"), null, "numeric ids only");
  assert.equal(parseVariantIds("1;DROP"), null);
  const tooMany = Array.from({ length: MAX_VARIANTS_PER_REQUEST + 1 }, (_, i) => i + 1).join(",");
  assert.equal(parseVariantIds(tooMany), null);
});
