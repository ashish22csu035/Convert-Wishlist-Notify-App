// The /app/wishlist-settings route: the button that opens it, its loader and action, direct opening and refreshing,
// and what the merchant sees when the settings cannot be read.
//
// Run: node --test tests/wishlist-settings-route.test.mjs
//
// Regression for "the Wishlist Settings button opens a blank page / 'This page could not be loaded'". The real cause,
// found in the app's error log, was `PrismaClientValidationError: Unknown field wishlistAppearance` in the loader while
// the dev server still ran a database client generated before the field existed. These tests cover the page working
// (including a NULL appearance) and the loader failing visibly instead of as a blank page.
//
// The REAL route module, its components and the Settings screen are compiled with esbuild and rendered in jsdom inside
// a real react-router. Shopify authentication and the database are replaced by small stubs (tests/helpers), so nothing
// here touches a database; NULL-column behaviour against MySQL is tested in tests/wishlist-appearance.test.mjs.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { DEFAULT_APPEARANCE, resolveAppearance, validateAppearance } from "../app/utils/wishlist-appearance-shared.js";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

const OUT_DIR = path.resolve("node_modules/.cache/kw-wishlist-route-test");
let Route;
let Settings;
let React;
let ReactRouter;
let createRoot;
let dom;
let container;
let root;
let logged;
let originalError;

const h = (...args) => React.createElement(...args);

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: "http://localhost/app/wishlist-settings?embedded=1&host=abc&shop=demo-store.myshopify.com" });
  for (const name of ["window", "document", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent"]) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  process.env.SHOPIFY_API_KEY = "key123";

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
          name: "route-stubs", // Shopify authentication and the database, replaced by the stubs in tests/helpers
          setup(b) {
            b.onResolve({ filter: /^\.\.\/shopify\.server$/ }, () => ({ path: path.resolve("tests/helpers/admin-session-stub.mjs") }));
            b.onResolve({ filter: /^\.\.\/models\/settings\.server$/ }, () => ({ path: path.resolve("tests/helpers/settings-route-stub.mjs") }));
          },
        },
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
  Route = await bundle("tests/helpers/wishlist-settings-route-entry.mjs", "route");
  Settings = await bundle("app/components/settings-form.jsx", "settings");
  React = (await import("react")).default;
  ReactRouter = await import("react-router");
  ({ createRoot } = await import("react-dom/client"));
});

after(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  dom?.window.close();
});

beforeEach(() => {
  delete globalThis.__kwAuth;
  delete globalThis.__kwSettings;
  logged = [];
  originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
});

const restoreConsole = () => {
  console.error = originalError;
};

async function mount(element) {
  container = document.getElementById("root");
  container.innerHTML = "";
  root = createRoot(container);
  await React.act(async () => root.render(element));
}
const unmount = () => React.act(async () => root.unmount());
const act = (fn) => React.act(async () => fn());
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byText = (selector, text) => [...container.querySelectorAll(selector)].find((el) => el.textContent.trim() === text);
const tabs = () => [...container.querySelectorAll('button[role="tab"]')].map((b) => b.textContent);
const banners = () => [...container.querySelectorAll("s-banner")].map((b) => b.getAttribute("heading"));

// Shows the router's current URL, so tests read what the browser's address would be.
const Where = () => {
  const location = ReactRouter.useLocation();
  return h("output", { id: "where" }, location.pathname + location.search);
};
const where = () => container.querySelector("#where").textContent;
const whereParams = () => Object.fromEntries(new URLSearchParams(where().split("?")[1] ?? ""));

