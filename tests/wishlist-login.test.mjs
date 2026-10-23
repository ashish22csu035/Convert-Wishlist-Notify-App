// Tests for the logged-out wishlist flow: remember the product, go to the store's
// login page, and finish the save after login (extensions/konvert-wishlist/assets).
//
// Run: node --test tests/wishlist-login.test.mjs
//
// The real konvert-wishlist.js and konvert-wishlist-extras.js run in a node:vm
// context against a tiny stub DOM, a stub login state, a stub wishlist API and
// stub product JSON. Shopify's real login pages cannot be exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const MAIN = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.js", "utf8");
const EXTRAS = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");

// ---- minimal DOM ---------------------------------------------------------------
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
    this.innerHTML = "";
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
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
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
  closest(sel) {
    for (let node = this; node; node = node.parent) if (node.matches(sel)) return node;
    return null;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  matches(sel) {
    if (sel.startsWith(".")) return this.has(sel.slice(1));
    const m = /^([a-z]*)\[([\w-]+)\]$/.exec(sel);
    if (m) return (!m[1] || this.tag === m[1]) && m[2] in this.attrs;
    return /^[a-z]+$/.test(sel) ? this.tag === sel : false;
  }
  find(sel) {
    return this.all().find((n) => n.matches(sel)) ?? null;
  }
  findAll(sel) {
    return this.all().filter((n) => n.matches(sel));
  }
  querySelector(sel) {
    return this.find(sel);
  }
  querySelectorAll(sel) {
    return this.findAll(sel);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

// ---- storefront simulation -----------------------------------------------------
const PRODUCTS = {
  snowboard: { id: 101, title: "Snowboard", handle: "snowboard", featured_image: null, available: true, price: 69995, variants: [{ id: 11, available: true, price: 69995 }] },
  "ski-wax": { id: 102, title: "Ski Wax", handle: "ski-wax", featured_image: null, available: true, price: 1500, variants: [{ id: 21, available: true, price: 1500 }] },
};

function newBrowser() {
  const store = new Map();
  return {
    storage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    store,
  };
}

// backend  = { items: [{ productId, ... }] } the signed-in customer's wishlist (persists across mounts)
// browser  = this tab's sessionStorage (persists across mounts, like a reload / login round trip)
async function mount({
  loggedIn = false,
  backend = { items: [] },
  browser = newBrowser(),
  path = "/products/snowboard",
  search = "",
  loginUrl = "/customer_authentication/login",
  button = "product",
  withButton = true,
  storageBroken = false,
  extrasFails = false,
  addStatus = 200,
} = {}) {
  const body = new Dom("body");
  const head = new Dom("head");

  const config = new Dom("script");
  config.attrs["data-kw-config"] = "";
  config.textContent = JSON.stringify({
    loggedIn,
    apiPath: "/apps/konvert-notify/api/wishlist",
    loginUrl,
    extrasUrl: "https://cdn.example/konvert-wishlist-extras.js",
    headerIcon: false,
    collectionCards: false,
    text: {
      add: "Add to wishlist", saved: "Saved to wishlist", loginPrompt: "Log in to save items to your wishlist.",
      loginLink: "Log in", close: "Close", full: "Wishlist full", error: "Something went wrong.",
      loginRedirect: "Please log in to save this to your wishlist.",
      loginStillRequired: "Please log in to finish saving this item to your wishlist.",
      savedAfterLogin: "Saved to your wishlist.",
    },
  });
  body.appendChild(config);

  const target = new Dom("button");
  target.attrs["data-kw-button"] = "";
  if (button === "product") {
    target.className = "kw-btn kw-btn--product";
    target.attrs["data-kw-product-id"] = "101";
    target.attrs["data-kw-handle"] = "snowboard";
    target.attrs["data-kw-title"] = "Snowboard";
    target.attrs["data-kw-variant-id"] = "11";
  } else {
    target.className = "kw-btn kw-btn--card";
    target.attrs["data-kw-handle"] = "ski-wax";
    target.attrs["aria-pressed"] = "false";
  }
  const label = new Dom("span");
  label.attrs["data-kw-label"] = "";
  label.textContent = "Add to wishlist";
  target.appendChild(label);
  if (withButton) body.appendChild(target);

  const badge = new Dom("span");
  badge.className = "kw-header-icon__count";
  badge.hidden = true;
  body.appendChild(badge);
  const icon = new Dom("a");
  icon.className = "kw-header-icon";
  body.appendChild(icon);

  const log = { requests: [], assigned: [], extrasLoads: 0 };
  const listeners = {};
  let win;

  const document = {
    readyState: "complete",
    documentElement: { lang: "en" },
    body,
    head,
    createElement: (tag) => new Dom(tag),
    querySelector: (sel) => body.find(sel),
    querySelectorAll: (sel) => body.findAll(sel),
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
    dispatchEvent() {},
  };
  // Appending the extras <script> runs the real extras file, like the browser would.
  head.appendChild = (node) => {
    Dom.prototype.appendChild.call(head, node);
    if (node.tag === "script" && node.src === undefined && node.attrs.src === undefined) return node;
    return node;
  };
  const originalCreate = document.createElement;
  document.createElement = (tag) => {
    const node = originalCreate(tag);
    if (tag === "script") {
      Object.defineProperty(node, "src", {
        set(v) {
          node._src = v;
        },
        get: () => node._src,
      });
    }
    return node;
  };
  const baseAppend = Dom.prototype.appendChild;
  head.appendChild = (node) => {
    baseAppend.call(head, node);
    if (node.tag === "script" && node._src) {
      log.extrasLoads += 1;
      setTimeout(() => {
        if (extrasFails) node.onerror?.(new Error("load failed"));
        else {
          vm.runInContext(EXTRAS, context);
          node.onload?.();
        }
      }, 0);
    }
    return node;
  };

  const storage = storageBroken
    ? {
        getItem() { throw new Error("blocked"); },
        setItem() { throw new Error("blocked"); },
        removeItem() { throw new Error("blocked"); },
      }
    : browser.storage;

  win = {
    Shopify: { routes: { root: "/" }, currency: { active: "USD" } },
    location: {
      origin: "https://shop.example",
      pathname: path,
      search,
      assign: (url) => log.assigned.push(url),
    },
    sessionStorage: storage,
    addEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    console: { warn() {}, log() {} },
  };

  async function fetchStub(url, init = {}) {
    if (url === "/apps/konvert-notify/api/wishlist") {
      const method = init.method || "GET";
      const payload = init.body ? JSON.parse(init.body) : null;
      log.requests.push({ method, body: payload });
      if (method === "GET") {
        return { ok: true, status: 200, json: async () => ({ loggedIn, items: loggedIn ? backend.items : [], count: backend.items.length }) };
      }
      if (!loggedIn) return { ok: false, status: 401, json: async () => ({ error: "login_required" }) };
      if (addStatus !== 200) return { ok: false, status: addStatus, json: async () => ({ error: "server_error" }) };
      if (payload.op === "add") {
        const exists = backend.items.some((i) => i.productId === String(payload.productId));
        if (!exists) {
          backend.items.push({ productId: String(payload.productId), variantId: payload.variantId, title: payload.title, handle: payload.handle });
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, saved: true, changed: !exists, count: backend.items.length }) };
      }
    }
    const handle = /products\/([^./?]+)\.js/.exec(url)?.[1];
    if (handle && PRODUCTS[handle]) return { ok: true, status: 200, json: async () => PRODUCTS[handle] };
    return { ok: false, status: 404, json: async () => ({}) };
  }

  const context = vm.createContext({
    window: win, document, fetch: fetchStub, URL, URLSearchParams, Intl, setTimeout, clearTimeout, console,
    Promise, Map, JSON, Error, encodeURIComponent, decodeURIComponent, Date, parseInt, RegExp, Boolean, String, Number,
  });
  vm.runInContext(MAIN, context);
  await settle();

  const click = async () => {
    for (const fn of listeners.click || []) fn({ target: target, preventDefault() {}, stopPropagation() {} });
    await settle();
  };
  const toasts = () => body.findAll(".kw-toast");
  return { target, label, badge, log, click, toasts, body, browser, backend, storage, context, runExtras: () => vm.runInContext(EXTRAS, context) };
}

