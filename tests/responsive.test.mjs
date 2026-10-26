// Tests for the phone layout of the merchant screens (app/styles/merchant.css and the two small component hooks it needs).
//
// Run: node --test tests/responsive.test.mjs
//
// These read the source: they prove that every phone rule sits inside a max-width media query (so no
// desktop declaration is changed), that the desktop declarations are still the original ones, that the
// breakpoints are the existing ones, and that overflow is never hidden globally. The layout itself was
// checked by rendering the six real pages in headless Chrome at 320-1280px (see the report); these tests
// guard the CSS that produced it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync("app/styles/merchant.css", "utf8");

// Splits the stylesheet into the rules outside any @media block and the @media blocks themselves.
function split(source) {
  let base = "";
  const media = [];
  let i = 0;
  while (i < source.length) {
    const at = source.indexOf("@media", i);
    if (at === -1) {
      base += source.slice(i);
      break;
    }
    base += source.slice(i, at);
    const open = source.indexOf("{", at);
    let depth = 1;
    let j = open + 1;
    while (depth > 0) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    media.push({ query: source.slice(at + 6, open).trim(), body: source.slice(open + 1, j - 1) });
    i = j;
  }
  return { base, media };
}
const { base, media } = split(css);
const phone = media.find((m) => m.query === "(max-width: 560px)" && m.body.includes(".kv-chart-scroll"));

test("every breakpoint is one the stylesheet already used: no competing system", () => {
  const queries = [...new Set(media.map((m) => m.query))].sort();
  assert.deepEqual(queries, ["(max-width: 359px)", "(max-width: 560px)", "(max-width: 700px)", "(max-width: 900px)"]);
});

test("the phone rules live only inside the phone media query", () => {
  assert.ok(phone, "one block holds the phone rules");
  for (const selector of [".kv-chart-scroll", ".kv-info-panel", ".kv-range-custom label", ".kv-toolbar > div:not(.grow)", ".kv-product-title", ".kv-kpis > .has-seg"]) {
    assert.ok(phone.body.includes(selector), `${selector} is adjusted for phones`);
  }
  assert.equal(base.includes(".kv-chart-scroll"), false, "the chart wrapper has no desktop style: it adds nothing on a wide screen");
  assert.equal(/\.kv-info-panel \{[^}]*position: fixed/.test(base), false);
  assert.equal(/min-width: 520px/.test(base), false);
  assert.equal(base.includes(".has-seg"), false);
});

test("the desktop declarations are still the original ones", () => {
  const rule = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()>*+]/g, "\\$&")} \\{([^}]*)\\}`).exec(base)?.[1] ?? "";
  assert.match(rule(".kv"), /padding: 20px;/);
  assert.match(rule(".kv"), /gap: 16px;/);
  assert.match(rule(".kv-range"), /min-width: 170px;/);
  assert.match(rule(".kv-kpi"), /padding: 16px;/);
  assert.match(rule(".kv-kpi-value"), /font-size: 28px;/);
  assert.match(rule(".kv-product-title"), /white-space: nowrap;/);
  assert.match(rule(".kv-chart text"), /font-size: 10px;/);
  assert.match(rule(".kv-split"), /grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/);
  assert.match(rule(".kv-kpis"), /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  assert.match(rule(".kv-kpis.n4"), /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(rule(".kv-info-panel"), /position: absolute;/);
  assert.match(rule(".kv-funnel"), /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
});

test("KPI cards stay two to a row on a phone, switch cards take the row, and only very narrow screens get one column", () => {
  const tablet = media.filter((m) => m.query === "(max-width: 900px)").map((m) => m.body).join(" ");
  assert.match(tablet, /\.kv-kpis\.n4 \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  const narrow = media.find((m) => m.query === "(max-width: 359px)").body;
  assert.match(narrow, /\.kv-kpis\.n4 \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(narrow, /\.kv-kpis\.n2 > \*,/, "two session cards also stack on a very narrow screen");
  assert.match(phone.body, /\.kv-kpis > \.has-seg \{\s*grid-column: 1 \/ -1;/);
  assert.match(phone.body, /\.kv-kpi-value \{\s*font-size: 22px;/);
});

test("overflow is never hidden to cover a layout problem; the chart scrolls inside its own box", () => {
  assert.equal(/overflow-x:\s*hidden/.test(css), false);
  assert.equal(/\boverflow:\s*hidden/.test(base.replace(/\.kv-product-title[^}]*\}/g, "").replace(/\.kv-thumb[^}]*\}/g, "").replace(/\.kv-sr[^}]*\}/g, "").replace(/\.kv-pv-(?:stage|device)[^}]*\}/g, "")), false, "no blanket overflow: hidden (only the thumbnail, the ellipsis title, the screen-reader text and the Wishlist Settings preview viewport clip; the preview's content scrolls inside its own frame)");
  assert.match(phone.body, /\.kv-chart-scroll \{\s*overflow-x: auto;/);
  assert.match(phone.body, /\.kv-chart \{\s*min-width: 520px;/);
  assert.match(phone.body, /\.kv-chart text \{\s*font-size: 12px;/, "axis labels stay readable at the scaled size");
});

test("phone controls: date inputs stack, buttons are touch-sized, long names wrap, the popover stays on screen", () => {
  assert.match(phone.body, /\.kv-range-apply \{\s*min-height: 40px;/);
  assert.match(phone.body, /\.kv-range-custom input\[type="date"\] \{\s*width: 100%;\s*min-width: 0;/);
  assert.match(phone.body, /\.kv-product-title \{\s*white-space: normal;\s*overflow-wrap: anywhere;/);
  assert.match(phone.body, /\.kv-info-panel \{\s*position: fixed;\s*inset-inline: 12px;/);
  assert.match(phone.body, /\.kv-pager \{\s*flex-wrap: wrap;/);
  assert.match(phone.body, /\.kv-toolbar > div:not\(\.grow\) \{[^}]*min-width: 0 !important;/s);
});

test("the two component hooks are inert on a wide screen: a plain wrapper and a class name", () => {
  assert.match(fs.readFileSync("app/components/activity-chart.jsx", "utf8"), /<div className="kv-chart-scroll">\s*<svg className="kv-chart"/);
  assert.match(fs.readFileSync("app/components/toggle-kpi-card.jsx", "utf8"), /className=\{`kv-kpi has-seg /);
  assert.equal(/\.kv-chart-scroll|\.has-seg/.test(base), false);
});
