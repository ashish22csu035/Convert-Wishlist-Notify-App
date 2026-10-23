// Regression tests for the collection hearts and the header icon on mobile.
//
// Run: node --test tests/wishlist-cards.test.mjs
//
// The real konvert-wishlist.js and konvert-wishlist-extras.js run in a node:vm
// context against a small stub DOM that understands the selectors the scripts use
// (tags, classes, ids, attribute operators, descendant combinators, lists).
// Layout (stacking, sizes) is stubbed where a test needs it; the actual rendering
// was checked in headless Chrome and must be re-checked in a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const MAIN = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.js", "utf8");
const EXTRAS = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");
// The text the extension really ships, so the accessible name below is the real one.
const LOCALE = JSON.parse(fs.readFileSync("extensions/konvert-wishlist/locales/en.default.json", "utf8")).kw;

// ---- selector engine -----------------------------------------------------------
function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const token = /^(?:([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)"?([^\]"]*)"?)?\])/;
  let rest = text;
  while (rest) {
    const m = token.exec(rest);
    if (!m) throw new Error("unsupported selector: " + text);
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else out.attrs.push({ name: m[4], op: m[5] ?? null, value: m[6] ?? null });
    rest = rest.slice(m[0].length);
  }
  return out;
}
function matchesCompound(node, c) {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.id && node.attrs.id !== c.id) return false;
  if (!c.classes.every((cls) => node.has(cls))) return false;
  return c.attrs.every(({ name, op, value }) => {
    if (!(name in node.attrs)) return false;
    const actual = node.attrs[name];
    if (!op) return true;
    if (op === "=") return actual === value;
    if (op === "*=") return actual.includes(value);
    if (op === "^=") return actual.startsWith(value);
    return actual.endsWith(value);
  });
}
function matchesSelector(node, selector) {
  return selector.split(",").some((part) => {
    const compounds = part.trim().split(/\s+/).map(parseCompound);
    if (!matchesCompound(node, compounds.at(-1))) return false;
    let index = compounds.length - 2;
    for (let up = node.parent; up && index >= 0; up = up.parent) {
      if (matchesCompound(up, compounds[index])) index -= 1;
    }
    return index < 0;
  });
}

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
    this.style = {};
    this.rectOverride = null;
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
  get parentNode() {
    return this.parent;
  }
  appendChild(node) {
    node.remove();
    node.parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    node.remove();
    node.parent = this;
    const at = this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
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
    for (let n = this; n; n = n.parent) if (matchesSelector(n, sel)) return n;
    return null;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelector(sel) {
    return this.all().find((n) => matchesSelector(n, sel)) ?? null;
  }
  querySelectorAll(sel) {
    return this.all().filter((n) => matchesSelector(n, sel));
  }
  getBoundingClientRect() {
    const r = this.rectOverride ? this.rectOverride() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return r;
  }
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const el = (tag, className = "", attrs = {}) => {
  const node = new Dom(tag);
  node.className = className;
  Object.assign(node.attrs, attrs);
  return node;
};

// A Dawn-like product card: li > div.card-wrapper > div.card > (div.card__inner > img) + div.card__content > h3 > a
function productCard(handle, { withMedia = true } = {}) {
  const li = el("li", "grid__item");
  const wrapper = li.appendChild(el("div", "card-wrapper"));
  const card = wrapper.appendChild(el("div", "card"));
  if (withMedia) {
    const inner = card.appendChild(el("div", "card__inner"));
    inner.appendChild(el("img", "", { src: `/${handle}.jpg` }));
  }
  const content = card.appendChild(el("div", "card__content"));
  const heading = content.appendChild(el("h3", "card__heading"));
  heading.appendChild(el("a", "", { href: `/products/${handle}` }));
  return { li, wrapper, card };
}

// ---- storefront -----------------------------------------------------------------
async function mount({ pageType = "collection", collectionCards = true, headerIcon = false, loggedIn = false, withCart = true, headerHeightWithIcon: initialHeaderHeight = 60, tightHeight = null, compactHeight = null, headerColumns = "1fr 2fr 1fr", withDrawer = true, withIconRow = true, withHeader = true } = {}) {
  const body = new Dom("body");
  const headTag = new Dom("head");
  let headerHeightWithIcon = initialHeaderHeight;

  const config = el("script", "", { "data-kw-config": "" });
  config.textContent = JSON.stringify({
    loggedIn, apiPath: "/apps/konvert-notify/api/wishlist", pagePath: "/apps/konvert-notify/my-wishlist",
    loginUrl: "/account/login", extrasUrl: "https://cdn.example/extras.js", headerIcon, collectionCards, pageType,
    text: { add: "Add to wishlist", saved: "Saved", headerLabel: LOCALE.header_label, close: "Close", error: "Error", loginLink: "Log in" },
  });
  body.appendChild(config);

  // The theme header: a menu link to a product (must be ignored), Dawn's mobile
  // drawer (header-drawer > details > summary.header__icon--menu + ul.menu-drawer__menu),
  // a logo and the icon row with the cart link.
  let current = null;
  function buildHeader() {
    const h = el("header", "header");
    const n = h.appendChild(el("nav"));
    n.appendChild(el("a", "", { href: "/products/menu-featured" }));
    let list = null;
    let button = null;
    if (withDrawer) {
      const wrap = h.appendChild(el("header-drawer"));
      const details = wrap.appendChild(el("details", "menu-drawer-container"));
      button = details.appendChild(el("summary", "header__icon header__icon--menu"));
      button.rectOverride = () => ({ left: 0, top: 8, right: 44, bottom: 52, width: 44, height: 44 });
      const panel = details.appendChild(el("div", "menu-drawer"));
      list = panel.appendChild(el("nav", "menu-drawer__navigation")).appendChild(el("ul", "menu-drawer__menu"));
      list.appendChild(el("li")).appendChild(el("a", "menu-drawer__menu-item", { href: "/collections/all" }));
    }
    const lg = h.appendChild(el("a", "logo", { href: "/" }));
    const ic = withIconRow ? h.appendChild(el("div", "header__icons")) : null;
    const ct = withCart && ic ? ic.appendChild(el("a", "", { href: "/cart", id: "cart-icon-bubble" })) : null;
    // Header geometry for the placement checks. With the wishlist icon inside, the header is
    // headerHeightWithIcon tall; after the grid adjustment (tight) it is tightHeight, after the
    // padding step (compact) it is compactHeight. Without the icon it is the theme's own 60.
    h.gridColumns = headerColumns;
    h.rectOverride = () => {
      const base = h.querySelector(".kw-header-icon") ? headerHeightWithIcon : 60;
      const tight = tightHeight ?? headerHeightWithIcon;
      const compact = compactHeight ?? tight;
      const height = !h.querySelector(".kw-header-icon") ? 60 : h.has("kw-header--compact") ? compact : h.has("kw-header--tight") ? tight : base;
      return { left: 0, top: 0, right: 400, bottom: height, width: 400, height };
    };
    h.scrollWidth = 400;
    h.clientWidth = 400;
    return { header: h, nav: n, logo: lg, icons: ic, cart: ct, drawerList: list, menuButton: button };
  }
  current = buildHeader();
  if (withHeader) body.appendChild(current.header);

  const main = body.appendChild(el("main", "", { id: "MainContent" }));
  const grid = main.appendChild(el("ul", "grid"));

  // a cart drawer that lives outside <main> and lists products
  const drawer = body.appendChild(el("cart-drawer"));
  drawer.appendChild(el("a", "", { href: "/products/in-cart" }));
  const footer = body.appendChild(el("footer"));
  footer.appendChild(el("a", "", { href: "/products/footer-link" }));

  const observers = [];
  const documentListeners = {};
  const resizeListeners = [];
  const sizeObservers = [];
  const win = {
    location: { origin: "https://shop.example", pathname: "/collections/all", search: "", assign() {} },
    Shopify: { routes: { root: "/" }, currency: { active: "USD" } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    console: { warn() {}, log() {} },
    getComputedStyle: (node) => ({
      position: node.style.position ?? "static",
      visibility: node.style.visibility ?? "visible",
      display: node.tag === "header" ? "grid" : "block",
      gridTemplateColumns: node.gridColumns ?? "",
    }),
    MutationObserver: class {
      constructor(cb) {
        observers.push(cb);
      }
      observe() {}
    },
    addEventListener: (type, fn) => {
      if (type === "resize") resizeListeners.push(fn);
    },
    ResizeObserver: class {
      constructor(cb) {
        sizeObservers.push(cb);
      }
      observe() {}
    },
  };
  const document = {
    readyState: "complete",
    documentElement: { lang: "en", clientWidth: 400 },
    body,
    head: headTag,
    createElement: (tag) => new Dom(tag),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (type, fn) => (documentListeners[type] ||= []).push(fn),
    getElementById: (id) => body.querySelector(`#${id}`),
  };
  const context = vm.createContext({
    window: win, document, fetch: async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }),
    URL, URLSearchParams, Promise, Map, JSON, Error, Date, parseInt, RegExp, Boolean, String, Number, Object, Array, Intl,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, console, Math,
    MutationObserver: win.MutationObserver, // in a browser window is the global object
    ResizeObserver: win.ResizeObserver,
  });
  // loading the extras <script> runs the real extras file
  headTag.appendChild = (node) => {
    Dom.prototype.appendChild.call(headTag, node);
    if (node.tag === "script") {
      setTimeout(() => {
        vm.runInContext(EXTRAS, context);
        node.onload?.();
      }, 0);
    }
    return node;
  };
  const origCreate = document.createElement;
  document.createElement = (tag) => {
    const node = origCreate(tag);
    if (tag === "script") Object.defineProperty(node, "src", { set(v) { node._src = v; }, get: () => node._src });
    return node;
  };

  const api = {
    body, main, grid, drawer, footer, win, context, observers, resizeListeners, sizeObservers, document,
    get header() { return current.header; },
    get nav() { return current.nav; },
    get icons() { return current.icons; },
    get cart() { return current.cart; },
    get logo() { return current.logo; },
    get drawerList() { return current.drawerList; },
    get menuButton() { return current.menuButton; },
    // the theme re-renders its header section: a new header replaces the old one
    reloadHeader: () => {
      const old = current.header;
      const fresh = buildHeader();
      body.insertBefore(fresh.header, old);
      old.remove();
      current = fresh;
    },
    setHeaderHeightWithIcon: (value) => {
      headerHeightWithIcon = value;
    },
    addCards: (...handles) => handles.map((h) => {
      const c = productCard(h);
      grid.appendChild(c.li);
      return c;
    }),
    start: async () => {
      vm.runInContext(MAIN, context);
      await tick(30);
    },
    hearts: () => body.querySelectorAll(".kw-btn--card"),
    // dispatches a click the way the browser would, returning what the page's handlers did to it
    click: (target) => {
      const event = { target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      for (const fn of documentListeners.click || []) fn(event);
      return event;
    },
  };
  return api;
}

// ---- collection hearts ----------------------------------------------------------
test("hearts are attached only to product cards inside <main>, never to header, nav, footer or cart-drawer links", async () => {
  const page = await mount();
  page.addCards("snowboard", "ski-wax", "shirt");
  await page.start();

  assert.equal(page.hearts().length, 3, "one per card");
  for (const region of [page.header, page.nav, page.footer, page.drawer]) {
    assert.equal(region.querySelectorAll(".kw-btn--card").length, 0, "no heart inside " + region.tag);
  }
  assert.ok(page.hearts().every((h) => page.main.contains(h)));
});

test("each heart sits in its own card's image container, and the card becomes its own stacking context", async () => {
  const page = await mount();
  const cards = page.addCards("snowboard", "ski-wax");
  await page.start();

  cards.forEach(({ wrapper }, i) => {
    const hearts = wrapper.querySelectorAll(".kw-btn--card");
    assert.equal(hearts.length, 1, "exactly one heart per card");
    assert.equal(hearts[0].parent.has("card__inner"), true, "positioned over the image, not over the text below it");
    assert.equal(hearts[0].getAttribute("data-kw-handle"), ["snowboard", "ski-wax"][i], "bound to this card's own product");
    assert.equal(wrapper.has("kw-card-host"), true, "card isolates its stacking so the heart can never rise above a sticky header");
    assert.equal(page.win.getComputedStyle(hearts[0].parent).position, "relative", "positioned relative to the image, not the viewport");
  });
});

test("a card without an identifiable image container falls back to the card itself", async () => {
  const page = await mount();
  const c = productCard("plain", { withMedia: false });
  page.grid.appendChild(c.li);
  await page.start();
  const heart = page.hearts()[0];
  assert.ok(heart, "still gets a heart");
  assert.ok(heart.parent.has("card-wrapper") || heart.parent === c.card || heart.parent.contains(heart));
  assert.equal(c.wrapper.has("kw-card-host"), true);
});

test("containers holding several products are not treated as a single card", async () => {
  const page = await mount();
  const carousel = el("li", "grid__item");
  const wrapper = carousel.appendChild(el("div", "card-wrapper"));
  wrapper.appendChild(el("a", "", { href: "/products/one" }));
  wrapper.appendChild(el("a", "", { href: "/products/two" }));
  page.grid.appendChild(carousel);
  await page.start();
  assert.equal(page.hearts().length, 0);
});

test("re-initialising (a section reload, a second script run, repeated observer callbacks) never duplicates hearts", async () => {
  const page = await mount();
  page.addCards("snowboard", "ski-wax");
  await page.start();
  assert.equal(page.hearts().length, 2);

  // the theme re-renders the grid: brand-new cards without hearts
  page.grid.children = [];
  page.addCards("snowboard", "ski-wax", "shirt");
  for (const cb of page.observers) cb();
  for (const cb of page.observers) cb();
  await tick(300);
  assert.equal(page.hearts().length, 3, "one heart for each new card");
  page.grid.querySelectorAll(".card-wrapper").forEach((w) => assert.equal(w.querySelectorAll(".kw-btn--card").length, 1));

  // the extras script loaded again (e.g. by another block): guarded
  vm.runInContext(EXTRAS, page.context);
  await tick(300);
  assert.equal(page.hearts().length, 3);
  assert.equal(page.body.querySelectorAll(".kw-header-icon").length, 0);
});

// ---- home page "Featured products" and other pages that use the same product cards ----------
// Dawn-style Featured products markup: a section holding a product grid / slider whose items
// are the same cards as a collection page, each with a quick-add button below the image.
function featuredSection(page, handles, { slider = false } = {}) {
  const section = page.main.appendChild(el("section", "", { id: "shopify-section-featured_collection" }));
  const ul = section.appendChild(el("ul", slider ? "grid product-grid slider slider--mobile" : "grid product-grid"));
  return handles.map((handle) => {
    const c = productCard(handle);
    c.li.className = slider ? "grid__item slider__slide" : "grid__item";
    const quickAdd = c.wrapper.appendChild(el("div", "quick-add")).appendChild(el("button", "quick-add__submit"));
    ul.appendChild(c.li);
    return { ...c, quickAdd, link: c.li.querySelector("a") };
  });
}

test("home page: every Featured products card gets exactly one heart, over its image", async () => {
  const page = await mount({ pageType: "index" });
  const cards = featuredSection(page, ["snowboard", "ski-wax", "shirt", "mug"]);
  await page.start();

  assert.equal(page.hearts().length, 4, "one per card");
  cards.forEach(({ wrapper }, i) => {
    const hearts = wrapper.querySelectorAll(".kw-btn--card");
    assert.equal(hearts.length, 1, "exactly one heart in card " + i);
    assert.equal(hearts[0].parent.has("card__inner"), true, "over the product image, like collection hearts");
    assert.equal(hearts[0].getAttribute("data-kw-handle"), ["snowboard", "ski-wax", "shirt", "mug"][i]);
    assert.equal(wrapper.has("kw-card-host"), true, "own stacking context, so it can never rise above a sticky header");
  });
  for (const region of [page.header, page.nav, page.footer, page.drawer]) assert.equal(region.querySelectorAll(".kw-btn--card").length, 0);
});

test("home page: a slider (mobile) version of the Featured products section works the same", async () => {
  const page = await mount({ pageType: "index" });
  featuredSection(page, ["snowboard", "ski-wax"], { slider: true });
  await page.start();
  assert.equal(page.hearts().length, 2);
});

test("home page: links, quick-add and the heart each keep their own behaviour", async () => {
  const page = await mount({ pageType: "index" });
  const [first] = featuredSection(page, ["snowboard", "ski-wax"]);
  await page.start();
  const heart = first.wrapper.querySelector(".kw-btn--card");

  // the heart is the only control the script takes over
  const onHeart = page.click(heart);
  assert.equal(onHeart.prevented, true, "the heart click is handled by the wishlist, not by a link around it");
  assert.equal(onHeart.stopped, true);

  const onLink = page.click(first.link);
  const onQuickAdd = page.click(first.quickAdd);
  assert.equal(onLink.prevented, false, "the product link navigates normally");
  assert.equal(onQuickAdd.prevented, false, "quick-add is untouched");
  assert.equal(onLink.stopped || onQuickAdd.stopped, false);

  // none of them carries wishlist attributes, and the heart does not sit inside the link or quick-add
  assert.equal("data-kw-button" in first.link.attrs, false);
  assert.equal("data-kw-button" in first.quickAdd.attrs, false);
  assert.equal(first.link.contains(heart), false);
  assert.equal(first.quickAdd.contains(heart), false);
  assert.equal(first.wrapper.querySelectorAll(".quick-add button").length, 1, "quick-add button still there, once");
});

test("home page: re-rendering the section (theme editor, filters, 'load more') never duplicates hearts", async () => {
  const page = await mount({ pageType: "index" });
  featuredSection(page, ["snowboard", "ski-wax"]);
  await page.start();
  assert.equal(page.hearts().length, 2);

  // the theme replaces the whole section with fresh cards, and adds one
  page.main.children = [];
  featuredSection(page, ["snowboard", "ski-wax", "shirt"]);
  for (const cb of page.observers) cb();
  for (const cb of page.observers) cb();
  await tick(300);
  assert.equal(page.hearts().length, 3);
  page.main.querySelectorAll(".card-wrapper").forEach((w) => assert.equal(w.querySelectorAll(".kw-btn--card").length, 1));

  vm.runInContext(EXTRAS, page.context); // another block loads the script again
  for (const cb of page.observers) cb();
  await tick(300);
  assert.equal(page.hearts().length, 3);
});

test("home page: a banner link to a product that is not a product card gets no heart", async () => {
  const page = await mount({ pageType: "index" });
  const banner = page.main.appendChild(el("div", "banner"));
  banner.appendChild(el("a", "", { href: "/products/snowboard" }));
  await page.start();
  assert.equal(page.hearts().length, 0);
});

test("search results and product-page recommendations use hearts too, but never on the page's own product", async () => {
  const search = await mount({ pageType: "search" });
  featuredSection(search, ["snowboard", "ski-wax"]);
  await search.start();
  assert.equal(search.hearts().length, 2);

  const product = await mount({ pageType: "product" });
  const own = product.main.appendChild(el("button", "kw-btn kw-btn--product", { "data-kw-button": "", "data-kw-handle": "snowboard", "data-kw-product-id": "1", "data-kw-title": "Snowboard" }));
  featuredSection(product, ["snowboard", "ski-wax", "shirt"]); // "You may also like": includes a card for the page's own product
  await product.start();
  assert.deepEqual(product.hearts().map((h) => h.getAttribute("data-kw-handle")), ["ski-wax", "shirt"], "the page's own product is skipped");
  assert.ok(own);
});

test("hearts are not added on pages that merely contain product links: cart, blog, custom pages, or when the setting is off", async () => {
  for (const options of [{ pageType: "cart" }, { pageType: "page" }, { pageType: "blog" }, { pageType: "article" }, { pageType: "list-collections" }, { pageType: "index", collectionCards: false }]) {
    const page = await mount({ ...options, headerIcon: options.collectionCards === false });
    featuredSection(page, ["snowboard"]);
    await page.start();
    assert.equal(page.hearts().length, 0, JSON.stringify(options));
  }
});

test("collection pages still get their hearts (regression)", async () => {
  const page = await mount({ pageType: "collection" });
  page.addCards("snowboard", "ski-wax", "shirt");
  await page.start();
  assert.equal(page.hearts().length, 3);
});

// ---- the My Wishlist icon: always in the theme header, never in the drawer or floating ----
const entries = (page) => page.body.querySelectorAll(".kw-header-icon");
const inIconRow = (page, node) => page.icons.contains(node);

// Whatever the layout, the icon must never end up in the drawer or float.
function assertHeaderOnly(page) {
  assert.equal(entries(page).length, 1, "exactly one icon");
  const [icon] = entries(page);
  assert.equal(page.header.contains(icon), true, "inside the theme header");
  assert.equal(icon.closest(".menu-drawer__menu"), null, "never inside the hamburger menu drawer");
  assert.equal(icon.closest("header-drawer"), null);
  assert.equal(page.drawerList ? page.drawerList.querySelectorAll(".kw-header-icon").length : 0, 0);
  assert.equal(page.drawerList ? page.drawerList.children.length : 1, 1, "the theme's own drawer menu is untouched");
  assert.equal(icon.has("kw-header-icon--floating"), false, "never floating");
  assert.equal(page.body.querySelectorAll(".kw-header-icon--floating").length, 0);
  assert.equal(icon.parent === page.body, false, "not appended to the page body");
}

test("the icon goes in the header icon row beside the cart, labelled and linking to My Wishlist", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false });
  await page.start();
  assertHeaderOnly(page);
  const [icon] = entries(page);
  assert.equal(inIconRow(page, icon), true);
  assert.equal(page.icons.children.indexOf(icon) < page.icons.children.indexOf(page.cart), true, "before the cart");
  assert.equal(icon.getAttribute("aria-label"), "My Wishlist");
  assert.equal(icon.getAttribute("href"), "/apps/konvert-notify/my-wishlist");
  assert.equal(icon.tag, "a", "a real link: keyboard focusable");
  assert.equal(page.header.has("kw-header--tight"), false, "nothing is adjusted when the header has room");
  assert.equal(page.header.has("kw-header--compact"), false);
});

