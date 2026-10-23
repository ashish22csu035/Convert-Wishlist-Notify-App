// Behaviour tests for the My Wishlist table page script
// (extensions/konvert-wishlist/assets/konvert-wishlist-extras.js).
//
// Run: node --test tests/wishlist-page.test.mjs
//
// No browser and no extra dependency: the script runs in a node:vm context
// against a tiny stub DOM, with stubbed wishlist API (kw.request), product JSON
// and Ajax Cart (fetch). Layout/CSS is not covered here and needs a browser check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const MAIN = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.js", "utf8");
const SCRIPT = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");

// ---- minimal DOM -------------------------------------------------------------
class Dom {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    const self = this;
    this.classList = {
      add: (c) => {
        if (!self.has(c)) self.className = `${self.className} ${c}`.trim();
      },
      remove: (c) => {
        self.className = self.className.split(" ").filter((x) => x && x !== c).join(" ");
      },
      contains: (c) => self.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !self.has(c) : on;
        if (want) self.classList.add(c);
        else self.classList.remove(c);
      },
    };
  }
  has(c) {
    return this.className.split(" ").includes(c);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  async fire(type) {
    for (const fn of this.listeners[type] || []) await fn({ target: this });
  }
  click() {
    return this.fire("click");
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set href(v) {
    this.attrs.href = v;
  }
  get href() {
    return this.attrs.href;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  matches(sel) {
    if (sel.startsWith(".")) return this.has(sel.slice(1));
    const attr = /^([a-z]*)\[([\w-]+)\]$/.exec(sel);
    if (attr) return (!attr[1] || this.tag === attr[1]) && attr[2] in this.attrs;
    return /^[a-z]+$/.test(sel) ? this.tag === sel : false;
  }
  closest(sel) {
    for (let n = this; n; n = n.parent) if (n.matches(sel)) return n;
    return null;
  }
  querySelector(sel) {
    return this.find(sel);
  }
  querySelectorAll(sel) {
    return this.findAll(sel);
  }
  find(sel) {
    return this.all().find((n) => n.matches(sel)) ?? null;
  }
  findAll(sel) {
    return this.all().filter((n) => n.matches(sel));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

// ---- fixtures ----------------------------------------------------------------
const SNOWBOARD = { productId: "1", variantId: "11", title: "Snowboard", handle: "snowboard" };
const GIFT = { productId: "2", variantId: "22", title: "Gift Card", handle: "gift-card" };
const GONE = { productId: "3", variantId: null, title: "Removed Thing", handle: "gone" };
const BADVARIANT = { productId: "5", variantId: "bad", title: "Broken Variant", handle: "badvariant" };
const SHIRT_SAVED = { productId: "4", variantId: "41", title: "Shirt", handle: "shirt" };
const GIFT_AVAILABLE = { productId: "6", variantId: "22", title: "Gift Card", handle: "gift-open" };
const SHIRT = { productId: "4", variantId: null, title: "Shirt", handle: "shirt" };

const PRODUCTS = {
  snowboard: {
    id: 1, title: "Snowboard", handle: "snowboard", featured_image: "https://cdn.example/s.jpg", available: true, price: 69995,
    variants: [
      { id: 11, title: "Small", available: true, price: 69995, compare_at_price: 79995 },
      { id: 12, title: "Large", available: true, price: 74995, featured_image: { src: "https://cdn.example/large.jpg" } },
    ],
  },
  "gift-card": {
    id: 2, title: "Gift Card", handle: "gift-card", featured_image: null, available: false, price: 1000,
    variants: [{ id: 22, available: false, price: 1000 }],
  },
  badvariant: {
    id: 5, title: "Broken Variant", handle: "badvariant", featured_image: null, available: true, price: 1500,
    variants: [{ id: "bad", available: true, price: 1500 }],
  },
  "gift-open": {
    id: 6, title: "Gift Card", handle: "gift-open", featured_image: null, available: true, price: 1000,
    variants: [{ id: 22, available: true, price: 1000 }],
  },
  shirt: {
    id: 4, title: "Shirt", handle: "shirt", featured_image: "https://cdn.example/t.jpg", available: true, price: 2500,
    variants: [{ id: 41, title: "M", available: true, price: 2500 }, { id: 42, title: "L", available: false, price: 2500 }],
  },
};

// Starts the real storefront scripts (konvert-wishlist.js, then the extras script it loads
// on demand) on a My Wishlist page, against a stub storefront: a stub wishlist API, product
// JSON, inventory endpoint and Ajax Cart, all served through fetch.
//   backend    plays the wishlist database; it survives across mounts, so mounting again
//              behaves like a page refresh
//   inventory  { "<variant id>": max | null }  what /api/inventory reports (mutable)
//   cart       { fail, failStatus, unconfirmed }  Ajax Cart behaviour
//   root       Shopify.routes.root (localized storefronts use e.g. "/fr/")
async function mount({ loggedIn = true, openFails = false, backend, cart = {}, inventory = {}, inventoryDown = false, notify = {}, subscribed = new Set(), statusFails = false, storage = null, root = "/", requestError = false, removeError = false, readyError = false } = {}) {
  const body = new Dom("div");
  const head = new Dom("head");
  const configNode = new Dom("script");
  configNode.attrs["data-kw-config"] = "";
  configNode.textContent = JSON.stringify({
    loggedIn,
    apiPath: "/apps/konvert-notify/api/wishlist",
    inventoryPath: "/apps/konvert-notify/api/inventory",
    notifyPath: "/apps/konvert-notify/api/notify",
    extrasUrl: "https://cdn.example/konvert-wishlist-extras.js",
    loginUrl: "/account/login",
    headerIcon: false,
    collectionCards: false,
    text: { loadError: "We could not load your wishlist.", error: "Something went wrong.", loginPrompt: "Log in", loginLink: "Log in", close: "Close" },
  });
  const count = new Dom("span");
  count.attrs["data-kw-page-count"] = "";
  const select = new Dom("button");
  select.attrs["data-kw-select"] = "";
  select.hidden = true;
  const pageBody = new Dom("div");
  pageBody.attrs["data-kw-page-body"] = "";
  [configNode, count, select, pageBody].forEach((n) => body.appendChild(n));

  const log = { requests: [], cart: [], calls: [], inventoryCalls: [], toasts: [], opens: [], notify: [], status: [], productFetches: [] };
  const cartItems = [];
  const state = { inventory, cart, removeError };

  // every toast the real showToast puts on the page, in order (message only)
  const baseAppend = Dom.prototype.appendChild;
  body.appendChild = (node) => {
    baseAppend.call(body, node);
    if (node.has && node.has("kw-toast")) log.toasts.push(node.children[0].textContent.trim());
    return node;
  };

  const document = {
    readyState: "complete",
    documentElement: { lang: "en", clientWidth: 400 },
    body,
    head,
    createElement: (tag) => {
      const node = new Dom(tag);
      if (tag === "script") Object.defineProperty(node, "src", { set(v) { node._src = v; }, get: () => node._src });
      return node;
    },
    querySelector: (sel) => body.find(sel),
    querySelectorAll: (sel) => body.findAll(sel),
    addEventListener() {},
  };
  const win = {
    Shopify: { currency: { active: "USD" }, routes: { root } },
    location: { origin: "https://shop.example", pathname: "/apps/konvert-notify/my-wishlist", search: "", assign() {} },
    sessionStorage: storage ?? { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    console: { warn() {}, log() {} },
  };

  const clientItems = () => backend.items.map((i) => ({ productId: i.productId, variantId: i.variantId, title: i.title, handle: i.handle }));
  async function fetchStub(url, init = {}) {
    if (url === "/apps/konvert-notify/api/wishlist") {
      const method = init.method || "GET";
      if (method === "GET") {
        if (readyError) return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        return { ok: true, status: 200, json: async () => ({ loggedIn, items: clientItems(), count: backend.items.length }) };
      }
      const payload = JSON.parse(init.body);
      // "open" (My Wishlist page opened) is tracked on its own so it never shifts the ordered request logs below
      if (payload.op === "open") {
        log.opens.push({ method, body: payload });
        if (openFails) return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, opened: true }) };
      }
      log.requests.push({ method, body: payload });
      if (payload.op !== "click") log.calls.push(`WISHLIST ${payload.op} ${payload.productId}`);
      if (requestError || (payload.op === "remove" && state.removeError)) {
        return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
      }
      if (payload.op === "remove") {
        backend.items = backend.items.filter((i) => (payload.variantId ? i.variantId !== payload.variantId : !(i.productId === payload.productId && !i.variantId)));
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, saved: false }) };
    }
    if (url.startsWith("/apps/konvert-notify/api/notify") && (init.method || "GET") === "GET") {
      // the server's own record of who is subscribed (persists across mounts, like a page reload)
      log.status.push(url);
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
    if (url.startsWith("/apps/konvert-notify/api/inventory")) {
      log.inventoryCalls.push(url);
      if (inventoryDown) return { ok: false, json: async () => ({}) };
      const wanted = new URL(url, "https://x.test").searchParams.get("ids").split(",");
      const variants = {};
      for (const id of wanted) if (id in state.inventory) variants[id] = { max: state.inventory[id] };
      return { ok: true, json: async () => ({ variants, unavailable: false }) };
    }
    if (url.endsWith("cart/add.js")) {
      const payload = JSON.parse(init.body);
      log.cart.push(payload);
      log.calls.push(`POST ${url}`);
      if (state.cart.fail) {
        return { ok: false, status: state.cart.failStatus ?? 422, json: async () => ({ status: 422, message: "Cart Error", description: state.cart.fail }) };
      }
      if (!state.cart.unconfirmed) for (const line of payload.items) cartItems.push({ variant_id: line.id, quantity: line.quantity });
      return { ok: true, status: 200, json: async () => ({ items: payload.items }) };
    }
    if (url.endsWith("cart.js")) {
      log.calls.push(`GET ${url}`);
      return { ok: true, json: async () => ({ items: cartItems }) };
    }
    const handle = /products\/([^./?]+)\.js/.exec(url)[1];
    log.productFetches.push(handle);
    if (!PRODUCTS[handle]) return { ok: false };
    return { ok: true, json: async () => PRODUCTS[handle] };
  }

  const context = vm.createContext({
    window: win, document, fetch: fetchStub, Intl, URL, URLSearchParams, setTimeout, clearTimeout, console,
    Number, String, Boolean, Object, Promise, Map, JSON, Error, parseInt, RegExp, Date, encodeURIComponent, decodeURIComponent,
  });
  // loading the extras <script> runs the real extras file
  head.appendChild = (node) => {
    baseAppend.call(head, node);
    if (node.tag === "script") {
      setTimeout(() => {
        vm.runInContext(SCRIPT, context);
        node.onload?.();
      }, 0);
    }
    return node;
  };
  vm.runInContext(MAIN, context);
  await tick();
  await tick();
  await tick();
  await tick();

  const kw = win.KonvertWishlist;
  const rows = () => pageBody.findAll("tr").filter((tr) => tr.has("kw-row"));
  return { body, count, select, pageBody, log, items: kw.items, rows, kw, state, rerun: () => vm.runInContext(SCRIPT, context) };
}

const text = (node, selector) => node.find(selector).textContent;

// ---- tests -------------------------------------------------------------------
test("saved products render as table rows with the real count, price and stock status", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT, GONE] } });
  assert.equal(page.rows().length, 3);
  assert.equal(page.count.textContent, "(3 Items)");
  assert.equal(page.select.hidden, false, "Select button shown when there are products");

  const head = page.pageBody.findAll("th").map((th) => th.textContent).filter(Boolean);
  assert.deepEqual(head, ["Remove", "Product image", "Product name", "Price", "Stock status", "Quantity", "Action"]);

  const [snow, gift, gone] = page.rows();
  assert.equal(text(snow, ".kw-row__title"), "Snowboard");
  assert.match(snow.find(".kw-row__title").href, /\/products\/snowboard\?variant=11$/, "links to the real product URL");
  assert.match(text(snow, ".kw-price"), /\$699\.95/, "price formatted in the store currency");
  assert.match(text(snow, ".kw-price"), /\$799\.95/, "compare-at price shown");
  assert.equal(text(snow, ".kw-stock"), "In stock");
  assert.equal(snow.findAll("img").length, 1);
  assert.equal(text(snow, ".kw-btn-cart"), "Add to cart");

  assert.equal(text(gift, ".kw-stock"), "Out of stock");
  assert.equal(text(gift, ".kw-btn-cart"), "Notify Me");
  assert.equal(gift.find(".kw-btn-cart").disabled, false);
  assert.ok(gift.find(".kw-thumb").has("kw-thumb--empty"), "missing image handled");

  assert.equal(text(gone, ".kw-stock"), "Availability unavailable", "no guessing when product data is missing");
  assert.equal(gone.find(".kw-btn-cart").disabled, true);
  assert.equal(gone.find(".kw-price").textContent, "");
});