// An app with both screens, as the file routes register them: /app/settings and /app/wishlist-settings (siblings).
function appStub({ initial = "/app/wishlist-settings", settingsAction } = {}) {
  const posted = [];
  const loads = [];
  const SettingsRoute = {
    path: "/app/settings",
    loader: () => ({ settings: { wishlistEnabled: true, notifyMeEnabled: true } }),
    Component: () => h(React.Fragment, null, h(Where), h(Settings.SettingsForm, { settings: ReactRouter.useLoaderData().settings })),
    action: async ({ request }) => {
      posted.push(Object.fromEntries(await request.formData()));
      return settingsAction ? settingsAction() : { ok: true, errors: {}, values: { wishlistEnabled: true, notifyMeEnabled: true } };
    },
  };
  const WishlistRoute = { path: "/app/wishlist-settings", loader: (args) => (loads.push(args.request.url), Route.loader(args)), action: Route.action, Component: () => h(React.Fragment, null, h(Where), h(Route.default)), ErrorBoundary: Route.ErrorBoundary };
  const Stub = ReactRouter.createRoutesStub([SettingsRoute, WishlistRoute]);
  return { posted, loads, element: h(Stub, { initialEntries: [initial] }) };
}

// ======================= the button and the route =======================
test("the button points at /app/wishlist-settings, a real sibling route of /app/settings", () => {
  const form = fs.readFileSync("app/components/settings-form.jsx", "utf8");
  assert.match(form, /navigate\(withEmbeddedParams\("\/app\/wishlist-settings", search\)\)/, "the button navigates to the route and keeps the Admin context");
  assert.equal(fs.existsSync("app/routes/app.wishlist-settings.jsx"), true, "the file route exists: flat routes make it /app/wishlist-settings");
  assert.equal(fs.existsSync("app/routes/app.settings.wishlist.jsx"), false, "not nested under a layout that has no Outlet");
  assert.match(fs.readFileSync("app/routes.js", "utf8"), /flatRoutes\(\)/);
  assert.equal(/<Outlet/.test(fs.readFileSync("app/routes/app.settings.jsx", "utf8")), false, "Settings renders no Outlet, so a child route would never show");
});

test("the production build registers the route under the app layout", { skip: !fs.existsSync("build/server/index.js") && "no build output (run npm run build)" }, () => {
  const built = fs.readFileSync("build/server/index.js", "utf8");
  const entry = /"routes\/app\.wishlist-settings":\s*\{[^}]*\}/.exec(built);
  assert.ok(entry, "routes/app.wishlist-settings is in the route manifest");
  assert.match(entry[0], /"path":\s*"wishlist-settings"/);
  assert.match(entry[0], /"parentId":\s*"routes\/app"/);
});

test("clicking the button opens the four-tab screen; Back returns to Settings; no switch is submitted or changed", async () => {
  const { element, posted } = appStub({ initial: "/app/settings" });
  await mount(element);
  await act(() => sleep(20));
  assert.equal(container.querySelectorAll("s-switch").length, 2);
  assert.equal(tabs().length, 0, "Settings first");

  await click(byText("s-button", "Wishlist Settings"));
  await act(() => sleep(40));
  assert.deepEqual(tabs(), ["General", "Product page", "Collection page", "Wishlist page"]);
  assert.ok(container.querySelector("iframe.kv-pv-frame"), "with the preview");
  assert.equal(container.querySelectorAll("s-banner[heading='Wishlist Settings could not be loaded']").length, 0);

  await click(byText("s-button", "Back to Settings"));
  await act(() => sleep(40));
  assert.equal(container.querySelectorAll("s-switch").length, 2, "back on Settings");
  assert.deepEqual([...container.querySelectorAll("s-switch")].map((s) => s.hasAttribute("checked")), [true, true], "the switches are as they were");
  assert.deepEqual(posted, [], "navigating submitted nothing");
  await unmount();
  restoreConsole();
});

