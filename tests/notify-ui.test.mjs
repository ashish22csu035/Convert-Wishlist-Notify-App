// Tests for Notify Me on the product page (the theme's own Add to cart button) and the
// logged-out login round trip.
//
// Run: node --test tests/notify-ui.test.mjs
//
// The real konvert-wishlist.js and konvert-wishlist-extras.js run in a node:vm context
// against a stub DOM shaped like a Dawn product form, with stub product JSON and a stub
// notify endpoint. A real theme, real browser, real variant picker and Shopify's login
// pages are NOT exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { Dom, el, tick } from "./helpers/dom.mjs";

const MAIN = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.js", "utf8");
const EXTRAS = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

const PRODUCT = {
  id: 101, title: "Snowboard", handle: "board", featured_image: null, available: true, price: 5000,
  variants: [
    { id: 1001, title: "Small", available: false, price: 5000 },
    { id: 1002, title: "Medium", available: true, price: 5000 },
    { id: 1003, title: "Large", available: false, price: 5500 },
  ],
};

async function mount({
  loggedIn = true, notifyEnabled = true, pageType = "product", selected = "1001",
  browser = new Map(), notify = {}, productFails = false, path = "/products/board",
  subscribed = new Set(), statusFails = false, statusGate = null, textOverride = {},
  stock = {}, productGate = null, statusGates = {}, features = undefined,
} = {}) {
  const body = new Dom("body");
  const head = new Dom("head");
  const config = el("script", "", { "data-kw-config": "" });
  config.textContent = JSON.stringify({
    loggedIn, apiPath: "/apps/konvert-notify/api/wishlist", notifyPath: "/apps/konvert-notify/api/notify",
    notifyEnabled, productHandle: pageType === "product" ? "board" : null, pageType,
    ...(features !== undefined ? { featuresPath: "/apps/konvert-notify/api/features" } : {}),
    loginUrl: "/customer_authentication/login", extrasUrl: "https://cdn.example/extras.js",
    text: {
      loginPrompt: "Log in to save.", loginLink: "Log in", close: "Close", error: "Something went wrong.",
      addToCart: "Add to cart", notifyMe: "Notify Me", notifySubscribed: "You're on the list!",
      notifySuccess: "You're on the list!", notifyAvailable: "Good news: back in stock.",
      notifyEmailError: "No email address on your account.", notifyUnavailable: "Notifications are not available right now.", notifyError: "Could not set up notification.",
      notifyLoginRedirect: "Please log in to be notified.", notifyLoginStillRequired: "Please log in to finish.",
      ...textOverride,
    },
  });
  body.appendChild(config);

  const main = body.appendChild(el("main", "", { id: "MainContent" }));
  const section = main.appendChild(el("section", "product"));
  const form = section.appendChild(el("form", "", { action: "/cart/add" }));
  const input = form.appendChild(el("input", "", { name: "id" }));
  input.value = selected;
  // Dawn: <button name="add" type="submit"><span>label</span><div class="loading__spinner"><span class="spinner-inner"/></div></button>
  const addButton = form.appendChild(el("button", "product-form__submit", { name: "add", type: "submit" }));
  const addLabel = addButton.appendChild(el("span", ""));
  const spinner = addButton.appendChild(el("div", "loading__spinner"));
  spinner.appendChild(el("span", "spinner-inner"));
  const payment = form.appendChild(el("div", "shopify-payment-button"));
  const buyNow = payment.appendChild(el("button", "", { type: "submit" }));
  buyNow.textContent = "Buy it now";
  const themeLabel = (id) => (PRODUCT.variants.find((v) => String(v.id) === String(id))?.available ? "Add to cart" : "Sold out");
  const themeRender = () => {
    addLabel.textContent = themeLabel(input.value);
    addButton.disabled = themeLabel(input.value) === "Sold out";
  };
  themeRender();

  const flags = { productFails: false };
  const rootClasses = new Set();
  const log = { notify: [], status: [], toasts: [], assigned: [], productFetches: [], submits: 0, features: 0 };
  const listeners = {};
  const observers = [];
  const baseAppend = Dom.prototype.appendChild;
  body.appendChild = (node) => {
    baseAppend.call(body, node);
    if (node.has && node.has("kw-toast")) log.toasts.push(node.children[0].textContent.trim());
    return node;
  };
  const win = {
    location: { origin: "https://shop.example", pathname: path, search: `?variant=${selected}`, assign: (u) => log.assigned.push(u) },
    Shopify: { routes: { root: "/" }, currency: { active: "USD" } },
    sessionStorage: { getItem: (k) => (browser.has(k) ? browser.get(k) : null), setItem: (k, v) => browser.set(k, String(v)), removeItem: (k) => browser.delete(k) },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    console: { warn() {}, log() {} },
    MutationObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
    addEventListener: (type, fn) => (listeners[`window:${type}`] ||= []).push(fn),
  };
  const document = {
    readyState: "complete", documentElement: { lang: "en", classList: { add: (name) => rootClasses.add(name) } }, body, head,
    createElement: (tag) => {
      const node = new Dom(tag);
      if (tag === "script") Object.defineProperty(node, "src", { set(v) { node._src = v; }, get: () => node._src });
      return node;
    },
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
    dispatchEvent() {},
  };

  async function fetchStub(url, init = {}) {
    if (url === "/apps/konvert-notify/api/features") {
      log.features += 1;
      if (features === null) return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
      return { ok: true, status: 200, json: async () => features };
    }
    if (url === "/apps/konvert-notify/api/wishlist") {
      return { ok: true, status: 200, json: async () => ({ loggedIn, items: [], count: 0 }) };
    }
    if (url.startsWith("/apps/konvert-notify/api/notify") && (init.method || "GET") === "GET") {
      // the server's own record of who is subscribed (persists across mounts, like a page reload)
      log.status.push(url);
      if (statusGate) await statusGate;
      const asked = new URL(url, "https://x.test").searchParams.get("ids");
      if (statusGates[asked]) await statusGates[asked];
      if (statusFails) return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
      const ids = new URL(url, "https://x.test").searchParams.get("ids").split(",");
      return { ok: true, status: 200, json: async () => ({ subscribed: ids.filter((id) => subscribed.has(id)) }) };
    }
    if (url === "/apps/konvert-notify/api/notify") {
      const payload = JSON.parse(init.body);
      log.notify.push(payload);
      if (notify.error) return { ok: false, status: notify.status ?? 500, json: async () => ({ error: notify.error }) };
      const changed = !subscribed.has(String(payload.variantId));
      subscribed.add(String(payload.variantId));
      return { ok: true, status: 200, json: async () => ({ ok: true, subscribed: true, changed }) };
    }
    if (/products\/board\.js/.test(url)) {
      log.productFetches.push({ url, cache: init.cache });
      if (productFails || flags.productFails) return { ok: false, status: 500, json: async () => ({}) };
      // The first product request can be held back to simulate a slow response.
      if (productGate && log.productFetches.length === 1) await productGate;
      // `stock` is what the storefront currently says per variant (mutable, like a restock).
      const live = { ...PRODUCT, variants: PRODUCT.variants.map((v) => ({ ...v, available: String(v.id) in stock ? stock[String(v.id)] : v.available })) };
      return { ok: true, status: 200, json: async () => live };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const context = vm.createContext({
    window: win, document, fetch: fetchStub, URL, URLSearchParams, Promise, Map, JSON, Error, Date, parseInt, RegExp, Boolean, String, Number, Object, Array, Intl,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, console, Math, MutationObserver: win.MutationObserver,
  });
  head.appendChild = (node) => {
    baseAppend.call(head, node);
    if (node.tag === "script") setTimeout(() => { vm.runInContext(EXTRAS, context); node.onload?.(); }, 0);
    return node;
  };
  vm.runInContext(MAIN, context);
  await settle();

  // A click goes to every capture listener in registration order, stopping at stopImmediatePropagation,
  // and the "default action" (form submit) only happens if nobody prevented it.
  const click = async (target = addButton) => {
    const event = {
      target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      stopImmediatePropagation() { this.stopped = true; },
    };
    for (const fn of listeners.click || []) {
      if (event.stopped) break;
      fn(event);
    }
    if (!event.defaultPrevented && !target.disabled) log.submits += 1;
    await settle();
    return event;
  };
  // Simpler themes update the same nodes when the variant changes (Dawn swaps the form), then signal.
  const selectVariant = async (id) => {
    input.value = String(id);
    themeRender();
    for (const fn of listeners.change || []) fn({ target: input });
    observers.forEach((cb) => cb());
    await tick(120);
  };
  const state = () => ({
    label: addLabel.textContent, disabled: addButton.disabled, notify: addButton.hasAttribute("data-kw-notify"),
  });
  return { rootClasses, buyNow, failProducts: () => (flags.productFails = true), body, form, input, addButton, addLabel, log, browser, click, selectVariant, state, listeners, observers, themeRender, win };
}

test("a sold-out selected variant turns the theme's Add to cart button into Notify Me", async () => {
  const page = await mount({ selected: "1001" });
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true });
  assert.equal(page.form.querySelectorAll("button").length, 2, "no extra button was added (Add to cart + the theme's own Buy it now)");
  assert.equal(page.log.productFetches[0].cache, "no-store", "availability comes from fresh product JSON");
});

