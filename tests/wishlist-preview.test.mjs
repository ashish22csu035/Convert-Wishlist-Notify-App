// Guards against the Wishlist Settings preview drifting away from the real storefront
// (app/utils/wishlist-preview-document.js vs konvert-wishlist.js / .css / -extras.js).
//
// Run: node --test tests/wishlist-preview.test.mjs
//
// Pure: no database, no browser. The REAL storefront script runs in node:vm and its output is compared with the
// preview's own function, so the preview applies settings exactly the way the storefront does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DEFAULT_APPEARANCE, resolveAppearance, toSparse, wishlistIconSvg } from "../app/utils/wishlist-appearance-shared.js";
import { PREVIEW_VIEWPORTS, SAMPLE_THEME_CSS, previewMarkup, previewShell, storefrontHooks } from "../app/utils/wishlist-preview-document.js";

const ASSETS = "extensions/konvert-wishlist/assets/";
const CORE = fs.readFileSync(ASSETS + "konvert-wishlist.js", "utf8");
const EXTRAS = fs.readFileSync(ASSETS + "konvert-wishlist-extras.js", "utf8");
const css = fs.readFileSync(ASSETS + "konvert-wishlist.css", "utf8").replace(/\r\n/g, "\n");
const PAGE_TEMPLATE = fs.readFileSync("app/routes/proxy.my-wishlist.jsx", "utf8"); // the Liquid the Wishlist page route serves
const TABS = ["general", "productPage", "collectionPage", "wishlistPage"];

