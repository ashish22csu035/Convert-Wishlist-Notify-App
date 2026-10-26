// Behaviour tests for the Wishlist Settings screen (app/components/wishlist-settings-form.jsx and its preview), the
// "Wishlist Settings" link on the Settings screen, and the route's server wiring.
//
// Run: node --test tests/wishlist-settings-ui.test.mjs
//
// Like tests/merchant-components.test.mjs: the REAL components are compiled with esbuild and rendered with React 18 into
// jsdom inside a real react-router. Polaris web components are not defined in jsdom, so they are plain unknown elements
// and the tests drive them the way the browser does (set the property, dispatch the native event). This proves the
// logic and the wiring; it cannot prove how Polaris draws the fields or how a real theme draws the storefront.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { DEFAULT_APPEARANCE, mergeAppearance, normalizeStored, resolveAppearance, toSparse, validateAppearance } from "../app/utils/wishlist-appearance-shared.js";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

const OUT_DIR = path.resolve("node_modules/.cache/kw-wishlist-settings-test");
const SHOP = "demo-store.myshopify.com";
let Form;
let Settings;
let Preview;
let React;
let ReactRouter;
let createRoot;
let dom;
let container;
let root;
const clipboard = [];

const h = (...args) => React.createElement(...args);

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: "http://localhost/" });
  for (const name of ["window", "document", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent"]) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text) => clipboard.push(text) }, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now().toString(36);
  const bundle = async (entry, name) => {
    const outfile = path.join(OUT_DIR, `${name}-${stamp}.mjs`);
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      loader: { ".css": "empty" },
      external: ["react", "react/jsx-runtime", "react-dom", "react-router"],
      alias: { "@shopify/shopify-app-react-router/server": path.resolve("tests/helpers/shopify-server-stub.mjs") },
      plugins: [
        {
          name: "raw-text", // Vite's "?raw" import (the storefront stylesheet, as text)
          setup(b) {
            b.onResolve({ filter: /^virtual:konvert-storefront-css$/ }, () => ({ path: path.resolve("extensions/konvert-wishlist/assets/konvert-wishlist.css"), namespace: "raw-text" })); // vite.config.js virtual module
            b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")), namespace: "raw-text" }));
            b.onLoad({ filter: /.*/, namespace: "raw-text" }, (args) => ({ contents: fs.readFileSync(args.path, "utf8"), loader: "text" }));
          },
        },
      ],
      logLevel: "silent",
    });
    return import(pathToFileURL(outfile).href);
  };
  Form = await bundle("app/components/wishlist-settings-form.jsx", "wsform");
  Settings = await bundle("app/components/settings-form.jsx", "settings");
  Preview = await bundle("app/components/wishlist-appearance-preview.jsx", "preview");
  React = (await import("react")).default;
  ReactRouter = await import("react-router");
  ({ createRoot } = await import("react-dom/client"));
});

after(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  dom?.window.close();
});

async function mount(element) {
  container = document.getElementById("root");
  container.innerHTML = "";
  root = createRoot(container);
  await React.act(async () => root.render(element));
}
const unmount = () => React.act(async () => root.unmount());
const act = (fn) => React.act(async () => fn());
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byText = (selector, text) => [...container.querySelectorAll(selector)].find((el) => el.textContent.trim() === text);
const banners = () => [...container.querySelectorAll("s-banner")].map((b) => ({ heading: b.getAttribute("heading"), text: b.textContent, tone: b.getAttribute("tone") }));
const hasBanner = (heading) => banners().some((b) => b.heading === heading);

const select = (label) => container.querySelector(`s-select[label="${label}"]`);
const field = (tag, label) => container.querySelector(`${tag}[label="${label}"]`);
const toggle = (label) => container.querySelector(`s-switch[label="${label}"]`);
const choose = (label, value) => act(() => { select(label).value = value; fire(select(label), "change"); });
const type = (el, value) => act(() => { el.value = value; fire(el, "input"); });
const flip = (el, on) => act(() => { el.checked = on; fire(el, "change"); });
const tab = (name) => byText('button[role="tab"]', name);
const goTab = (name) => click(tab(name));
const saveButton = () => byText("s-button", "Save") ?? byText("s-button", "Saving…");
const discardButton = () => byText("s-button", "Discard");
const selectedTab = () => [...container.querySelectorAll('button[role="tab"]')].filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.textContent);

// The stub route's action does what the real one does with the posted text: the shared validator, then the merge.
function formApp({ appearance = DEFAULT_APPEARANCE, action, apiKey = "key123" } = {}) {
  const calls = [];
  let savedDocument = toSparse(appearance);
  const Stub = ReactRouter.createRoutesStub([
    {
      path: "/",
      Component: () => h(React.Fragment, null, h(ReactRouter.Link, { to: "/elsewhere", id: "go" }, "go elsewhere"), h(Form.WishlistSettingsForm, { appearance, shop: SHOP, apiKey })),
      action: async ({ request }) => {
        const posted = (await request.formData()).get("appearance");
        calls.push(posted);
        if (action) {
          const custom = await action(posted, calls.length);
          if (custom) return custom;
        }
        const { values, errors } = validateAppearance(posted);
        if (Object.keys(errors).length) return { ok: false, errors };
        savedDocument = toSparse(mergeAppearance(normalizeStored(savedDocument), values));
        return { ok: true, errors: {}, appearance: resolveAppearance(savedDocument) };
      },
    },
    { path: "/elsewhere", Component: () => h("div", { id: "other" }, "Elsewhere") },
  ]);
  return { calls, element: h(Stub, { initialEntries: ["/"] }), saved: () => savedDocument };
}
const posted = (calls, index = 0) => JSON.parse(calls[index]);

// ======================= structure =======================
test("four tabs share one screen; General is first; each tab shows its own controls", async () => {
  const { element } = formApp();
  await mount(element);
  await act(() => sleep(10));
  assert.deepEqual([...container.querySelectorAll('button[role="tab"]')].map((b) => b.textContent), ["General", "Product page", "Collection page", "Wishlist page"]);
  assert.deepEqual(selectedTab(), ["General"]);
  assert.deepEqual([...container.querySelectorAll("s-select, s-color-field, s-number-field, s-switch")].map((e) => e.getAttribute("label")), ["Icon", "Default icon color", "Hover color", "Saved color", "Use my theme’s fonts"]);

  await goTab("Product page");
  assert.deepEqual(selectedTab(), ["Product page"]);
  assert.deepEqual([...container.querySelectorAll("s-select, s-color-field, s-number-field, s-switch")].map((e) => e.getAttribute("label")), ["Show the Wishlist button on product pages", "Button content", "Button style", "Corner radius (px)", "Width", "Alignment in its block"]);

  await goTab("Collection page");
  assert.deepEqual([...container.querySelectorAll("s-select, s-color-field, s-number-field, s-switch")].map((e) => e.getAttribute("label")), ["Show hearts on product cards", "Icon size (px)", "Background opacity (%)", "Position on the product image", "Wishlist count"]);

  await goTab("Wishlist page");
  assert.deepEqual([...container.querySelectorAll("s-select, s-color-field, s-number-field, s-switch, s-text-field")].map((e) => e.getAttribute("label")), ["Layout", "Show the Wishlist icon in the header", "Wishlist page address"]);
  assert.equal(container.querySelector('[role="tabpanel"]'), container.querySelector("#kv-tabpanel"));
  await unmount();
});