test("an available selected variant keeps Add to cart untouched", async () => {
  const page = await mount({ selected: "1002" });
  assert.deepEqual(page.state(), { label: "Add to cart", disabled: false, notify: false });
  const event = await page.click();
  assert.equal(event.defaultPrevented, false, "the theme's add-to-cart still runs");
  assert.equal(page.log.notify.length, 0);
});

test("switching variants updates the button, and the click always uses the variant selected right now", async () => {
  const page = await mount({ selected: "1001" });
  await page.selectVariant("1002");
  assert.deepEqual(page.state(), { label: "Add to cart", disabled: false, notify: false });
  await page.selectVariant("1003");
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true });
  await page.click();
  assert.deepEqual(page.log.notify, [{ op: "subscribe", variantId: "1003", storefrontSoldOut: true }]);
  assert.equal(page.state().label, "You're on the list!");
  assert.equal(page.state().disabled, true);

  await page.selectVariant("1001");
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true }, "another sold-out variant is not subscribed yet");
  await page.selectVariant("1002");
  assert.deepEqual(page.state(), { label: "Add to cart", disabled: false, notify: false });
});

test("repeated syncs are stable (the observer cannot loop or flip the label)", async () => {
  const page = await mount({ selected: "1001" });
  for (let i = 0; i < 5; i += 1) page.observers.forEach((cb) => cb());
  await tick(120);
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true });
});