// ======================= the click itself =======================
test("clicking Wishlist Settings runs the handler without throwing, requests exactly one navigation, submits no form, and leaves the master switches alone", async () => {
  const errors = [];
  const onError = (event) => errors.push(event.message);
  window.addEventListener("error", onError);
  const { element, posted, loads } = appStub({ initial: "/app/settings?" + ADMIN });
  await mount(element);
  await act(() => sleep(20));
  const button = byText("s-button", "Wishlist Settings");
  assert.equal(button.closest("form"), null, "the button is not inside a form, so it cannot submit one");
  assert.equal(container.querySelectorAll("form").length, 0, "the Settings screen has no <form> at all");
  const switchesBefore = [...container.querySelectorAll("s-switch")].map((t) => t.hasAttribute("checked"));
  const clicked = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  await act(() => button.dispatchEvent(clicked));
  await act(() => sleep(60));

  assert.deepEqual(errors, [], "no exception was thrown by the click");
  assert.equal(clicked.defaultPrevented, false, "nothing in the click path cancelled or hijacked it");
  assert.equal(loads.length, 1, "the Wishlist Settings route data was requested exactly once");
  assert.deepEqual(posted, [], "the Settings (master switch) action was never called");
  assert.deepEqual(tabs(), ["General", "Product page", "Collection page", "Wishlist page"], "and the screen opened");
  await click(byText("s-button", "Back to Settings"));
  await act(() => sleep(40));
  assert.deepEqual([...container.querySelectorAll("s-switch")].map((t) => t.hasAttribute("checked")), switchesBefore, "the master switches are exactly as they were");
  assert.deepEqual(posted, [], "still nothing submitted");
  assert.equal(loads.length, 1, "Back did not request the Wishlist Settings data again");
  window.removeEventListener("error", onError);
  await unmount();
  restoreConsole();
});

test("the main Settings page stays on screen until the navigation succeeds: while the route data is pending nothing is removed", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.__kwSettings = { getAppearance: async () => (await gate, resolveAppearance(null)) };
  const { element } = appStub({ initial: "/app/settings?" + ADMIN });
  await mount(element);
  await act(() => sleep(20));
  await click(byText("s-button", "Wishlist Settings"));
  await act(() => sleep(60));
  assert.equal(container.querySelectorAll("s-switch").length, 2, "Settings is still fully rendered while the request is pending");
  assert.ok(byText("s-button", "Wishlist Settings"), "with its button");
  assert.match(where(), /^\/app\/settings/, "and the URL has not changed yet");
  release();
  await act(() => sleep(60));
  assert.deepEqual(tabs(), ["General", "Product page", "Collection page", "Wishlist page"]);
  await unmount();
  restoreConsole();
});

// ======================= a rejected route-data request =======================
// What Shopify's library answers a route-data request with when the session cannot be accepted: a thrown 401 (no body), a
// 410, or its bounce page (HTML with a <script>). The library's boundary renders such a body with dangerouslySetInnerHTML,
// and a script set that way never runs: after a client-side navigation the content area would simply be empty.
const BOUNCE = '<script data-api-key="k">/* app bridge bounce */ shopify.idToken().then(() => location.reload())</script>';
for (const [label, make] of [
  ["401 with no body", () => new Response(undefined, { status: 401, statusText: "Unauthorized" })],
  ["410 Gone", () => new Response(undefined, { status: 410, statusText: "Gone" })],
  ["the session-token bounce page", () => new Response(BOUNCE, { status: 200 }) && new Response(BOUNCE, { status: 401 })],
]) {
  test(`a rejected route-data request (${label}) after the app is running leaves a recoverable page, not an empty area`, async () => {
    Route.setAppRendered(true); // the app layout has rendered in this browser tab: this is a client-side navigation
    globalThis.__kwAuth = async () => { throw make(); }; // the library throws its response from authenticate.admin
    const { element } = appStub({ initial: "/app/settings?" + ADMIN });
    await mount(element);
    await act(() => sleep(20));
    await click(byText("s-button", "Wishlist Settings"));
    await act(() => sleep(80));
    const text = container.textContent.replace(/\s+/g, " ").trim();
    assert.ok(text.length > 40, "the content area is not empty: " + JSON.stringify(text));
    assert.match(text, /session needs to be refreshed/);
    assert.equal(container.querySelectorAll("script").length, 0, "and it does not rely on a script that React would not run");
    const reload = byText("button", "Reload page");
    assert.ok(reload, "with a control that recovers");
    await unmount();
    Route.setAppRendered(false);
    restoreConsole();
  });
}

