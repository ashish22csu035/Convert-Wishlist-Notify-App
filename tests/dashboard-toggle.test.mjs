// Behaviour test for the Dashboard's "Wishlist items" card toggle (app/components/toggle-kpi-card.jsx).
//
// Run: node --test tests/dashboard-toggle.test.mjs
//
// The REAL component is compiled with esbuild and rendered with React 18 into a jsdom document; the
// buttons are clicked like a user would. No database or Shopify is involved. This proves the toggle is
// rendered and switches number, selected state and caption without a page reload; it does not prove
// the look of the card inside Shopify Admin (that needs a manual check).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

const OUT_DIR = path.resolve("node_modules/.cache/kw-toggle-test");
let ToggleKpiCard;
let wishlistItemsView;
let attributionView;
let ATTRIBUTION_FOOTNOTE;
let WISHLIST_ITEM_MODES;
let React;
let createRoot;
let dom;
let container;
let root;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  for (const name of ["window", "document", "HTMLElement", "Node", "Event", "MouseEvent"]) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `toggle-${Date.now().toString(36)}.mjs`);
  await build({
    entryPoints: ["app/components/toggle-kpi-card.jsx"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    logLevel: "silent",
  });
  ({ ToggleKpiCard } = await import(pathToFileURL(outfile).href));
  ({ WISHLIST_ITEM_MODES, wishlistItemsView, attributionView, ATTRIBUTION_FOOTNOTE } = await import("../app/utils/format.js"));
  React = (await import("react")).default;
  ({ createRoot } = await import("react-dom/client"));
});

after(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  dom?.window.close();
});

const dashboard = { wishlist: { savedItems: 3 }, activity: { allTime: { WISHLIST_ADDED: 5 } } };
const h = (...args) => React.createElement(...args);
const card = (options, extra = {}) => h(ToggleKpiCard, { label: "Wishlist items", icon: "heart", tone: "violet", options, initial: "active", ...extra });
const optionsFor = (d) => WISHLIST_ITEM_MODES.map((mode) => ({ ...mode, ...wishlistItemsView(d, mode.key) }));

