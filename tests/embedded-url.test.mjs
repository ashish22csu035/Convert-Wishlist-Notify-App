// withEmbeddedParams (app/utils/embedded-url.js): which parts of the current URL travel with an in-app navigation.
//
// Run: node --test tests/embedded-url.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withEmbeddedParams } from "../app/utils/embedded-url.js";

test("embedded, host, shop and locale are kept; everything else is dropped", () => {
  const result = withEmbeddedParams("/app/settings", "?embedded=1&host=abc&shop=s.myshopify.com&locale=fr&days=30&page=2&q=hat&id_token=a.b.c&timestamp=1");
  assert.equal(result.pathname, "/app/settings");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(result.search)), { embedded: "1", host: "abc", shop: "s.myshopify.com", locale: "fr" });
});

test("no Admin context means a plain path with no question mark", () => {
  for (const search of ["", "?", "?days=30", undefined, "?embedded=&host="]) assert.deepEqual(withEmbeddedParams("/app/wishlist-settings", search), { pathname: "/app/wishlist-settings", search: "" }, String(search));
});

test("values are re-encoded, not concatenated, so nothing can be injected through them", () => {
  const { search } = withEmbeddedParams("/app/settings", "?host=a%26evil%3D1&shop=x%23y");
  assert.equal(search, "?host=a%26evil%3D1&shop=x%23y");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(search)), { host: "a&evil=1", shop: "x#y" });
});

test("the path is whatever the caller passes: it never comes from the query", () => {
  assert.equal(withEmbeddedParams("/app/settings", "?pathname=/evil&embedded=1").pathname, "/app/settings");
});