test("the options offered are the ones the server accepts", async () => {
  const { element } = formApp();
  await mount(element);
  const offered = async (tabName, label) => (await goTab(tabName), [...select(label).querySelectorAll("s-option")].map((o) => o.getAttribute("value")));
  assert.deepEqual(await offered("General", "Icon"), ["heart", "star", "bookmark"]);
  assert.deepEqual(await offered("Product page", "Button content"), ["icon_text", "icon"]);
  assert.deepEqual(await offered("Product page", "Button style"), ["outline", "filled"]);
  assert.deepEqual(await offered("Product page", "Width"), ["full", "auto", "manual"]);
  assert.deepEqual(await offered("Product page", "Alignment in its block"), ["left", "center", "right"]);
  assert.deepEqual(await offered("Collection page", "Position on the product image"), ["top-right", "top-left", "bottom-left", "bottom-right"]);
  assert.deepEqual(await offered("Collection page", "Wishlist count"), ["header_badge", "none"]);
  assert.deepEqual(await offered("Wishlist page", "Layout"), ["table", "grid"]);
  assert.equal(select("Layout").getAttribute("value"), "table", "defaults are selected");
  await unmount();
});

test("the screen says what only the theme editor can do, with links into it", async () => {
  const { element } = formApp({ apiKey: "abc 123" });
  await mount(element);
  const notice = banners().find((b) => b.heading === "Some things are set in your theme editor");
  assert.ok(notice);
  assert.match(notice.text, /cannot turn on something your theme does not have yet/);
  assert.match(notice.text, /Where\s+you place that block in the theme editor is where the button appears, for example under Add to cart/);
  const links = [...container.querySelectorAll("s-banner s-link")].map((a) => a.getAttribute("href"));
  assert.deepEqual(links, [
    `https://${SHOP}/admin/themes/current/editor?context=apps&activateAppId=abc%20123/wishlist-embed`,
    `https://${SHOP}/admin/themes/current/editor?template=product&addAppBlockId=abc%20123/wishlist-button&target=mainSection`,
  ]);
  assert.ok([...container.querySelectorAll("s-banner s-link")].every((a) => a.getAttribute("target") === "_blank"));
  await goTab("Product page");
  assert.match(toggle("Show the Wishlist button on product pages").getAttribute("details"), /can hide the button but cannot add it/);
  await goTab("Collection page");
  assert.match(toggle("Show hearts on product cards").getAttribute("details"), /can hide them but cannot add them/);
  await unmount();
});

// ======================= one state across tabs =======================
test("edits survive switching tabs, Save sends everything once, and success is shown only after the server confirms", async () => {
  const { element, calls } = formApp({ action: async (text) => { await sleep(60); return null; } });
  await mount(element);
  await act(() => sleep(10));
  assert.equal(saveButton().hasAttribute("disabled"), true, "nothing to save yet");

  await choose("Icon", "star");
  await goTab("Product page");
  await flip(toggle("Show the Wishlist button on product pages"), false);
  await choose("Button style", "filled");
  await goTab("Collection page");
  await type(field("s-number-field", "Icon size (px)"), "30");
  await choose("Position on the product image", "bottom-left");
  await goTab("Wishlist page");
  await choose("Layout", "grid");

  await goTab("General");
  assert.equal(select("Icon").getAttribute("value"), "star", "the General edit is still there");
  await goTab("Product page");
  assert.equal(toggle("Show the Wishlist button on product pages").hasAttribute("checked"), false);
  assert.equal(select("Button style").getAttribute("value"), "filled");
  await goTab("Collection page");
  assert.equal(field("s-number-field", "Icon size (px)").getAttribute("value"), "30");
  await goTab("Wishlist page");
  assert.equal(select("Layout").getAttribute("value"), "grid");
  assert.match(container.textContent, /Unsaved changes/);
  assert.equal(calls.length, 0, "editing and previewing sends nothing");

  await click(saveButton());
  assert.equal(hasBanner("Appearance saved"), false, "not announced before the server confirms");
  assert.equal(saveButton().textContent, "Saving…");
  await click(saveButton()); // a second click while saving
  await act(() => sleep(150));
  assert.equal(calls.length, 1, "no duplicate submission");
  const sent = posted(calls);
  assert.equal(sent.general.iconType, "star");
  assert.equal(sent.productPage.enabled, false);
  assert.equal(sent.productPage.buttonStyle, "filled");
  assert.equal(sent.collectionPage.iconSize, 30);
  assert.equal(sent.collectionPage.position, "bottom-left");
  assert.equal(sent.wishlistPage.layout, "grid");
  assert.deepEqual(Object.keys(sent).sort(), ["collectionPage", "general", "productPage", "wishlistPage"], "all four tabs travel together");
  assert.equal(Object.keys(sent).some((k) => /wishlistEnabled|notifyMeEnabled|shop/i.test(k)), false, "no switch and no shop is ever sent");
  assert.equal(hasBanner("Appearance saved"), true);
  assert.equal(saveButton().hasAttribute("disabled"), true, "saved: nothing left to save");
  assert.equal(container.textContent.includes("Unsaved changes"), false);
  await unmount();
});