test("quantity can never go below 1 or above the maximum", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT] } });
  const [snow, gift] = page.rows();
  const [minus, plus] = snow.findAll("button").filter((b) => b.has("kw-qty__btn"));
  const input = snow.find(".kw-qty__input");

  assert.equal(input.value, "1");
  assert.equal(minus.disabled, true, "minus disabled at 1");
  await plus.click();
  assert.equal(input.value, "2");
  await minus.click();
  assert.equal(input.value, "1");

  input.value = "0";
  await input.fire("change");
  assert.equal(input.value, "1", "0 is corrected to 1");
  input.value = "-4";
  await input.fire("change");
  assert.equal(input.value, "1");
  input.value = "500";
  await input.fire("change");
  assert.equal(input.value, "99", "capped at 99");
  assert.equal(plus.disabled, true);

  assert.equal(gift.find(".kw-qty__input").disabled, true, "sold-out rows cannot change quantity");
});

test("Add to cart uses the localized cart URL, confirms the cart, and only then removes the product from the wishlist", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT] }, root: "/fr/" });
  const [snow] = page.rows();
  const plus = snow.findAll("button").filter((b) => b.has("kw-qty__btn"))[1];
  await plus.click();
  await plus.click();
  await snow.find(".kw-btn-cart").click();
  await tick();

  assert.equal(JSON.stringify(page.log.cart), JSON.stringify([{ items: [{ id: 11, quantity: 3 }] }]));
  assert.deepEqual(
    page.log.calls,
    ["POST /fr/cart/add.js", "GET /fr/cart.js", "WISHLIST remove 1"],
    "add, confirm from the cart, and only then remove from the wishlist"
  );
  assert.equal(page.rows().length, 1, "row disappears after the removal succeeded");
  assert.equal(text(page.rows()[0], ".kw-row__title"), "Gift Card");
  assert.equal(page.count.textContent, "(1 Item)");
  assert.equal(page.items.size, 1);
  assert.deepEqual(page.log.toasts, ["Added to cart"]);
});

