// Behaviour tests for the shared merchant UI (app/components/merchant-ui.jsx, settings-form.jsx,
// wc-fields.jsx): metric hints, URL-driven filters and search, and the whole
// Settings form (validation, save states, double-submit guard, unsaved-changes guard, preview).
//
// Run: node --test tests/merchant-components.test.mjs
//
// The REAL components are compiled with esbuild and rendered with React 18 into jsdom, inside a real
// react-router (MemoryRouter / createRoutesStub). Polaris web components are not defined in jsdom, so
// they are plain unknown elements here: the tests drive them the way the browser does (setting the
// property and dispatching the native event). This proves the logic; it cannot prove how Polaris draws it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { barDiscard, barSave, barShowing, canDiscard, canSave, installSaveBar } from "./helpers/save-bar.mjs";
import { parsePeriod, periodView } from "../app/utils/period.js";
import { CUSTOMER_SORTS } from "../app/utils/dashboard-constants.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

const OUT_DIR = path.resolve("node_modules/.cache/kw-components-test");
let UI;
let Form;
let Switch;
let Funnel;
let React;
let ReactRouter;
let createRoot;
let dom;
let container;
let root;

const h = (...args) => React.createElement(...args);

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: "http://localhost/" });
  installSaveBar(dom.window);
  for (const name of ["window", "document", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent"]) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
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
      logLevel: "silent",
    });
    return import(pathToFileURL(outfile).href);
  };
  UI = await bundle("app/components/merchant-ui.jsx", "ui");
  Form = await bundle("app/components/settings-form.jsx", "form");
  Switch = await bundle("app/components/activity-switch.jsx", "switch");
  Funnel = await bundle("app/components/product-funnel.jsx", "funnel");
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
const fire = (el, type, init = {}) => el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }));
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const type = (el, value) => act(() => { el.value = value; fire(el, "input"); });
const byText = (selector, text) => [...container.querySelectorAll(selector)].find((el) => el.textContent.trim() === text);
// Polaris banners carry their title in the "heading" attribute, so tests read it from there.
const banners = () => [...container.querySelectorAll("s-banner")].map((b) => ({ heading: b.getAttribute("heading"), text: b.textContent, tone: b.getAttribute("tone") }));
const hasBanner = (heading) => banners().some((b) => b.heading === heading);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ======================= cards and hints =======================
test("a metric card explains itself with a tooltip, and unavailable data is labelled, never zero", async () => {
  await mount(h(UI.KpiCard, { label: "Unique Wishlist users", value: 12, icon: "person", hint: "Different logged-in customers in the date range." }));
  assert.equal(container.querySelector(".kv-kpi-value").textContent, "12");
  const tip = container.querySelector("s-tooltip");
  assert.equal(tip.textContent, "Different logged-in customers in the date range.");
  const icon = container.querySelector("s-icon[interestfor]");
  assert.equal(icon.getAttribute("interestfor"), tip.id, "the info icon points at its tooltip");
  const button = icon.closest("button");
  assert.equal(button.getAttribute("type"), "button", "a real button, so the keyboard can reach it");
  assert.match(button.getAttribute("aria-label"), /About Unique Wishlist users: Different logged-in customers/, "screen readers get the explanation itself");
  assert.equal(button.getAttribute("title"), "Different logged-in customers in the date range.", "and a plain tooltip works even without the Polaris one");

  await mount(h(UI.KpiCard, { label: "Revenue", value: null, icon: "cart" }));
  assert.equal(container.querySelector(".kv-kpi-value").textContent, "Unavailable");
  await mount(h(UI.KpiCard, { label: "Revenue", value: 0, icon: "cart" }));
  assert.equal(container.querySelector(".kv-kpi-value").textContent, "0", "a real zero stays a zero");
  await mount(h(UI.KpiCard, { label: "Revenue", value: null, display: "Waiting for orders", icon: "cart", note: "No orders yet" }));
  assert.equal(container.querySelector(".kv-kpi-value").textContent, "Waiting for orders");
  await unmount();
});

test("the recent-activity feed names the kind of event as well as the time", async () => {
  await mount(h(UI.Feed, { items: [{ id: 1, text: "A customer added “Hat” to their Wishlist", label: "Added to Wishlist", time: "5 minutes ago", icon: "heart", tone: "" }] }));
  assert.match(container.querySelector(".kv-feed-time").textContent, /Added to Wishlist · 5 minutes ago/);
  await unmount();
});

// ======================= filters and search =======================
function Where() {
  const location = ReactRouter.useLocation();
  return h("output", { id: "where" }, `${location.pathname}${location.search}`);
}
const withRouter = (initial, child) => h(ReactRouter.MemoryRouter, { initialEntries: [initial] }, child, h(Where));

test("a filter select writes its choice into the URL, resets the page, keeps the other parameters, and ignores a repeat", async () => {
  await mount(withRouter("/app/wishlist?days=30&page=3&host=abc", h(UI.ParamSelect, { label: "Date range", param: "days", value: 30, options: UI.RANGE_OPTIONS })));
  const select = container.querySelector("s-select");
  assert.deepEqual([...select.querySelectorAll("s-option")].map((o) => o.textContent), ["Last 7 days", "Last 30 days", "Last 90 days"]);

  await act(() => { select.value = "30"; fire(select, "change"); });
  assert.equal(document.getElementById("where").textContent, "/app/wishlist?days=30&page=3&host=abc", "choosing the current value changes nothing");

  await act(() => { select.value = "7"; fire(select, "change"); });
  assert.equal(document.getElementById("where").textContent, "/app/wishlist?days=7&host=abc", "the page resets, the embedded-app parameter stays");
  await unmount();
});