const pending = (browser) => JSON.parse(browser.store.get("kw:pending") ?? "null");
const addRequests = (page) => page.log.requests.filter((r) => r.method === "POST" && r.body.op === "add");

// ---- logged-out click ----------------------------------------------------------
test("logged-out click on the product page: remembers product + variant, shows a message, goes to the store login with a safe return path", async () => {
  const page = await mount({ path: "/products/snowboard", search: "?variant=11" });
  await page.click();

  const saved = pending(page.browser);
  assert.equal(saved.h, "snowboard");
  assert.equal(saved.v, "11", "the variant chosen on the page is kept");
  assert.deepEqual(Object.keys(saved).sort(), ["h", "t", "v"], "only handle, variant and a timestamp: no customer data");

  assert.equal(page.log.assigned.length, 1);
  assert.equal(
    page.log.assigned[0],
    "/customer_authentication/login?return_url=" + encodeURIComponent("/products/snowboard?variant=11")
  );
  assert.equal(addRequests(page).length, 0, "nothing is written to the wishlist while logged out");
  assert.equal(page.toasts().length, 1);
  assert.match(page.toasts()[0].textContent, /Please log in to save this to your wishlist/);
  assert.equal(page.toasts()[0].find("a").href.startsWith("/customer_authentication/login?return_url="), true, "fallback login link in the message");
  assert.equal(page.target.attrs["aria-busy"], "true", "loading state while redirecting");
  assert.equal(JSON.stringify(page.log.requests).includes("customer"), false, "no identity in any API request");
});