// What the real script puts on <html> for an appearance document.
async function realHooks(appearance) {
  const attributes = {};
  const variables = {};
  const root = {
    setAttribute: (k, v) => { attributes[k] = String(v); },
    removeAttribute: (k) => { delete attributes[k]; },
    style: { setProperty: (k, v) => { variables[k] = String(v); }, removeProperty: (k) => { delete variables[k]; } },
    classList: { add() {}, remove() {}, contains: () => false },
  };
  const node = { textContent: JSON.stringify({ featuresPath: "/f", collectionCards: true, headerIcon: true, text: {} }) };
  const document = { readyState: "complete", documentElement: root, head: { appendChild() {} }, body: {}, createElement: () => ({}), querySelectorAll: (s) => (s === "script[data-kw-config]" ? [node] : []), querySelector: () => null, addEventListener() {} };
  const window = { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, Shopify: {}, location: { assign() {} } };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ wishlist: true, notifyMe: true, appearance }) });
  vm.runInContext(CORE, vm.createContext({ window, document, fetch, console: { warn() {} } }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  return { attributes, variables };
}

const SAMPLES = [
  DEFAULT_APPEARANCE,
  { general: { iconType: "star" } },
  { general: { iconType: "bookmark", defaultColor: "#112233", hoverColor: "#445566", activeColor: "#778899", useThemeFonts: false } },
  { productPage: { enabled: false, buttonType: "icon", position: "right", buttonStyle: "filled", buttonRadius: 0, widthMode: "manual", manualWidth: 800 } },
  { productPage: { widthMode: "auto", buttonRadius: 50, manualWidth: 100 } },
  { collectionPage: { enabled: false, iconSize: 14, backgroundOpacity: 0, position: "bottom-left", countDisplay: "none" } },
  { collectionPage: { iconSize: 40, backgroundOpacity: 100, position: "bottom-right" } },
  { wishlistPage: { layout: "grid", headerIcon: false } },
  { general: { iconType: "star", defaultColor: "#abcdef" }, productPage: { buttonStyle: "filled" }, collectionPage: { position: "top-left" }, wishlistPage: { layout: "grid" } },
];

test("the preview applies settings exactly as the real storefront script does", async () => {
  for (const sample of SAMPLES) {
    const appearance = toSparse(resolveAppearance(sample));
    const real = await realHooks(appearance);
    const preview = storefrontHooks(appearance);
    assert.deepEqual(preview.attributes, real.attributes, `attributes for ${JSON.stringify(sample)}`);
    assert.deepEqual(preview.variables, real.variables, `variables for ${JSON.stringify(sample)}`);
  }
});

test("an untouched shop gets no attribute and no variable, so the storefront stylesheet's own look shows", () => {
  assert.deepEqual(storefrontHooks(DEFAULT_APPEARANCE), { attributes: {}, variables: {} });
  assert.deepEqual(storefrontHooks(null), { attributes: {}, variables: {} });
  assert.deepEqual(storefrontHooks({ general: { defaultColor: "javascript:alert(1)", iconType: "<b>" } }), { attributes: {}, variables: {} }, "invalid values never reach the frame");
});

test("theme-editor colour precedence: no colour variable unless the merchant chose one", () => {
  assert.equal("--kw-general-default-color" in storefrontHooks(resolveAppearance({ general: { iconType: "star" } })).variables, false);
  assert.equal(storefrontHooks(resolveAppearance({ general: { defaultColor: "#ABC" } })).variables["--kw-general-default-color"], "#aabbcc");
  assert.match(SAMPLE_THEME_CSS, /:root \{ --kw-accent: #d6336c;/, "the sample theme stands in for the embed's Heart color setting");
});

test("the icon is the storefront's own markup, character for character", () => {
  assert.ok(CORE.includes(wishlistIconSvg()), "konvert-wishlist.js contains exactly the SVG the preview draws");
  assert.ok(previewMarkup("general").includes(wishlistIconSvg()));
});

test("every storefront class the sample pages use exists in the storefront stylesheet or script", () => {
  const PREVIEW_ONLY = new Set(["kw-force-hover"]); // draws the :hover colour statically (see SAMPLE_THEME_CSS)
  for (const tab of TABS) {
    const used = new Set([...previewMarkup(tab).matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith("kw-")));
    assert.ok(used.size > 3, `${tab} uses storefront classes`);
    for (const name of used) {
      if (PREVIEW_ONLY.has(name)) continue;
      assert.ok(css.includes(`.${name}`) || CORE.includes(name) || EXTRAS.includes(name) || PAGE_TEMPLATE.includes(name), `${tab}: .${name} is a real storefront class`);
    }
  }
});

test("the Wishlist page sample is built like the page script builds it", () => {
  const html = previewMarkup("wishlistPage");
  for (const cell of ["select", "remove", "image", "name", "price", "stock", "qty", "action"]) {
    assert.ok(html.includes(`kw-td--${cell}`), `cell ${cell}`);
    assert.ok(EXTRAS.includes(`kw-td--${cell}`) || EXTRAS.includes(`'${cell}'`) || EXTRAS.includes(`kw-th--${cell}`), `the page script has the same ${cell} cell`);
  }
  for (const part of ["kw-qty__btn", "kw-qty__input", "kw-btn-cart--notify", "kw-row__variant", "kw-line", "kw-page__select"]) {
    assert.ok(EXTRAS.includes(part) || PAGE_TEMPLATE.includes(part), `the page script uses ${part}`);
    assert.ok(html.includes(part), `the sample uses ${part}`);
  }
  // the page script builds the stock class as 'kw-stock kw-stock--' + state; the stylesheet defines both states the sample shows
  assert.ok(EXTRAS.includes("'kw-stock kw-stock--' + state"));
  for (const state of ["in", "out"]) assert.ok(css.includes(`.kw-stock--${state}`) && html.includes(`kw-stock--${state}`), `stock state ${state}`);
  assert.ok(PAGE_TEMPLATE.includes('class="kw-page__body"') && html.includes('class="kw-page__body"'), "the page body wrapper matches the served page");
});

test("sample pages hold only invented, inert content", () => {
  for (const tab of [...TABS, "unknown"]) {
    const html = previewMarkup(tab);
    assert.doesNotMatch(html, /<script|<form|<iframe|<link|<object|<embed|\ssrc=|srcset=|on\w+\s*=/i, `${tab}: nothing executable or loadable`);
    assert.doesNotMatch(html, /href="(?!#")/, `${tab}: links go nowhere`);
    assert.doesNotMatch(html, /gid:\/\/|@[a-z]+\.[a-z]|myshopify|https?:\/\//i, `${tab}: no shop, customer or product data`);
    for (const button of html.match(/<button[^>]*>/g) ?? []) assert.match(button, /type="button"/, `${tab}: ${button}`);
  }
  assert.match(previewMarkup("nope"), /data-preview="general"/, "an unknown tab falls back to the General page");
  assert.doesNotMatch(previewShell("a{}"), /@import|https?:/);
});

test("the touch target never drops below 44px for any icon size, in the same CSS the storefront uses", () => {
  assert.ok(css.includes("width: max(44px, calc(var(--kw-collection-page-icon-size, 22) * 1px + 22px));"));
  assert.ok(css.includes("height: max(44px, calc(var(--kw-collection-page-icon-size, 22) * 1px + 22px));"));
  for (const size of [14, 22, 40]) assert.ok(Math.max(44, size + 22) >= 44);
});

test("preview widths are real storefront widths on either side of the storefront's own breakpoint", () => {
  const breakpoint = Number(/@media \(max-width: (\d+)px\) \{\s*\.kw-page \{/.exec(css)[1]); // where the Wishlist table becomes cards
  assert.equal(breakpoint, 860);
  assert.ok(PREVIEW_VIEWPORTS.desktop.width > breakpoint, "the desktop preview shows the table layout");
  assert.ok(PREVIEW_VIEWPORTS.mobile.width <= breakpoint, "the mobile preview shows the phone layout");
  const sampleBreakpoint = Number(/@media \(max-width: (\d+)px\)/.exec(SAMPLE_THEME_CSS)[1]);
  assert.ok(PREVIEW_VIEWPORTS.mobile.width <= sampleBreakpoint && PREVIEW_VIEWPORTS.desktop.width > sampleBreakpoint);
});