test("search runs on Enter and on the Search button, trims the text, and Clear removes it", async () => {
  await mount(withRouter("/app/customers?page=2&sort=saved", h(UI.SearchBox, { value: "", placeholder: "Search by customer ID" })));
  const field = container.querySelector("s-search-field");
  await type(field, "  12345  ");
  await act(() => container.querySelector(".grow").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(document.getElementById("where").textContent, "/app/customers?sort=saved&q=12345", "Enter searches with the trimmed text, the page resets, sorting stays");
  await unmount();

  await mount(withRouter("/app/customers?sort=saved", h(UI.SearchBox, { value: "", placeholder: "Search" })));
  await type(container.querySelector("s-search-field"), "987");
  await click(byText("s-button", "Search"));
  assert.match(document.getElementById("where").textContent, /q=987/);
  await unmount();

  await mount(withRouter("/app/customers?q=987&sort=saved", h(UI.SearchBox, { value: "987", placeholder: "Search" })));
  await click(byText("s-button", "Clear"));
  assert.equal(document.getElementById("where").textContent, "/app/customers?sort=saved");
  await unmount();
});

test("pagination shows the real range and result count, and only offers pages that exist", async () => {
  await mount(withRouter("/app/wishlist?tab=products&q=hat", h(UI.Pager, { page: 2, total: 60, noun: "saved variants" })));
  assert.match(container.querySelector(".kv-pager").textContent, /Showing 26–50 of 60 saved variants/);
  const hrefs = [...container.querySelectorAll(".kv-pager a")].map((a) => a.getAttribute("href"));
  assert.equal(hrefs.length, 2, "one link to the previous page, one to the next");
  assert.ok(hrefs[0].includes("page=1") && hrefs[0].includes("q=hat") && hrefs[1].includes("page=3"), "the search and tab are kept while paging");
  await mount(withRouter("/app/wishlist", h(UI.Pager, { page: 1, total: 0, noun: "saved variants" })));
  assert.match(container.querySelector(".kv-pager").textContent, /Showing 0–0 of 0/);
  assert.equal(container.querySelectorAll(".kv-pager a").length, 0, "no pages to go to");
  await unmount();
});

// ======================= the Settings form =======================
const SAVED = { wishlistEnabled: true, notifyMeEnabled: true };

function settingsApp({ settings = SAVED, action }) {
  const calls = [];
  const Stub = ReactRouter.createRoutesStub([
    {
      path: "/",
      Component: () => h(React.Fragment, null, h(ReactRouter.Link, { to: "/other", id: "go" }, "go elsewhere"), h(Form.SettingsForm, { settings })),
      action: async ({ request }) => {
        const form = Object.fromEntries(await request.formData());
        calls.push(form);
        return action(form, calls.length);
      },
    },
    { path: "/other", Component: () => h("div", { id: "other" }, "Other page") },
  ]);
  return { calls, element: h(Stub, { initialEntries: ["/"] }) };
}
const saveButton = () => barSave(document);
const okAction = (form) => ({ ok: true, errors: {}, values: { wishlistEnabled: form.wishlistEnabled === "true", notifyMeEnabled: form.notifyMeEnabled === "true" } });
const switches = () => [...container.querySelectorAll("s-switch")];
const flip = (toggle, on) => act(() => { toggle.checked = on; fire(toggle, "change"); });

test("settings: two independent switches; the email content fields and the preview are gone", async () => {
  const { element } = settingsApp({ action: okAction });
  await mount(element);
  await act(() => sleep(10));
  assert.equal(switches().length, 2);
  assert.deepEqual(switches().map((t) => t.getAttribute("label")), ["Enable Wishlist", "Enable Notify Me"]);
  assert.deepEqual(switches().map((t) => t.hasAttribute("checked")), [true, true]);
  assert.equal(container.querySelectorAll("s-text-field, s-text-area, s-email-field").length, 0, "no email content fields");
  assert.equal(container.querySelector(".kv-preview"), null, "no email preview");
  assert.equal(canSave(), false, "nothing to save yet");

  await flip(switches()[0], false); // Wishlist off
  assert.deepEqual(switches().map((t) => t.hasAttribute("checked")), [false, true], "Notify Me did not move");
  assert.equal(hasBanner("Wishlist is off"), true);
  assert.equal(hasBanner("Notify Me is off"), false, "disabling one does not disable or mention the other");
  assert.equal(canSave(), true);
  assert.equal(barShowing(), true, "the native Save bar is showing");

  await flip(switches()[0], true); // back to what is saved
  assert.equal(canSave(), false, "no difference, nothing to save");
  await unmount();
});

test("settings: each switch saves as its own value, once, and success is shown only after the server confirms", async () => {
  const { element, calls } = settingsApp({ action: async (form) => { await sleep(60); return okAction(form); } });
  await mount(element);
  await act(() => sleep(10));
  await flip(switches()[1], false); // Notify Me off, Wishlist stays on
  const warning = banners().find((b) => b.heading === "Notify Me is off");
  assert.ok(warning);
  assert.match(warning.text, /skipped permanently/, "queued emails are skipped, not held");
  assert.match(warning.text, /Existing subscriptions and history are kept/);
  await click(saveButton());
  assert.equal(hasBanner("Settings saved"), false, "not announced before the server confirms");
  assert.equal(saveButton().hasAttribute("loading"), true, "the native Save shows its spinner while the request runs");
  await click(saveButton()); // a second click while saving
  await act(() => sleep(120));
  assert.equal(calls.length, 1, "no duplicate submission");
  assert.deepEqual(calls[0], { wishlistEnabled: "true", notifyMeEnabled: "false" });
  assert.equal(hasBanner("Settings saved"), true);
  assert.equal(canSave(), false, "saved: nothing left to save");
  assert.equal(barShowing(), false, "the native Save bar is hidden");
  await unmount();
});

test("settings: a saved state loads as saved, and a failed save keeps the choice and can be retried", async () => {
  const { element, calls } = settingsApp({ settings: { wishlistEnabled: false, notifyMeEnabled: true }, action: (form, n) => (n === 1 ? { ok: false, errors: {}, values: form, failed: true } : okAction(form)) });
  await mount(element);
  await act(() => sleep(10));
  assert.deepEqual(switches().map((t) => t.hasAttribute("checked")), [false, true], "reloads in the saved state");
  assert.equal(hasBanner("Wishlist is off"), true);
  await flip(switches()[0], true);
  await click(saveButton());
  await act(() => sleep(40));
  const failure = banners().find((b) => b.heading === "Settings were not saved");
  assert.ok(failure, "the failure is reported");
  assert.equal(failure.tone, "critical");
  assert.match(failure.text, /try Save again/);
  assert.equal(hasBanner("Settings saved"), false);
  assert.equal(switches()[0].hasAttribute("checked"), true, "the choice is still there");
  assert.equal(canSave(), true);
  await click(saveButton());
  await act(() => sleep(40));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { wishlistEnabled: "true", notifyMeEnabled: "true" });
  assert.equal(hasBanner("Settings saved"), true);
  assert.equal(hasBanner("Settings were not saved"), false, "the old failure is gone");
  await unmount();
});

test("settings: leaving with unsaved changes asks first; staying keeps the form, leaving goes on", async () => {
  const { element } = settingsApp({ action: okAction });
  await mount(element);
  await act(() => sleep(10));
  await click(document.getElementById("go")); // clean form: leaves freely
  await act(() => sleep(20));
  assert.ok(document.getElementById("other"), "no prompt when nothing is unsaved");
  await unmount();

  const second = settingsApp({ action: okAction });
  await mount(second.element);
  await act(() => sleep(10));
  await flip(switches()[0], false);
  await click(document.getElementById("go"));
  await act(() => sleep(20));
  assert.equal(hasBanner("You have unsaved changes"), true);
  assert.equal(document.getElementById("other"), null, "navigation is held");
  await click(byText("s-button", "Stay on this page"));
  await act(() => sleep(20));
  assert.equal(hasBanner("You have unsaved changes"), false);
  assert.equal(switches()[0].hasAttribute("checked"), false, "the form is untouched");
  await click(document.getElementById("go"));
  await act(() => sleep(20));
  await click(byText("s-button", "Leave without saving"));
  await act(() => sleep(20));
  assert.ok(document.getElementById("other"), "leaving proceeds when the merchant chooses it");
  await unmount();
});