test("when the icon would make the header taller, only the header's column sizing is adjusted and the icon stays in the header", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 97, tightHeight: 60 });
  await page.start();
  assertHeaderOnly(page);
  assert.equal(inIconRow(page, entries(page)[0]), true);
  assert.equal(page.header.has("kw-header--tight"), true, "side columns sized to their content");
  assert.equal(page.header.has("kw-header--compact"), false, "the second step is not needed");
  assert.equal(page.icons.children.length, 2, "the theme's own icon (cart) plus ours");
});

test("on very narrow screens a second step uses the page's standard side padding", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 97, tightHeight: 80, compactHeight: 60 });
  await page.start();
  assertHeaderOnly(page);
  assert.equal(page.header.has("kw-header--tight"), true);
  assert.equal(page.header.has("kw-header--compact"), true);
});

test("if even that cannot fully fix a header, the icon still stays in the header (never moved elsewhere)", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 97, tightHeight: 97, compactHeight: 97 });
  await page.start();
  assertHeaderOnly(page);
  assert.equal(inIconRow(page, entries(page)[0]), true);
});

test("headers that are not the 3-column menu|logo|icons grid are not restyled, but the icon is still placed in them", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 97, headerColumns: "1fr auto" });
  await page.start();
  assertHeaderOnly(page);
  assert.equal(page.header.has("kw-header--tight"), false);
  assert.equal(inIconRow(page, entries(page)[0]), true);
});

