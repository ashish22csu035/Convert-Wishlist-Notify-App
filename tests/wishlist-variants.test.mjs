// Tests for variant-specific wishlist hearts (collection cards and the product page).
//
// Run: node --test tests/wishlist-variants.test.mjs
//
// The real konvert-wishlist.js and konvert-wishlist-extras.js run in a node:vm context
// against a stub DOM, a stub wishlist API (the signed-in customer's list, kept per
// variant) and stub product JSON. Real variant pickers, themes and the Shopify login
// pages are not exercised here.
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

// Product JSON as the storefront serves it. Variant order is Shopify's own. A collection card saves
// the FIRST variant in this order, whether or not it is in stock.
const PRODUCTS = {
  board: {
    id: 101, title: "Snowboard", handle: "board", featured_image: null, available: true, price: 5000,
    variants: [
      { id: 1001, title: "Small", available: false, price: 5000 },   // the FIRST variant, and it is sold out
      { id: 1002, title: "Medium", available: true, price: 5000 },   // a later variant that is in stock
      { id: 1003, title: "Large", available: true, price: 5500 },
    ],
  },
  mug: {
    id: 102, title: "Mug", handle: "mug", featured_image: null, available: true, price: 900,
    variants: [{ id: 2001, title: "Default Title", available: true, price: 900 }],
  },
  tee: {
    id: 104, title: "Tee", handle: "tee", featured_image: null, available: true, price: 2000,
    variants: [{ id: 4001, title: "S", available: true, price: 2000 }, { id: 4002, title: "M", available: true, price: 2000 }, { id: 4003, title: "L", available: false, price: 2000 }],
  },
  soldout: {
    id: 103, title: "Sold Out Thing", handle: "soldout", featured_image: null, available: false, price: 700,
    variants: [{ id: 3001, title: "A", available: false, price: 700 }, { id: 3002, title: "B", available: false, price: 700 }],
  },
};

function productCard(handle) {
  const li = el("li", "grid__item");
  const wrapper = li.appendChild(el("div", "card-wrapper"));
  const card = wrapper.appendChild(el("div", "card"));
  const inner = card.appendChild(el("div", "card__inner"));
  inner.appendChild(el("img", "", { src: `/${handle}.jpg` }));
  card.appendChild(el("div", "card__content")).appendChild(el("h3", "card__heading")).appendChild(el("a", "", { href: `/products/${handle}` }));
  return li;
}