test("Discard goes back to the last server-confirmed settings on every tab, and a later Save sends the confirmed state", async () => {
  const start = resolveAppearance({ general: { iconType: "bookmark" }, collectionPage: { iconSize: 26 } });
  const { element, calls } = formApp({ appearance: start });
  await mount(element);
  await act(() => sleep(10));
  assert.equal(discardButton().hasAttribute("disabled"), true, "nothing to discard yet");

  await choose("Icon", "heart");
  await goTab("Collection page");
  await type(field("s-number-field", "Icon size (px)"), "40");
  await goTab("Wishlist page");
  await choose("Layout", "grid");
  assert.equal(discardButton().hasAttribute("disabled"), false);
  await click(discardButton());
  assert.equal(select("Layout").getAttribute("value"), "table");
  await goTab("Collection page");
  assert.equal(field("s-number-field", "Icon size (px)").getAttribute("value"), "26");
  await goTab("General");
  assert.equal(select("Icon").getAttribute("value"), "bookmark");
  assert.equal(saveButton().hasAttribute("disabled"), true);
  assert.equal(container.textContent.includes("Unsaved changes"), false);

  // after a save, Discard returns to THAT save, not to the page as first loaded
  await choose("Icon", "star");
  await click(saveButton());
  await act(() => sleep(40));
  await choose("Icon", "heart");
  await click(discardButton());
  assert.equal(select("Icon").getAttribute("value"), "star");
  assert.equal(calls.length, 1);
  await unmount();
});

test("a failed save keeps every edit, says so, can be retried, and Discard clears the stale message", async () => {
  const { element, calls } = formApp({ action: (text, n) => (n === 1 ? { ok: false, errors: {}, failed: true } : null) });
  await mount(element);
  await act(() => sleep(10));
  await choose("Icon", "star");
  await goTab("Wishlist page");
  await choose("Layout", "grid");
  await click(saveButton());
  await act(() => sleep(40));
  const failure = banners().find((b) => b.heading === "Appearance was not saved");
  assert.ok(failure);
  assert.equal(failure.tone, "critical");
  assert.match(failure.text, /try Save again/);
  assert.equal(hasBanner("Appearance saved"), false);
  assert.equal(select("Layout").getAttribute("value"), "grid", "the edit is still there");
  assert.equal(saveButton().hasAttribute("disabled"), false);

  await click(saveButton());
  await act(() => sleep(40));
  assert.equal(calls.length, 2);
  assert.equal(hasBanner("Appearance saved"), true);
  assert.equal(hasBanner("Appearance was not saved"), false, "the old failure is gone");

  // a failure message does not outlive a Discard
  const second = formApp({ action: () => ({ ok: false, errors: {}, failed: true }) });
  await mount(second.element);
  await act(() => sleep(10));
  await choose("Icon", "star");
  await click(saveButton());
  await act(() => sleep(40));
  assert.equal(hasBanner("Appearance was not saved"), true);
  await click(discardButton());
  assert.equal(hasBanner("Appearance was not saved"), false);
  await unmount();
});

test("values the server refuses are reported without losing the edits", async () => {
  const { element } = formApp({ action: () => ({ ok: false, errors: { "general.iconType": "Choose one of the listed options." } }) });
  await mount(element);
  await act(() => sleep(10));
  await choose("Icon", "star");
  await click(saveButton());
  await act(() => sleep(40));
  const banner = banners().find((b) => b.heading === "Appearance was not saved");
  assert.match(banner.text, /Some values were not valid/);
  assert.equal(select("Icon").getAttribute("value"), "star");
  await unmount();
});

// ======================= validation on the screen =======================
test("a value the server would refuse is flagged on the field and cannot be saved", async () => {
  const { element, calls } = formApp();
  await mount(element);
  await act(() => sleep(10));
  await goTab("Collection page");
  const size = () => field("s-number-field", "Icon size (px)");
  await type(size(), "5");
  assert.match(size().getAttribute("error"), /whole number from 14 to 40/);
  assert.equal(saveButton().hasAttribute("disabled"), true, "Save is off while a field is invalid");
  await click(saveButton());
  assert.equal(calls.length, 0, "nothing is sent");
  assert.match(container.textContent, /Unsaved changes/, "and leaving would still warn");
  await type(size(), "abc");
  assert.ok(size().getAttribute("error"));
  await type(size(), "");
  assert.ok(size().getAttribute("error"), "icon size cannot be empty");
  await type(size(), "40");
  assert.equal(size().getAttribute("error"), null);
  assert.equal(saveButton().hasAttribute("disabled"), false);

  await type(field("s-number-field", "Background opacity (%)"), "101");
  assert.ok(field("s-number-field", "Background opacity (%)").getAttribute("error"));
  await goTab("General");
  await type(field("s-color-field", "Default icon color"), "red");
  assert.match(field("s-color-field", "Default icon color").getAttribute("error"), /hex color/);
  assert.equal(saveButton().hasAttribute("disabled"), true, "an error on another tab still blocks Save");
  await unmount();
});

test("colours: unset means 'use the theme editor colour'; choosing one sends it; Use default clears it", async () => {
  const { element, calls } = formApp();
  await mount(element);
  await act(() => sleep(10));
  const colorField = () => field("s-color-field", "Default icon color");
  assert.match(colorField().getAttribute("details"), /Not set: your theme editor’s “Heart color” is used/);
  assert.equal(byText("s-button", "Use default"), undefined, "nothing to clear yet");
  await type(colorField(), "#AA00FF");
  assert.ok(byText("s-button", "Use default"));
  assert.equal(colorField().getAttribute("details"), null, "the 'not set' note goes once a colour is chosen");
  await click(saveButton());
  await act(() => sleep(40));
  assert.equal(posted(calls).general.defaultColor, "#AA00FF", "the server normalizes it; the screen sends what was typed");
  await click(byText("s-button", "Use default"));
  assert.equal(saveButton().hasAttribute("disabled"), false, "clearing the colour is a change");
  await click(saveButton());
  await act(() => sleep(40));
  assert.equal(posted(calls, 1).general.defaultColor, null);

  // an app colour left untouched is never sent as a value
  const fresh = formApp();
  await mount(fresh.element);
  await act(() => sleep(10));
  await choose("Icon", "star");
  await click(saveButton());
  await act(() => sleep(40));
  assert.equal(posted(fresh.calls).general.defaultColor, null);
  await unmount();
});

test("fields appear only when they apply: fixed width only for the fixed-width mode", async () => {
  const { element } = formApp();
  await mount(element);
  await goTab("Product page");
  assert.equal(field("s-number-field", "Fixed width (px)"), null);
  await choose("Width", "manual");
  assert.equal(field("s-number-field", "Fixed width (px)").getAttribute("value"), "240");
  await type(field("s-number-field", "Fixed width (px)"), "50");
  assert.match(field("s-number-field", "Fixed width (px)").getAttribute("error"), /100 to 800/);
  await type(field("s-number-field", "Corner radius (px)"), "60");
  assert.match(field("s-number-field", "Corner radius (px)").getAttribute("error"), /0 to 50/);
  await type(field("s-number-field", "Corner radius (px)"), "");
  assert.equal(field("s-number-field", "Corner radius (px)").getAttribute("error"), null, "empty radius = follow the theme");
  await unmount();
});