test("clicking Notify Me posts only the exact variant id, blocks the cart submit, and confirms", async () => {
  const page = await mount({ selected: "1001" });
  const event = await page.click();
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.log.submits, 0, "the form was not submitted to /cart/add");
  assert.deepEqual(page.log.notify, [{ op: "subscribe", variantId: "1001", storefrontSoldOut: true }], "no email, customer or shop in the body");
  assert.equal(page.log.toasts.at(-1), "You're on the list!");
  assert.equal(page.state().label, "You're on the list!");
});

test("duplicate clicks send one request", async () => {
  const page = await mount({ selected: "1001" });
  await Promise.all([page.click(), page.click(), page.click()]);
  await page.click();
  assert.equal(page.log.notify.length, 1);
});

test("the form cannot be submitted around the takeover (Enter key / requestSubmit)", async () => {
  const page = await mount({ selected: "1001" });
  let prevented = false;
  for (const fn of page.listeners.submit || []) fn({ target: page.form, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  assert.equal(prevented, true);
});

test("backend rejections are shown and never reported as a success", async () => {
  for (const [error, status, expected] of [
    ["customer_data_unavailable", 403, /not available right now/i],
    ["customer_email_unavailable", 422, /email address/i],
    ["customer_not_found", 404, /email address/i],
    ["shop_unavailable", 503, /could not set up/i],
    ["server_error", 500, /could not set up/i],
  ]) {
    const page = await mount({ selected: "1001", notify: { error, status } });
    await page.click();
    assert.match(page.log.toasts.at(-1), expected, error);
    assert.equal(page.log.toasts.some((t) => /on the list/i.test(t)), false, error);
    assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true }, `${error}: can be retried`);
  }
});