test("logged-out click on a collection heart remembers the product handle", async () => {
  const page = await mount({ button: "card", path: "/collections/all", search: "?page=2" });
  await page.click();
  assert.deepEqual({ h: pending(page.browser).h, v: pending(page.browser).v }, { h: "ski-wax", v: null });
  assert.equal(page.log.assigned[0], "/customer_authentication/login?return_url=" + encodeURIComponent("/collections/all?page=2"));
});

test("the return URL can never leave the store", async () => {
  for (const path of ["//evil.example/phish", "/\\evil.example", "evil"]) {
    const page = await mount({ path });
    await page.click();
    assert.equal(page.log.assigned[0], "/customer_authentication/login?return_url=%2F", "unsafe path becomes '/': " + path);
  }
  const crossOrigin = await mount({ loginUrl: "https://evil.example/login" });
  await crossOrigin.click();
  assert.equal(crossOrigin.log.assigned[0].startsWith("/account/login?return_url="), true, "login URL on another origin is ignored");
});

test("values that are not a plain handle / numeric variant are never stored", async () => {
  const page = await mount({});
  page.target.attrs["data-kw-handle"] = "../../etc/passwd";
  await page.click();
  assert.equal(pending(page.browser), null, "invalid handle is not remembered");
  assert.equal(page.log.assigned.length, 1, "the customer is still sent to log in");

  const variant = await mount({ search: "?variant=abc;drop" });
  variant.target.attrs["data-kw-variant-id"] = "x1";
  await variant.click();
  assert.equal(pending(variant.browser).v, null, "non-numeric variant is dropped");
});

test("blocked sessionStorage or a failed extras download still sends the customer to log in", async () => {
  const blocked = await mount({ storageBroken: true });
  await blocked.click();
  assert.equal(blocked.log.assigned.length, 1);

  const offline = await mount({ extrasFails: true, loginUrl: "/account/login" });
  await offline.click();
  assert.deepEqual(offline.log.assigned, ["/account/login"], "plain redirect fallback");
});