test("sold-out items cannot be added to the cart (their button is Notify Me)", async () => {
  const page = await mount({ backend: { items: [GIFT] } });
  const [gift] = page.rows();
  await gift.find(".kw-btn-cart").click();
  await tick();
  assert.equal(page.log.cart.length, 0);
});

test("an unconfirmed cart add keeps the wishlist item and shows no success", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] }, cart: { unconfirmed: true } });
  const [row] = page.rows();
  await row.find(".kw-btn-cart").click();
  await tick();
  assert.equal(page.log.toasts.length, 1);
  assert.match(page.log.toasts[0], /could not confirm/);
  assert.equal(page.log.requests.filter((r) => r.body.op === "remove").length, 0, "wishlist untouched");
  assert.equal(page.log.requests.filter((r) => r.body.op === "cart_add").length, 0, "no successful-cart event for an unconfirmed add");
  assert.equal(page.rows().length, 1);
  assert.equal(text(row, ".kw-btn-cart"), "Add to cart", "no false 'Added to cart'");
  assert.equal(row.find(".kw-btn-cart").disabled, false);
});

test("a failed cart add keeps the wishlist item, shows Shopify's message and never calls the removal API", async () => {
  const page = await mount({
    backend: { items: [SNOWBOARD] },
    cart: { fail: "Cannot add this product right now.", failStatus: 400 },
  });
  const [row] = page.rows();
  await row.find(".kw-btn-cart").click();
  await tick();
  assert.deepEqual(page.log.toasts, ["Cannot add this product right now."]);
  assert.equal(page.log.calls.length, 1, "no confirmation request after a failed add");
  assert.equal(page.log.requests.filter((r) => r.body.op === "remove").length, 0);
  assert.equal(page.log.requests.filter((r) => r.body.op === "cart_add").length, 0, "a failed cart request records no event");
  assert.equal(page.rows().length, 1);
  assert.equal(page.count.textContent, "(1 Item)");
  assert.equal(row.find(".kw-btn-cart").disabled, false);
  assert.equal(text(row, ".kw-btn-cart"), "Add to cart");
});

test("a stock refusal (422) shows a generic message without Shopify's text or any quantity", async () => {
  const page = await mount({
    backend: { items: [SNOWBOARD] },
    cart: { fail: "You can only add 3 Snowboard to the cart.", failStatus: 422 },
  });
  await page.rows()[0].find(".kw-btn-cart").click();
  await tick();
  assert.equal(page.log.toasts.length, 1);
  assert.match(page.log.toasts[0], /not enough stock is available/);
  assert.equal(/\d/.test(page.log.toasts[0]), false, "no number in the message");
  assert.equal(page.rows().length, 1, "item stays on the wishlist");
});

test("repeated clicks cannot submit duplicate cart requests", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] } });
  const button = page.rows()[0].find(".kw-btn-cart");
  await Promise.all([button.click(), button.click(), button.click()]);
  await tick();
  assert.equal(page.log.cart.length, 1, "exactly one cart request");
  assert.equal(page.log.requests.filter((r) => r.body.op === "remove").length, 1, "exactly one removal");
});