test("if the server says the variant is available AND the storefront now agrees (a restock), the button goes back to Add to cart", async () => {
  const stock = {};
  const page = await mount({ selected: "1001", stock, notify: { error: "variant_available", status: 409 } });
  assert.equal(page.state().label, "Notify Me");
  stock["1001"] = true; // restocked after the page loaded
  await page.click();
  assert.equal(page.log.productFetches.length, 2, "availability was fetched again");
  assert.match(page.log.productFetches.at(-1).cache, /^no-(store|cache)$/, "and never served from a stale cache");
  assert.match(page.log.toasts.at(-1), /back in stock/i);
  assert.deepEqual(page.state(), { label: "Add to cart", disabled: false, notify: false });
});

test("if the server says 'available' but the storefront still says sold out, the sold-out button is handed back and Add to cart is never shown", async () => {
  // This is the 3p-fulfilled-snowboard situation: Shopify Admin data says sellable, the storefront says Sold out.
  const page = await mount({ selected: "1001", notify: { error: "variant_available", status: 409 } });
  assert.equal(page.state().label, "Notify Me");
  await page.click();
  assert.equal(page.log.notify.length, 1);
  assert.deepEqual(page.state(), { label: "Sold out", disabled: true, notify: false }, "exactly the theme's own sold-out button");
  assert.match(page.log.toasts.at(-1), /couldn't confirm that this item is out of stock/i);
  assert.equal(page.log.toasts.some((t) => /on the list|back in stock/i.test(t)), false, "no success and no 'in stock' claim");

  // Later syncs (theme events, DOM changes, switching away and back) must not take the button over again.
  for (let i = 0; i < 3; i += 1) page.observers.forEach((cb) => cb());
  await tick(120);
  assert.deepEqual(page.state(), { label: "Sold out", disabled: true, notify: false });
  await page.selectVariant("1002");
  assert.deepEqual(page.state(), { label: "Add to cart", disabled: false, notify: false });
  await page.selectVariant("1001");
  assert.deepEqual(page.state(), { label: "Sold out", disabled: true, notify: false });
  assert.equal(page.log.notify.length, 1, "and nothing more was sent");
});

test("a recheck that cannot reach the storefront still never shows Add to cart", async () => {
  const page = await mount({ selected: "1001", notify: { error: "variant_available", status: 409 } });
  page.failProducts();
  await page.click();
  assert.deepEqual(page.state(), { label: "Sold out", disabled: true, notify: false });
});

test("the theme's Buy it now button is never touched, and only the Notify Me button's submit is blocked", async () => {
  const page = await mount({ selected: "1001" });
  assert.equal(page.buyNow.textContent, "Buy it now");
  assert.equal(page.buyNow.disabled, false);
  let prevented = 0;
  const fire = (submitter) => (page.listeners.submit || []).forEach((fn) => fn({ target: page.form, submitter, preventDefault() { prevented += 1; }, stopImmediatePropagation() {} }));
  fire(page.buyNow);
  assert.equal(prevented, 0, "a submit from Buy it now goes through");
  fire(page.addButton);
  assert.equal(prevented, 1, "a submit from the Notify Me button is stopped");
  assert.equal(page.buyNow.textContent, "Buy it now");
});

test("a slow product response cannot overwrite the variant selected meanwhile", async () => {
  let release;
  const productGate = new Promise((resolve) => (release = resolve));
  const page = await mount({ selected: "1001", productGate });
  assert.equal(page.state().label, "Sold out", "the product data is still on its way: the theme's button is untouched");
  await page.selectVariant("1002"); // the customer picks an in-stock variant before the data arrives
  release();
  await tick(120);
  assert.deepEqual(page.state(), { label: "Add to cart", disabled: false, notify: false }, "judged by the variant selected NOW, not the one selected at page load");
  await page.selectVariant("1001");
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true });
});