// ======================= date range =======================
const where = () => document.getElementById("where").textContent;
const listButton = (name) => [...document.querySelectorAll("s-popover s-button")].find((b) => b.textContent.trim() === name);
const presetNames = () => [...document.querySelectorAll("s-popover > s-box > div:first-child s-button")].map((b) => b.textContent.trim());
const rangeOf = (extra = {}) => ({ kind: "preset", days: 30, from: null, to: null, error: null, requested: null, ...extra });

test("date range: one Polaris button shows the range and opens a popover with the presets and Custom range; a preset applies at once", async () => {
  await mount(withRouter("/app?days=30&host=abc&page=2", h(UI.DateRange, { period: rangeOf() })));
  assert.equal(container.querySelector("s-select"), null, "no select: its native option list could not host the calendar");
  assert.equal(container.querySelector(".kv-range s-button").textContent.trim(), "Last 30 days");
  assert.deepEqual(presetNames(), ["Last 7 days", "Last 30 days", "Last 90 days", "Custom range"]);
  assert.equal(listButton("Last 30 days").getAttribute("icon"), "check", "the range on screen is ticked");
  await click(listButton("Last 90 days"));
  assert.equal(where(), "/app?days=90&host=abc", "the page resets and the embedded-app parameter stays");
  await unmount();
});

test("date range: an active custom range is named on the button and ticked on Custom range; a preset clears it", async () => {
  const custom = rangeOf({ kind: "custom", days: 15, from: "2026-10-01", to: "2026-10-15" });
  await mount(withRouter("/app?range=custom&from=2026-10-01&to=2026-10-15&page=2&host=abc", h(UI.DateRange, { period: custom })));
  assert.match(container.querySelector(".kv-range s-button").textContent, /Oct 1 – Oct 15, 2026 \(UTC\)/);
  assert.equal(listButton("Custom range").getAttribute("icon"), "check");
  assert.equal(listButton("Last 7 days").getAttribute("icon"), null);
  await click(listButton("Last 7 days"));
  assert.equal(where(), "/app?host=abc&days=7", "the custom range, its dates and the page are removed");
  await unmount();
});

function Live({ page }) {
  const { search } = ReactRouter.useLocation();
  const period = periodView(parsePeriod(new URLSearchParams(search)));
  return page ? h(UI.Page, { title: page, period }, h("p", null, "body")) : h(UI.DateRange, { period });
}
const live = (url, page) => withRouter(url, h(Live, { page }));
const triggerLabel = () => container.querySelector(".kv-range s-button").textContent.trim();
const choose = (value) => click(listButton(value === "custom" ? "Custom range" : `Last ${value} days`));
const params = () => new URLSearchParams(where().split("?")[1] ?? "");

// ---- The shared date-range popover: Polaris <s-popover> + <s-date-picker type="range">. jsdom has no Polaris, so these
// tests play the parts Polaris plays (the popover's "show" / "afterhide" events, the picker's value and its input event). ----
const popoverEl = () => document.querySelector("s-popover");
const pickerEl = () => document.querySelector("s-popover s-date-picker");
const footerButton = (name) => [...document.querySelectorAll("s-popover s-button")].find((b) => b.textContent.trim() === name);
const summary = () => popoverEl().querySelector("s-text").textContent;
const rangeAlert = () => popoverEl().querySelector('[role="alert"]');
const applyDisabled = () => footerButton("Apply").hasAttribute("disabled");
const calendarRange = (extra = {}) => h(UI.DateRange, { period: rangeOf(extra) });
// The merchant presses the trigger (Polaris opens the popover on the list), then presses Custom range: the same popover
// swaps its list for the date picker.
const openCalendar = async () => {
  await click(listButton("Custom range"));
};
const pickRange = (value) => act(() => { pickerEl().value = value; fire(pickerEl(), "input"); }); // "2026-10-02--" is a start with no end yet
const closePopover = () => act(() => fire(popoverEl(), "afterhide")); // Cancel, Escape or a click outside: Polaris hides it

test("date range: it is Polaris - a select, a popover with a range date picker, Cancel and a primary Apply - and no custom calendar markup", async () => {
  await mount(withRouter("/app?days=30&host=abc", calendarRange()));
  assert.ok(popoverEl() && pickerEl(), "s-popover holds an s-date-picker");
  assert.equal(pickerEl().getAttribute("type"), "range");
  assert.equal(popoverEl().getAttribute("id"), container.querySelector(".kv-range s-button").getAttribute("commandfor"), "the visible trigger button opens this popover");
  assert.equal(footerButton("Apply").getAttribute("variant"), "primary");
  assert.equal(footerButton("Cancel").getAttribute("command"), "--hide");
  assert.equal(document.querySelector(".kv-cal, .kv-cal-grid, .kv-cal-day"), null, "the hand-made calendar is gone");
  assert.equal(container.querySelectorAll('input[type="date"]').length, 0);
  await unmount();
});

test("date range: opening starts empty on a preset, Apply stays disabled until a complete valid range exists, and opening changes nothing", async () => {
  await mount(withRouter("/app?days=30&host=abc", calendarRange()));
  await openCalendar();
  assert.equal(summary(), "Select a start date");
  assert.equal(applyDisabled(), true);
  assert.equal(pickerEl().allow, `2000-01-01--${new Date().toISOString().slice(0, 10)}`, "past days and today only, like the server");
  await pickRange("2026-10-02--");
  assert.equal(summary(), "Oct 2, 2026 – select an end date");
  assert.equal(applyDisabled(), true, "a start without an end is incomplete");
  assert.equal(where(), "/app?days=30&host=abc", "nothing was applied");
  await unmount();
});

test("date range: pick a start and an end, then Apply writes the URL (days and page dropped) and the select shows the range", async () => {
  await mount(live("/app?days=30&host=abc&page=2"));
  await openCalendar();
  await pickRange("2026-10-02--2026-10-12");
  assert.equal(summary(), "Oct 2, 2026 – Oct 12, 2026");
  assert.equal(applyDisabled(), false);
  await click(footerButton("Apply"));
  assert.equal(where(), "/app?host=abc&range=custom&from=2026-10-02&to=2026-10-12");
  assert.match(triggerLabel(), /Oct 2 – Oct 12, 2026 \(UTC\)/, "the button names the applied range");
  await unmount();
});

