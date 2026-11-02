// Source-level checks of the app shell (app/routes/app.jsx) and the stylesheet rules it relies on: ONE loading indicator for
// page changes, centred in the app frame, with the leaving page faded out instead of left half-visible.
// Layout is not computed here (no browser): see the real-browser check described in the change notes.
//
// Run: node --test tests/app-shell.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const shell = fs.readFileSync("app/routes/app.jsx", "utf8");
const css = fs.readFileSync("app/styles/merchant.css", "utf8");
const rule = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start !== -1, `rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
};

test("page changes show one centred spinner and no longer the in-flow one at the top", () => {
  assert.equal((shell.match(/<s-spinner/g) ?? []).length, 1, "a single loading indicator in the whole shell");
  assert.equal(/<s-box[^>]*>\s*<s-spinner/.test(shell), false, "not a box in the page flow (that pushed the page down)");
  assert.match(shell, /navigation\.state === "loading"/);
  assert.match(shell, /<div className="kv-loading" role="status" aria-live="polite">\s*<s-spinner size="large"/);
  const box = rule(".kv-loading");
  assert.match(box, /position: fixed;/);
  assert.match(box, /inset: 0;/);
  assert.match(box, /display: grid;[^}]*place-items: center;/, "centred both ways inside the app frame");
  assert.equal(/top:\s*0;[^}]*width:\s*100%/.test(box), false, "not a strip along the top");
  assert.match(box, /pointer-events: none;/, "it never blocks the Shopify chrome or the page behind it");
});

test("the leaving page fades out (no half-old page next to the spinner) and a fast navigation shows neither", () => {
  assert.match(shell, /toggleAttribute\("data-kv-loading", loading\)/);
  assert.match(shell, /removeAttribute\("data-kv-loading"\)/, "the flag is cleared on the way out");
  const fade = rule("html[data-kv-loading] s-page");
  assert.match(fade, /opacity: 0;/);
  assert.match(fade, /transition: opacity 0\.15s ease 0\.12s;/, "delayed, so a quick page change does not flash");
  assert.match(rule(".kv-loading"), /animation: kv-loading-in 0\.15s ease 0\.12s both;/, "the spinner waits the same 120ms");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*html\[data-kv-loading\] s-page \{ transition: none; \}/);
  assert.equal(/(^|\n)\s*s-page[\s{,]/.test(css), false, "Shopify's own page element is only touched while loading");
});

test("the app navigation and the auth boundary are untouched", () => {
  for (const link of ['href="/app">Dashboard', 'href="/app/wishlist">Wishlist', 'href="/app/notify-me">Notify Me', 'href="/app/customers">Engaged customers', 'href="/app/analytics">Analytics', 'href="/app/settings">Settings']) assert.ok(shell.includes(link), link);
  assert.match(shell, /<AppProvider embedded apiKey=\{apiKey\}>/);
  assert.match(shell, /<Outlet \/>/);
});