test("on the very first page load (server-rendered bounce page) Shopify's own response is still used, so its script runs", async () => {
  Route.setAppRendered(false); // nothing has rendered yet in this tab: this is the document request
  globalThis.__kwAuth = async () => { throw new Response(BOUNCE, { status: 401 }); };
  const { element } = appStub({ initial: "/app/wishlist-settings?" + ADMIN });
  await mount(element);
  await act(() => sleep(60));
  assert.ok(container.innerHTML.includes("app bridge bounce"), "the library's HTML is rendered untouched");
  assert.equal(byText("button", "Reload page"), undefined, "no replacement panel on the document path");
  await unmount();
  restoreConsole();
});

test("the shared auth boundary: only Shopify's authentication responses are handled, and which output depends on whether the app is running", () => {
  class ErrorResponseImpl {
    constructor(status, data) {
      Object.assign(this, { status, statusText: "x", internal: false, data });
    }
  }
  Route.setAppRendered(false);
  for (const status of [401, 410, 302, 303]) {
    const first = Route.authResponseBoundary(new ErrorResponseImpl(status, BOUNCE));
    assert.equal(first.type, "div", `first load, ${status}: the library's own output`);
    assert.equal(first.props.dangerouslySetInnerHTML.__html, BOUNCE);
  }
  Route.setAppRendered(true);
  for (const status of [401, 410, 302, 303]) {
    const running = Route.authResponseBoundary(new ErrorResponseImpl(status, BOUNCE));
    assert.equal(running.props.status, status, `app running, ${status}: the recovery panel`);
    assert.notEqual(running.type, "div");
  }
  for (const other of [new ErrorResponseImpl(500, "x"), new ErrorResponseImpl(404, "x"), new Error("boom"), null, undefined, "text"]) {
    assert.equal(Route.authResponseBoundary(other), null, "anything else is left to the page's own error handling");
  }
  Route.setAppRendered(false);
});

test("the app layout marks itself rendered and routes its own errors through the same boundary", () => {
  const layout = fs.readFileSync("app/routes/app.jsx", "utf8");
  assert.match(layout, /setAppRendered\(true\)/, "set once the layout has rendered in the browser");
  assert.ok(layout.includes("authResponseBoundary(error) ?? boundary.error(error)"), "an auth response after that gets the recovery panel; everything else is unchanged");
  assert.ok(fs.readFileSync("app/components/merchant-ui.jsx", "utf8").includes("[401, 302, 303, 410].includes(error.status)"), "the statuses Shopify uses for an unusable session");
});

// ======================= the embedded Admin context =======================
const ADMIN = "embedded=1&host=aG9zdA&shop=demo-store.myshopify.com";

test("navigating between the screens keeps embedded, host, shop and locale in the URL, and nothing else", async () => {
  const { element, posted } = appStub({ initial: "/app/settings?" + ADMIN + "&locale=en&days=30&q=hat&id_token=stale.jwt.value" });
  await mount(element);
  await act(() => sleep(20));
  await click(byText("s-button", "Wishlist Settings"));
  await act(() => sleep(40));
  assert.deepEqual(tabs(), ["General", "Product page", "Collection page", "Wishlist page"]);
  assert.match(where(), /^\/app\/wishlist-settings\?/);
  assert.deepEqual(whereParams(), { embedded: "1", host: "aG9zdA", shop: "demo-store.myshopify.com", locale: "en" }, "the Admin context travels; filters from another screen and the stale token do not");

  await click(byText("s-button", "Back to Settings"));
  await act(() => sleep(40));
  assert.match(where(), /^\/app\/settings\?/);
  assert.deepEqual(whereParams(), { embedded: "1", host: "aG9zdA", shop: "demo-store.myshopify.com", locale: "en" }, "and back again");
  assert.deepEqual(posted, [], "navigating submitted no form");
  await unmount();
  restoreConsole();
});

