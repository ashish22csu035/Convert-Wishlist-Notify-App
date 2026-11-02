// Tests for the sample product photos in the Wishlist Settings and Notify Me Settings previews.
// Pure / file-level: no database, no browser (the real-browser look is checked separately in Edge).
//
// Run: node --test tests/preview-images.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREVIEW_IMAGE_BASE, PREVIEW_PRODUCT_IMAGES, previewImageUrl } from "../app/utils/preview-products.js";
import { PREVIEW_APP_ID, previewMarkup } from "../app/utils/wishlist-preview-document.js";

const DIR = "public/preview-products";
const TABS = ["general", "productPage", "collectionPage", "wishlistPage"];
const css = fs.readFileSync("app/styles/merchant.css", "utf8");
const doc = fs.readFileSync("app/utils/wishlist-preview-document.js", "utf8");
const notify = fs.readFileSync("app/components/notify-preview.jsx", "utf8");

test("every sample photo exists, is a real JPEG, is light enough to ship, and is listed in the credits", () => {
  const credits = fs.readFileSync(`${DIR}/CREDITS.md`, "utf8");
  assert.ok(Object.keys(PREVIEW_PRODUCT_IMAGES).length >= 8, "at least eight different photos");
  for (const [key, { file, position }] of Object.entries(PREVIEW_PRODUCT_IMAGES)) {
    const bytes = fs.readFileSync(path.join(DIR, file));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], `${key}: JPEG header`);
    assert.ok(bytes.length > 5_000 && bytes.length < 120_000, `${key}: ${bytes.length} bytes`);
    assert.match(position, /^\d{1,3}% \d{1,3}%$/, `${key}: a plain percentage object-position`);
    assert.ok(credits.includes(`\`${file}\``), `${key} is in CREDITS.md`);
  }
  assert.match(credits, /https:\/\/unsplash\.com\/license/);
  const listed = [...credits.matchAll(/https:\/\/unsplash\.com\/photos\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  assert.equal(new Set(listed).size, Object.keys(PREVIEW_PRODUCT_IMAGES).length, "one source page per photo");
  assert.equal(fs.readdirSync(DIR).filter((f) => f.endsWith(".jpg")).length, Object.keys(PREVIEW_PRODUCT_IMAGES).length, "no unused photo is left in the folder");
});

test("the photos are served from the app's own origin: a root-relative path, no outside host", () => {
  assert.equal(PREVIEW_IMAGE_BASE, "/preview-products/");
  for (const key of Object.keys(PREVIEW_PRODUCT_IMAGES)) assert.match(previewImageUrl(key), /^\/preview-products\/[a-z]+\.jpg$/);
  assert.equal(/https?:\/\/(?!unsplash)/.test(fs.readFileSync("app/utils/preview-products.js", "utf8").replace(/\/\/.*$/gm, "")), false, "no external URL in code");
});

test("every Wishlist Settings preview tab draws photos, never colour blocks, and every photo it names exists", () => {
  for (const tab of TABS) {
    const html = previewMarkup(tab);
    assert.equal(/pv-tone|linear-gradient/.test(html), false, `${tab}: no colour placeholder`);
    const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    if (tab === "productPage") assert.ok(srcs.length >= 5, "product page: main photo plus detail thumbnails");
    else assert.ok(srcs.length >= 2, `${tab}: product photos`);
    for (const src of srcs) assert.ok(fs.existsSync(path.join("public", src)), `${tab}: ${src} exists`);
    for (const m of html.matchAll(/<div class="pv-img[^"]*">(?!<img)/g)) assert.fail(`${tab}: an image box without a photo: ${m[0]}`);
  }
  // distinct photos within a grid: the general (collection grid) preview shows eight different products
  const general = [...previewMarkup("general").matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(general).size, general.length, "no photo repeats in the grid");
  assert.equal(general.length, 8);
  const collection = [...previewMarkup("collectionPage").matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(collection).size, collection.length);
  // the Wishlist page rows show different photos too
  const rows = [...previewMarkup("wishlistPage").matchAll(/kw-thumb[^>]*><div class="pv-img"><img src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows).size, 4);
});

test("photos are never stretched: a fixed-ratio box, object-fit cover, no forced width and height on the image itself", () => {
  assert.match(doc, /\.pv-img \{[^}]*aspect-ratio: 4 \/ 5;[^}]*overflow: hidden;/);
  assert.match(doc, /\.pv-img img \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: cover;[^}]*object-position: var\(--pv-pos, 50% 50%\);/);
  assert.match(doc, /\.pv-img--square \{ aspect-ratio: 1 \/ 1; \}/);
  assert.match(doc, /\.kw-thumb \.pv-img \{ height: 100%; aspect-ratio: auto; \}/, "the 80px Wishlist thumbnail box crops instead of squashing");
  assert.match(css, /\.kv-np-img \{[^}]*overflow: hidden;/);
  assert.match(css, /\.kv-np-img img \{[^}]*object-fit: cover;/);
  assert.match(css, /\.kv-np-canvas\[data-viewport="mobile"\] \.kv-np-img--lg \{ aspect-ratio: 4 \/ 3; \}/, "a 4:3 box on mobile");
  assert.equal(/\.kv-np-canvas\[data-viewport="mobile"\] \.kv-np-img--lg img \{[^}]*contain/.test(css), false, "no contain: the photo fills the width, so there are no side bars");
});

test("the old colour blocks and the CSS-drawn silhouette are gone from both previews", () => {
  for (const [name, source] of [["preview document", doc], ["merchant.css (Notify preview part)", css.slice(css.indexOf(".kv-np-canvas"))], ["notify-preview.jsx", notify]]) {
    assert.equal(/pv-tone|kv-np-tone/.test(source), false, `${name}: no tone classes`);
  }
  assert.equal(/\.pv-img::after/.test(doc), false, "no white rounded shape drawn on the image box");
  assert.equal(/\.kv-np-img \{[^}]*gradient/.test(css), false);
});

test("the Notify Me preview shows photos on both of its pages and keeps its sample behaviour", () => {
  assert.match(notify, /previewImageUrl\("shirt"\)/, "product page photo");
  assert.match(notify, /previewImagePosition\("shirt"\)/, "cropped by the manifest position, not stretched");
  assert.match(notify, /previewImageUrl\(row\.photo\)/, "Wishlist page rows");
  assert.equal((notify.match(/photo: "[a-z]+"/g) ?? []).length, 2);
  for (const kept of ["Relaxed linen shirt", "Size S is sold out in this sample.", "NOTIFY_SUBSCRIBED_LABEL", "Reset preview", "onSubscribed(false)"]) assert.ok(notify.includes(kept), kept);
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon/.test(notify), false, "still no way to reach a backend");
});

test("the sample page keeps its hearts, labels and the preview document id", () => {
  assert.ok(PREVIEW_APP_ID);
  const grid = previewMarkup("general");
  assert.equal((grid.match(/data-kw-button/g) ?? []).length, 8, "a heart on every sample card");
  for (const kept of ["Classic cotton tee", "$28.00", "kw-btn--card", "kw-heart"]) assert.ok(grid.includes(kept), kept);
  assert.ok(previewMarkup("wishlistPage").includes("Out of stock"), "availability labels stay");
  assert.ok(previewMarkup("wishlistPage").includes("Notify Me"));
});