test("date range: a single day is a valid range; a start can be corrected before applying", async () => {
  await mount(live("/app?days=30"));
  await openCalendar();
  await pickRange("2026-10-20--");
  await pickRange("2026-10-10--"); // the picker restarts from an earlier day
  assert.equal(applyDisabled(), true);
  await pickRange("2026-10-10--2026-10-10");
  assert.equal(applyDisabled(), false);
  await click(footerButton("Apply"));
  assert.equal(where(), "/app?range=custom&from=2026-10-10&to=2026-10-10");
  await unmount();
});

test("date range: an end before the start, a range over 366 days and a future start are refused with a reason, and Apply stays disabled", async () => {
  await mount(live("/app?days=30"));
  await openCalendar();
  await pickRange("2026-10-12--2026-10-02");
  assert.match(rangeAlert().textContent, /end date cannot be before the start date/);
  assert.equal(applyDisabled(), true);
  await pickRange("2024-01-15--" + new Date().toISOString().slice(0, 10));
  assert.match(rangeAlert().textContent, /at most 366 days/);
  assert.equal(applyDisabled(), true);
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await pickRange(`${tomorrow}--${tomorrow}`);
  assert.match(rangeAlert().textContent, /cannot be in the future/);
  assert.equal(applyDisabled(), true);
  await click(footerButton("Apply")); // disabled in Polaris; even a stray click applies nothing
  assert.equal(where(), "/app?days=30");
  await pickRange("2026-10-01--2026-10-05");
  assert.equal(rangeAlert(), null);
  assert.equal(applyDisabled(), false);
  await unmount();
});

test("date range: reopening starts from the applied range; a discarded pick is gone", async () => {
  await mount(live("/app?range=custom&from=2026-10-06&to=2026-10-23"));
  const before = where();
  await openCalendar();
  assert.equal(pickerEl().value, "2026-10-06--2026-10-23");
  assert.equal(pickerEl().view, "2026-10", "opens on the month of the applied end day");
  assert.equal(summary(), "Oct 6, 2026 – Oct 23, 2026");
  await pickRange("2026-10-01--");
  await closePopover(); // Cancel / Escape / outside click
  assert.equal([where(), triggerLabel()].join(), [before, "Oct 6 – Oct 23, 2026 (UTC)"].join(), "nothing applied, the button still names the applied range");
  assert.equal(document.querySelector("s-popover > s-box > div:first-child").hasAttribute("hidden"), false, "closed any way, it reopens on the list");
  await openCalendar();
  assert.equal(pickerEl().value, "2026-10-06--2026-10-23", "the unconfirmed pick was thrown away");
  assert.equal(summary(), "Oct 6, 2026 – Oct 23, 2026");
  await unmount();
});

test("date range: Cancel on a preset returns the select to the preset and applies nothing", async () => {
  await mount(live("/app?days=30&host=abc"));
  await openCalendar();
  assert.equal(document.querySelector("s-popover > s-box > div:last-child").hasAttribute("hidden"), false, "the picker replaced the list in the same popover");
  await pickRange("2026-10-02--2026-10-04");
  await closePopover();
  assert.equal([where(), triggerLabel()].join(), ["/app?days=30&host=abc", "Last 30 days"].join());
  await unmount();
});

test("date range: custom ranges can be applied again and again, and presets still apply", async () => {
  await mount(live("/app?days=30&host=abc&page=2"));
  for (const [from, to] of [["2026-10-06", "2026-10-23"], ["2026-10-01", "2026-10-09"], ["2026-09-15", "2026-09-30"]]) {
    await openCalendar();
    await pickRange(`${from}--${to}`);
    await click(footerButton("Apply"));
    assert.equal(where(), `/app?host=abc&range=custom&from=${from}&to=${to}`);
    for (const key of ["range", "from", "to", "host"]) assert.equal(params().getAll(key).length, 1, `${key} appears once`);
    assert.equal(params().has("days") || params().has("page"), false);
  }
  assert.equal(listButton("Custom range").getAttribute("icon"), "check");
  await choose("7");
  assert.equal(where(), "/app?host=abc&days=7", "the custom range, its dates and the page are removed");
  assert.equal(listButton("Custom range").getAttribute("icon"), null, "no tick on Custom range once a preset applies");
  await choose("90");
  assert.equal(where(), "/app?host=abc&days=90");
  await choose("30");
  assert.equal(where(), "/app?host=abc&days=30");
  await unmount();
});

test("date range: a custom range the server refused is explained next to the select, and Custom range can pick again", async () => {
  await mount(live("/app?range=custom&from=2026-10-23&to=2026-10-06"));
  assert.equal(triggerLabel(), "Last 30 days", "back on the default preset");
  assert.match(container.querySelector('.kv-range-error[role="alert"]').textContent, /before the start date/);
  await openCalendar();
  await pickRange("2026-10-01--2026-10-05");
  await click(footerButton("Apply"));
  assert.equal(where(), "/app?range=custom&from=2026-10-01&to=2026-10-05");
  assert.equal(container.querySelector(".kv-range-error"), null, "the explanation goes once the range is valid");
  await unmount();
});

test("date range: the popover takes no room in the page, and every page that has a date range gets the same one", async () => {
  await mount(withRouter("/app?days=30", calendarRange()));
  const before = container.querySelectorAll("*").length;
  await openCalendar();
  assert.equal(container.querySelectorAll("*").length, before, "opening adds nothing to the page layout");
  await unmount();
  for (const title of ["Dashboard", "Wishlist", "Notify Me", "Engaged customers", "Analytics"]) {
    await mount(withRouter("/app", h(UI.Page, { title, period: rangeOf() }, h("p", null, "body"))));
    assert.equal(document.querySelectorAll("s-popover s-date-picker").length, 1, title);
    assert.equal(container.querySelectorAll('input[type="date"]').length, 0, title);
    await unmount();
  }
  for (const file of fs.readdirSync("app/routes").filter((f) => f.endsWith(".jsx"))) {
    assert.equal(/type="date"|s-date-picker|calendarRange/.test(fs.readFileSync(`app/routes/${file}`, "utf8")), false, `${file} has no page-specific date picker`);
  }
  for (const file of ["app._index", "app.wishlist", "app.notify-me", "app.customers", "app.analytics"]) assert.match(fs.readFileSync(`app/routes/${file}.jsx`, "utf8"), /<Page [^>]*period=\{period\}/, `${file} uses the shared Page date range`);
});