// ======================= the header arrow =======================
// Shopify Admin draws the arrow beside the title from the page's breadcrumb slot. Without a breadcrumb it falls back to
// browser history, which after a direct open or a refresh leads out of the app. The slot must name Settings explicitly.
const arrow = () => container.querySelector('s-page > s-link[slot="breadcrumb-actions"]');

test("header arrow: opened DIRECTLY (no earlier Settings visit) it is an explicit link to Settings and goes there with the Admin context, without history", async () => {
  const { element, posted } = appStub({ initial: "/app/wishlist-settings?" + ADMIN + "&locale=en&id_token=stale.jwt.value" });
  await mount(element);
  await act(() => sleep(40));
  assert.deepEqual(tabs(), ["General", "Product page", "Collection page", "Wishlist page"]);
  const link = arrow();
  assert.ok(link, "the page declares a breadcrumb action, which is the arrow");
  assert.equal(link.getAttribute("href"), "/app/settings");
  const stepped = [];
  const { back, go } = window.history;
  window.history.back = () => stepped.push("back");
  window.history.go = (n) => stepped.push(`go(${n})`);
  const clicked = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  await act(() => link.dispatchEvent(clicked));
  await act(() => sleep(40));
  assert.match(where(), /^\/app\/settings\?/);
  assert.deepEqual(whereParams(), { embedded: "1", host: "aG9zdA", shop: "demo-store.myshopify.com", locale: "en" });
  assert.equal(container.querySelectorAll("s-switch").length, 2, "Settings is on screen");
  assert.equal(clicked.defaultPrevented, true, "the router performs the move, not the browser");
  Object.assign(window.history, { back, go });
  assert.deepEqual(stepped, [], "browser history was never used");
  assert.deepEqual(posted, [], "no form was submitted and no switch was changed");
  await unmount();
  restoreConsole();
});

test("header arrow and the Back to Settings button end up in exactly the same place", async () => {
  const run = async (pick) => {
    const { element, posted } = appStub({ initial: "/app/wishlist-settings?" + ADMIN });
    await mount(element);
    await act(() => sleep(40));
    await click(pick());
    await act(() => sleep(40));
    const result = where();
    assert.deepEqual(posted, []);
    await unmount();
    return result;
  };
  assert.equal(await run(arrow), await run(() => byText("s-button", "Back to Settings")));
  restoreConsole();
});

test("outside Admin (no parameters) the URLs are plain paths, with no stray question mark", async () => {
  const { element } = appStub({ initial: "/app/settings" });
  await mount(element);
  await act(() => sleep(20));
  await click(byText("s-button", "Wishlist Settings"));
  await act(() => sleep(40));
  assert.equal(where(), "/app/wishlist-settings");
  await click(byText("s-button", "Back to Settings"));
  await act(() => sleep(40));
  assert.equal(where(), "/app/settings");
  await unmount();
  restoreConsole();
});

test("the URL the app navigated to still carries what Shopify needs to start the page if it is reloaded", async () => {
  // A full reload inside the Admin iframe (hot reload, a Reload button) requests exactly this URL. Without shop and host,
  // Shopify's session-token page cannot finish and the iframe stays white.
  const { element } = appStub({ initial: "/app/settings?" + ADMIN });
  await mount(element);
  await act(() => sleep(20));
  await click(byText("s-button", "Wishlist Settings"));
  await act(() => sleep(40));
  const params = whereParams();
  assert.ok(params.shop && params.host && params.embedded, "shop, host and embedded are all present");
  await unmount();
  restoreConsole();
});