test("if the cart add worked but the wishlist removal failed, the cart is not added to again and removal can be retried", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT] }, removeError: true });
  const [row] = page.rows();
  await row.find(".kw-btn-cart").click();
  await tick();

  assert.equal(page.log.cart.length, 1, "added to the cart once");
  assert.equal(page.rows().length, 2, "row stays while the removal failed");
  assert.match(page.log.toasts.at(-1), /Added to your cart, but we could not remove it from your wishlist/);
  assert.equal(text(row, ".kw-btn-cart"), "Remove from wishlist", "action becomes a removal retry");
  assert.equal(row.find(".kw-qty__input").disabled, true, "quantity locked: it is already in the cart");

  // clicking the retry button must not add to the cart again
  page.state.removeError = true;
  await row.find(".kw-btn-cart").click();
  await tick();
  assert.equal(page.log.cart.length, 1, "retry never re-adds to the cart");
  assert.equal(page.rows().length, 2, "still on the wishlist after a second failure");

  page.state.removeError = false;
  await row.find(".kw-btn-cart").click();
  await tick();
  assert.equal(page.log.cart.length, 1);
  assert.equal(page.rows().length, 1, "removed once the retry succeeds");
  assert.equal(page.count.textContent, "(1 Item)");
  assert.equal(text(page.rows()[0], ".kw-row__title"), "Gift Card");
});

test("only the row that was added is removed from the wishlist", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, SHIRT_SAVED] } });
  const [snow, shirt] = page.rows();
  await shirt.find(".kw-btn-cart").click();
  await tick();
  assert.deepEqual(page.log.requests.filter((r) => r.body.op === "remove").map((r) => r.body.productId), ["4"]);
  assert.equal(JSON.stringify(page.log.cart), JSON.stringify([{ items: [{ id: 41, quantity: 1 }] }]), "that row's own variant");
  assert.equal(page.rows().length, 1);
  assert.equal(page.rows()[0], snow);
  assert.equal(page.count.textContent, "(1 Item)");
});

test("an invalid variant id is rejected before any cart request", async () => {
  const page = await mount({ backend: { items: [BADVARIANT] } });
  const [row] = page.rows();
  await row.find(".kw-btn-cart").click();
  assert.equal(page.log.cart.length, 0);
  assert.match(page.log.toasts[0], /cannot be added from here/);
  assert.equal(page.log.inventoryCalls.length, 0, "non-numeric ids are never sent to the inventory endpoint");
});

// Collects every piece of text a customer could read or hear: visible text,
// tooltips (title) and accessibility labels.
function customerFacingText(root) {
  const parts = [root.textContent];
  for (const node of root.all()) {
    for (const key of ["title", "aria-label", "aria-valuemax", "aria-valuetext", "max", "placeholder", "alt"]) {
      if (typeof node.attrs[key] === "string") parts.push(node.attrs[key]);
    }
    if (typeof node.title === "string") parts.push(node.title);
    if (node.max !== undefined) parts.push(`max=${node.max}`);
  }
  return parts.join(" | ");
}

test("quantity is limited silently: no inventory number appears anywhere customer-facing", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] }, inventory: { 11: 6 } });
  const [row] = page.rows();
  assert.equal(page.log.inventoryCalls.length, 1, "the limit is still fetched from the server");
  assert.match(page.log.inventoryCalls[0], /ids=11$/);

  const input = row.find(".kw-qty__input");
  const [, plus] = row.findAll("button").filter((b) => b.has("kw-qty__btn"));
  assert.equal(row.find(".kw-qty__note"), null, "no stock label element exists");
  assert.equal(input.max, undefined, "no max attribute that browsers or readers could expose");

  const everything = customerFacingText(page.body);
  assert.equal(/\bmax\b/i.test(everything), false, "no 'Max' label anywhere");
  assert.equal(/only\s+\d+|\d+\s+(left|available|in stock)/i.test(everything), false);
  assert.equal(/(?<![\d.,$])6(?![\d.,])/.test(everything), false, "the number 6 is not shown (price digits are not a standalone 6)");

  // the limit is still enforced
  input.value = "500";
  await input.fire("change");
  assert.equal(input.value, "6", "typed quantity clamped to the sellable quantity");
  assert.equal(plus.disabled, true, "+ is disabled at the permitted maximum");
  await plus.click();
  assert.equal(input.value, "6", "+ cannot exceed the maximum");
  assert.equal(text(row, ".kw-line"), "Subtotal: $4,199.70", "subtotal still follows quantity (6 x $699.95)");
});

test("the + button disables exactly at the permitted maximum while stepping up one at a time", async () => {
  const page = await mount({ backend: { items: [GIFT_AVAILABLE] }, inventory: { 22: 2 } });
  const [row] = page.rows();
  const [minus, plus] = row.findAll("button").filter((b) => b.has("kw-qty__btn"));
  const input = row.find(".kw-qty__input");
  assert.equal(plus.disabled, false);
  await plus.click();
  assert.equal(input.value, "2");
  assert.equal(plus.disabled, true);
  assert.equal(minus.disabled, false);
  assert.equal(page.log.cart.length, 0);
  await row.find(".kw-btn-cart").click();
  await tick();
  assert.equal(JSON.stringify(page.log.cart), JSON.stringify([{ items: [{ id: 22, quantity: 2 }] }]));
});

test("a variant with zero sellable inventory becomes Out of stock even if the product JSON said available", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] }, inventory: { 11: 0 } });
  const [row] = page.rows();
  assert.equal(text(row, ".kw-stock"), "Out of stock");
  assert.equal(text(row, ".kw-btn-cart"), "Notify Me");
  assert.equal(row.find(".kw-btn-cart").disabled, false);
  assert.equal(row.find(".kw-qty__input").disabled, true);
});