// ---- after login ---------------------------------------------------------------
test("after login the remembered product is added once, the saved state and header count update, and the intent is cleared", async () => {
  const browser = newBrowser();
  const loggedOut = await mount({ browser, path: "/products/snowboard", search: "?variant=11" });
  await loggedOut.click(); // customer leaves for the login page; the tab keeps its sessionStorage

  const backend = { items: [] };
  const back = await mount({ loggedIn: true, browser, backend, path: "/products/snowboard", search: "?variant=11" });
  assert.equal(addRequests(back).length, 1, "exactly one add");
  assert.deepEqual(addRequests(back)[0].body, { op: "add", productId: "101", variantId: "11", handle: "snowboard", title: "Snowboard" });
  assert.equal(backend.items.length, 1);
  assert.equal(back.target.attrs["aria-pressed"], "true");
  assert.equal(back.label.textContent, "Saved to wishlist");
  assert.equal(back.badge.textContent, "1");
  assert.equal(back.badge.hidden, false);
  assert.equal(pending(browser), null, "intent cleared so it cannot run again");
  assert.match(back.toasts()[0].textContent, /Saved to your wishlist/);
  assert.equal(back.target.attrs["aria-busy"], "false");
  assert.equal(JSON.stringify(addRequests(back)[0].body).match(/customer|shop|actor/i), null, "no identity fields in the request");
});

test("a collection heart is resolved by handle after login and shown as saved", async () => {
  const browser = newBrowser();
  const out = await mount({ browser, button: "card", path: "/collections/all" });
  await out.click();
  const backend = { items: [] };
  const back = await mount({ loggedIn: true, browser, backend, button: "card", path: "/collections/all" });
  assert.deepEqual(addRequests(back)[0].body, { op: "add", productId: "102", variantId: "21", handle: "ski-wax", title: "Ski Wax" }, "a card heart saves the first available variant");
  assert.equal(back.target.attrs["aria-pressed"], "true");
  assert.equal(back.badge.textContent, "1");
});

test("reloading after login never adds the product again", async () => {
  const browser = newBrowser();
  const out = await mount({ browser });
  await out.click();
  const backend = { items: [] };
  const first = await mount({ loggedIn: true, browser, backend });
  assert.equal(addRequests(first).length, 1);

  const reload = await mount({ loggedIn: true, browser, backend });
  assert.equal(addRequests(reload).length, 0, "no second write after a refresh");
  assert.equal(backend.items.length, 1, "still exactly one entry");
  assert.equal(reload.target.attrs["aria-pressed"], "true", "saved state comes from the backend list");
});

test("a product the customer already saved is not written again", async () => {
  const browser = newBrowser();
  await (await mount({ browser })).click();
  const backend = { items: [{ productId: "101", variantId: "11", title: "Snowboard", handle: "snowboard" }] };
  const back = await mount({ loggedIn: true, browser, backend });
  assert.equal(addRequests(back).length, 0);
  assert.equal(backend.items.length, 1);
  assert.equal(back.target.attrs["aria-pressed"], "true");
  assert.match(back.toasts()[0].textContent, /Saved to your wishlist/);
});

test("still logged out when they come back (login cancelled or failed): nothing is added and they are asked to log in again", async () => {
  const browser = newBrowser();
  await (await mount({ browser })).click();
  const back = await mount({ loggedIn: false, browser });
  assert.equal(addRequests(back).length, 0, "nothing saved");
  assert.match(back.toasts()[0].textContent, /Please log in to finish saving this item/);
  assert.equal(back.toasts()[0].find("a").textContent, "Log in");
  assert.notEqual(pending(browser), null, "the intended product is kept for the login window");
  assert.equal(back.log.assigned.length, 0, "no automatic redirect, so no redirect loop");
});

test("expired or forged remembered values are ignored and removed", async () => {
  const stale = newBrowser();
  stale.store.set("kw:pending", JSON.stringify({ h: "snowboard", v: "11", t: Date.now() - 31 * 60 * 1000 }));
  const a = await mount({ loggedIn: true, browser: stale });
  assert.equal(addRequests(a).length, 0, "older than 30 minutes");
  assert.equal(stale.store.has("kw:pending"), false);

  const forged = newBrowser();
  forged.store.set("kw:pending", JSON.stringify({ h: "x/../y", v: "11", t: Date.now() }));
  const b = await mount({ loggedIn: true, browser: forged });
  assert.equal(addRequests(b).length, 0);

  const future = newBrowser();
  future.store.set("kw:pending", JSON.stringify({ h: "snowboard", v: null, t: Date.now() + 3600 * 1000 }));
  assert.equal(addRequests(await mount({ loggedIn: true, browser: future })).length, 0);

  const garbage = newBrowser();
  garbage.store.set("kw:pending", "{not json");
  assert.equal(addRequests(await mount({ loggedIn: true, browser: garbage })).length, 0);
});