// ======================= reset =======================
test("Reset to defaults resets only the tab you are on, and still needs Save", async () => {
  const start = resolveAppearance({ general: { iconType: "star", defaultColor: "#112233" }, collectionPage: { iconSize: 30, position: "bottom-left" }, wishlistPage: { layout: "grid" } });
  const { element, calls } = formApp({ appearance: start });
  await mount(element);
  await act(() => sleep(10));
  await goTab("Collection page");
  await click(byText("s-button", "Reset to defaults"));
  assert.equal(field("s-number-field", "Icon size (px)").getAttribute("value"), "22");
  assert.equal(select("Position on the product image").getAttribute("value"), "top-right");
  assert.equal(saveButton().hasAttribute("disabled"), false);
  await goTab("General");
  assert.equal(select("Icon").getAttribute("value"), "star", "other tabs keep their settings");
  assert.equal(field("s-color-field", "Default icon color").getAttribute("value"), "#112233");
  await goTab("Wishlist page");
  assert.equal(select("Layout").getAttribute("value"), "grid");
  assert.equal(calls.length, 0, "a reset sends nothing until Save");
  await click(discardButton());
  await goTab("Collection page");
  assert.equal(field("s-number-field", "Icon size (px)").getAttribute("value"), "30", "Discard undoes a reset");
  await unmount();
});

// ======================= leaving =======================
test("leaving with unsaved changes asks first; clean forms leave freely; staying keeps the edits", async () => {
  const clean = formApp();
  await mount(clean.element);
  await act(() => sleep(10));
  await click(document.getElementById("go"));
  await act(() => sleep(20));
  assert.ok(document.getElementById("other"), "no prompt when nothing is unsaved");
  await unmount();

  const { element } = formApp();
  await mount(element);
  await act(() => sleep(10));
  await choose("Icon", "star");
  await click(document.getElementById("go"));
  await act(() => sleep(20));
  assert.equal(document.getElementById("other"), null, "blocked");
  assert.equal(hasBanner("You have unsaved changes"), true);
  await click(byText("s-button", "Stay on this page"));
  assert.equal(select("Icon").getAttribute("value"), "star", "the edit is kept");
  await click(document.getElementById("go"));
  await act(() => sleep(20));
  await click(byText("s-button", "Leave without saving"));
  await act(() => sleep(20));
  assert.ok(document.getElementById("other"), "leaving goes on when the merchant chooses to");
  await unmount();
});

// ======================= preview =======================
// The preview is an <iframe> whose document is written by the component; jsdom keeps that document (it does not lay it out).
const frameEl = () => container.querySelector("iframe.kv-pv-frame");
const pdoc = () => frameEl().contentDocument;
const proot = () => pdoc().documentElement;
const pq = (selector) => pdoc().querySelector(selector);
const pqa = (selector) => [...pdoc().querySelectorAll(selector)];
const pattr = (name) => proot().getAttribute(name);
const pvar = (name) => proot().style.getPropertyValue(name);
const pattrs = () => Object.fromEntries([...proot().attributes].filter((a) => a.name.startsWith("data-kw-")).map((a) => [a.name, a.value]));
const viewportButton = (label) => byText(".kv-seg-btn", label);

test("each tab shows its own sample storefront page, built from the storefront's real markup", async () => {
  const { element } = formApp();
  await mount(element);
  await act(() => sleep(10));
  const expectPage = (name, selectors) => {
    assert.equal(pq(".pv-page").getAttribute("data-preview"), name);
    for (const selector of selectors) assert.ok(pq(selector), `${name}: ${selector}`);
  };

  expectPage("general", [".pv-header", ".kw-header-icon .kw-heart svg", ".pv-grid"]);
  assert.equal(pqa(".pv-grid .kw-btn--card").length, 8, "several product cards, each with a heart over its image");
  assert.equal(pqa(".pv-grid .pv-media .kw-btn--card").length, 8, "the heart sits inside the product image");
  assert.deepEqual(pqa(".pv-grid .pv-title").slice(0, 2).map((e) => e.textContent), ["Classic cotton tee", "Canvas market tote"]);
  assert.match(pq(".pv-price").textContent, /^\$\d+\.\d\d$/, "titles and prices");
  assert.deepEqual(pqa(".pv-tag").map((e) => e.textContent), ["Default", "Hover", "Saved"], "three clearly different states");
  assert.equal(pqa(".kw-btn--card.kw-force-hover").length, 1);
  assert.equal(pqa('.kw-btn--card[aria-pressed="true"]').length, 1);
  assert.ok(frameEl().getAttribute("title").includes("Collection grid"));

  await goTab("Product page");
  expectPage("productPage", [".pv-product .pv-gallery", ".pv-ptitle", ".pv-pprice", ".pv-desc", ".pv-add", ".kw-block .kw-btn--product .kw-heart svg", ".kw-btn__label"]);
  assert.equal(pq(".pv-add").textContent, "Add to cart");
  assert.equal(pq(".kw-btn__label").textContent, "Add to wishlist");
  const order = [...pq(".pv-details").children].map((e) => e.className.split(" ")[0]);
  assert.ok(order.indexOf("kw-block") > order.indexOf("pv-add"), "the sample puts the button after Add to cart (the real position is the theme editor's)");
  assert.equal(pqa(".kw-btn--card").length, 0);

  await goTab("Collection page");
  expectPage("collectionPage", [".pv-toolbar", ".pv-grid", ".kw-header-icon__count"]);
  assert.equal(pqa(".pv-grid .kw-btn--card").length, 6);
  assert.equal(pqa(".kw-btn--card").length, 6);
  assert.equal(pq(".kw-header-icon__count").textContent, "3", "the header count is a single badge; there is no per-product count");
  assert.equal(pqa(".pv-card [class*=count]").length, 0, "no count on the cards");

  await goTab("Wishlist page");
  expectPage("wishlistPage", [".kw-page .kw-page__title", ".kw-table-wrap .kw-table thead", ".kw-table tbody"]);
  assert.match(pq(".kw-page__title").textContent, /Wishlisted products/);
  assert.equal(pqa(".kw-row").length, 4);
  const first = pq(".kw-row");
  for (const part of [".kw-td--remove .kw-row__remove", ".kw-td--image .kw-thumb", ".kw-td--name .kw-row__title", ".kw-td--price .kw-price", ".kw-td--stock .kw-stock", ".kw-td--qty .kw-qty", ".kw-td--action .kw-btn-cart"]) assert.ok(first.querySelector(part), `a saved-product row has ${part}`);
  assert.deepEqual(pqa(".kw-stock").map((e) => e.textContent), ["In stock", "Out of stock", "In stock", "In stock"]);
  assert.equal(pqa(".kw-btn-cart--notify").length, 1, "the sold-out row offers Notify Me instead of Add to cart");
  assert.equal(pqa(".kw-btn-cart:not(.kw-btn-cart--notify)").length, 3);
  await unmount();
});