test("products that allow overselling (no limit reported) are not blocked, and inventory outages do not block either", async () => {
  const oversell = await mount({ backend: { items: [SNOWBOARD] }, inventory: { 11: null } });
  const input = oversell.rows()[0].find(".kw-qty__input");
  input.value = "40";
  await input.fire("change");
  assert.equal(input.value, "40", "no artificial limit when the store continues selling");
  assert.equal(/\bmax\b/i.test(customerFacingText(oversell.body)), false);
  assert.equal(oversell.rows()[0].findAll("button").filter((b) => b.has("kw-qty__btn"))[1].disabled, false, "+ stays enabled without a limit");

  const down = await mount({ backend: { items: [SNOWBOARD] }, inventoryDown: true });
  const input2 = down.rows()[0].find(".kw-qty__input");
  input2.value = "7";
  await input2.fire("change");
  assert.equal(input2.value, "7", "without inventory data the selector is not limited; Shopify's cart still decides");
  await down.rows()[0].find(".kw-btn-cart").click();
  await tick();
  assert.equal(down.log.cart.length, 1, "add to cart still works");
});

test("the line total follows quantity while the unit price stays visible", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT] } });
  const [snow, gift] = page.rows();
  assert.match(text(snow, ".kw-price"), /\$699\.95/);
  assert.equal(text(snow, ".kw-line"), "Subtotal: $699.95");
  const [, plus] = snow.findAll("button").filter((b) => b.has("kw-qty__btn"));
  await plus.click();
  await plus.click();
  assert.equal(text(snow, ".kw-line"), "Subtotal: $2,099.85", "unit price x quantity");
  assert.match(text(snow, ".kw-price"), /\$699\.95/, "unit price unchanged");
  assert.match(snow.find(".kw-line").title, /Discounts, taxes and shipping/, "labelled as an estimate");
  assert.equal(gift.find(".kw-line").hidden, true, "no line total for a product that cannot be bought");
});

test("stock changing between page load and add to cart: a generic refusal, a silently refreshed limit, and the item stays", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] }, inventory: { 11: 6 } });
  const [row] = page.rows();
  const input = row.find(".kw-qty__input");
  input.value = "5";
  await input.fire("change");

  page.state.inventory[11] = 3; // someone else bought stock meanwhile
  page.state.cart.fail = "You can only add 3 Snowboard to the cart.";
  await row.find(".kw-btn-cart").click();
  await tick();
  await tick();

  assert.equal(page.log.toasts.length, 1);
  assert.match(page.log.toasts[0], /not enough stock is available/);
  assert.equal(/\d/.test(page.log.toasts[0]), false, "no quantity in our message");
  assert.equal(page.log.inventoryCalls.length, 2, "inventory re-read after the 422");
  assert.equal(input.value, "3", "quantity lowered to what is really sellable");
  assert.equal(/\bmax\b/i.test(customerFacingText(page.body)), false);
  assert.equal(page.rows().length, 1, "wishlist item kept");
  assert.equal(page.log.requests.filter((r) => r.body.op === "remove").length, 0);
});

test("bulk add is refused while any selected row is invalid", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, BADVARIANT] } });
  await page.select.click();
  const [snow, bad] = page.rows();
  snow.find(".kw-check").checked = true;
  bad.find(".kw-check").checked = true;
  await snow.find(".kw-check").fire("change");
  const [add] = page.pageBody.find(".kw-bulk").findAll("button");
  await add.click();
  await tick();
  assert.equal(page.log.cart.length, 0, "nothing sent while one selected row is invalid");
  assert.match(page.log.toasts[0], /Broken Variant/);
});

test("removing updates the table and count; a failed removal keeps the row and tells the customer", async () => {
  const backend = { items: [SNOWBOARD, GIFT] };
  const page = await mount({ backend });
  await page.rows()[1].find(".kw-row__remove").click();
  await tick();
  assert.deepEqual(page.log.requests.at(-1), { method: "POST", body: { op: "remove", productId: "2", variantId: "22" } });
  assert.equal(page.rows().length, 1);
  assert.equal(page.count.textContent, "(1 Item)");
  assert.equal(page.items.size, 1);

  const failing = await mount({ backend: { items: [SNOWBOARD] }, requestError: true });
  const button = failing.rows()[0].find(".kw-row__remove");
  await button.click();
  await tick();
  assert.equal(failing.rows().length, 1, "row stays when the API fails");
  assert.equal(failing.count.textContent, "(1 Item)");
  assert.equal(button.disabled, false);
  assert.equal(failing.log.toasts.length, 1);
});

test("removing the last product shows the empty state", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] } });
  await page.rows()[0].find(".kw-row__remove").click();
  await tick();
  assert.equal(page.rows().length, 0);
  assert.equal(page.count.textContent, "(0 Items)");
  assert.ok(page.pageBody.find(".kw-empty"));
  assert.match(page.pageBody.textContent, /Your wishlist is empty\./);
  assert.match(page.pageBody.textContent, /Continue shopping/);
  assert.equal(page.select.hidden, true);
});

test("the page shows saved products again after a refresh (state comes from the backend)", async () => {
  const backend = { items: [SNOWBOARD, GIFT] };
  const first = await mount({ backend });
  await first.rows()[1].find(".kw-row__remove").click();
  await tick();

  const refreshed = await mount({ backend });
  assert.equal(refreshed.rows().length, 1);
  assert.equal(refreshed.count.textContent, "(1 Item)");
  assert.equal(text(refreshed.rows()[0], ".kw-row__title"), "Snowboard");
});

test("an empty wishlist and an API load failure both render a clear state", async () => {
  const empty = await mount({ backend: { items: [] } });
  assert.ok(empty.pageBody.find(".kw-empty"));
  assert.equal(empty.count.textContent, "(0 Items)");

  const broken = await mount({ backend: { items: [SNOWBOARD] }, readyError: true });
  assert.equal(broken.rows().length, 0);
  assert.equal(broken.pageBody.textContent, "We could not load your wishlist.");
  assert.equal(broken.select.hidden, true);
});