test("overlapping other header content also triggers the adjustment, not a different location", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, tightHeight: 60 });
  page.logo.rectOverride = () => ({ left: 100, top: 10, right: 300, bottom: 50, width: 200, height: 40 });
  const original = Dom.prototype.getBoundingClientRect;
  Dom.prototype.getBoundingClientRect = function () {
    if (this.has("kw-header-icon") && this.parent && this.parent.has("header__icons") && !page.header.has("kw-header--tight")) {
      return { left: 120, top: 8, right: 164, bottom: 52, width: 44, height: 44 };
    }
    return original.call(this);
  };
  try {
    await page.start();
  } finally {
    Dom.prototype.getBoundingClientRect = original;
  }
  assertHeaderOnly(page);
  assert.equal(page.header.has("kw-header--tight"), true);
});

test("where the theme has no cart link the icon still goes in the header: its icon row, else the header itself", async () => {
  const row = await mount({ headerIcon: true, collectionCards: false, withCart: false });
  await row.start();
  assertHeaderOnly(row);
  assert.equal(inIconRow(row, entries(row)[0]), true, "appended to the icon row");

  const bare = await mount({ headerIcon: true, collectionCards: false, withCart: false, withIconRow: false });
  await bare.start();
  assertHeaderOnly(bare);
  assert.equal(entries(bare)[0].parent, bare.header, "appended to the header element");
});