test("KPI cards carry no percentage-change badge or arrow, on any page", async () => {
  await mount(h(UI.KpiCard, { label: "Wishlist sessions", value: 12, icon: "heart", tone: "violet", delta: -67, days: 7, note: "Last 7 days" }));
  assert.equal(container.querySelector(".kv-delta"), null);
  assert.equal(/[↑↓→]|%|vs previous/.test(container.textContent), false);
  assert.match(container.textContent, /12/);
  assert.match(container.textContent, /Last 7 days/);
  await unmount();
  for (const file of ["app._index", "app.analytics", "app.wishlist", "app.notify-me", "app.customers"]) assert.equal(/delta=|deltaOf/.test(fs.readFileSync(`app/routes/${file}.jsx`, "utf8")), false, file);
  assert.equal(fs.readFileSync("app/styles/merchant.css", "utf8").includes(".kv-delta"), false, "its styles are gone");
});

// ---- Customers in tables ----
test("CustomerLink shows the masked email as the link to the same Shopify customer page; without one it shows the id as before", async () => {
  await mount(h("div", null, h(UI.CustomerLink, { customerId: "123", emails: { 123: "a*************@gmail.com" } }), h(UI.CustomerLink, { customerId: "456", emails: { 123: "a*************@gmail.com" } }), h(UI.CustomerLink, { customerId: "789" })));
  const links = [...container.querySelectorAll("s-link")];
  assert.deepEqual(links.map((l) => l.getAttribute("href")), ["shopify://admin/customers/123", "shopify://admin/customers/456", "shopify://admin/customers/789"], "the destination is always the customer id");
  assert.deepEqual(links.map((l) => l.textContent), ["a*************@gmail.com", "Customer 456", "Customer 789"]);
  assert.equal(container.querySelector("[title]"), null, "no hover text that would reveal the id");
  assert.equal(links[0].textContent.includes("123"), false, "the id is not in the visible text when an email is shown");
  assert.equal(/@[a-z]+\.com/.test(container.innerHTML.replace(/a\*+@gmail\.com/g, "")), false, "no unmasked address is rendered");
  await unmount();
});

test("the page header shows the date range control only on pages that have one", async () => {
  await mount(withRouter("/app", h(UI.Page, { title: "Dashboard", period: rangeOf() }, h("p", null, "body"))));
  assert.ok(container.querySelector(".kv-range s-button"));
  await mount(withRouter("/app", h(UI.Page, { title: "Settings" }, h("p", null, "body"))));
  assert.equal(container.querySelector(".kv-range"), null);
  await unmount();
});

// ======================= (i) popover =======================
test("the (i) popover opens on click, is announced, and closes with Escape, a click elsewhere, or the button again", async () => {
  await mount(h("div", null, h("p", { id: "outside" }, "elsewhere"), h(UI.InfoPopover, { label: "About these figures" }, h("ul", null, h("li", null, "Saved items are current totals.")))));
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-label"), "About these figures");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector('[role="note"]'), null, "closed by default");
  await click(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.match(container.querySelector('[role="note"]').textContent, /current totals/);
  assert.equal(button.getAttribute("aria-controls"), container.querySelector('[role="note"]').id);
  await act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(container.querySelector('[role="note"]'), null, "Escape closes it");
  await click(button);
  await click(document.getElementById("outside"));
  assert.equal(container.querySelector('[role="note"]'), null, "a click elsewhere closes it");
  await click(button);
  await click(button);
  assert.equal(container.querySelector('[role="note"]'), null, "the button toggles it");
  await unmount();
});

test("Engaged customers: no search any more; the sort stays with its three options, at the right of the toolbar", async () => {
  const source = fs.readFileSync("app/routes/app.customers.jsx", "utf8");
  for (const gone of ["SearchBox", "Search by customer ID", "cleanQuery", 'get("q")', "q={", "No matching customers", "numeric customer ID shown"]) assert.equal(source.includes(gone), false, `${gone} is gone from the route`);
  assert.equal(/\bq\b/.test(source.replace(/\/\/.*$/gm, "")), false, "no search variable is left");
  assert.match(source, /<div className="kv-toolbar kv-toolbar--end">\s*<div style=\{\{ minWidth: 200 \}\}>\s*<ParamSelect label="Sort by" param="sort" value=\{sort\} options=\{Object\.entries\(CUSTOMER_SORTS\)\} \/>\s*<\/div>\s*<\/div>/, "the sort is the toolbar's only control");
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  assert.match(css, /\.kv-toolbar--end \{\s*align-items: center;\s*justify-content: flex-end;/, "right-aligned, level with the table");
  assert.match(css, /\.kv-toolbar > div:not\(\.grow\) \{\s*flex: 1 1 100%;/, "and full width on a phone");
  // exactly the three sort options, with their labels, and each one writes ?sort= and resets the page
  assert.deepEqual(Object.entries(CUSTOMER_SORTS), [["recent", "Recently active"], ["saved", "Most saved items"], ["activity", "Most activity"]]);
  await mount(withRouter("/app/customers?sort=recent&page=3&host=abc", h(UI.ParamSelect, { label: "Sort by", param: "sort", value: "recent", options: Object.entries(CUSTOMER_SORTS) })));
  const select = container.querySelector("s-select");
  assert.deepEqual([...select.querySelectorAll("s-option")].map((o) => o.textContent), ["Recently active", "Most saved items", "Most activity"]);
  await act(() => { select.value = "saved"; fire(select, "change"); });
  assert.equal(document.getElementById("where").textContent, "/app/customers?sort=saved&host=abc");
  await act(() => { select.value = "activity"; fire(select, "change"); });
  assert.equal(document.getElementById("where").textContent, "/app/customers?sort=activity&host=abc");
  await unmount();
});

test("Engaged customers: the long explanation is in the popover, not under the table, and says what the task requires", async () => {
  const source = fs.readFileSync("app/routes/app.customers.jsx", "utf8");
  assert.match(source, /<InfoPopover label="About these figures">/);
  for (const needle of ["current totals", "Wishlist and Notify Me actions", "no saved items now", "Shopify customer ID", "partly hidden"]) {
    assert.ok(source.includes(needle), `the popover says: ${needle}`);
  }
  assert.equal(/<p className="kv-note">“Saved items”/.test(source), false, "the old paragraph under the table is gone");
  assert.equal(/customer\.(email|name|firstName|lastName)/i.test(source), false, "no personal data is read here");
});

// ======================= activity chart switch =======================
const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03"];
const seriesOf = (over = {}) => ({
  days: DAYS,
  values: { WISHLIST_ADDED: [1, 2, 3], wishlistUsers: [1, 1, 2], WISHLIST_PRODUCT_CLICKED: [0, 1, 0], NOTIFY_SUBSCRIBED: [0, 0, 0], NOTIFY_UNSUBSCRIBED: [0, 0, 0], RESTOCK_EMAIL_SENT: [0, 0, 0], ...over },
});
const legend = () => [...container.querySelectorAll(".kv-legend span")].map((n) => n.textContent);
const switchButtons = () => [...container.querySelectorAll(".kv-seg-btn")];

test("activity chart: Wishlist activity is shown first; switching shows the Notify Me chart with its own legend, labels and data", async () => {
  await mount(h(Switch.ActivitySwitch, { series: seriesOf({ NOTIFY_SUBSCRIBED: [2, 0, 1], RESTOCK_EMAIL_SENT: [0, 1, 0] }), rangeLabel: "Oct 1 – Oct 3, 2026 (UTC)" }));
  assert.deepEqual(switchButtons().map((b) => b.textContent), ["Wishlist activity", "Notify Me activity"]);
  assert.deepEqual(switchButtons().map((b) => b.getAttribute("aria-pressed")), ["true", "false"]);
  assert.deepEqual(legend(), ["Products added", "Unique users", "Product clicks"]);
  assert.match(container.querySelector("svg").getAttribute("aria-label"), /^Wishlist activity, Oct 1 – Oct 3, 2026 \(UTC\)\. Products added: 6 in total/);
  assert.equal(container.textContent.includes("Daily counts, UTC days"), false, "no explanatory note under the chart");

  await click(switchButtons()[1]);
  assert.deepEqual(switchButtons().map((b) => b.getAttribute("aria-pressed")), ["false", "true"]);
  assert.deepEqual(legend(), ["Subscribed", "Unsubscribed", "Restock emails sent"]);
  assert.match(container.querySelector("svg").getAttribute("aria-label"), /^Notify Me activity, Oct 1 – Oct 3, 2026 \(UTC\)\. Subscribed: 3 in total; Unsubscribed: 0 in total; Restock emails sent: 1 in total/);
  assert.equal(container.querySelector(".kv-legend")?.textContent.includes("Unique users") ?? false, false, "the Wishlist-only series is gone");

  await click(switchButtons()[0]);
  assert.deepEqual(legend(), ["Products added", "Unique users", "Product clicks"]);
  await unmount();
});

test("activity chart: a view without data shows its own empty state, not the other chart and not invented numbers", async () => {
  await mount(h(Switch.ActivitySwitch, { series: seriesOf(), rangeLabel: "Last 30 days" }));
  await click(switchButtons()[1]);
  assert.equal(container.querySelector("svg"), null, "no chart drawn from nothing");
  assert.match(container.querySelector(".kv-chart-empty").textContent, /No activity in this period/);
  assert.equal(switchButtons()[1].getAttribute("aria-pressed"), "true");
  await unmount();
});

const hoverDay = (iso) => act(() => document.querySelector(`.kv-chart .hit[data-day="${iso}"]`).dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })));
const tooltip = () => container.querySelector('[data-testid="chart-tooltip"]');
const tooltipRows = () => [...tooltip().querySelectorAll("li")].map((li) => [li.querySelector(".kv-tooltip-name").textContent, li.querySelector("strong").textContent]);