test("Select mode: bulk add sends only purchasable rows, bulk remove removes the chosen rows", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT, SHIRT] } });
  const table = page.pageBody.find("table");
  assert.equal(table.has("kw-table--select"), false);

  await page.select.click();
  assert.equal(table.has("kw-table--select"), true, "checkbox column shown");
  assert.equal(page.select.textContent, "Cancel");

  const [snow, gift] = page.rows();
  snow.find(".kw-check").checked = true;
  gift.find(".kw-check").checked = true;
  await snow.find(".kw-check").fire("change");

  const [add, remove] = page.pageBody.find(".kw-bulk").findAll("button");
  assert.equal(add.disabled, false);
  await add.click();
  await tick();
  assert.equal(JSON.stringify(page.log.cart), JSON.stringify([{ items: [{ id: 11, quantity: 1 }] }]), "sold-out row excluded");

  await remove.click();
  await tick();
  assert.deepEqual(page.log.requests.filter((r) => r.body.op === "remove").map((r) => r.body.productId), ["1", "2"]);
  assert.equal(page.rows().length, 1);
  assert.equal(page.count.textContent, "(1 Item)");

  await page.select.click();
  assert.equal(page.select.textContent, "Select");
});

// ---- My Wishlist page open: the one read-only page that opens a session -------------
test("opening My Wishlist sends exactly one 'open' call, with nothing in it but the operation", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT] } });
  assert.equal(page.log.opens.length, 1);
  assert.deepEqual(page.log.opens[0].body, { op: "open" }, "shop and customer come from the signed query, never from the page");
  assert.equal(page.log.requests.length, 0, "it is not an add, remove or click");
});

test("opening My Wishlist counts even when the wishlist is empty or the list fails to load", async () => {
  const empty = await mount({ backend: { items: [] } });
  assert.equal(empty.log.opens.length, 1);
  const broken = await mount({ backend: { items: [SNOWBOARD] }, readyError: true });
  assert.equal(broken.log.opens.length, 1, "the page was still opened");
});

test("a failed 'open' call is silent and does not disturb the page", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] }, openFails: true });
  assert.equal(page.log.opens.length, 1);
  assert.equal(page.rows().length, 1, "the table renders normally");
  assert.deepEqual(page.log.toasts, []);
});

test("re-running the page script does not send a second 'open'", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD] } });
  page.rerun();
  page.rerun();
  await tick();
  assert.equal(page.log.opens.length, 1);
});

test("a logged-out visitor never sends 'open'", async () => {
  const page = await mount({ loggedIn: false, backend: { items: [] } });
  assert.equal(page.log.opens.length, 0);
});

test("add, remove and click keep working alongside 'open' and are counted separately", async () => {
  const page = await mount({ backend: { items: [SNOWBOARD, GIFT] } });
  await page.rows()[1].find(".kw-row__remove").click();
  await tick();
  assert.deepEqual(page.log.requests.map((r) => r.body.op), ["remove"]);
  assert.equal(page.log.opens.length, 1);
});

// ---- My Wishlist rows are the exact saved variant ------------------------------------
const SNOW_SMALL = { productId: "1", variantId: "11", title: "Snowboard", handle: "snowboard" };
const SNOW_LARGE = { productId: "1", variantId: "12", title: "Snowboard", handle: "snowboard" };
const SHIRT_ON = { productId: "4", variantId: "41", title: "Shirt", handle: "shirt" };
const SHIRT_SOLD_OUT = { productId: "4", variantId: "42", title: "Shirt", handle: "shirt" };
const LEGACY = { productId: "4", variantId: null, title: "Shirt", handle: "shirt" };
const VANISHED = { productId: "4", variantId: "49", title: "Shirt", handle: "shirt" };
const everyText = (page) => page.pageBody.textContent;

test("a saved variant that is available shows Add to cart and never 'Choose options'", async () => {
  const page = await mount({ backend: { items: [SNOW_LARGE, SHIRT_ON] } });
  for (const row of page.rows()) {
    assert.equal(text(row, ".kw-btn-cart"), "Add to cart");
    assert.equal(row.find(".kw-btn-cart").tag, "button", "a cart button, not a link to a variant-selection page");
    assert.equal(row.find(".kw-btn-cart").disabled, false);
  }
  assert.equal(/choose options|select options/i.test(everyText(page)), false);
});

test("each row uses its own variant's price, label, image and cart id", async () => {
  const page = await mount({ backend: { items: [SNOW_SMALL, SNOW_LARGE] } });
  const [small, large] = page.rows();
  assert.equal(text(small, ".kw-row__variant"), "Small");
  assert.equal(text(large, ".kw-row__variant"), "Large");
  assert.match(text(small, ".kw-price"), /\$699\.95/);
  assert.match(text(large, ".kw-price"), /\$749\.95/, "the Large variant's own price");
  assert.equal(large.find("img").getAttribute("src") ?? large.find("img").src, "https://cdn.example/large.jpg", "the variant's own image when it has one");
  assert.equal(small.find("img").src, "https://cdn.example/s.jpg", "the product image otherwise");

  await large.find(".kw-btn-cart").click();
  await tick();
  assert.equal(JSON.stringify(page.log.cart), JSON.stringify([{ items: [{ id: 12, quantity: 1 }] }]), "the exact saved variant goes to the cart");
});

test("two saved variants of one product are two rows, and removing one leaves the other", async () => {
  const backend = { items: [SNOW_SMALL, SNOW_LARGE] };
  const page = await mount({ backend });
  assert.equal(page.rows().length, 2);
  assert.equal(page.count.textContent, "(2 Items)");
  assert.equal(page.items.size, 2, "stored per variant");

  await page.rows()[0].find(".kw-row__remove").click();
  await tick();
  assert.deepEqual(page.log.requests.at(-1).body, { op: "remove", productId: "1", variantId: "11" }, "the exact variant is removed");
  assert.deepEqual(backend.items.map((i) => i.variantId), ["12"], "the other variant is untouched");
  assert.equal(page.rows().length, 1);
  assert.equal(text(page.rows()[0], ".kw-row__variant"), "Large");
  assert.equal(page.count.textContent, "(1 Item)");
});