test("every control updates the preview at once, without saving", async () => {
  const { element, calls } = formApp();
  await mount(element);
  await act(() => sleep(10));
  assert.deepEqual(pattrs(), {}, "defaults: no setting is applied, so the storefront stylesheet's own look shows");
  assert.equal(pq("html") === proot() && proot().getAttribute("style"), null);

  // ---- General
  await choose("Icon", "star");
  assert.equal(pattr("data-kw-general-icon-type"), "star");
  await choose("Icon", "bookmark");
  assert.equal(pattr("data-kw-general-icon-type"), "bookmark");
  await type(field("s-color-field", "Default icon color"), "#112233");
  await type(field("s-color-field", "Hover color"), "#445566");
  await type(field("s-color-field", "Saved color"), "#778899");
  assert.deepEqual([pvar("--kw-general-default-color"), pvar("--kw-general-hover-color"), pvar("--kw-general-active-color")], ["#112233", "#445566", "#778899"]);
  await click(byText("s-button", "Use default"));
  assert.equal(pvar("--kw-general-default-color"), "", "back to 'not set': the theme editor colour applies again");
  await flip(toggle("Use my theme’s fonts"), false);
  assert.equal(pattr("data-kw-general-use-theme-fonts"), "false");
  await flip(toggle("Use my theme’s fonts"), true);
  assert.equal(pattr("data-kw-general-use-theme-fonts"), null);

  // ---- Product page
  await goTab("Product page");
  await choose("Button content", "icon");
  await choose("Button style", "filled");
  await choose("Width", "manual");
  await type(field("s-number-field", "Fixed width (px)"), "300");
  await type(field("s-number-field", "Corner radius (px)"), "20");
  await choose("Alignment in its block", "center");
  assert.equal(pattr("data-kw-product-page-button-type"), "icon");
  assert.equal(pattr("data-kw-product-page-button-style"), "filled");
  assert.equal(pattr("data-kw-product-page-width-mode"), "manual");
  assert.equal(pvar("--kw-product-page-manual-width"), "300");
  assert.equal(pvar("--kw-product-page-button-radius"), "20");
  assert.equal(pattr("data-kw-product-page-button-radius"), "20");
  assert.equal(pattr("data-kw-product-page-position"), "center");
  await flip(toggle("Show the Wishlist button on product pages"), false);
  assert.equal(pattr("data-kw-product-page-enabled"), "false");
  assert.match(container.textContent, /The Wishlist button is hidden on product pages/);
  await flip(toggle("Show the Wishlist button on product pages"), true);
  assert.equal(pattr("data-kw-product-page-enabled"), null);
  assert.doesNotMatch(container.textContent, /hidden on product pages/);

  // ---- Collection page: every corner, size, opacity, count, on/off
  await goTab("Collection page");
  for (const corner of ["top-left", "bottom-left", "bottom-right", "top-right"]) {
    await choose("Position on the product image", corner);
    assert.equal(pattr("data-kw-collection-page-position"), corner === "top-right" ? null : corner, corner);
  }
  await type(field("s-number-field", "Icon size (px)"), "36");
  await type(field("s-number-field", "Background opacity (%)"), "40");
  assert.equal(pvar("--kw-collection-page-icon-size"), "36");
  assert.equal(pvar("--kw-collection-page-background-opacity"), "40");
  await choose("Wishlist count", "none");
  assert.equal(pattr("data-kw-collection-page-count-display"), "none");
  await flip(toggle("Show hearts on product cards"), false);
  assert.equal(pattr("data-kw-collection-page-enabled"), "false");
  assert.match(container.textContent, /Hearts are hidden on product cards/);

  // ---- Wishlist page
  await goTab("Wishlist page");
  await choose("Layout", "grid");
  assert.equal(pattr("data-kw-wishlist-page-layout"), "grid");
  await flip(toggle("Show the Wishlist icon in the header"), false);
  assert.equal(pattr("data-kw-wishlist-page-header-icon"), "false");
  assert.match(container.textContent, /header Wishlist icon is hidden/);

  assert.equal(calls.length, 0, "nothing was saved by previewing");
  await unmount();
});

test("the preview and the storefront stylesheet really connect: hidden things are hidden in the frame", async () => {
  const { element } = formApp();
  await mount(element);
  await act(() => sleep(10));
  await goTab("Product page");
  const display = (selector) => pdoc().defaultView.getComputedStyle(pq(selector)).display;
  assert.notEqual(display(".kw-block"), "none");
  await flip(toggle("Show the Wishlist button on product pages"), false);
  assert.equal(display(".kw-block"), "none", "the real rule html[data-kw-product-page-enabled='false'] .kw-block applies in the frame");
  await goTab("Collection page");
  assert.notEqual(display(".pv-grid .kw-btn--card"), "none");
  await flip(toggle("Show hearts on product cards"), false);
  assert.equal(display(".pv-grid .kw-btn--card"), "none");
  await unmount();
});

