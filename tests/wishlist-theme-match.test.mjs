// Static guards for the product-page button's theme matching (assets/konvert-wishlist-theme.js + the --kw-theme-* variables in
// konvert-wishlist.css). The layout itself was checked in headless Chrome against two synthetic themes (see the report); this
// file keeps the rules that make it safe: it only reads the theme, writes only on the Konvert block, and the CSS has fallbacks.
//
// Run: node --test tests/wishlist-theme-match.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ASSETS = "extensions/konvert-wishlist/assets/";
const script = fs.readFileSync(ASSETS + "konvert-wishlist-theme.js", "utf8");
const css = fs.readFileSync(ASSETS + "konvert-wishlist.css", "utf8").replace(/\r\n/g, "\n");
const block = fs.readFileSync("extensions/konvert-wishlist/blocks/wishlist-button.liquid", "utf8");

test("the product block loads the theme-matching script from its own assets, deferred, and not through the size-limited core script", () => {
  assert.match(block, /<script src="\{\{ 'konvert-wishlist-theme\.js' \| asset_url \}\}" defer><\/script>/);
  assert.match(block, /"javascript": "konvert-wishlist\.js"/, "the core script is unchanged");
  assert.equal(/konvert-wishlist-theme/.test(fs.readFileSync(ASSETS + "konvert-wishlist.js", "utf8")), false);
});

test("the script only reads the theme: it writes custom properties on .kw-block and never touches another element", () => {
  const writes = script.match(/\.(setProperty|removeProperty|style\.[a-zA-Z]+\s*=|className\s*=|classList\.|setAttribute|appendChild|remove\()/g) ?? [];
  assert.ok(writes.length > 0);
  for (const call of script.match(/[\w.]+\.(setProperty|removeProperty)\(/g) ?? []) assert.match(call, /^style\./, `${call} writes on the block's style only`);
  assert.equal(/theme\.style|theme\.className|theme\.classList|\.insertAdjacent|innerHTML/.test(script), false, "the theme's own button is never modified");
  assert.match(script, /--kw-theme-/);
  assert.equal(/!important/.test(script), false);
});

test("the purchase button is found by what it does, not by one theme's class names", () => {
  assert.match(script, /form\[action\*="\/cart\/add"\]/);
  assert.match(script, /\[type="submit"\]:not\(\[data-kw-button\]\)/, "the Wishlist button itself is never mistaken for it");
});

test("every theme-matched property has a fallback, so the button is complete without the script", () => {
  for (const name of ["width", "height", "pad-x", "font-family", "font-size", "font-weight", "letter-spacing", "text-transform", "radius", "gap"]) {
    const uses = css.match(new RegExp(`var\\(--kw-theme-${name},[^)]+\\)`, "g")) ?? [];
    assert.ok(uses.length > 0, `--kw-theme-${name} is used with a fallback`);
  }
  assert.match(css, /\.kw-btn--product \{[^}]*width: var\(--kw-theme-width, 100%\);/s);
  assert.match(css, /min-height: max\(44px, var\(--kw-theme-height, 44px\)\)/, "never below a 44px touch target");
});

test("the merchant's own Wishlist Settings still win over the theme-matched values", () => {
  assert.match(css, /html\[data-kw-product-page-width-mode='manual'\] \.kw-btn--product \{/);
  assert.match(css, /html\[data-kw-product-page-button-radius\] \.kw-btn--product \{/);
});

test("no broad selector was added: every new rule is scoped to the Konvert product button or block", () => {
  const added = css.slice(css.indexOf("/* Product page button."), css.indexOf("/* Icon only:"));
  const selectors = [...added.matchAll(/^([^{}\n/][^{}]*)\{/gm)].map((m) => m[1].trim());
  assert.ok(selectors.length >= 2);
  for (const selector of selectors) assert.match(selector, /\.kw-/, selector);
  assert.equal(/(^|[\s,>])(button|\.button|form)(\s|,|\{|$)/m.test(added), false);
});