// ======================= loader =======================
test("opening or refreshing the URL directly works, for a shop with no saved appearance (NULL) and for one with settings", async () => {
  const calls = [];
  globalThis.__kwSettings = { getAppearance: async (shop) => (calls.push(shop), resolveAppearance(null)) }; // what a NULL column resolves to
  const first = appStub();
  await mount(first.element);
  await act(() => sleep(40));
  assert.deepEqual(tabs(), ["General", "Product page", "Collection page", "Wishlist page"]);
  const initialIcon = container.querySelector('s-select[label="Icon"]').getAttribute("value");
  assert.equal(initialIcon, DEFAULT_APPEARANCE.general.iconType, "defaults");
  assert.equal(container.querySelector("[role=tab][aria-selected=true]").textContent, "General");
  assert.equal(container.querySelectorAll("s-button").length >= 3, true);
  assert.deepEqual(validateAppearance(resolveAppearance(null)).errors, {}, "the starting state is valid, so Save is not blocked");
  await unmount();

  // "refresh": a brand-new mount at the same URL, now with a saved appearance
  globalThis.__kwSettings = { getAppearance: async (shop) => (calls.push(shop), resolveAppearance({ general: { iconType: "star" } })) };
  const second = appStub();
  await mount(second.element);
  await act(() => sleep(40));
  assert.equal(container.querySelector('s-select[label="Icon"]').getAttribute("value"), "star");
  assert.deepEqual(calls, ["demo-store.myshopify.com", "demo-store.myshopify.com"], "the authenticated shop is the one that is read");
  await unmount();
  restoreConsole();
});

test("the loader reads the shop from the authenticated session only, never from the URL", async () => {
  const read = [];
  globalThis.__kwAuth = async () => ({ session: { shop: "real-shop.myshopify.com" } });
  globalThis.__kwSettings = { getAppearance: async (shop) => (read.push(shop), resolveAppearance(null)) };
  const result = await Route.loader({ request: new Request("http://localhost/app/wishlist-settings?shop=evil.myshopify.com&shopId=other&host=x") });
  assert.deepEqual(read, ["real-shop.myshopify.com"]);
  assert.deepEqual(result.appearance, DEFAULT_APPEARANCE);
  assert.deepEqual([result.shop, result.apiKey], ["real-shop.myshopify.com", "key123"]);
  restoreConsole();
});

test("a failed login passes straight through: the loader reads nothing and does not turn it into another error", async () => {
  const redirect = new Response(null, { status: 302, headers: { Location: "/auth/login" } });
  let read = 0;
  globalThis.__kwAuth = async () => {
    throw redirect;
  };
  globalThis.__kwSettings = { getAppearance: async () => (read += 1, resolveAppearance(null)) };
  await assert.rejects(Route.loader({ request: new Request("http://localhost/app/wishlist-settings") }), (thrown) => thrown === redirect);
  assert.equal(read, 0);
  assert.deepEqual(logged, [], "and logs no error of its own");
  restoreConsole();
});

test("when the settings cannot be read the loader says so in the log and fails visibly: nothing is swallowed or faked", async () => {
  const failure = Object.assign(new Error("Invalid `prisma.shop.findUnique()` invocation: Unknown field `wishlistAppearance` for select statement on model `ShopSettings`. gid://shopify/Customer/123456789"), { name: "PrismaClientValidationError" });
  globalThis.__kwSettings = { getAppearance: async () => { throw failure; } };
  let thrown;
  try {
    await Route.loader({ request: new Request("http://localhost/app/wishlist-settings") });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "the loader throws; it does not return an empty or default page");
  assert.equal(thrown.type, "DataWithResponseInit", "a response the page can show a specific message for");
  assert.deepEqual([thrown.init.status, thrown.data], [500, { code: "appearance_unavailable" }]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[wishlist-settings\] the appearance settings could not be loaded/);
  assert.match(logged[0], /PrismaClientValidationError/);
  assert.match(logged[0], /demo-store\.myshopify\.com/);
  assert.match(logged[0], /Unknown field/, "the cause is in the log");
  assert.doesNotMatch(logged[0], /123456789/, "long ids are removed from the logged message");
  restoreConsole();
});