test("Desktop and Mobile switch the frame width without touching the page around it or the settings", async () => {
  const { element, calls } = formApp();
  await mount(element);
  await act(() => sleep(10));
  const buttons = () => [...container.querySelectorAll(".kv-seg-btn")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
  assert.deepEqual(buttons(), [["Desktop", "true"], ["Mobile", "false"]], "Desktop first on the General tab");
  assert.equal(frameEl().style.width, "960px");
  assert.ok(container.querySelector(".kv-pv-device--desktop"));
  const controlsCard = container.querySelector('[role="tabpanel"]');
  const stageBefore = container.querySelector(".kv-pv-stage").getAttribute("style");

  await click(viewportButton("Mobile"));
  assert.deepEqual(buttons(), [["Desktop", "false"], ["Mobile", "true"]]);
  assert.equal(frameEl().style.width, "390px");
  assert.ok(container.querySelector(".kv-pv-device--mobile"));
  assert.equal(container.querySelector(".kv-pv-stage").getAttribute("style"), stageBefore, "the stage (and so the page layout) keeps its size");
  assert.equal(controlsCard.getAttribute("style"), null, "the controls are not resized");
  assert.equal(saveButton().hasAttribute("disabled"), true, "a view choice is not a change to save");
  assert.equal(container.textContent.includes("Unsaved changes"), false);
  assert.equal(pq(".pv-page").getAttribute("data-preview"), "general", "same page, new width");

  await goTab("Collection page");
  assert.deepEqual(buttons(), [["Desktop", "false"], ["Mobile", "true"]], "the Collection page starts as the mobile grid");
  assert.equal(frameEl().style.width, "390px");
  await click(viewportButton("Desktop"));
  assert.equal(frameEl().style.width, "960px");
  await goTab("General");
  assert.deepEqual(buttons(), [["Desktop", "false"], ["Mobile", "true"]], "each tab remembers its own choice");
  assert.equal(calls.length, 0);
  await unmount();
});

test("the frame is laid out at a real storefront width and scaled down to fit the stage", async () => {
  const original = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientWidth");
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList?.contains("kv-pv-stage") ? 480 : 0; } });
  try {
    const { element } = formApp();
    await mount(element);
    await act(() => sleep(10));
    assert.equal(frameEl().style.transform, "scale(0.5)", "960px storefront in a 480px stage");
    assert.equal(frameEl().style.width, "960px", "laid out at the real width, so desktop breakpoints are the real ones");
    assert.equal(frameEl().style.height, "1200px", "tall enough that the scaled frame fills the 600px stage");
    assert.equal(container.querySelector(".kv-pv-device").style.width, "480px");
    await click(viewportButton("Mobile"));
    assert.equal(frameEl().style.transform, "scale(1)", "a 390px phone fits a 480px stage unscaled");
    assert.equal(container.querySelector(".kv-pv-device").style.width, "390px");
    await unmount();
  } finally {
    if (original) Object.defineProperty(window.HTMLElement.prototype, "clientWidth", original);
    else delete window.HTMLElement.prototype.clientWidth;
  }
});

test("unsaved edits survive tab switches, and the preview of every tab shows them", async () => {
  const { element, calls } = formApp();
  await mount(element);
  await act(() => sleep(10));
  await choose("Icon", "star");
  await type(field("s-color-field", "Default icon color"), "#aa0000");
  await goTab("Product page");
  assert.equal(pq(".pv-page").getAttribute("data-preview"), "productPage");
  assert.equal(pattr("data-kw-general-icon-type"), "star", "the General edit shows on the product page sample");
  assert.equal(pvar("--kw-general-default-color"), "#aa0000");
  await choose("Button style", "filled");
  await goTab("Wishlist page");
  await choose("Layout", "grid");
  await goTab("Collection page");
  assert.deepEqual(pattrs(), { "data-kw-general-icon-type": "star", "data-kw-product-page-button-style": "filled", "data-kw-wishlist-page-layout": "grid" }, "all edits travel with every tab");
  await goTab("General");
  assert.equal(select("Icon").getAttribute("value"), "star");
  assert.equal(pattrs()["data-kw-product-page-button-style"], "filled");
  assert.equal(calls.length, 0);
  await unmount();
});

test("Reset to defaults and Discard update the preview immediately; Save keeps working and matches the preview", async () => {
  const start = resolveAppearance({ general: { iconType: "bookmark", defaultColor: "#112233" }, wishlistPage: { layout: "grid" } });
  const { element, calls } = formApp({ appearance: start });
  await mount(element);
  await act(() => sleep(10));
  assert.equal(pattr("data-kw-general-icon-type"), "bookmark", "the saved settings are what the preview starts from");
  assert.equal(pvar("--kw-general-default-color"), "#112233");
  assert.equal(pattr("data-kw-wishlist-page-layout"), "grid");

  await click(byText("s-button", "Reset to defaults")); // General tab
  assert.equal(pattr("data-kw-general-icon-type"), null);
  assert.equal(pvar("--kw-general-default-color"), "");
  assert.equal(pattr("data-kw-wishlist-page-layout"), "grid", "other tabs' settings stay");
  assert.equal(calls.length, 0, "a reset saves nothing");

  await click(discardButton());
  assert.equal(pattr("data-kw-general-icon-type"), "bookmark");
  assert.equal(pvar("--kw-general-default-color"), "#112233");

  await choose("Icon", "star");
  await click(saveButton());
  await act(() => sleep(40));
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0]).general.iconType, "star", "Save sends what the preview shows");
  assert.equal(pattr("data-kw-general-icon-type"), "star");
  await choose("Icon", "heart");
  await click(discardButton());
  assert.equal(pattr("data-kw-general-icon-type"), "star", "Discard returns to the last SAVED state");
  await unmount();
});

test("Wishlist page: table is the default; grid is the same rows laid out as cards", async () => {
  const { element } = formApp();
  await mount(element);
  await goTab("Wishlist page");
  assert.equal(pattr("data-kw-wishlist-page-layout"), null);
  assert.equal(pqa(".kw-table > thead th").length, 8, "table with its column headings");
  const rowsBefore = pq(".kw-table tbody").innerHTML;
  await choose("Layout", "grid");
  assert.equal(pattr("data-kw-wishlist-page-layout"), "grid");
  assert.equal(pq(".kw-table tbody").innerHTML, rowsBefore, "the same markup: the grid is the storefront's CSS, not a second renderer");
  assert.equal(pqa(".kw-row").length, 4);
  await click(viewportButton("Mobile"));
  assert.equal(frameEl().style.width, "390px", "and the phone view of either layout is the storefront's own narrow-screen CSS");
  await choose("Layout", "table");
  assert.equal(pattr("data-kw-wishlist-page-layout"), null);
  await unmount();
});