test("a successful Add to cart removes only the added variant from the wishlist", async () => {
  const backend = { items: [SNOW_SMALL, SNOW_LARGE] };
  const page = await mount({ backend });
  await page.rows()[1].find(".kw-btn-cart").click();
  await tick();
  assert.equal(JSON.stringify(page.log.cart), JSON.stringify([{ items: [{ id: 12, quantity: 1 }] }]));
  assert.deepEqual(page.log.requests.map((r) => r.body.op), ["cart_add", "remove"]);
  assert.ok(page.log.calls.indexOf("WISHLIST cart_add 1") > page.log.calls.indexOf("GET /cart.js"), "recorded after cart.js confirmed the add");
  assert.deepEqual(page.log.requests.filter((r) => r.body.op === "remove").map((r) => r.body.variantId), ["12"]);
  assert.deepEqual(backend.items.map((i) => i.variantId), ["11"], "the other saved variant stays");
});

test("a failed cart add keeps the exact variant on the wishlist", async () => {
  const backend = { items: [SNOW_SMALL, SNOW_LARGE] };
  const page = await mount({ backend, cart: { fail: "Nope.", failStatus: 400 } });
  await page.rows()[0].find(".kw-btn-cart").click();
  await tick();
  assert.equal(page.log.requests.filter((r) => r.body.op === "remove").length, 0);
  assert.equal(backend.items.length, 2);
  assert.equal(page.rows().length, 2);
});

test("a saved variant that is unavailable shows Notify Me and can never be added to the cart", async () => {
  const page = await mount({ backend: { items: [SHIRT_ON, SHIRT_SOLD_OUT] } });
  const [on, off] = page.rows();
  assert.equal(text(on, ".kw-btn-cart"), "Add to cart", "another variant of the same product is still buyable");
  assert.equal(text(off, ".kw-btn-cart"), "Notify Me");
  assert.equal(text(off, ".kw-stock"), "Out of stock");
  assert.equal(off.find(".kw-qty__input").disabled, true);
  assert.equal(/choose options/i.test(everyText(page)), false, "no 'Choose options' for a sold-out variant");

  await off.find(".kw-btn-cart").click();
  assert.equal(page.log.cart.length, 0, "nothing is sent for the unavailable variant");
  assert.equal(page.log.inventoryCalls.some((u) => /ids=[^&]*42/.test(u)), false, "the unavailable variant is not even looked up for stock");
});

test("an older item with no saved variant is shown safely: never matched to a variant, never added to the cart", async () => {
  const page = await mount({ backend: { items: [LEGACY] } });
  const [row] = page.rows();
  assert.equal(text(row, ".kw-stock"), "Variant not saved");
  assert.equal(text(row, ".kw-btn-cart"), "View product");
  assert.equal(row.find(".kw-btn-cart").tag, "a", "a link to the product page");
  assert.equal(row.find(".kw-btn-cart").href, "/products/shirt", "no variant is chosen for the customer");
  assert.equal(row.find(".kw-qty__input").disabled, true);
  assert.equal(row.find(".kw-line").hidden, true, "no price is implied for a variant nobody chose");
  assert.equal(text(row, ".kw-row__variant"), "", "no variant label");
  assert.equal(page.log.cart.length, 0);
  assert.equal(page.log.inventoryCalls.length, 0);

  // it can still be removed, and removal never touches variant entries
  const backend = { items: [LEGACY, SHIRT_ON] };
  const both = await mount({ backend });
  await both.rows()[0].find(".kw-row__remove").click();
  await tick();
  assert.deepEqual(both.log.requests.at(-1).body, { op: "remove", productId: "4", variantId: null });
  assert.deepEqual(backend.items.map((i) => i.variantId), ["41"]);
});

test("a saved variant that no longer exists in the product shows as unavailable, not as another variant", async () => {
  const page = await mount({ backend: { items: [VANISHED] } });
  const [row] = page.rows();
  assert.equal(text(row, ".kw-stock"), "Availability unavailable");
  assert.equal(row.find(".kw-btn-cart").disabled, true);
  assert.equal(page.log.cart.length, 0);
});

// ---- Notify Me on My Wishlist ------------------------------------------------
test("Notify Me on a sold-out saved variant sends that exact variant id and keeps it on the wishlist", async () => {
  const page = await mount({ backend: { items: [SHIRT_ON, SHIRT_SOLD_OUT] } });
  const [on, off] = page.rows();
  assert.equal(text(on, ".kw-btn-cart"), "Add to cart", "available variant keeps Add to cart");
  await off.find(".kw-btn-cart").click();
  await tick();
  assert.deepEqual(page.log.notify, [{ op: "subscribe", variantId: "42", storefrontSoldOut: false }], "only the exact saved variant id is sent, with no claim about the storefront (this page has not read it)");
  assert.equal(page.rows().length, 2, "the product stays on the wishlist");
  assert.equal(page.log.requests.filter((r) => r.body.op === "remove").length, 0, "nothing is removed");
  assert.equal(page.items.size, 2);
  assert.equal(text(off, ".kw-btn-cart"), "You're on the list!");
  assert.equal(off.find(".kw-btn-cart").disabled, true);
  assert.match(page.log.toasts.at(-1), /on the list/i);
  assert.equal(page.log.cart.length, 0);
});

test("repeated Notify Me clicks send one request", async () => {
  const page = await mount({ backend: { items: [SHIRT_SOLD_OUT] } });
  const [row] = page.rows();
  const button = row.find(".kw-btn-cart");
  await Promise.all([button.click(), button.click(), button.click()]);
  await tick();
  await button.click();
  await tick();
  assert.equal(page.log.notify.length, 1);
});