test("a failed save after login shows an error and is not retried on reload", async () => {
  const browser = newBrowser();
  await (await mount({ browser })).click();
  const failing = await mount({ loggedIn: true, browser, addStatus: 500 });
  assert.equal(addRequests(failing).length, 1);
  assert.match(failing.toasts()[0].textContent, /Something went wrong/);
  assert.equal(failing.target.attrs["aria-pressed"], "false", "no false 'saved' state");
  assert.equal(failing.target.attrs["aria-busy"], "false");

  const reload = await mount({ loggedIn: true, browser });
  assert.equal(addRequests(reload).length, 0, "no automatic retry loop");
});

test("if the server says the visitor is not logged in, they are prompted again and nothing is shown as saved", async () => {
  const browser = newBrowser();
  await (await mount({ browser })).click();
  const page = await mount({ loggedIn: true, browser, addStatus: 401 });
  assert.match(page.toasts()[0].textContent, /Log in to save items/);
  assert.equal(page.target.attrs["aria-pressed"], "false");
});

test("logged-in visitors keep the normal behaviour: no redirect, direct add", async () => {
  const backend = { items: [] };
  const page = await mount({ loggedIn: true, backend });
  await page.click();
  assert.equal(page.log.assigned.length, 0);
  assert.equal(addRequests(page).length, 1);
  assert.equal(backend.items.length, 1);
  assert.equal(page.target.attrs["aria-pressed"], "true");
});

// ---- browsing must not track: sessions are for wishlist engagement only ------------
const everyPost = (page) => page.log.requests.filter((r) => r.method === "POST");

test("ordinary storefront pages send no wishlist write for a logged-in customer, with the hearts loaded but untouched", async () => {
  for (const [path, button] of [["/", "product"], ["/products/snowboard", "product"], ["/collections/all", "card"], ["/collections/all", "product"]]) {
    const page = await mount({ loggedIn: true, path, button });
    assert.equal(everyPost(page).length, 0, `no POST of any kind on ${path} (${button})`);
    assert.ok(page.log.requests.every((r) => r.method === "GET"), "the only call is the read-only list that shows saved hearts");
    assert.equal(page.target.attrs["aria-pressed"], button === "product" ? "false" : "false", "controls render, untouched");
  }
});

test("the extras script is only downloaded where a wishlist control or the header icon needs it", async () => {
  const withButton = await mount({ loggedIn: true });
  assert.equal(withButton.log.extrasLoads, 1, "a page with a wishlist button loads it, once");

  const nothingToDo = await mount({ loggedIn: true, withButton: false });
  assert.equal(nothingToDo.log.extrasLoads, 0, "a page with no wishlist control (and no header icon) downloads nothing extra");
});

test("logged-out pages send no request at all", async () => {
  for (const path of ["/", "/products/snowboard", "/collections/all"]) {
    const page = await mount({ loggedIn: false, path });
    assert.equal(page.log.requests.length, 0, path);
  }
});

test("re-initialising the scripts never writes anything", async () => {
  const page = await mount({ loggedIn: true });
  page.runExtras();
  page.runExtras();
  await settle();
  assert.equal(everyPost(page).length, 0);
});

test("a heart click is what writes: one add request, and nothing else", async () => {
  const backend = { items: [] };
  const page = await mount({ loggedIn: true, backend });
  assert.equal(everyPost(page).length, 0, "before the click");
  await page.click();
  assert.deepEqual(everyPost(page).map((r) => r.body.op), ["add"]);
  assert.equal(backend.items.length, 1);
});