test("a late status answer for the previous variant cannot change the newly selected variant", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const page = await mount({ selected: "1001", subscribed: new Set(["1001"]), statusGates: { 1001: gate } });
  assert.equal(page.state().disabled, true, "waiting for 1001's status");
  await page.selectVariant("1003"); // the customer moves on while 1001's answer is still pending
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true }, "1003 is judged on its own status");
  release(); // the old answer ("1001 is subscribed") arrives late
  await tick(80);
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true }, "1003 is still unsubscribed");
  await page.selectVariant("1001");
  assert.deepEqual(page.state(), { label: "You're on the list!", disabled: true, notify: true }, "1001 keeps its own state");
});

test("a 401 from the server asks the customer to log in and shows no success", async () => {
  const page = await mount({ selected: "1001", notify: { error: "login_required", status: 401 } });
  await page.click();
  assert.equal(page.log.toasts.at(-1), "Log in to save. Log in");
});

test("Notify Me is off when the setting is off, on other page types, or when product data cannot load", async () => {
  const off = await mount({ selected: "1001", notifyEnabled: false });
  assert.equal(off.state().label, "Sold out");
  assert.equal(off.log.productFetches.length, 0);
  const other = await mount({ selected: "1001", pageType: "collection" });
  assert.equal(other.log.productFetches.length, 0);
  const broken = await mount({ selected: "1001", productFails: true });
  assert.deepEqual(broken.state(), { label: "Sold out", disabled: true, notify: false }, "theme left exactly as it was");
});

// ---- logged out ------------------------------------------------------------------
test("logged-out click remembers only the product handle and variant id and goes to the store login", async () => {
  const page = await mount({ loggedIn: false, selected: "1003" });
  assert.equal(page.state().label, "Notify Me");
  await page.click();
  assert.equal(page.log.notify.length, 0, "nothing is sent while logged out");
  const stored = JSON.parse(page.browser.get("kw:pending-notify"));
  assert.deepEqual(Object.keys(stored).sort(), ["h", "t", "v"]);
  assert.equal(stored.h, "board");
  assert.equal(stored.v, "1003");
  assert.equal(page.log.assigned.length, 1);
  assert.equal(page.log.assigned[0], "/customer_authentication/login?return_url=" + encodeURIComponent("/products/board?variant=1003"));
});

test("after login the remembered variant is subscribed once, the intent is cleared, and a reload does not repeat it", async () => {
  const browser = new Map([["kw:pending-notify", JSON.stringify({ h: "board", v: "1003", t: Date.now() })]]);
  const page = await mount({ loggedIn: true, selected: "1001", browser });
  assert.deepEqual(page.log.notify, [{ op: "subscribe", variantId: "1003", storefrontSoldOut: true }], "the exact remembered variant, not whatever is selected now");
  assert.equal(browser.has("kw:pending-notify"), false);
  assert.match(page.log.toasts.at(-1), /on the list/i);
  const again = await mount({ loggedIn: true, selected: "1001", browser });
  assert.equal(again.log.notify.length, 0);
});

test("a failed restore shows the error and is not retried on reload", async () => {
  const browser = new Map([["kw:pending-notify", JSON.stringify({ h: "board", v: "1003", t: Date.now() })]]);
  const page = await mount({ loggedIn: true, browser, notify: { error: "customer_data_unavailable", status: 403 } });
  assert.equal(page.log.notify.length, 1);
  assert.match(page.log.toasts.at(-1), /not available right now/i);
  assert.equal(browser.has("kw:pending-notify"), false);
});

