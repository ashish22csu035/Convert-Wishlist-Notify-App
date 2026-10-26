// Guards the responsive CSS hooks and the app-block script size limit.
//
// Run: node --test tests/wishlist-responsive.test.mjs
//
// These are static checks of the stylesheet. They do not render anything: the
// layout itself was checked separately in headless Chrome at 320, 375, 390, 430,
// 768, 1024 and 1280 px, and should be re-checked in a real browser on the store
// after design changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ASSETS = "extensions/konvert-wishlist/assets/";
const css = fs.readFileSync(ASSETS + "konvert-wishlist.css", "utf8").replace(/\r\n/g, "\n");

// Tiny CSS reader: returns [{ at, selectors, body }] where `at` is the enclosing
// @media query (or null). Handles one level of @media nesting, which is all this
// stylesheet uses.
function parse(source, at = null) {
  const rules = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const prelude = source.slice(preludeStart, bodyStart - 1).trim();
        const body = source.slice(bodyStart, i);
        if (prelude.startsWith("@media")) rules.push(...parse(body, prelude.replace("@media", "").trim()));
        else if (!prelude.startsWith("@")) rules.push({ at, selectors: prelude.split(",").map((s) => s.trim()), body });
        preludeStart = i + 1;
      }
    }
  }
  return rules;
}
const rules = parse(css.replace(/\/\*[\s\S]*?\*\//g, ""));

// Declarations of the first rule containing `selector` inside the given @media query
// (or outside any query when `at` is null).
function decl(selector, at = null) {
  const hits = rules.filter((r) => r.at === at && r.selectors.includes(selector));
  return hits.length ? hits.map((r) => r.body).join(";") : null;
}
// "width: 44px" style check on a declaration block
const has = (body, property, value) =>
  (body ?? "")
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .includes(`${property}: ${value}`);

test("collection hearts are 44x44 touch targets that sit above a card's overlay link", () => {
  const heart = decl(".kw-btn--card");
  assert.ok(heart, "rule exists");
  // Never below 44px: with the default 22px icon the size is max(44px, 22px + 22px) = 44px, as before the icon size became a setting.
  const size = "max(44px, calc(var(--kw-collection-page-icon-size, 22) * 1px + 22px))";
  assert.ok(has(heart, "width", size) && has(heart, "height", size));
  assert.ok(has(heart, "position", "absolute"));
  assert.ok(has(heart, "z-index", "10"), "above Dawn-style card overlay links (z-index 1), within the card's own stacking context");
  assert.ok(has(heart, "touch-action", "manipulation"));
});

test("the product-page button fits the content width and keeps a 44px height", () => {
  const button = decl(".kw-btn--product");
  assert.ok(has(button, "width", "100%") && has(button, "max-width", "100%") && has(button, "box-sizing", "border-box"));
  assert.ok(has(button, "min-height", "44px"));
  assert.ok(has(button, "align-items", "center") && has(button, "justify-content", "center"));
  const block = decl(".kw-block");
  assert.ok(has(block, "max-width", "100%") && has(block, "box-sizing", "border-box"));
  assert.ok(has(decl(".kw-btn--product .kw-btn__label"), "overflow-wrap", "anywhere"), "long labels wrap");
  assert.ok(has(decl(".kw-btn--product .kw-heart"), "flex", "none"), "heart never shrinks");
});

test("My Wishlist becomes stacked cards up to 860px (tablet and phones) without sideways scrolling", () => {
  const MOBILE = "(max-width: 860px)";
  const row = decl(".kw-row", MOBILE);
  assert.ok(row, "860px breakpoint rule exists");
  assert.ok(has(row, "display", "grid"));
  assert.ok(row.includes("'img name name rm'") && row.includes("'qty qty act act'"), "named areas for image, name, remove, qty, action");
  assert.ok(has(decl(".kw-table-wrap", MOBILE), "overflow-x", "visible"), "no inner scroll box on mobile");
  assert.ok(has(decl(".kw-table", MOBILE), "display", "block"));
  assert.ok(has(decl(".kw-table", MOBILE), "min-width", "0"));
  assert.ok((decl(".kw-table thead", MOBILE) ?? "").includes("clip: rect(0 0 0 0)"), "header row visually hidden, still in the DOM for assistive tech");
  assert.ok(has(decl(".kw-page", MOBILE), "overflow-x", "hidden"), "safety net against page-level horizontal scroll");
});

test("mobile controls are at least 44px tall and text can wrap safely", () => {
  const MOBILE = "(max-width: 860px)";
  assert.ok(has(decl(".kw-btn-cart", MOBILE), "min-height", "44px"));
  assert.ok(has(decl(".kw-btn-cart", MOBILE), "overflow-wrap", "anywhere"));
  const remove = decl(".kw-row__remove", MOBILE);
  assert.ok(has(remove, "width", "44px") && has(remove, "height", "44px"));
  assert.ok(has(decl(".kw-qty__btn", MOBILE), "min-height", "44px"));
  assert.ok(has(decl(".kw-price", MOBILE), "overflow-wrap", "anywhere"));
  assert.ok(has(decl(".kw-price__compare"), "white-space", "nowrap"), "a price never breaks in the middle of a number");
});

test("Select mode keeps its checkbox and bulk bar usable on mobile", () => {
  const MOBILE = "(max-width: 860px)";
  assert.ok(has(decl(".kw-table--select .kw-td--select", MOBILE), "position", "absolute"), "checkbox sits in its own gutter");
  assert.ok((decl(".kw-table--select .kw-row", MOBILE) ?? "").includes("padding-left"));
  assert.ok(has(decl(".kw-bulk .kw-btn-cart", MOBILE), "flex", "1 1 140px"), "bulk buttons wrap instead of overflowing");
});

test("a smaller layout exists for very narrow phones (320px)", () => {
  assert.ok(has(decl(".kw-thumb", "(max-width: 360px)"), "width", "72px"));
});

test("desktop keeps the table: the card layout only applies up to 860px", () => {
  assert.ok(has(decl(".kw-table"), "min-width", "780px"));
  assert.ok((decl(".kw-th") ?? "").includes("background"), "grey header row");
  assert.ok(decl(".kw-th--price", "(min-width: 861px)"), "desktop-only column width starts above the breakpoint");
  assert.equal(decl(".kw-row"), null, "no card-style grid on the base (desktop) row");
});

test("the app-block script stays under Shopify's 10,000 byte limit", () => {
  const bytes = fs.statSync(ASSETS + "konvert-wishlist.js").size;
  assert.ok(bytes < 10000, `konvert-wishlist.js is ${bytes} bytes`);
});

test("regression: card hearts cannot paint above a sticky header (the mobile header-overlap bug)", () => {
  // Cause: the heart had a high z-index in the page-wide stacking context, above
  // Dawn-style sticky headers (z-index 3), so hearts of cards scrolling under the
  // header were painted over the logo and cart. Fix: each card is its own stacking
  // context, so the heart's z-index only competes with the card's overlay link.
  assert.ok(has(decl(".kw-card-host"), "isolation", "isolate"), "cards isolate their stacking");
  const heart = decl(".kw-btn--card");
  assert.ok(has(heart, "position", "absolute"));
  assert.ok(has(heart, "z-index", "10"), "z-index is local to the card (needs the isolation rule above)");
  assert.ok(!(heart ?? "").includes("position: fixed"), "never positioned against the viewport");
});

test("the wishlist icon only ever lives in the header: no floating or drawer styling or code exists", () => {
  const extras = fs.readFileSync(ASSETS + "konvert-wishlist-extras.js", "utf8");
  for (const [name, source] of [["stylesheet", css], ["extras script", extras]]) {
    assert.equal(/kw-header-icon--floating/.test(source), false, name + " has no floating placement");
    assert.equal(/kw-header-icon--drawer/.test(source), false, name + " has no drawer placement");
  }
  assert.equal(/menu-drawer/.test(extras.replace(/never moved into the menu drawer/, "")), false, "no code touches the theme's menu drawer");
  assert.equal(/position:s*fixed/.test(decl(".kw-header-icon") ?? ""), false, "the icon is never positioned against the viewport");
  assert.ok(has(decl(".kw-header-icon"), "width", "44px") && has(decl(".kw-header-icon"), "height", "44px"), "44px touch target");
});

test("narrow headers: the header's own grid is adjusted (side columns to content), then its side padding, never the controls", () => {
  const NARROW = "(max-width: 989px)";
  const tight = decl("header.kw-header--tight[class]", NARROW);
  assert.ok(tight, "tight rule exists and applies only to mobile/tablet widths");
  assert.ok(has(tight, "grid-template-columns", "auto 1fr auto"), "menu | logo | icons: logo takes the leftover space");
  const compact = decl("header.kw-header--tight.kw-header--compact[class]", NARROW);
  assert.ok(has(compact, "padding-right", "1.5rem") && has(compact, "padding-left", "1.5rem"), "page's standard side padding, only as a second step");
  assert.equal(decl("header.kw-header--tight[class]"), null, "nothing applies outside the narrow-width media query");
  // scoped to the header element carrying our class: no global selectors
  for (const rule of rules.filter((r) => r.selectors.some((sel) => sel.includes("kw-header--")))) {
    assert.ok(rule.selectors.every((sel) => sel.startsWith("header.kw-header--")), "scoped: " + rule.selectors.join(", "));
  }
});