test("a theme with no header element gets no icon at all (never a floating one)", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, withHeader: false });
  await page.start();
  assert.equal(entries(page).length, 0);
  assert.equal(page.body.querySelectorAll(".kw-header-icon--floating").length, 0);
});

test("resizing re-checks the header: the adjustment is removed when there is room and re-applied when there is not, with one icon throughout", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 97, tightHeight: 60 });
  await page.start();
  assert.equal(page.header.has("kw-header--tight"), true, "narrow");

  page.setHeaderHeightWithIcon(60); // widened: the header takes the icon without growing
  for (const fn of page.resizeListeners) fn();
  await tick(250);
  assertHeaderOnly(page);
  assert.equal(page.header.has("kw-header--tight"), false, "no adjustment left behind on a wide screen");

  page.setHeaderHeightWithIcon(97); // narrow again
  for (const fn of page.resizeListeners) fn();
  await tick(250);
  assertHeaderOnly(page);
  assert.equal(page.header.has("kw-header--tight"), true);
});

test("when the theme re-renders its header the icon is placed again in the new header, once", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false });
  await page.start();
  assert.equal(inIconRow(page, entries(page)[0]), true);

  page.reloadHeader(); // brand-new header: the old one, and our icon with it, is gone
  assert.equal(entries(page).length, 0);
  for (const cb of page.observers) cb();
  await tick(350);
  assertHeaderOnly(page);
  assert.equal(inIconRow(page, entries(page)[0]), true, "in the new header's icon row");
});

