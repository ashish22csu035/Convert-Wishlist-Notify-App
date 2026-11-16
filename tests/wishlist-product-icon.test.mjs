// Product page display modes (Wishlist Settings > Product page > Display on product page): the pieces that carry the setting to
// the storefront. The rendering itself was checked in headless Chrome against a synthetic product page (button only, icon only
// with and without the block, both, add and remove); these tests keep the wiring and the rules that stop controls doubling up.
//
// Run: node --test tests/wishlist-product-icon.test.mjs
import "./helpers/resolve-extensionless.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_APPEARANCE, OPTION_LABELS, SPEC, toSparse } from "../app/utils/wishlist-appearance-shared.js";
import { previewMarkup, storefrontHooks } from "../app/utils/wishlist-preview-document.js";

const ASSETS = "extensions/konvert-wishlist/assets/";
const css = fs.readFileSync(ASSETS + "konvert-wishlist.css", "utf8").replace(/\r\n/g, "\n");
const core = fs.readFileSync(ASSETS + "konvert-wishlist.js", "utf8");
const extras = fs.readFileSync(ASSETS + "konvert-wishlist-extras.js", "utf8").replace(/\r\n/g, "\n");
const snippet = fs.readFileSync("extensions/konvert-wishlist/snippets/kw-config.liquid", "utf8");

test("the setting: three modes and four image corners, stored only when they differ from today's button", () => {
  assert.deepEqual(SPEC.productPage.displayMode.options, ["button", "icon", "both"]);
  assert.deepEqual(SPEC.productPage.imagePosition.options, ["top-right", "top-left", "bottom-left", "bottom-right"]);
  assert.deepEqual(SPEC.productPage.imagePosition.options, SPEC.collectionPage.position.options, "the same corners as the collection page");
  assert.equal("iconStyle" in SPEC.productPage, false, "the icon shape is the General icon type");
  assert.deepEqual(OPTION_LABELS.displayMode.map((o) => o[1]), ["Button only", "Icon only", "Both icon and button"]);
  assert.equal("iconStyle" in OPTION_LABELS, false);
  assert.equal(DEFAULT_APPEARANCE.productPage.displayMode, "button");
  assert.deepEqual(toSparse({}), { version: 1 });
});

test("the storefront receives the setting through the existing appearance path: attributes on <html>, nothing for the default", () => {
  assert.deepEqual(storefrontHooks({}).attributes, {});
  assert.deepEqual(storefrontHooks({ productPage: { displayMode: "both", imagePosition: "bottom-left" }, collectionPage: { position: "top-left" } }).attributes, { "data-kw-product-page-display-mode": "both", "data-kw-product-page-image-position": "bottom-left", "data-kw-collection-page-position": "top-left" });
  for (const value of ["button", "icon", "both", "top-right", "top-left", "bottom-left", "bottom-right"]) assert.match(value, /^[a-z_-]{1,16}$/, `${value} passes the script's own value check`);
});

test("the Liquid config carries what the icon needs without a block: product id, title, handle and first variant", () => {
  for (const key of ["productId", "productTitle", "productHandle", "variantId"]) assert.match(snippet, new RegExp(`"${key}":`), key);
  assert.match(snippet, /product\.selected_or_first_available_variant\.id/);
});

test("the core script asks for the extras script when an icon is to be shown (icon or both), and only then", () => {
  assert.match(core, /function showsProductIcon\(features\)/);
  assert.match(core, /page\.displayMode === 'icon' \|\| page\.displayMode === 'both'/);
  assert.match(core, /kw\.productIcon = showsProductIcon\(features\);/);
  assert.match(core, /kw\.productIcon \|\|/);
});

test("the extras script mounts exactly one icon, only on product pages and only for icon or both, as a product-page save button", () => {
  const body = extras.slice(extras.indexOf("function mountProductIcon()"), extras.indexOf("kw.mountProductIcon = mountProductIcon;"));
  assert.match(body, /!kw\.productIcon \|\|/, "only when the core script says the saved setting asks for an icon");
  assert.match(body, /config\.pageType !== 'product'/);
  assert.match(body, /for \(var i = 1; i < present\.length; i \+= 1\) present\[i\]\.remove\(\)/, "never more than one, whatever re-rendered");
  assert.match(body, /if \(present\.length\) return true/);
  assert.match(body, /'kw-btn kw-btn--product kw-btn--prodicon'/, "it reuses the product button's save and variant logic");
  assert.match(body, /setAttribute\('data-kw-button', ''\)/, "and the same click handler");
  assert.match(body, /data-kw-label/, "so the accessible name follows the saved state");
  assert.match(body, /host\.appendChild\(wrap\)/, "laid over the image's container, not placed by the title");
  assert.equal(/insertAdjacentElement|h1/.test(body), false, "nothing is placed next to the product title any more");
  assert.match(body, /getComputedStyle\(host\)\.position === 'static'\) host\.classList\.add\('kw-media-host'\)/, "the host is positioned only when the theme left it static");
  assert.match(extras, /mountHeaderIcon\(\);\n  mountProductIcon\(\);\n  watchProductIcon\(\);\n  scanCards\(\);\n  watchVariantChanges\(\);/, "mounted before the variant watcher looks for the product button");
});