test("still logged out after the login round trip: nothing is sent and the intent waits", async () => {
  const browser = new Map([["kw:pending-notify", JSON.stringify({ h: "board", v: "1003", t: Date.now() })]]);
  const page = await mount({ loggedIn: false, browser });
  assert.equal(page.log.notify.length, 0);
  assert.match(page.log.toasts.at(-1), /log in to finish/i);
  assert.equal(browser.has("kw:pending-notify"), true);
});

test("forged, expired or other-product intents never subscribe", async () => {
  for (const intent of [
    { h: "board", v: "abc", t: Date.now() },
    { h: "board", v: "1003", t: Date.now() - 31 * 60 * 1000 },
    { h: "../x", v: "1003", t: Date.now() },
    { h: "board", v: null, t: Date.now() },
  ]) {
    const browser = new Map([["kw:pending-notify", JSON.stringify(intent)]]);
    const page = await mount({ loggedIn: true, browser });
    assert.equal(page.log.notify.length, 0, JSON.stringify(intent));
    assert.equal(browser.has("kw:pending-notify"), false, "bad intents are removed");
  }
  const other = new Map([["kw:pending-notify", JSON.stringify({ h: "different-product", v: "1003", t: Date.now() })]]);
  const page = await mount({ loggedIn: true, browser: other });
  assert.equal(page.log.notify.length, 0, "an intent for another product is not run on this page");
});

// ---- persistent subscription state (the server is the source of truth) ---------------
const askedIds = (page) => page.log.status.map((u) => new URL(u, "https://x.test").searchParams.get("ids"));

test("after subscribing, a reload shows the on-the-list state from the server and offers no second request", async () => {
  const subscribed = new Set();
  const first = await mount({ selected: "1001", subscribed });
  await first.click();
  assert.equal(first.state().label, "You're on the list!");
  assert.equal(first.log.notify.length, 1);

  // A reload: brand-new page, brand-new browser storage; only the server remembers.
  const second = await mount({ selected: "1001", subscribed, browser: new Map() });
  assert.deepEqual(askedIds(second), ["1001"], "the server was asked about the selected variant");
  assert.deepEqual(second.state(), { label: "You're on the list!", disabled: true, notify: true });
  await second.click();
  assert.equal(second.log.notify.length, 0, "no new subscription request");
  assert.equal(second.browser.size, 0, "nothing about the subscription was kept in the browser");
});

test("a different variant stays unsubscribed, including after switching variants", async () => {
  const subscribed = new Set(["1001"]);
  const page = await mount({ selected: "1003", subscribed });
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true });
  await page.selectVariant("1001");
  assert.deepEqual(page.state(), { label: "You're on the list!", disabled: true, notify: true });
  await page.selectVariant("1003");
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true });
  await page.selectVariant("1002");
  assert.deepEqual(page.state(), { label: "Add to cart", disabled: false, notify: false });
  assert.deepEqual(askedIds(page), ["1003", "1001"], "each variant is asked about once");
});

test("the button is locked while the server is still being asked, so no early duplicate request", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const page = await mount({ selected: "1001", subscribed: new Set(["1001"]), statusGate: gate });
  assert.equal(page.state().disabled, true);
  await page.click();
  assert.equal(page.log.notify.length, 0);
  release();
  await tick(60);
  assert.deepEqual(page.state(), { label: "You're on the list!", disabled: true, notify: true });
});

test("if the status cannot be loaded the customer is NOT shown as subscribed and can still use Notify Me", async () => {
  const page = await mount({ selected: "1001", subscribed: new Set(["1001"]), statusFails: true });
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true }, "no false claim");
  await page.click();
  assert.equal(page.log.notify.length, 1, "the server decides (it never duplicates a subscription)");
  assert.equal(page.log.toasts.at(-1), "You're on the list!", "success shown only after the server confirmed");
});

test("a logged-out visitor triggers no status request", async () => {
  const page = await mount({ loggedIn: false, selected: "1001" });
  assert.equal(page.log.status.length, 0);
  assert.deepEqual(page.state(), { label: "Notify Me", disabled: false, notify: true });
});