test("a re-rendered header with different room re-evaluates the adjustment against the new header", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 97, tightHeight: 60 });
  await page.start();
  assert.equal(page.header.has("kw-header--tight"), true);
  page.setHeaderHeightWithIcon(60);
  page.reloadHeader();
  for (const cb of page.observers) cb();
  await tick(350);
  assertHeaderOnly(page);
  assert.equal(page.header.has("kw-header--tight"), false);
  assert.equal(page.body.querySelectorAll(".kw-header--tight").length, 0, "no stale class on any header");
});

test("stale duplicate icons are removed", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false });
  await page.start();
  page.body.appendChild(el("a", "kw-header-icon")); // a leftover copy
  for (const fn of page.resizeListeners) fn();
  await tick(250);
  assertHeaderOnly(page);
});

test("the icon's count and saved state update in the header", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, loggedIn: true });
  await page.start();
  const icon = entries(page)[0];
  page.context.window.KonvertWishlist.items.set("1", { productId: "1" });
  page.context.window.KonvertWishlist.render();
  assert.equal(icon.querySelector(".kw-header-icon__count").textContent, "1");
  assert.equal(icon.has("kw-header-icon--filled"), true);
});

test("a scrollbar appearing after load (no resize event, but a narrower page) re-checks the header", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 60 });
  await page.start();
  assert.equal(page.header.has("kw-header--tight"), false, "fits at load, before the page content (and its scrollbar) arrives");

  page.setHeaderHeightWithIcon(97);          // the header is now narrower, so the icon no longer fits...
  page.context.document.documentElement.clientWidth = 385; // ...because the page got a scrollbar
  page.sizeObservers.forEach((cb) => cb());
  await tick(250);
  assertHeaderOnly(page);
  assert.equal(page.header.has("kw-header--tight"), true, "the adjustment is applied after the re-check");
});

test("size callbacks that do not change the page width (our own header adjustments change heights only) cause no work", async () => {
  const page = await mount({ headerIcon: true, collectionCards: false, headerHeightWithIcon: 97, tightHeight: 60 });
  await page.start();
  const before = entries(page)[0];
  page.sizeObservers.forEach((cb) => cb());
  page.sizeObservers.forEach((cb) => cb());
  await tick(250);
  assert.equal(entries(page)[0], before, "the same icon node, not re-created or moved");
  assert.equal(page.header.has("kw-header--tight"), true);
});

test("the shipped accessible name for the icon is \"My Wishlist\"", () => {
  assert.equal(LOCALE.header_label, "My Wishlist");
});