test("the stylesheet: Icon only hides the block, the icon needs the setting, one shape per style, saved is visibly different", () => {
  assert.match(css, /html\[data-kw-product-page-display-mode='icon'\] \.kw-block \{\s*display: none;/);
  assert.match(css, /\.kw-prodicon \{\s*display: none;\s*\}/, "no icon unless the setting says so");
  assert.match(css, /html\[data-kw-product-page-display-mode\] \.kw-prodicon \{\s*position: absolute;\s*top: 12px;\s*right: 12px;\s*z-index: 3;\s*display: block;/, "top right of the image");
  assert.match(css, /\.kw-media-host \{\s*position: relative;/);
  assert.match(css, /\.kw-btn--prodicon\.kw-btn--product \{[^}]*background: rgba\(255, 255, 255, 0\.92\);[^}]*border-radius: 50%;[^}]*box-shadow:/s, "a round, lightly shadowed backing that reads on light and dark images");
  assert.match(css, /html\[data-kw-product-page-enabled='false'\] \.kw-prodicon \{\s*display: none !important;/, "the existing on/off switch hides the icon too");
  assert.equal(/icon-style/.test(css), false, "no separate icon style rules: the general icon type decides the shape");
  assert.equal(/kw-btn--prodicon \.kw-i-/.test(css), false);
  for (const corner of ["top-left", "bottom-left", "bottom-right"]) assert.ok(css.includes(`html[data-kw-product-page-image-position='${corner}'] .kw-prodicon`), corner);
  assert.match(css, /image-position='top-left'\] \.kw-prodicon \{\s*right: auto;\s*left: 12px;/);
  assert.match(css, /image-position='bottom-left'\] \.kw-prodicon \{\s*top: auto;\s*right: auto;\s*bottom: 12px;\s*left: 12px;/);
  assert.match(css, /image-position='bottom-right'\] \.kw-prodicon \{\s*top: auto;\s*bottom: 12px;/);
  assert.equal(/collection-page-position[^{]*kw-prodicon|image-position[^{]*kw-btn--card/.test(css), false, "the two positions never touch each other's element");
  assert.match(css, /\.kw-btn--prodicon\.kw-btn--product \{[^}]*width: 44px;[^}]*height: 44px;/s, "a 44px touch target");
  assert.match(css, /\.kw-btn--prodicon:focus-visible \{\s*outline:/, "a visible focus state");
});

test("the icon is never styled by, and never styles, the Add to cart or Buy it now buttons: every rule is on Konvert's own classes", () => {
  const added = css.slice(css.indexOf("/* Product page display"), css.indexOf(".kw-btn--loading {")).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...added.matchAll(/^([^{}\n/][^{}]*)\{/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
  assert.ok(selectors.length > 8);
  for (const selector of selectors) assert.match(selector, /\.kw-/, selector);
});

test("the preview draws the same icon: the same classes, shown or hidden by the same attributes", () => {
  const html = previewMarkup("productPage");
  assert.match(html, /<div class="kw-prodicon"><button type="button" class="kw-btn kw-btn--product kw-btn--prodicon" data-kw-button/);
  assert.match(html, /<div class="kw-block">/, "and the button block it already drew");
  assert.equal(html.split("kw-prodicon").length - 1, 1, "one icon in the preview");
});

test("the extras script finds the product image by what it is, never by the title or one theme's class names", () => {
  const find = extras.slice(extras.indexOf("function productImage()"), extras.indexOf("function mountProductIcon()"));
  assert.match(find, /box\.width < 150 \|\| box\.height < 150/, "thumbnails and icons are not the main image");
  assert.match(find, /MEDIA_SKIP/);
  for (const skipped of ["header", "footer", "dialog", "form[action*=\"/cart/add\"]", "thumb", "recommend"]) assert.ok(extras.includes(skipped), `${skipped} is skipped`);
  assert.match(find, /box\.width \* box\.height > bestArea/, "the largest visible picture wins");
  const host = extras.slice(extras.indexOf("function mediaHost(picture)"), extras.indexOf("function mountProductIcon()"));
  assert.match(host, /\^\(A\|BUTTON\)\$/, "never inside a link or a button (a zoom opener)");
  assert.match(host, /overflow === 'auto' \|\| overflow === 'scroll'/, "never inside a scrolling slider track");
  assert.match(extras, /watchProductIcon\(\);/);
  assert.match(extras, /shopify:section:load/, "re-mounted after a theme section reload, once");
});

test("the preview puts the icon over the sample product image, in the same corner", () => {
  const html = previewMarkup("productPage");
  assert.match(html, /<div class="pv-hero"><div class="pv-img pv-img--square">[\s\S]*?<div class="kw-prodicon">/, "inside the image's wrapper");
  assert.equal(/<\/h1>\s*<div class="kw-prodicon">/.test(html), false, "not under the title");
});