test("a rejected Notify Me shows the error, is never reported as success, and the item stays", async () => {
  const page = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, notify: { error: "customer_data_unavailable", status: 403 } });
  const [row] = page.rows();
  await row.find(".kw-btn-cart").click();
  await tick();
  assert.equal(page.log.notify.length, 1);
  assert.match(page.log.toasts.at(-1), /aren't available right now/i, "store-side approval problem is not blamed on the customer's email");
  assert.equal(page.log.toasts.some((t) => /on the list/i.test(t)), false);
  assert.equal(text(row, ".kw-btn-cart"), "Notify Me", "can be retried");
  assert.equal(row.find(".kw-btn-cart").disabled, false);
  assert.equal(page.rows().length, 1);
});

test("a variant the storefront now sells (a restock) is corrected to Add to cart after the server's 409", async () => {
  const shirt = PRODUCTS.shirt.variants.find((v) => v.id === 42);
  const page = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, notify: { error: "variant_available", status: 409 } });
  const [row] = page.rows();
  assert.equal(text(row, ".kw-btn-cart"), "Notify Me");
  shirt.available = true; // restocked after the page loaded
  try {
    await row.find(".kw-btn-cart").click();
    await tick();
  } finally {
    shirt.available = false;
  }
  assert.ok(page.log.productFetches.filter((h) => h === "shirt").length >= 2, "the product was re-read from the storefront");
  assert.match(page.log.toasts.at(-1), /back in stock/i);
  assert.equal(text(row, ".kw-stock"), "In stock");
  assert.equal(text(row, ".kw-btn-cart"), "Add to cart");
  assert.equal(page.rows().length, 1, "still on the wishlist");
});

test("when the server says 'available' but the storefront still says sold out, the row stays sold out: never Add to cart", async () => {
  const page = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, notify: { error: "variant_available", status: 409 } });
  const [row] = page.rows();
  await row.find(".kw-btn-cart").click();
  await tick();
  assert.equal(text(row, ".kw-stock"), "Out of stock", "the storefront's answer is what is shown");
  assert.equal(text(row, ".kw-btn-cart"), "Sold out");
  assert.equal(row.find(".kw-btn-cart").disabled, true);
  assert.match(page.log.toasts.at(-1), /couldn't confirm that this item is out of stock/i);
  assert.equal(page.log.toasts.some((t) => /on the list|back in stock/i.test(t)), false);
  assert.equal(page.log.cart.length, 0);
  assert.equal(page.rows().length, 1, "still on the wishlist");
  assert.equal(page.log.notify.length, 1);
});

test("a customer with no email on file gets the email message", async () => {
  const page = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, notify: { error: "customer_email_unavailable", status: 422 } });
  await page.rows()[0].find(".kw-btn-cart").click();
  await tick();
  assert.match(page.log.toasts.at(-1), /email address/i);
});

// ---- persistent subscription state on My Wishlist ------------------------------------
test("a variant the customer is already subscribed to shows the on-the-list state and cannot be requested again; another variant does not", async () => {
  const subscribed = new Set(["42", "999"]);
  const sibling = { productId: "6", variantId: "22", title: "Gift Card", handle: "gift-card" };
  const page = await mount({ backend: { items: [SHIRT_SOLD_OUT, sibling] }, subscribed });
  const [shirt, gift] = page.rows();
  assert.equal(text(shirt, ".kw-btn-cart"), "You're on the list!");
  assert.equal(shirt.find(".kw-btn-cart").disabled, true);
  assert.equal(text(gift, ".kw-btn-cart"), "Notify Me", "a different variant is unaffected");
  assert.equal(gift.find(".kw-btn-cart").disabled, false);
  await shirt.find(".kw-btn-cart").click();
  assert.equal(page.log.notify.length, 0);
  assert.deepEqual(
    page.log.status.map((u) => new URL(u, "https://x.test").searchParams.get("ids").split(",").sort()),
    [["22", "42"]],
    "one status request, only for the sold-out rows",
  );
});

test("subscribing on My Wishlist is still shown after a reload, from the server's record", async () => {
  const subscribed = new Set();
  const backend = { items: [SHIRT_SOLD_OUT] };
  const first = await mount({ backend, subscribed });
  await first.rows()[0].find(".kw-btn-cart").click();
  await tick();
  assert.equal(text(first.rows()[0], ".kw-btn-cart"), "You're on the list!");
  assert.equal(first.log.toasts.at(-1), "You're on the list!");
  const second = await mount({ backend, subscribed });
  assert.equal(text(second.rows()[0], ".kw-btn-cart"), "You're on the list!");
  assert.equal(second.log.notify.length, 0);
});

test("if the status cannot be loaded My Wishlist does not claim a subscription", async () => {
  const page = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, subscribed: new Set(["42"]), statusFails: true });
  assert.equal(text(page.rows()[0], ".kw-btn-cart"), "Notify Me");
  assert.equal(page.rows()[0].find(".kw-btn-cart").disabled, false);
});

test("the product copy kept in the tab expires: stale stock data is refetched, fresh data is reused", async () => {
  // A copy that wrongly says the sold-out variant 42 is available.
  const stale = { id: "4", title: "Shirt", handle: "shirt", image: null, available: true, price: 2500, compareAt: null, defaultVariantId: "42", variants: [{ id: "42", title: "L", available: true, price: 2500, compareAt: null, image: null }] };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

  store.set("kw:p5:shirt", JSON.stringify({ at: Date.now() - 5 * 60 * 1000, product: stale }));
  const old = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, storage });
  assert.ok(old.log.productFetches.includes("shirt"), "an old copy is not trusted");
  assert.equal(text(old.rows()[0], ".kw-stock"), "Out of stock", "the real, current data is shown");

  const fresh = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, storage });
  assert.equal(fresh.log.productFetches.includes("shirt"), false, "a copy from moments ago is reused");

  store.clear();
  store.set("kw:p4:shirt", JSON.stringify(stale));
  const legacy = await mount({ backend: { items: [SHIRT_SOLD_OUT] }, storage });
  assert.ok(legacy.log.productFetches.includes("shirt"), "the old never-expiring cache entries are ignored");
  assert.equal(text(legacy.rows()[0], ".kw-stock"), "Out of stock");
});