test("chart tooltip: hovering a day shows its date and the exact value of EVERY series, from the same data the lines use", async () => {
  await mount(h(Switch.ActivitySwitch, { series: seriesOf({ WISHLIST_ADDED: [21, 5, 1200], wishlistUsers: [12, 3, 7], WISHLIST_PRODUCT_CLICKED: [7, 0, 2], NOTIFY_SUBSCRIBED: [2, 0, 1], NOTIFY_UNSUBSCRIBED: [0, 1, 0], RESTOCK_EMAIL_SENT: [0, 4, 0] }), rangeLabel: "Oct 1 – Oct 3, 2026 (UTC)" }));
  assert.equal(tooltip(), null, "nothing until the pointer is on the chart");
  await hoverDay("2026-10-01");
  assert.equal(tooltip().querySelector(".kv-tooltip-date").textContent, "October 1, 2026");
  assert.deepEqual(tooltipRows(), [["Products added", "21"], ["Unique users", "12"], ["Product clicks", "7"]]);
  await hoverDay("2026-10-03");
  assert.equal(tooltip().querySelector(".kv-tooltip-date").textContent, "October 3, 2026");
  assert.deepEqual(tooltipRows(), [["Products added", "1,200"], ["Unique users", "7"], ["Product clicks", "2"]], "numbers are formatted");
  assert.equal(container.querySelectorAll(".kv-chart .hover-dot").length, 3, "one marker per series on the hovered day");
  assert.equal(tooltip().classList.contains("left"), true, "in the right half it opens to the left, so it stays inside the chart");
  await hoverDay("2026-10-02");
  assert.equal(tooltip().classList.contains("left"), false);
  // every series gets its own colour dot, the same colour as the legend
  assert.deepEqual([...tooltip().querySelectorAll("li")].map((li) => li.style.getPropertyValue("--dot")), [...container.querySelectorAll(".kv-legend span")].map((n) => n.style.getPropertyValue("--dot")));
  // the Notify Me chart reads its own series
  await click(switchButtons()[1]);
  await hoverDay("2026-10-02");
  assert.deepEqual(tooltipRows(), [["Subscribed", "0"], ["Unsubscribed", "1"], ["Restock emails sent", "4"]]);
  await unmount();
});

test("chart tooltip: it leaves with the pointer, and the arrow keys read each day for keyboard users", async () => {
  await mount(h(Switch.ActivitySwitch, { series: seriesOf(), rangeLabel: "Last 30 days" }));
  const wrap = container.querySelector(".kv-chart-wrap");
  assert.equal(wrap.getAttribute("tabindex"), "0");
  await hoverDay("2026-10-02");
  assert.ok(tooltip());
  await act(() => wrap.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  assert.equal(tooltip(), null, "gone when the pointer leaves");
  const key = (name) => act(() => wrap.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  await key("ArrowRight");
  assert.equal(tooltip().querySelector(".kv-tooltip-date").textContent, "October 1, 2026", "the first day");
  await key("ArrowRight");
  await key("ArrowRight");
  await key("ArrowRight");
  assert.equal(tooltip().querySelector(".kv-tooltip-date").textContent, "October 3, 2026", "stops at the last day");
  assert.deepEqual(tooltipRows(), [["Products added", "3"], ["Unique users", "2"], ["Product clicks", "0"]]);
  await key("ArrowLeft");
  assert.equal(tooltip().querySelector(".kv-tooltip-date").textContent, "October 2, 2026");
  await key("Escape");
  assert.equal(tooltip(), null);
  await unmount();
});

test("chart tooltip: one day of data and a many-day range both have a hover area for every day", async () => {
  await mount(h(Switch.ActivitySwitch, { series: { days: ["2026-10-05"], values: { WISHLIST_ADDED: [4], wishlistUsers: [2], WISHLIST_PRODUCT_CLICKED: [1], NOTIFY_SUBSCRIBED: [0], NOTIFY_UNSUBSCRIBED: [0], RESTOCK_EMAIL_SENT: [0] } }, rangeLabel: "Oct 5" }));
  assert.equal(container.querySelectorAll(".kv-chart .hit").length, 1);
  await hoverDay("2026-10-05");
  assert.deepEqual(tooltipRows(), [["Products added", "4"], ["Unique users", "2"], ["Product clicks", "1"]]);
  await unmount();
  const days = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10));
  const flat = days.map((_, i) => i);
  await mount(h(Switch.ActivitySwitch, { series: { days, values: { WISHLIST_ADDED: flat, wishlistUsers: flat, WISHLIST_PRODUCT_CLICKED: flat, NOTIFY_SUBSCRIBED: flat, NOTIFY_UNSUBSCRIBED: flat, RESTOCK_EMAIL_SENT: flat } }, rangeLabel: "Last 90 days" }));
  assert.equal(container.querySelectorAll(".kv-chart .hit").length, 90);
  await hoverDay(days[89]);
  assert.deepEqual(tooltipRows()[0], ["Products added", "89"]);
  await unmount();
});