// page: "collection" or "index" (the home page): the same product cards; or "product" (the board's page)
// backend: the signed-in customer's saved items, mutated by the stub API (survives remounts)
async function mount({ page = "collection", loggedIn = true, backend = { items: [] }, browser = new Map(), selected = "1002" } = {}) {
  const body = new Dom("body");
  const head = new Dom("head");
  const config = el("script", "", { "data-kw-config": "" });
  config.textContent = JSON.stringify({
    loggedIn, apiPath: "/apps/konvert-notify/api/wishlist", loginUrl: "/account/login",
    extrasUrl: "https://cdn.example/extras.js", headerIcon: false, collectionCards: page !== "product",
    pageType: page, text: { add: "Add to wishlist", saved: "Saved to wishlist", error: "Something went wrong.", loginLink: "Log in", close: "Close", loginPrompt: "Log in to save.", noVariantToSave: "Unavailable right now." },
  });
  body.appendChild(config);

  const main = body.appendChild(el("main", "", { id: "MainContent" }));
  let formInput = null;
  let productButton = null;
  if (page === "collection" || page === "index") {
    const grid = main.appendChild(el("section", "", { id: "shopify-section-featured_collection" })).appendChild(el("ul", page === "index" ? "grid product-grid slider" : "grid"));
    for (const handle of ["board", "mug", "tee", "soldout"]) grid.appendChild(productCard(handle));
  } else {
    const section = main.appendChild(el("section", "product"));
    const form = section.appendChild(el("form", "", { action: "/cart/add" }));
    formInput = form.appendChild(el("input", "", { name: "id" }));
    formInput.value = selected;
    productButton = section.appendChild(el("button", "kw-btn kw-btn--product", { "data-kw-button": "", "data-kw-product-id": "101", "data-kw-handle": "board", "data-kw-title": "Snowboard", "data-kw-variant-id": "1002", "aria-pressed": "false" }));
    productButton.appendChild(el("span", "kw-heart"));
    const label = productButton.appendChild(el("span", ""));
    label.attrs["data-kw-label"] = "";
    label.textContent = "Add to wishlist";
  }

  const log = { requests: [], toasts: [], assigned: [] };
  const listeners = {};
  const toastAppend = Dom.prototype.appendChild;
  body.appendChild = (node) => {
    toastAppend.call(body, node);
    if (node.has && node.has("kw-toast")) log.toasts.push(node.children[0].textContent.trim());
    return node;
  };
  const observers = [];
  const subscribers = [];
  const win = {
    location: { origin: "https://shop.example", pathname: page === "product" ? "/products/board" : page === "index" ? "/" : "/collections/all", search: "", assign: (u) => log.assigned.push(u) },
    Shopify: { routes: { root: "/" }, currency: { active: "USD" } },
    sessionStorage: { getItem: (k) => (browser.has(k) ? browser.get(k) : null), setItem: (k, v) => browser.set(k, String(v)), removeItem: (k) => browser.delete(k) },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    console: { warn() {}, log() {} },
    getComputedStyle: (node) => ({ position: node.style.position ?? "static", visibility: "visible", display: "block", gridTemplateColumns: "" }),
    MutationObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
    addEventListener: (type, fn) => (listeners[`window:${type}`] ||= []).push(fn),
  };
  const document = {
    readyState: "complete", documentElement: { lang: "en", clientWidth: 400 }, body, head,
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

  const listItems = () => backend.items.map((i) => ({ productId: i.productId, variantId: i.variantId, title: i.title, handle: i.handle }));
  async function fetchStub(url, init = {}) {
    if (url === "/apps/konvert-notify/api/wishlist") {
      const method = init.method || "GET";
      if (method === "GET") return { ok: true, status: 200, json: async () => ({ loggedIn, items: loggedIn ? listItems() : [], count: backend.items.length }) };
      const payload = JSON.parse(init.body);
      log.requests.push(payload);
      if (!loggedIn) return { ok: false, status: 401, json: async () => ({ error: "login_required" }) };
      if (payload.op === "add") {
        if (!payload.variantId) return { ok: false, status: 400, json: async () => ({ error: "invalid_request" }) };
        if (!backend.items.some((i) => i.variantId === String(payload.variantId))) {
          backend.items.push({ productId: String(payload.productId), variantId: String(payload.variantId), title: payload.title, handle: payload.handle });
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, saved: true }) };
      }
      if (payload.op === "remove") {
        backend.items = backend.items.filter((i) => i.variantId !== String(payload.variantId));
        return { ok: true, status: 200, json: async () => ({ ok: true, saved: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    const handle = /products\/([^./?]+)\.js/.exec(url)?.[1];
    if (handle && PRODUCTS[handle]) return { ok: true, status: 200, json: async () => PRODUCTS[handle] };
    return { ok: false, status: 404, json: async () => ({}) };
  }

  const context = vm.createContext({
    window: win, document, fetch: fetchStub, URL, URLSearchParams, Promise, Map, JSON, Error, Date, parseInt, RegExp, Boolean, String, Number, Object, Array, Intl,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, console, Math, MutationObserver: win.MutationObserver,
    subscribe: (name, cb) => subscribers.push({ name, cb }),
    PUB_SUB_EVENTS: { variantChange: "variant-change" },
  });
  head.appendChild = (node) => {
    Dom.prototype.appendChild.call(head, node);
    if (node.tag === "script") setTimeout(() => { vm.runInContext(EXTRAS, context); node.onload?.(); }, 0);
    return node;
  };
  vm.runInContext(MAIN, context);
  await settle();

  const heart = (handle) => body.querySelectorAll(".kw-btn--card").find((b) => b.getAttribute("data-kw-handle") === handle);
  const click = async (button) => {
    for (const fn of listeners.click || []) fn({ target: button, preventDefault() {}, stopPropagation() {} });
    await settle();
  };
  // pick another variant the way themes do: update the form's id input, then signal
  const selectVariant = async (id, how = "change") => {
    formInput.value = String(id);
    if (how === "change") for (const fn of listeners.change || []) fn({ target: formInput });
    if (how === "mutation") observers.forEach((cb) => cb());
    if (how === "pubsub") subscribers.forEach((s) => s.cb());
    if (how === "popstate") (listeners["window:popstate"] || []).forEach((fn) => fn());
    await tick(120);
  };
  return { body, log, backend, browser, heart, click, selectVariant, productButton, formInput, listeners, observers, subscribers, context, config, win, toasts: () => log.toasts };
}

const posts = (page) => page.log.requests;
const pressed = (button) => button.getAttribute("aria-pressed") === "true";

// ---- collection hearts: the first AVAILABLE variant ---------------------------------------
test("a collection heart saves the product's FIRST variant even when it is sold out and a later variant is in stock", async () => {
  const page = await mount();
  await page.click(page.heart("board"));
  assert.deepEqual(posts(page).map((p) => ({ op: p.op, variantId: p.variantId, productId: p.productId })), [{ op: "add", variantId: "1001", productId: "101" }], "Small (first, sold out), not Medium (a later, in-stock variant)");
  assert.deepEqual(page.backend.items.map((i) => i.variantId), ["1001"]);
  assert.equal(pressed(page.heart("board")), true);
  assert.deepEqual(page.toasts(), [], "no 'unavailable' message");
});

test("a collection heart saves the first variant when it is in stock too, never a later one", async () => {
  const page = await mount();
  await page.click(page.heart("tee"));
  assert.deepEqual(posts(page).map((p) => p.variantId), ["4001"], "S, although M is also in stock and L is not");
});
test("a single-variant product's heart saves its only variant", async () => {
  const page = await mount();
  await page.click(page.heart("mug"));
  assert.equal(posts(page)[0].variantId, "2001");
});

test("a product whose variants are ALL out of stock can be saved: its first variant is stored, with no message", async () => {
  const page = await mount();
  await page.click(page.heart("soldout"));
  assert.deepEqual(posts(page).map((p) => ({ op: p.op, variantId: p.variantId })), [{ op: "add", variantId: "3001" }]);
  assert.deepEqual(page.backend.items.map((i) => i.variantId), ["3001"]);
  assert.equal(pressed(page.heart("soldout")), true);
  assert.deepEqual(page.toasts(), []);
});
test("clicking a saved card heart again removes that same (first) variant", async () => {
  const page = await mount();
  await page.click(page.heart("board"));
  await page.click(page.heart("board"));
  assert.deepEqual(posts(page).map((p) => `${p.op}:${p.variantId}`), ["add:1001", "remove:1001"]);
  assert.equal(page.backend.items.length, 0);
  assert.equal(pressed(page.heart("board")), false);
});
test("a card heart shows saved only when the card's own (first) variant is saved, not when another variant of the product is", async () => {
  const other = await mount({ backend: { items: [{ productId: "101", variantId: "1002", title: "Snowboard", handle: "board" }] } });
  assert.equal(pressed(other.heart("board")), false, "Medium is saved, but the card stands for Small");

  const same = await mount({ backend: { items: [{ productId: "101", variantId: "1001", title: "Snowboard", handle: "board" }] } });
  assert.equal(pressed(same.heart("board")), true, "the first variant is saved even though it is sold out");
});
test("a card heart never overwrites or removes another saved variant of the same product", async () => {
  const backend = { items: [{ productId: "101", variantId: "1003", title: "Snowboard", handle: "board" }] };
  const page = await mount({ backend });
  await page.click(page.heart("board"));
  assert.deepEqual(backend.items.map((i) => i.variantId).sort(), ["1001", "1003"], "Small added next to Large");
  await page.click(page.heart("board"));
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1003"], "removing Small leaves Large");
});
test("legacy items (no variant) do not make a card heart look saved", async () => {
  const page = await mount({ backend: { items: [{ productId: "101", variantId: null, title: "Snowboard", handle: "board" }] } });
  assert.equal(pressed(page.heart("board")), false);
});

// ---- product page: the exact selected variant ---------------------------------------------
test("the product page saves the exact selected variant, not the default one", async () => {
  const page = await mount({ page: "product", selected: "1003" });
  await page.click(page.productButton);
  assert.deepEqual(posts(page).map((p) => ({ op: p.op, variantId: p.variantId })), [{ op: "add", variantId: "1003" }]);
  assert.deepEqual(page.backend.items.map((i) => i.variantId), ["1003"]);
  assert.equal(pressed(page.productButton), true);
});

test("the product page saves an out-of-stock selected variant, and an in-stock one next to it", async () => {
  const backend = { items: [] };
  const page = await mount({ page: "product", selected: "1001", backend }); // Small is sold out
  await page.click(page.productButton);
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1001"], "sold-out variants can be saved");
  assert.equal(pressed(page.productButton), true);

  await page.selectVariant("1002"); // Medium is in stock
  assert.equal(pressed(page.productButton), false);
  await page.click(page.productButton);
  assert.deepEqual(backend.items.map((i) => i.variantId).sort(), ["1001", "1002"], "both saved as separate entries");
  assert.deepEqual(page.toasts(), []);
});

test("an already-saved selected variant loads in the saved state and clicking removes exactly that variant", async () => {
  const backend = { items: [{ productId: "101", variantId: "1003", title: "Snowboard", handle: "board" }, { productId: "101", variantId: "1002", title: "Snowboard", handle: "board" }] };
  const page = await mount({ page: "product", selected: "1003", backend });
  assert.equal(pressed(page.productButton), true);
  assert.equal(page.productButton.querySelector("[data-kw-label]").textContent, "Saved to wishlist");
  await page.click(page.productButton);
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1002"], "the other variant is untouched");
});

test("changing the selected variant refreshes the heart: available to add for a new variant, saved for a saved one", async () => {
  const backend = { items: [{ productId: "101", variantId: "1003", title: "Snowboard", handle: "board" }] };
  const page = await mount({ page: "product", selected: "1003", backend });
  assert.equal(pressed(page.productButton), true);

  await page.selectVariant("1002");
  assert.equal(pressed(page.productButton), false, "Medium is not saved: the heart is available to add it");
  assert.equal(page.productButton.querySelector("[data-kw-label]").textContent, "Add to wishlist");

  await page.selectVariant("1003");
  assert.equal(pressed(page.productButton), true, "back to the saved variant");
});

test("every way a theme can change the variant refreshes the heart", async () => {
  for (const how of ["change", "mutation", "pubsub", "popstate"]) {
    const backend = { items: [{ productId: "101", variantId: "1003", title: "Snowboard", handle: "board" }] };
    const page = await mount({ page: "product", selected: "1002", backend });
    assert.equal(pressed(page.productButton), false, how + ": starts on Medium");
    await page.selectVariant("1003", how);
    assert.equal(pressed(page.productButton), true, how + ": refreshed to the saved Large");
  }
});

test("switching variants never removes or overwrites a different variant's entry", async () => {
  const backend = { items: [] };
  const page = await mount({ page: "product", selected: "1002", backend });
  await page.click(page.productButton);                 // save Medium
  await page.selectVariant("1003");
  assert.equal(pressed(page.productButton), false);
  await page.click(page.productButton);                 // save Large too
  assert.deepEqual(backend.items.map((i) => i.variantId).sort(), ["1002", "1003"], "two separate entries");

  await page.click(page.productButton);                 // remove Large
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1002"], "Medium untouched");
  await page.selectVariant("1002");
  assert.equal(pressed(page.productButton), true);
  assert.deepEqual(posts(page).map((p) => `${p.op}:${p.variantId}`), ["add:1002", "add:1003", "remove:1003"]);
});

test("the click always uses the variant selected right now, even if no change event reached the script", async () => {
  const page = await mount({ page: "product", selected: "1002" });
  page.formInput.value = "1003"; // the theme updated the form silently: no event, no mutation
  await page.click(page.productButton);
  assert.equal(posts(page)[0].variantId, "1003", "no stale variant id");
});

test("the selected variant falls back to the URL's ?variant= and then to the variant the page rendered with", async () => {
  const page = await mount({ page: "product", selected: "1002" });
  page.formInput.value = "";                          // no usable form value
  page.win.location.search = "?variant=1003";
  await page.click(page.productButton);
  assert.equal(posts(page)[0].variantId, "1003", "URL parameter");

  const plain = await mount({ page: "product", selected: "1002" });
  plain.formInput.value = "";
  await plain.click(plain.productButton);
  assert.equal(posts(plain)[0].variantId, "1002", "the variant rendered into the page");
});

test("variant watching adds no duplicate listeners or controls when the scripts initialise again", async () => {
  const page = await mount({ page: "product", selected: "1002" });
  const before = { change: page.listeners.change.length, popstate: (page.listeners["window:popstate"] || []).length, observers: page.observers.length, subs: page.subscribers.length };
  vm.runInContext(EXTRAS, page.context);
  vm.runInContext(EXTRAS, page.context);
  await settle();
  assert.deepEqual({ change: page.listeners.change.length, popstate: (page.listeners["window:popstate"] || []).length, observers: page.observers.length, subs: page.subscribers.length }, before);
  assert.equal(page.body.querySelectorAll(".kw-btn--product").length, 1);
});

// ---- logged out: the exact variant survives the login round trip --------------------------
test("logged out on the product page: the selected variant is remembered and saved exactly after login", async () => {
  const browser = new Map();
  const out = await mount({ page: "product", loggedIn: false, selected: "1003", browser });
  await out.click(out.productButton);
  const intent = JSON.parse(browser.get("kw:pending"));
  assert.equal(intent.v, "1003");
  assert.equal(posts(out).length, 0, "nothing written while logged out");

  const backend = { items: [] };
  const back = await mount({ page: "product", loggedIn: true, selected: "1003", browser, backend });
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1003"]);
  assert.equal(pressed(back.productButton), true);
  assert.equal(browser.has("kw:pending"), false);
});

test("logged out on a collection card: after login the first variant is saved, in stock or not", async () => {
  const browser = new Map();
  const out = await mount({ loggedIn: false, browser });
  await out.click(out.heart("board"));
  assert.equal(JSON.parse(browser.get("kw:pending")).v, null, "a card has no selected variant");

  const backend = { items: [] };
  await mount({ loggedIn: true, browser, backend });
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1001"], "the first variant (sold out), not the first available one");
});
test("after login a card for a product that is entirely out of stock saves its first variant", async () => {
  const browser = new Map();
  const out = await mount({ loggedIn: false, browser });
  await out.click(out.heart("soldout"));
  const backend = { items: [] };
  const back = await mount({ loggedIn: true, browser, backend });
  assert.deepEqual(backend.items.map((i) => i.variantId), ["3001"]);
  assert.equal(back.toasts().some((m) => /unavailable|cannot be saved/i.test(m)), false, "only the normal saved message, never an 'unavailable' one");
});

// ---- the home page's Featured products use the same rule -------------------------------------
test("home page: a Featured products heart saves the first variant even when it is sold out and a later one is in stock", async () => {
  const page = await mount({ page: "index" });
  await page.click(page.heart("board"));
  assert.deepEqual(posts(page).map((p) => ({ op: p.op, variantId: p.variantId, productId: p.productId })), [{ op: "add", variantId: "1001", productId: "101" }]);
  assert.equal(pressed(page.heart("board")), true);
  assert.deepEqual(page.toasts(), []);

  await page.click(page.heart("soldout")); // every variant sold out: still saved, first variant
  assert.deepEqual(page.backend.items.map((i) => i.variantId).sort(), ["1001", "3001"]);
});

test("home page: already-wishlisted variants render saved, a second click removes only that variant, duplicates are not created", async () => {
  const backend = { items: [{ productId: "101", variantId: "1001", title: "Snowboard", handle: "board" }, { productId: "101", variantId: "1003", title: "Snowboard", handle: "board" }] };
  const page = await mount({ page: "index", backend });
  assert.equal(pressed(page.heart("board")), true, "the card's own (first) variant is saved");
  assert.equal(pressed(page.heart("mug")), false);

  await page.click(page.heart("board"));
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1003"], "only the first variant is removed; Large stays");
  await page.click(page.heart("board"));
  await page.click(page.heart("board"));
  assert.equal(backend.items.filter((i) => i.variantId === "1001").length <= 1, true, "never two entries for one variant");
});

test("home page: logged out, then login: the first variant is saved and the heart shows saved", async () => {
  const browser = new Map();
  const out = await mount({ page: "index", loggedIn: false, browser });
  await out.click(out.heart("board"));
  assert.equal(posts(out).length, 0, "nothing written while logged out");

  const backend = { items: [] };
  const back = await mount({ page: "index", loggedIn: true, browser, backend });
  assert.deepEqual(backend.items.map((i) => i.variantId), ["1001"]);
  assert.equal(pressed(back.heart("board")), true);
});