test("a failed subscription never shows the on-the-list state, even after a reload", async () => {
  const subscribed = new Set();
  const failing = await mount({ selected: "1001", subscribed, notify: { error: "customer_data_unavailable", status: 403 } });
  await failing.click();
  assert.deepEqual(failing.state(), { label: "Notify Me", disabled: false, notify: true });
  assert.equal(failing.log.toasts.some((t) => /on the list/i.test(t)), false);
  const reload = await mount({ selected: "1001", subscribed });
  assert.deepEqual(reload.state(), { label: "Notify Me", disabled: false, notify: true });
});

test("Shopify's HTML-escaped apostrophes in the translated text are shown as plain text", async () => {
  const page = await mount({ selected: "1001", subscribed: new Set(["1001"]), textOverride: { notifySubscribed: "You&#39;re on the list!" } });
  assert.equal(page.state().label, "You're on the list!");
  assert.equal(page.state().label.includes("&"), false);
});

// ======================= merchant switches (Settings) =======================
test("Notify Me switched off in Settings: the theme's Add to cart button is left alone and nothing is requested", async () => {
  const page = await mount({ features: { wishlist: true, notifyMe: false } });
  assert.equal(page.log.features, 1, "the switches were read once");
  assert.deepEqual(page.state(), { label: "Sold out", disabled: true, notify: false }, "no Notify Me takeover");
  assert.equal(page.log.status.length, 0, "no status request");
  await page.click();
  assert.equal(page.log.notify.length, 0, "no subscription request");
  assert.equal(page.rootClasses.has("kw-wishlist-off"), false, "Wishlist is unaffected");
});

test("Notify Me switched on in Settings behaves as before", async () => {
  const page = await mount({ features: { wishlist: true, notifyMe: true } });
  assert.equal(page.state().notify, true);
  await page.click();
  assert.deepEqual(page.log.notify, [{ op: "subscribe", variantId: "1001", storefrontSoldOut: true }]);
  assert.match(page.log.toasts.at(-1), /on the list/);
});

test("Wishlist switched off in Settings hides the Wishlist interface and leaves Notify Me working", async () => {
  const page = await mount({ features: { wishlist: false, notifyMe: true } });
  assert.equal(page.rootClasses.has("kw-wishlist-off"), true, "the theme CSS hides every Wishlist element");
  assert.equal(page.win.KonvertWishlist.config.wishlistOff, true);
  assert.equal(page.win.KonvertWishlist.config.headerIcon || false, false);
  assert.equal(page.state().notify, true, "Notify Me still takes over the sold-out button");
});

test("if the switches cannot be read nothing is hidden: the server still enforces them on every write", async () => {
  const page = await mount({ features: null });
  assert.equal(page.log.features, 1);
  assert.equal(page.rootClasses.has("kw-wishlist-off"), false);
  assert.equal(page.state().notify, true);
});

test("a stale page whose Notify Me was switched off meanwhile gets a truthful message, never a success", async () => {
  const page = await mount({ features: { wishlist: true, notifyMe: true }, notify: { error: "feature_disabled", status: 403 } });
  await page.click();
  assert.equal(page.log.notify.length, 1);
  assert.equal(page.log.toasts.at(-1), "Notifications are not available right now.");
  assert.equal(page.log.toasts.some((t) => /on the list/.test(t)), false);
});

test("clicking Notify Me on a sold-out variant tells the server the page shows it sold out, and the subscribed state then survives a reload", async () => {
  const subscribed = new Set();
  const first = await mount({ subscribed });
  await first.click();
  assert.deepEqual(first.log.notify, [{ op: "subscribe", variantId: "1001", storefrontSoldOut: true }]);
  assert.match(first.log.toasts.at(-1), /on the list/);
  // a reload: a fresh page, the server's own record is the only memory
  const reloaded = await mount({ subscribed });
  assert.match(reloaded.state().label, /on the list/i, "the persisted subscription is shown, not the Notify Me button");
  assert.equal(reloaded.log.notify.length, 0, "and no second request is made");
});