// ======================= what the merchant sees =======================
test("if the settings cannot be read the merchant gets a specific message and a Reload button, never a blank page", async () => {
  globalThis.__kwSettings = { getAppearance: async () => { throw Object.assign(new Error("Unknown field"), { name: "PrismaClientValidationError" }); } };
  const { element } = appStub();
  await mount(element);
  await act(() => sleep(40));
  assert.deepEqual(banners(), ["Wishlist Settings could not be loaded"]);
  assert.equal(container.querySelector("s-page").getAttribute("heading"), "Wishlist Settings");
  assert.match(container.querySelector("s-banner").textContent, /switches and your storefront are not affected/);
  assert.ok(byText("s-button", "Reload page"));
  assert.equal(tabs().length, 0, "no half-working form is shown");
  assert.equal(logged.some((line) => /\[wishlist-settings\]/.test(line)), true, "the failure was logged");
  await unmount();
  restoreConsole();
});

test("the error page can always be left: Reload, and Back to Settings with the Admin context kept", async () => {
  globalThis.__kwSettings = { getAppearance: async () => { throw Object.assign(new Error("Unknown field"), { name: "PrismaClientValidationError" }); } };
  const { element } = appStub({ initial: "/app/wishlist-settings?" + ADMIN });
  await mount(element);
  await act(() => sleep(40));
  assert.deepEqual(banners(), ["Wishlist Settings could not be loaded"]);
  assert.ok(byText("s-button", "Reload page"));
  await click(byText("s-button", "Back to Settings"));
  await act(() => sleep(40));
  assert.match(where(), /^\/app\/settings\?/);
  assert.deepEqual(whereParams(), { embedded: "1", host: "aG9zdA", shop: "demo-store.myshopify.com" });
  assert.equal(container.querySelectorAll("s-switch").length, 2, "the Settings screen is usable again after the failed page");
  assert.deepEqual(banners(), [], "and the failure does not follow the merchant");
  await unmount();
  restoreConsole();
});

test("any other unexpected error still shows the standard 'This page could not be loaded' page", async () => {
  globalThis.__kwAuth = async () => {
    throw new Error("something else broke");
  };
  const { element } = appStub();
  await mount(element);
  await act(() => sleep(40));
  assert.deepEqual(banners(), ["This page could not be loaded"]);
  await unmount();
  restoreConsole();
});

// ======================= action =======================
test("saving still works through the route action, writes only through saveAppearance for the session's shop, and a failed write is reported and logged", async () => {
  const saved = [];
  globalThis.__kwAuth = async () => ({ session: { shop: "real-shop.myshopify.com" } });
  globalThis.__kwSettings = { saveAppearance: async (shop, input) => (saved.push([shop, input]), { ok: true, errors: {}, appearance: resolveAppearance(null) }) };
  const body = new URLSearchParams({ appearance: JSON.stringify(DEFAULT_APPEARANCE), shop: "evil.myshopify.com" });
  const ok = await Route.action({ request: new Request("http://localhost/app/wishlist-settings?shop=evil.myshopify.com", { method: "POST", body }) });
  assert.equal(ok.ok, true);
  assert.deepEqual(saved.map(([shop]) => shop), ["real-shop.myshopify.com"], "the shop comes from the session, not the form or URL");

  const missing = await Route.action({ request: new Request("http://localhost/app/wishlist-settings", { method: "POST", body: new URLSearchParams({}) }) });
  assert.equal(missing.ok, false);
  assert.equal(saved.length, 1, "nothing saved without an appearance field");

  globalThis.__kwSettings = { saveAppearance: async () => { throw Object.assign(new Error("connection lost"), { name: "PrismaClientInitializationError" }); } };
  const failed = await Route.action({ request: new Request("http://localhost/app/wishlist-settings", { method: "POST", body }) });
  assert.deepEqual([failed.ok, failed.failed], [false, true], "reported as not saved, never as a success");
  assert.equal(logged.some((line) => /could not be saved/.test(line) && /PrismaClientInitializationError/.test(line)), true, "and logged");
  restoreConsole();
});