test("default colours keep the theme editor colour: the app only adds a colour once the merchant chooses one", async () => {
  const { element } = formApp();
  await mount(element);
  await act(() => sleep(10));
  assert.equal(pvar("--kw-general-default-color"), "");
  const shellStyles = pqa("style").map((s) => s.textContent).join("\n");
  assert.match(shellStyles, /:root \{ --kw-accent: #d6336c;/, "the sample theme provides the theme editor's Heart color");
  assert.ok(shellStyles.includes("color: var(--kw-general-default-color, var(--kw-accent, #d6336c));"), "the storefront rule: app colour, else the theme editor's, else #d6336c");
  await choose("Icon", "star");
  assert.equal(pvar("--kw-general-default-color"), "", "changing something else never sets a colour");
  await type(field("s-color-field", "Default icon color"), "#00AA55");
  assert.equal(pvar("--kw-general-default-color"), "#00aa55", "an explicit colour is applied (normalized)");
  await unmount();
});

test("the preview is sealed: no script, no request, no link out, nothing saved", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { requests.push(args); return Promise.reject(new Error("the preview must not fetch")); };
  try {
    const { element, calls } = formApp();
    await mount(element);
    await act(() => sleep(10));
    assert.equal(frameEl().getAttribute("sandbox"), "allow-same-origin", "no scripts may run in the frame");
    for (const name of ["General", "Product page", "Collection page", "Wishlist page"]) {
      await goTab(name);
      assert.equal(pqa("script, form, iframe, link, object, embed").length, 0, `${name}: nothing executable or loadable`);
      assert.equal(pqa("[src], [srcset]").length, 0, `${name}: no external resource`);
      assert.equal(pqa("a[href]").filter((a) => a.getAttribute("href") !== "#").length, 0, `${name}: no link goes anywhere`);
      assert.equal(pqa("button").filter((b) => b.getAttribute("type") !== "button").length, 0, `${name}: no button can submit`);
      assert.equal(pqa("[onclick], [onload], [onerror]").length, 0);
    }
    assert.doesNotMatch(pdoc().head.innerHTML, /@import|url\(\s*["']?https?:/i, "the stylesheet loads nothing");
    await click(pq("button"));
    assert.deepEqual([requests.length, calls.length], [0, 0], "no request and no save from rendering, switching tabs or clicking the preview");
    assert.equal(hasBanner("Appearance saved"), false);
    await unmount();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ======================= a failing preview must not take the form down =======================
// Reproduced in a real browser: an exception thrown by the preview's frame code (inside an effect) replaced the WHOLE
// Wishlist Settings screen with "This page could not be loaded". The preview is now isolated.
test("when drawing the preview fails the form stays fully usable, the failure is logged, and the next change recovers", async () => {
  const proto = window.HTMLIFrameElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "contentDocument");
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let broken = true;
  Object.defineProperty(proto, "contentDocument", { configurable: true, get() { if (broken) throw new Error("injected frame failure"); return original.get.call(this); } });
  try {
    const { element, calls } = formApp();
    await mount(element);
    await act(() => sleep(20));
    assert.equal(container.querySelectorAll('button[role="tab"]').length, 4, "all four tabs are still there");
    assert.ok(select("Icon"), "and the controls");
    const alert = container.querySelector('p.kv-pv-notes[role="alert"]');
    assert.ok(alert, "the preview says it could not be drawn");
    assert.match(alert.textContent, /preview could not be drawn.*controls are not affected/);
    assert.equal(banners().includes("Wishlist Settings could not be loaded"), false);
    assert.equal(container.querySelector("s-banner[heading='This page could not be loaded']"), null, "the screen was not replaced by the error page");
    assert.ok(logged.some((line) => /\[wishlist-settings\] the preview could not be drawn/.test(line) && /injected frame failure/.test(line)), "logged with its cause");

    // the merchant can still edit, switch tabs and save
    await choose("Icon", "star");
    await goTab("Wishlist page");
    assert.ok(select("Layout"));
    await goTab("General");
    await click(saveButton());
    await act(() => sleep(40));
    assert.equal(calls.length, 1, "Save works while the preview is broken");
    assert.equal(hasBanner("Appearance saved"), true);
    assert.equal(JSON.parse(calls[0]).general.iconType, "star");

    // once the frame works again, the next change draws it and the message goes
    broken = false;
    await goTab("Wishlist page");
    await choose("Layout", "grid");
    assert.equal(container.querySelector('p.kv-pv-notes[role="alert"]'), null, "recovered");
    assert.equal(pattr("data-kw-wishlist-page-layout"), "grid");
    assert.equal(pattr("data-kw-general-icon-type"), "star");
    await unmount();
  } finally {
    broken = false;
    Object.defineProperty(proto, "contentDocument", original);
    console.error = originalError;
  }
});

test("an error thrown while RENDERING the preview is contained too: the rest of the page stays, and it can be retried", async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let explode = true;
  const Thrower = () => {
    if (explode) throw new Error("injected render failure");
    return h("p", { id: "preview-ok" }, "preview fine");
  };
  try {
    await mount(h("div", null, h("button", { id: "form-control", type: "button" }, "form"), h(Preview.PreviewBoundary, null, h(Thrower))));
    assert.ok(document.getElementById("form-control"), "the form beside the preview is still rendered");
    assert.match(container.querySelector('[role="alert"]').textContent, /preview could not be drawn/);
    assert.ok(logged.some((line) => /\[wishlist-settings\] the preview failed to render/.test(line) && /injected render failure/.test(line)));
    explode = false;
    await click(byText("s-button", "Try again"));
    assert.ok(document.getElementById("preview-ok"), "Try again renders it again");
    assert.equal(container.querySelector('[role="alert"]'), null);
    await unmount();
  } finally {
    console.error = originalError;
  }
});

// ======================= Wishlist page address =======================
test("the Wishlist page address is shown read-only with a Copy button", async () => {
  clipboard.length = 0;
  const { element } = formApp();
  await mount(element);
  await goTab("Wishlist page");
  const address = field("s-text-field", "Wishlist page address");
  assert.equal(address.getAttribute("value"), `https://${SHOP}/apps/konvert-notify/my-wishlist`, "the existing route is shown, not a new one");
  assert.ok(address.hasAttribute("readonly") || address.hasAttribute("readOnly"));
  await click(byText("s-button", "Copy"));
  await act(() => sleep(10));
  assert.deepEqual(clipboard, [`https://${SHOP}/apps/konvert-notify/my-wishlist`]);
  assert.ok(byText("s-button", "Copied"));
  await unmount();
});

// ======================= the Settings screen =======================
test("Settings links to Wishlist Settings; the two switches still work exactly as before", async () => {
  const calls = [];
  const Stub = ReactRouter.createRoutesStub([
    {
      path: "/",
      Component: () => h(Settings.SettingsForm, { settings: { wishlistEnabled: true, notifyMeEnabled: true } }),
      action: async ({ request }) => {
        calls.push(Object.fromEntries(await request.formData()));
        return { ok: true, errors: {}, values: { wishlistEnabled: true, notifyMeEnabled: false } };
      },
    },
    { path: "/app/wishlist-settings", Component: () => h("div", { id: "ws" }, "Wishlist Settings screen") },
  ]);
  await mount(h(Stub, { initialEntries: ["/"] }));
  await act(() => sleep(10));
  assert.equal(container.querySelectorAll("s-switch").length, 2, "still exactly the two master switches");
  assert.equal(byText("s-button", "Wishlist Settings") !== undefined, true);
  assert.equal(container.querySelectorAll("s-button").length >= 2, true);
  // Layout regression: the description must not use the negative-margin "help" style, which pulled it over the button.
  const link = byText("s-button", "Wishlist Settings").parentElement;
  assert.equal(link.className, "kv-form-link");
  assert.deepEqual([...link.children].map((c) => c.tagName.toLowerCase()), ["s-button", "p"], "button first, description after it");
  assert.equal(link.querySelector("p").className, "", "not p.help");
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  const rule = (selector) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  assert.match(rule(".kv-form-link"), /display: flex;[^]*flex-wrap: wrap;[^]*gap: 8px 16px;/, "a row that wraps, with spacing on both axes");
  assert.match(rule(".kv-form-link p"), /flex: 1 1 240px;[^]*margin: 0;/, "the text wraps under the button when the row is narrow");
  assert.equal(/margin:\s*-/.test(rule(".kv-form-link p")), false, "no negative margin");
  const wishlistCard = byText("s-button", "Wishlist Settings").closest("section");
  assert.equal(wishlistCard.querySelector("s-switch").getAttribute("label"), "Enable Wishlist");
  assert.equal(container.querySelectorAll("section")[1].querySelector("s-button"), null, "Notify Me has no such link");

  const notify = container.querySelectorAll("s-switch")[1];
  await act(() => { notify.checked = false; fire(notify, "change"); });
  await click(byText("s-button", "Save"));
  await act(() => sleep(30));
  assert.deepEqual(calls, [{ wishlistEnabled: "true", notifyMeEnabled: "false" }], "a switch save still posts only the two switches");

  await click(byText("s-button", "Wishlist Settings"));
  await act(() => sleep(20));
  assert.ok(document.getElementById("ws"), "the button opens the Wishlist Settings route");
  await unmount();
});

// Regression (blank content after clicking "Wishlist Settings" in Shopify Admin): in Admin the click must be handled by App
// Bridge, which moves the app with the same mechanism as the app menu links. That needs a real href on the s-button; the
// page's own navigate() call is only the fallback when App Bridge is not running. App Bridge listens for clicks in the
// capture phase and stops them, so the fallback must not run when it handled the click.
test("Wishlist Settings and Back to Settings carry an href that App Bridge handles; the click is not also navigated by the page", async () => {
  const handledByAppBridge = [];
  const appBridge = (event) => {
    const el = event.target.closest?.("s-button[href]");
    if (!el) return;
    handledByAppBridge.push(el.getAttribute("href"));
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const Stub = ReactRouter.createRoutesStub([
    { path: "/", Component: () => h(Settings.SettingsForm, { settings: { wishlistEnabled: true, notifyMeEnabled: true } }) },
    { path: "/app/wishlist-settings", Component: () => h("div", { id: "ws" }, "Wishlist Settings screen") },
  ]);
  await mount(h(Stub, { initialEntries: ["/"] }));
  await act(() => sleep(10));
  assert.equal(byText("s-button", "Wishlist Settings").getAttribute("href"), "/app/wishlist-settings");
  window.addEventListener("click", appBridge, true);
  try {
    await click(byText("s-button", "Wishlist Settings"));
    await act(() => sleep(20));
  } finally {
    window.removeEventListener("click", appBridge, true);
  }
  assert.deepEqual(handledByAppBridge, ["/app/wishlist-settings"]);
  assert.equal(document.getElementById("ws"), null, "with App Bridge handling the click, the page does not navigate on its own");
  await unmount();

  const Back = ReactRouter.createRoutesStub([
    { path: "/", Component: () => h(Form.WishlistSettingsForm, { appearance: DEFAULT_APPEARANCE, shop: SHOP, apiKey: "key" }) },
  ]);
  await mount(h(Back, { initialEntries: ["/"] }));
  await act(() => sleep(10));
  assert.equal(byText("s-button", "Back to Settings").getAttribute("href"), "/app/settings");
  await unmount();
});

// ======================= server wiring =======================
test("the route takes the shop only from the authenticated session and writes only the appearance", () => {
  const route = fs.readFileSync("app/routes/app.wishlist-settings.jsx", "utf8");
  assert.match(route, /authenticate\.admin\(request\)/g);
  assert.equal((route.match(/authenticate\.admin\(request\)/g) || []).length, 2, "both the loader and the action authenticate");
  assert.match(route, /getAppearance\(session\.shop\)/);
  assert.match(route, /saveAppearance\(session\.shop, raw\)/);
  assert.equal(/formData\(\)\)?\.get\("(?:shop|shopId|domain)"/.test(route), false, "no shop or id is read from the form");
  assert.equal(/saveSettings|validateSettings|wishlistEnabled|notifyMeEnabled/.test(route), false, "the master switches are not part of this route");

  const settingsRoute = fs.readFileSync("app/routes/app.settings.jsx", "utf8");
  assert.equal(/Appearance|appearance/.test(settingsRoute), false, "the switch route knows nothing of appearance");
  const routes = fs.readFileSync("app/routes.js", "utf8");
  assert.match(routes, /flatRoutes\(\)/, "flat file routes: app.wishlist-settings.jsx is /app/wishlist-settings, a sibling (not a child) of /app/settings");
  assert.equal(fs.existsSync("app/routes/app.settings.wishlist.jsx"), false, "no nested route under a layout that has no Outlet");
});

test("the Wishlist Settings preview component exports its note", () => {
  assert.equal(Preview.PREVIEW_NOTE, "Approximate preview — your Shopify theme may differ");
});

// Regression (Wishlist Settings reloaded the Settings page in Shopify Admin): Shopify CLI's dev proxy, and so the tunnel,
// answers every /extensions/* URL itself ("Extension with id ... not found", 404). The preview used to import the storefront
// stylesheet by its path under extensions/, so Vite served it at /extensions/...; the 404 made the whole route module fail
// to load, and React Router reloaded the page. No module of this route may be requested under that prefix.
test("no module of the Wishlist Settings route is imported from a path under /extensions/ (the Shopify CLI proxy reserves it)", () => {
  for (const file of ["app/routes/app.wishlist-settings.jsx", "app/components/wishlist-settings-form.jsx", "app/components/wishlist-appearance-preview.jsx", "app/utils/wishlist-preview-document.js", "app/utils/wishlist-appearance-shared.js"]) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.equal(/(^|\/)extensions\//.test(match[1]), false, `${file} imports ${match[1]}`);
    }
  }
  assert.match(fs.readFileSync("app/components/wishlist-appearance-preview.jsx", "utf8"), /from "virtual:konvert-storefront-css"/);
  const config = fs.readFileSync("vite.config.js", "utf8");
  assert.match(config, /konvert-wishlist\.css/);
  assert.match(config, /plugins: \[storefrontCss\(\)/);
});