async function mount(element) {
  container = document.getElementById("root");
  container.innerHTML = "";
  root = createRoot(container);
  await React.act(async () => root.render(element));
}
const unmount = () => React.act(async () => root.unmount());
const click = (button) => React.act(async () => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const buttons = () => [...container.querySelectorAll("button.kv-seg-btn")];
const text = (selector) => container.querySelector(selector)?.textContent;
const pressed = () => buttons().map((b) => b.getAttribute("aria-pressed"));

test("both options render in the card header; Active is selected by default with the right number and caption", async () => {
  await mount(card(optionsFor(dashboard)));
  assert.deepEqual(buttons().map((b) => b.textContent), ["Active", "All-time"]);
  assert.deepEqual(pressed(), ["true", "false"]);
  assert.equal(container.querySelector('[role="group"]').getAttribute("aria-label"), "Wishlist items view");
  assert.equal(text(".kv-kpi-value"), "3");
  assert.equal(text(".kv-kpi-label"), "Wishlist items");
  assert.equal(text(".kv-kpi-note"), "Currently saved by customers");
  // Layout: the header row holds only the icon and the control; number, title and caption sit below it.
  const header = container.querySelector(".kv-kpi-top");
  assert.deepEqual([...header.children].map((c) => c.className), ["kv-kpi-icon", "kv-seg"]);
  assert.equal(header.contains(container.querySelector(".kv-kpi-value")), false);
  await unmount();
});

test("clicking switches the number, the selected state and the caption immediately, and back again", async () => {
  await mount(card(optionsFor(dashboard)));
  await click(buttons()[1]); // All-time
  assert.equal(text(".kv-kpi-value"), "5");
  assert.equal(text(".kv-kpi-note"), "Total wishlist additions, including items later removed");
  assert.deepEqual(pressed(), ["false", "true"]);
  assert.ok(buttons()[1].classList.contains("on") && !buttons()[0].classList.contains("on"));

  await click(buttons()[0]); // Active
  assert.equal(text(".kv-kpi-value"), "3");
  assert.equal(text(".kv-kpi-note"), "Currently saved by customers");
  assert.deepEqual(pressed(), ["true", "false"]);
  await unmount();
});

test("switching changes only this card: a sibling card is left exactly as it was", async () => {
  await mount(
    h("div", null, card(optionsFor(dashboard)), h("div", { id: "sibling", className: "kv-kpi" }, h("span", { className: "kv-kpi-value" }, "42"), h("span", { className: "kv-kpi-note" }, "Other metric"))),
  );
  const before = container.querySelector("#sibling").outerHTML;
  await click(buttons()[1]);
  assert.equal(container.querySelector("#sibling").outerHTML, before);
  assert.equal(text(".kv-kpi-value"), "5");
  await unmount();
});

test("an unavailable figure is labelled unavailable, never shown as zero, while the other option still works", async () => {
  const partial = { wishlist: { savedItems: 3 }, activity: { allTime: {} } };
  await mount(card(optionsFor(partial)));
  assert.equal(text(".kv-kpi-value"), "3");
  await click(buttons()[1]);
  assert.equal(text(".kv-kpi-value"), "Unavailable");
  assert.equal(text(".kv-kpi-note"), "This figure could not be loaded.");
  await click(buttons()[0]);
  assert.equal(text(".kv-kpi-value"), "3");
  await unmount();
});

test("a real zero stays a zero", async () => {
  const empty = { wishlist: { savedItems: 0 }, activity: { allTime: { WISHLIST_ADDED: 0 } } };
  await mount(card(optionsFor(empty)));
  assert.equal(text(".kv-kpi-value"), "0");
  assert.equal(text(".kv-kpi-note"), "Currently saved by customers");
  await unmount();
});

test("the Dashboard route puts this toggle card first, defaulting to Active, fed by both counts", () => {
  const source = fs.readFileSync("app/routes/app._index.jsx", "utf8");
  assert.match(source, /<Grid>\s*<ToggleKpiCard\s+label="Wishlist items"/, "the first card in the metric grid is the toggle card");
  assert.match(source, /initial="active"/);
  assert.match(source, /WISHLIST_ITEM_MODES\.map\(\(mode\) => \(\{ \.\.\.mode, \.\.\.wishlistItemsView\(d, mode\.key\) \}\)\)/);
  // The merchant-ui barrel exports the real component, so the route's import resolves to it.
  assert.match(fs.readFileSync("app/components/merchant-ui.jsx", "utf8"), /export \{ ToggleKpiCard \} from "\.\/toggle-kpi-card"/);
});

// ---- Attributed revenue card: Overall / Wishlist / Notify Me -----------------------------------------
const attribution = {
  state: "ready",
  currency: "USD",
  overall: { orders: 3, revenue: "90.00", orderValue: "140.00" },
  wishlist: { orders: 2, revenue: "60.00", orderValue: "90.00" },
  notifyMe: { orders: 0, revenue: "0.00", orderValue: "0.00" },
};
const revenueCard = (extra = {}) => h(ToggleKpiCard, { label: "Attributed revenue", icon: "cart", tone: "green", options: attributionView(attribution, 30).options, initial: "overall", ...extra });
const notes = () => [...container.querySelectorAll(".kv-kpi-note")].map((n) => n.textContent);

const hintText = () => container.querySelector(".kv-hint").getAttribute("aria-label");

test("revenue card: three options render, Overall is the default, each switch changes the figures, and the long explanation lives in the (i) tooltip", async () => {
  await mount(revenueCard());
  assert.deepEqual(buttons().map((b) => b.textContent), ["Overall", "Wishlist", "Notify Me"]);
  assert.deepEqual(pressed(), ["true", "false", "false"]);
  assert.equal(text(".kv-kpi-value"), "$90.00");
  // the card itself stays short: figure, attributed orders and the full value of those orders
  assert.deepEqual(notes(), ["3 attributed orders · last 30 days", "Full order value: $140.00"]);
  assert.equal(notes().some((n) => /not the whole order|Last touch/.test(n)), false, "no long copy on the card");
  const info = container.querySelector("button.kv-hint");
  assert.ok(info, "an (i) button is present");
  assert.match(hintText(), /counted once/);
  assert.match(hintText(), /not the whole order/, "the tooltip says revenue is only the eligible items");
  assert.match(hintText(), /Last touch within 7 days/);
  assert.ok(container.querySelector("s-tooltip").textContent.includes("not the whole order"), "the tooltip content is in the page for hover and focus");

  await click(buttons()[1]); // Wishlist
  assert.equal(text(".kv-kpi-value"), "$60.00");
  assert.equal(notes()[0], "2 attributed orders · last 30 days");
  assert.match(hintText(), /Wishlist/);
  assert.deepEqual(pressed(), ["false", "true", "false"]);

  await click(buttons()[2]); // Notify Me: a confirmed zero
  assert.equal(text(".kv-kpi-value"), "$0.00");
  assert.deepEqual(notes(), ["0 attributed orders · last 30 days"]);
  assert.match(hintText(), /restock email/);
  assert.deepEqual(pressed(), ["false", "false", "true"]);

  await click(buttons()[0]);
  assert.equal(text(".kv-kpi-value"), "$90.00");
  await unmount();
});

test("revenue card for a custom date range names the range instead of 'last N days'", async () => {
  const options = attributionView(attribution, { kind: "custom", days: 15, from: "2026-10-01", to: "2026-10-15" }).options;
  await mount(revenueCard({ options }));
  assert.equal(notes()[0], "3 attributed orders · Oct 1 – Oct 15, 2026 (UTC)");
  await unmount();
});

test("revenue card and Wishlist items card switch independently", async () => {
  await mount(h("div", null, h("div", { id: "wl" }, card(optionsFor(dashboard))), h("div", { id: "rev" }, revenueCard())));
  const wl = () => document.querySelector("#wl");
  const rev = () => document.querySelector("#rev");
  const wlBefore = wl().innerHTML;
  await click(rev().querySelectorAll("button")[2]); // Notify Me
  assert.equal(wl().innerHTML, wlBefore, "the Wishlist items card did not move");
  assert.equal(rev().querySelector(".kv-kpi-value").textContent, "$0.00");

  const revBefore = rev().innerHTML;
  await click(wl().querySelectorAll("button")[1]); // All-time
  assert.equal(rev().innerHTML, revBefore, "the revenue card did not move");
  assert.equal(wl().querySelector(".kv-kpi-value").textContent, "5");
  await unmount();
});

test("the Dashboard shows the revenue toggle card (or its setup message) in place of the old placeholder", () => {
  const source = fs.readFileSync("app/routes/app._index.jsx", "utf8");
  assert.match(source, /<ToggleKpiCard label="Attributed revenue"[^>]*options={revenue.options}[^>]*initial="overall"/);
  assert.match(source, /display={revenue.setup.display}/, "setup states render a message, not a number");
  assert.equal(source.includes("Order data is not collected yet"), false);
  assert.equal(/UnavailableCard/.test(source), false);
});