// ======================= product funnel =======================
test("product funnel: stages show their count or 'Unavailable' with the reason, never a made-up zero", async () => {
  const stages = [
    { key: "a", label: "Alpha", count: 12, available: true, reason: null, caption: "Left over from older data" },
    { key: "b", label: "Beta", count: null, available: false, reason: "Needs the read_orders permission." },
    { key: "c", label: "Gamma", count: 0, available: true, reason: null },
    { key: "d", label: "Delta", count: 1234, available: true, display: "$1,234.00", reason: null },
  ];
  await mount(h(Funnel.ProductFunnel, { stages, label: "Test funnel" }));
  const items = [...container.querySelectorAll(".kv-funnel-stage")];
  assert.equal(container.querySelector(".kv-funnel").getAttribute("aria-label"), "Test funnel");
  assert.deepEqual(items.map((i) => i.querySelector(".kv-funnel-label").textContent), ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.deepEqual(items.map((i) => i.querySelector(".kv-funnel-count").textContent), ["12", "Unavailable", "0", "$1,234.00"]);
  assert.deepEqual(items.map((i) => i.classList.contains("na")), [false, true, false, false]);
  assert.match(items[1].textContent, /Needs the read_orders permission/);
  assert.equal(items[0].textContent.includes("Left over"), false, "no helper text under a stage");
  assert.equal(items[0].querySelector(".kv-funnel-reason"), null);
  assert.equal(container.querySelector(".kv-funnel-rate"), null, "no conversion percentage is drawn");
  await unmount();
});

// ======================= pages =======================
test("Notify Me page: Failed or unknown is no longer a KPI card; Notify Me-attributed revenue is, from the same service; failures stay in Email activity", () => {
  const source = fs.readFileSync("app/routes/app.notify-me.jsx", "utf8");
  assert.equal(source.includes('<KpiCard label="Failed or unknown"'), false);
  for (const label of ["Active subscriptions", "Customers notified", "Emails sent", "Queued or sending", "Notify Me-attributed revenue"]) {
    assert.ok(source.includes(`label="${label}"`), `${label} is kept`);
  }
  assert.match(source, /getAttribution\(shop\.id, period,/, "the same getAttribution service as the Dashboard, with the same period");
  assert.match(source, /attributionView\(data\.attribution, period, data\.storeCurrency\)/, "the same view helper, so the same definitions");
  assert.match(source, /find\(\(option\) => option\.key === "notifyMe"\)/);
  assert.match(source, /Failed and unknown emails \(\$\{formatNumber\(o\.deliveries\.FAILED \+ o\.deliveries\.UNKNOWN\)\} in total\)/, "the count is still on the page");
  assert.ok(source.includes("DELIVERY_FILTERS"), "Email activity can still be filtered by Failed or Unknown");
});

test("Dashboard: the KPI row, the revenue card without its long copy, and the activity switch", () => {
  const source = fs.readFileSync("app/routes/app._index.jsx", "utf8");
  assert.equal(source.includes("footnote="), false, "no long copy on the revenue card");
  assert.match(source, /<ActivitySwitch series={d\.series} rangeLabel={words\.label} \/>/);
  assert.equal(/ActivityChart/.test(source), false);
  for (const label of ["Unique Wishlist users", "Total sessions", "Active Notify Me subscriptions", "Restock emails sent", "Attributed revenue"]) assert.ok(source.includes(`label="${label}"`), label);
  assert.ok(source.includes('label="Wishlist items"'));
  assert.ok(source.includes("WISHLIST_ITEM_MODES"), "the Active/All-time selector is kept");
});

test("a row of metric cards gets a layout that matches its count, so no card leaves a gap beside it", async () => {
  for (const count of [3, 5, 6]) {
    await mount(h(UI.Grid, null, ...Array.from({ length: count }, (_, i) => h("div", { key: i }, `card ${i}`))));
    assert.equal(container.firstChild.className, `kv-grid kv-kpis n${count}`);
  }
  await mount(h(UI.Grid, { two: true }, h("div", null, "a"), h("div", null, "b")));
  assert.equal(container.firstChild.className, "kv-grid two", "the two-column layout is unchanged");
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  assert.match(css, /\.kv-kpis\.n5 > :nth-child\(n \+ 4\)/, "five cards: three on top, two filling the bottom row");
  await unmount();
});

// ======================= Wishlist / Notify Me funnel selector =======================
const featureFunnel = async (feature, window, attribution = { state: "waiting" }) => {
  const { buildFeatureFunnel } = await import(pathToFileURL(path.resolve("app/utils/funnel.js")).href);
  return buildFeatureFunnel(feature, { window, attribution });
};
const READY = { state: "ready", currency: "USD", wishlist: { orders: 2, revenue: "60.00" }, notifyMe: { orders: 1, revenue: "30.00" } };
const funnelButtons = () => [...container.querySelectorAll(".kv-seg-btn")];
const stageLabels = () => [...container.querySelectorAll(".kv-funnel-label")].map((n) => n.textContent);
const stageCounts = () => [...container.querySelectorAll(".kv-funnel-count")].map((n) => n.textContent);

test("funnel selector: Wishlist is selected first; switching shows the Notify Me funnel with its own stages, data and note", async () => {
  const window = { WISHLIST_ADDED: 12, WISHLIST_PRODUCT_CLICKED: 5, NOTIFY_SUBSCRIBED: 8, RESTOCK_EMAIL_SENT: 6 };
  const funnels = { wishlist: await featureFunnel("wishlist", window, READY), notifyMe: await featureFunnel("notifyMe", window, READY) };
  await mount(h(Funnel.FunnelSwitch, { funnels, rangeLabel: "Oct 1 – Oct 3, 2026 (UTC)" }));
  assert.deepEqual(funnelButtons().map((b) => b.textContent), ["Wishlist", "Notify Me"]);
  assert.deepEqual(funnelButtons().map((b) => b.getAttribute("aria-pressed")), ["true", "false"]);
  assert.equal(container.querySelector('[role="group"]').getAttribute("aria-label"), "Funnel");
  assert.deepEqual(stageLabels(), ["Products saved", "Opened from Wishlist", "Attributed orders", "Attributed revenue"]);
  assert.deepEqual(stageCounts(), ["12", "5", "2", "$60.00"]);
  assert.equal(container.querySelectorAll(".kv-funnel-rate").length, 0, "no percentage between stages that are not a cohort");
  assert.equal(container.querySelector(".kv-note"), null, "no explanatory text under the funnel");
  assert.equal(/UTC days|not tracked/.test(container.textContent), false);
  assert.match(container.querySelector(".kv-funnel").getAttribute("aria-label"), /^Wishlist funnel, Oct 1 – Oct 3, 2026/);

  await click(funnelButtons()[1]);
  assert.deepEqual(funnelButtons().map((b) => b.getAttribute("aria-pressed")), ["false", "true"]);
  assert.deepEqual(stageLabels(), ["Subscriptions", "Restock emails sent", "Attributed orders", "Attributed revenue"]);
  assert.deepEqual(stageCounts(), ["8", "6", "1", "$30.00"]);
  assert.equal(container.querySelector(".kv-note"), null);
  assert.equal(/queued, failed|UTC days/.test(container.textContent), false);
  assert.equal(container.textContent.includes("Add to cart"), false, "nothing of the Wishlist funnel remains");

  await click(funnelButtons()[0]);
  assert.deepEqual(stageCounts(), ["12", "5", "2", "$60.00"]);
  await unmount();
});

test("funnel selector: unavailable stages say why instead of showing zero, and a funnel without activity shows an empty state", async () => {
  const window = { WISHLIST_ADDED: 3, WISHLIST_PRODUCT_CLICKED: 0 };
  const funnels = { wishlist: await featureFunnel("wishlist", window, { state: "needs_access" }), notifyMe: await featureFunnel("notifyMe", { NOTIFY_SUBSCRIBED: 0, RESTOCK_EMAIL_SENT: 0 }, { state: "waiting" }) };
  await mount(h(Funnel.FunnelSwitch, { funnels, rangeLabel: "Last 30 days" }));
  assert.deepEqual(stageCounts(), ["3", "0", "Unavailable", "Unavailable"], "a real zero stays zero; missing order data is unavailable");
  const reasons = [...container.querySelectorAll(".kv-funnel-reason")].map((n) => n.textContent);
  assert.ok(reasons.some((r) => /read_orders/.test(r)), "the reason is on the stage");
  assert.equal(container.textContent.includes("Not available yet"), false);

  await click(funnelButtons()[1]);
  assert.equal(container.querySelector(".kv-funnel"), null, "no row of zeros");
  assert.match(container.querySelector(".kv-empty").textContent, /No Notify Me activity in this period/);
  assert.equal(funnelButtons()[1].getAttribute("aria-pressed"), "true");
  await unmount();
});

test("the KPI row with four cards is four equal columns, then two by two, then one on a very narrow screen", () => {
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  assert.match(css, /\.kv-kpis\.n4 \{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 900px\) \{\s*\.kv-kpis\.n4 \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 359px\) \{\s*\.kv-kpis\.n4 \{\s*grid-template-columns: minmax\(0, 1fr\);/);
});

// ======================= Dashboard layout =======================
test("Dashboard: the old inline setup checklist stays gone (the new one is a separate component); the chart and Recent activity share the middle row; products use the full width below", () => {
  const source = fs.readFileSync("app/routes/app._index.jsx", "utf8");
  for (const gone of ["Setup checklist", "setupSteps", "d.setup"]) assert.equal(source.includes(gone), false, gone);
  const grid = source.indexOf("</Grid>");
  const split = source.indexOf("<Split>");
  const endSplit = source.indexOf("</Split>");
  const activity = source.indexOf('<Card title="Activity"');
  const recent = source.indexOf('<Card title="Recent activity"');
  const products = source.indexOf('<Card title="Top wishlisted products"');
  assert.ok(grid < split && split < activity && activity < recent && recent < endSplit, "KPIs, then chart | Recent activity in one row");
  assert.ok(endSplit < products, "the products table is below, outside the two-column row");
  assert.equal((source.match(/<Split>/g) ?? []).length, 1, "one two-column row, so no blank cell is left");
  assert.equal((source.match(/title="Recent activity"/g) ?? []).length, 1, "Recent activity appears once");
  assert.match(source, /action={{ to: "\/app\/wishlist\?tab=activity", label: "View Wishlist log" }}/, "its navigation is kept");
  assert.match(source, /action={{ to: "\/app\/wishlist", label: "View all" }}/, "the products navigation is kept");
  assert.match(source, /<ActivitySwitch series={d\.series} rangeLabel={words\.label} \/>/, "the chart and its selector are unchanged");
});

test("Dashboard layout CSS: the two-column row stretches to one height and stacks on a narrow screen", () => {
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  assert.match(css, /\.kv-split \{[^}]*grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);[^}]*align-items: stretch;/s);
  assert.match(css, /@media \(max-width: 900px\) \{\s*\.kv-split \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.equal(/\.kv-(check|progress|optional)/.test(css), false, "no leftover checklist styles");
});

test("Dashboard Activity row: no summary cards over the chart, equal-height panels, and a Recent activity list that scrolls inside its panel", async () => {
  const dashboard = fs.readFileSync("app/routes/app._index.jsx", "utf8");
  const activity = dashboard.slice(dashboard.indexOf("<Split>"), dashboard.indexOf("</Split>"));
  assert.equal(/KpiCard|ToggleKpiCard|kv-kpi/.test(activity), false, "no metric cards above the chart");
  assert.match(activity, /to: "\/app\/wishlist\?tab=activity", label: "View Wishlist log"/, "the log link is kept");
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  assert.match(css, /\.kv-split > \.kv-card \{\s*display: flex;\s*flex-direction: column;/);
  assert.match(css, /\.kv-feed \{[^}]*max-height: 340px;[^}]*overflow-y: auto;/s);
  await mount(h(UI.Feed, { items: [{ id: 1, text: "A customer added “A very long product name that has to wrap inside the panel”", label: "Added to Wishlist", time: "just now", icon: "heart", tone: "neutral" }] }));
  const list = container.querySelector(".kv-feed");
  assert.equal(list.getAttribute("tabindex"), "0", "a scrolling region can be reached by keyboard");
  assert.equal(list.getAttribute("aria-label"), "Recent activity");
  assert.match(container.querySelector(".kv-feed-time").textContent, /Added to Wishlist · just now/);
  await unmount();
});
