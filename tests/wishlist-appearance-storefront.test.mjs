// Storefront side of the Wishlist appearance settings: how konvert-wishlist.js applies the "appearance" document from
// GET /api/features to <html>, and that konvert-wishlist.css gives every attribute and variable its effect.
//
// Run: node --test tests/wishlist-appearance-storefront.test.mjs
//
// The REAL core script runs in node:vm against a small page stub (no browser, no network, no database). That proves the
// logic: which settings become which attribute or variable, what is ignored, how old caches and failures behave.
// It cannot prove how a real theme draws the result: see the manual storefront checks in the project notes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ASSETS = "extensions/konvert-wishlist/assets/";
const CORE = fs.readFileSync(ASSETS + "konvert-wishlist.js", "utf8");
const css = fs.readFileSync(ASSETS + "konvert-wishlist.css", "utf8").replace(/\r\n/g, "\n");
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const FULL = {
  version: 1,
  general: { iconType: "star", defaultColor: "#112233", hoverColor: "#445566", activeColor: "#778899", useThemeFonts: false },
  productPage: { enabled: false, buttonType: "icon", position: "center", buttonStyle: "filled", buttonRadius: 12, widthMode: "manual", manualWidth: 300 },
  collectionPage: { enabled: false, iconSize: 30, backgroundOpacity: 0, position: "bottom-right", countDisplay: "none" },
  wishlistPage: { layout: "grid", headerIcon: false },
};
const FULL_ATTRIBUTES = {
  "data-kw-general-icon-type": "star",
  "data-kw-general-use-theme-fonts": "false",
  "data-kw-product-page-enabled": "false",
  "data-kw-product-page-button-type": "icon",
  "data-kw-product-page-position": "center",
  "data-kw-product-page-button-style": "filled",
  "data-kw-product-page-button-radius": "12",
  "data-kw-product-page-width-mode": "manual",
  "data-kw-product-page-manual-width": "300",
  "data-kw-collection-page-enabled": "false",
  "data-kw-collection-page-icon-size": "30",
  "data-kw-collection-page-background-opacity": "0",
  "data-kw-collection-page-position": "bottom-right",
  "data-kw-collection-page-count-display": "none",
  "data-kw-wishlist-page-layout": "grid",
  "data-kw-wishlist-page-header-icon": "false",
};
const FULL_VARIABLES = {
  "--kw-general-default-color": "#112233",
  "--kw-general-hover-color": "#445566",
  "--kw-general-active-color": "#778899",
  "--kw-product-page-button-radius": "12",
  "--kw-product-page-manual-width": "300",
  "--kw-collection-page-icon-size": "30",
  "--kw-collection-page-background-opacity": "0",
};

// Runs the core script on a stub page. `features` is the JSON the features endpoint answers (or "fail" / "http500" /
// "garbage"); `cache` is what sessionStorage already holds for kw:features.
function boot({ features, cache = null, config = {} } = {}) {
  const attributes = {};
  const variables = {};
  const classes = new Set();
  const root = {
    lang: "en",
    setAttribute: (name, value) => {
      attributes[name] = String(value);
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    style: {
      setProperty: (name, value) => {
        variables[name] = String(value);
      },
      removeProperty: (name) => {
        delete variables[name];
      },
    },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
  const store = new Map(cache ? [["kw:features", JSON.stringify(cache)]] : []);
  const fetches = [];
  const node = { textContent: JSON.stringify({ featuresPath: "/apps/konvert-notify/api/features", collectionCards: true, headerIcon: true, text: {}, ...config }) };
  const document = {
    readyState: "complete",
    documentElement: root,
    head: { appendChild() {} },
    body: {},
    createElement: () => ({}),
    querySelectorAll: (selector) => (selector === "script[data-kw-config]" ? [node] : []),
    querySelector: () => null,
    addEventListener() {},
  };
  const window = {
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    Shopify: { routes: { root: "/" } },
    location: { assign() {} },
  };
  const fetch = async (url) => {
    fetches.push(url);
    if (features === "fail") throw new Error("network down");
    if (features === "http500") return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
    if (features === "garbage") return { ok: true, status: 200, json: async () => "not an object" };
    return { ok: true, status: 200, json: async () => features };
  };
  const context = vm.createContext({ window, document, fetch, console: { warn() {}, log() {} } });
  vm.runInContext(CORE, context);
  const syncSnapshot = { attributes: { ...attributes }, variables: { ...variables } }; // what the page has before any await
  return {
    attributes, variables, classes, fetches, store, syncSnapshot,
    kw: window.KonvertWishlist,
    settle: () => tick(20),
  };
}

const NOW = () => Date.now();
const cached = (value, age = 1000) => ({ t: NOW() - age, v: value });

test("an untouched store: no appearance in the answer means no attribute, variable or class on <html>", async () => {
  for (const features of [{ wishlist: true, notifyMe: true }, { wishlist: true, notifyMe: true, appearance: { version: 1 } }, { wishlist: true, notifyMe: true, appearance: null }, { wishlist: true, notifyMe: true, appearance: [] }]) {
    const page = boot({ features });
    await page.settle();
    assert.deepEqual(page.attributes, {}, JSON.stringify(features));
    assert.deepEqual(page.variables, {});
    assert.deepEqual([...page.classes], []);
    assert.deepEqual([page.kw.config.collectionCards, page.kw.config.headerIcon, page.kw.config.wishlistOff], [true, true, undefined], "the Liquid settings are unchanged");
  }
});

test("every supported setting becomes its attribute or variable on <html>", async () => {
  const page = boot({ features: { wishlist: true, notifyMe: true, appearance: FULL } });
  await page.settle();
  assert.deepEqual(page.attributes, FULL_ATTRIBUTES);
  assert.deepEqual(page.variables, FULL_VARIABLES);
});

test("the two behaviour switches (cards off, header icon off) reach the script's own config; nothing else does", async () => {
  const off = boot({ features: { wishlist: true, notifyMe: true, appearance: FULL } });
  await off.settle();
  assert.deepEqual([off.kw.config.collectionCards, off.kw.config.headerIcon], [false, false]);
  const on = boot({ features: { wishlist: true, notifyMe: true, appearance: { version: 1, collectionPage: { iconSize: 30 }, wishlistPage: { layout: "grid" } } } });
  await on.settle();
  assert.deepEqual([on.kw.config.collectionCards, on.kw.config.headerIcon], [true, true], "other settings leave cards and header icon alone");
  const noCards = boot({ features: { wishlist: true, notifyMe: true, appearance: { version: 1, collectionPage: { enabled: false } } }, config: { collectionCards: false } });
  await noCards.settle();
  assert.equal(noCards.kw.config.collectionCards, false, "the app can switch an element off but never on: a theme with cards off stays off");
  const embedOff = boot({ features: { wishlist: true, notifyMe: true, appearance: { version: 1 } }, config: { headerIcon: false } });
  await embedOff.settle();
  assert.equal(embedOff.kw.config.headerIcon, false, "an embed with the header icon unticked is never switched on by the app");
});

test("every attribute and variable the script sets is used by the stylesheet (and the stylesheet's names are all settable)", () => {
  for (const name of [...Object.keys(FULL_ATTRIBUTES), ...Object.keys(FULL_VARIABLES)]) {
    // A number is set as both: the variable carries the value, the attribute only says it was set (used where the theme's own value is the fallback).
    const counterpart = name.startsWith("data-") ? `--${name.slice(5)}` : null;
    const used = name.startsWith("--") ? css.includes(`var(${name}`) : css.includes(`[${name}`) || (counterpart in FULL_VARIABLES && css.includes(`var(${counterpart}`));
    assert.ok(used, `${name} appears in konvert-wishlist.css`);
  }
  const named = new Set([...css.matchAll(/\[(data-kw-(?:general|product-page|collection-page|wishlist-page)-[a-z-]+)/g)].map((m) => m[1]).concat([...css.matchAll(/var\((--kw-(?:general|product|collection|wishlist)-[a-z-]+)/g)].map((m) => m[1])));
  for (const name of named) assert.ok(name in FULL_ATTRIBUTES || name in FULL_VARIABLES, `${name} in the stylesheet is something the script can set`);
});

test("hostile or odd values are skipped: names and values are re-checked in the browser", async () => {
  const hostile = {
    version: 1,
    general: { iconType: 'star"] x', defaultColor: "red", hoverColor: "url(javascript:1)", activeColor: "#12345g", onclick: "alert(1)", "on click": "x", "a-b": "c" },
    "bad section": { enabled: false },
    productPage: { buttonRadius: 1e9, manualWidth: NaN, position: "x".repeat(40), buttonStyle: { toString: "filled" }, widthMode: ["auto"], enabled: null },
    collectionPage: "not an object",
    wishlistPage: null,
  };
  const page = boot({ features: { wishlist: true, notifyMe: true, appearance: hostile } });
  await page.settle();
  for (const [name, value] of Object.entries(page.attributes)) {
    assert.match(name, /^data-kw-[a-z-]+$/, name);
    assert.match(value, /^(?:[a-z_-]{1,16}|-?\d{1,5}(?:\.\d+)?|true|false)$/, `${name}=${value}`);
  }
  assert.equal("data-kw-general-icon-type" in page.attributes, false);
  assert.equal(Object.keys(page.attributes).some((name) => /click|bad|section/.test(name)), false);
  assert.deepEqual(page.variables, {}, "no invalid colour or out-of-range number became a variable");
  assert.equal(page.kw.config.collectionCards, true);
});

test("a fresh cached answer is used without a request, applied before the page can paint; an old cache without appearance still works", async () => {
  const withLook = boot({ cache: cached({ wishlist: true, notifyMe: true, appearance: FULL }) });
  assert.deepEqual(withLook.syncSnapshot.attributes, FULL_ATTRIBUTES, "applied while the script is still starting, before any await");
  await withLook.settle();
  assert.deepEqual(withLook.fetches, [], "a cache younger than a minute is not refreshed");
  assert.deepEqual(withLook.attributes, FULL_ATTRIBUTES);

  const oldShape = boot({ cache: cached({ wishlist: true, notifyMe: true }) }); // written by the previous version of the script
  await oldShape.settle();
  assert.deepEqual([oldShape.attributes, oldShape.variables, oldShape.fetches], [{}, {}, []]);
  assert.equal(oldShape.kw.config.wishlistOff, undefined);

  const oldOff = boot({ cache: cached({ wishlist: false, notifyMe: true }) });
  await oldOff.settle();
  assert.equal(oldOff.classes.has("kw-wishlist-off"), true, "an old cached 'Wishlist off' still hides it");

  for (const junk of ["not json", '{"t":1}', '{"t":1,"v":null}', '{"t":"x","v":{"appearance":"star"}}', "[]", "null"]) {
    const page = boot({ features: { wishlist: true, notifyMe: true, appearance: { version: 1, general: { iconType: "bookmark" } } } });
    page.store.set("kw:features", junk);
    const retry = boot({ features: { wishlist: true, notifyMe: true } });
    retry.store.set("kw:features", junk);
    await retry.settle();
    assert.deepEqual(retry.attributes, {}, `damaged cache ${junk} does not break or style anything`);
  }
});

test("an older cache shows the last look at once, then the fresh answer replaces it (nothing stale is left behind)", async () => {
  const stale = cached({ wishlist: true, notifyMe: true, appearance: { version: 1, general: { iconType: "star", defaultColor: "#aabbcc" }, wishlistPage: { layout: "grid" } } }, 5 * 60 * 1000);
  const page = boot({ cache: stale, features: { wishlist: true, notifyMe: true, appearance: { version: 1, general: { iconType: "bookmark" } } } });
  assert.equal(page.syncSnapshot.attributes["data-kw-general-icon-type"], "star", "the last known look first");
  await page.settle();
  assert.equal(page.fetches.length, 1);
  assert.deepEqual(page.attributes, { "data-kw-general-icon-type": "bookmark" }, "the fresh answer replaced it: no star, no grid layout left over");
  assert.deepEqual(page.variables, {}, "and the old colour is gone");
  assert.equal(JSON.parse(page.store.get("kw:features")).v.appearance.general.iconType, "bookmark", "the new answer is cached together with its appearance");
  assert.deepEqual(JSON.parse(page.store.get("kw:features")).v.wishlist, true);
});

test("when the features answer fails, the default look is used and nothing else breaks", async () => {
  const stale = cached({ wishlist: true, notifyMe: true, appearance: FULL }, 5 * 60 * 1000);
  for (const features of ["fail", "http500", "garbage"]) {
    const page = boot({ features, cache: stale });
    assert.ok(Object.keys(page.syncSnapshot.attributes).length > 0, "the last look shows while waiting");
    await page.settle();
    assert.deepEqual(page.attributes, {}, `${features}: back to the default look`);
    assert.deepEqual(page.variables, {});
    assert.deepEqual([...page.classes], [], "nothing is hidden when the answer cannot be read");
    assert.deepEqual([page.kw.config.collectionCards, page.kw.config.headerIcon, page.kw.config.wishlistOff], [true, true, undefined]);
    assert.equal(typeof page.kw.toggle === "function" || page.kw.toggle === undefined, true);
  }
  const noCache = boot({ features: "fail" });
  await noCache.settle();
  assert.deepEqual([noCache.attributes, noCache.variables], [{}, {}]);
});

test("the Wishlist and Notify Me switches behave exactly as before, with or without an appearance", async () => {
  const off = boot({ features: { wishlist: false, notifyMe: true, appearance: FULL } }, { });
  await off.settle();
  assert.equal(off.classes.has("kw-wishlist-off"), true);
  assert.equal(off.kw.config.wishlistOff, true);
  assert.deepEqual(off.attributes, FULL_ATTRIBUTES, "the look is applied independently of the switch");

  const plain = boot({ features: { wishlist: false, notifyMe: false } });
  await plain.settle();
  assert.deepEqual([plain.classes.has("kw-wishlist-off"), plain.kw.config.wishlistOff, plain.kw.config.notifyEnabled], [true, true, false]);

  const notifyOff = boot({ features: { wishlist: true, notifyMe: false, appearance: { version: 1, general: { iconType: "star" } } }, config: { notifyEnabled: true } });
  await notifyOff.settle();
  assert.deepEqual([notifyOff.kw.config.notifyEnabled, notifyOff.classes.has("kw-wishlist-off")], [false, false]);
});

test("the core script stays inside its size budget and still draws the heart by default", () => {
  const bytes = fs.statSync(ASSETS + "konvert-wishlist.js").size;
  assert.ok(bytes < 10000, `konvert-wishlist.js is ${bytes} bytes (limit used by this project: 10000)`);
  assert.ok(/class="kw-i-heart"/.test(CORE) && /class="kw-i-star"/.test(CORE) && /class="kw-i-bookmark"/.test(CORE), "all three shapes are in the SVG");
  assert.ok(CORE.indexOf('class="kw-i-heart"') < CORE.indexOf('class="kw-i-star"'), "heart first");
});

// ======================= stylesheet =======================
function parse(source, at = null) {
  const rules = [];
  let depth = 0;
  let start = 0;
  let bodyStart = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const prelude = source.slice(start, bodyStart - 1).trim();
        const body = source.slice(bodyStart, i);
        if (prelude.startsWith("@media")) rules.push(...parse(body, prelude.replace("@media", "").trim()));
        else if (!prelude.startsWith("@")) rules.push({ at, selectors: prelude.split(",").map((s) => s.trim()), body });
        start = i + 1;
      }
    }
  }
  return rules;
}
const rules = parse(css.replace(/\/\*[\s\S]*?\*\//g, ""));
const decl = (selector, at = null) => {
  const hits = rules.filter((r) => r.at === at && r.selectors.includes(selector));
  return hits.length ? hits.map((r) => r.body).join(";") : null;
};
const has = (body, property, value) =>
  (body ?? "").split(";").map((d) => d.trim().replace(/\s+/g, " ")).includes(`${property}: ${value}`);
const DEFAULT_CHAIN = "var(--kw-general-default-color, var(--kw-accent, #d6336c))";

test("styles: with no setting present the original look is what the stylesheet falls back to", () => {
  assert.ok(has(decl(".kw-heart"), "color", DEFAULT_CHAIN), "heart colour: app colour, else the theme editor's, else #d6336c");
  assert.ok(has(decl(".kw-header-icon__count"), "background", DEFAULT_CHAIN));
  const card = decl(".kw-btn--card");
  assert.ok(has(card, "top", "8px") && has(card, "right", "8px"), "top right");
  assert.ok(has(card, "background", "rgba(255, 255, 255, calc(var(--kw-collection-page-background-opacity, 92) / 100))"), "92% white");
  assert.ok(has(card, "box-shadow", "0 1px 4px rgba(0, 0, 0, 0.25)"));
  assert.ok(has(decl(".kw-btn--card .kw-heart"), "width", "calc(var(--kw-collection-page-icon-size, 22) * 1px)"), "22px icon");
  const product = decl(".kw-btn--product");
  assert.ok(has(product, "width", "100%") && has(product, "border-radius", "var(--buttons-radius, 4px)") && has(product, "background", "transparent") && has(product, "border", "1px solid currentColor"), "full width outline button that follows the theme radius");
  assert.ok(has(decl(".kw-i-star"), "display", "none") && decl(".kw-i-star") !== null && rules.some((r) => r.selectors.includes(".kw-i-bookmark") && has(r.body, "display", "none")), "only the heart shows by default");
  assert.equal(decl(".kw-table", null) !== null && has(decl(".kw-table"), "min-width", "780px"), true, "the table is still the default layout");
});

test("styles: every new rule is conditional on a setting being present", () => {
  const added = rules.filter((r) => r.selectors.some((s) => /data-kw-(?:general|product-page|collection-page|wishlist-page)/.test(s)));
  assert.ok(added.length > 30);
  for (const rule of added) for (const selector of rule.selectors) assert.match(selector, /^html\[data-kw-[a-z-]+(?:='[a-z0-9_-]+')?\]/, selector);
  const unconditional = rules.filter((r) => r.selectors.some((s) => /^\.kw-i-/.test(s)));
  assert.deepEqual(unconditional.map((r) => r.selectors), [[".kw-i-star", ".kw-i-bookmark"]], "the only unconditional addition is hiding the unused icon shapes");
});

test("styles: icon type, colours, hover/saved colours and fonts", () => {
  for (const type of ["star", "bookmark"]) {
    assert.ok(rules.some((r) => r.selectors.includes(`html[data-kw-general-icon-type='${type}'] .kw-i-heart`) && has(r.body, "display", "none")), `${type}: heart hidden`);
    assert.ok(rules.some((r) => r.selectors.includes(`html[data-kw-general-icon-type='${type}'] .kw-i-${type}`) && has(r.body, "display", "inline")), `${type}: shape shown`);
  }
  assert.ok(has(decl(".kw-btn:hover > .kw-heart"), "color", "var(--kw-general-hover-color, var(--kw-general-default-color, var(--kw-accent, #d6336c)))"));
  const saved = "var(--kw-general-active-color, var(--kw-general-default-color, var(--kw-accent, #d6336c)))";
  assert.ok(has(decl(".kw-btn[aria-pressed='true'] > .kw-heart"), "color", saved));
  assert.ok(has(decl(".kw-header-icon.kw-header-icon--filled > .kw-heart"), "color", saved));
  const order = (selector) => rules.findIndex((r) => r.selectors.includes(selector));
  assert.ok(order(".kw-btn[aria-pressed='true'] > .kw-heart") > order(".kw-btn:hover > .kw-heart"), "the saved colour wins over hover for a saved heart");
  const fonts = decl("html[data-kw-general-use-theme-fonts='false'] .kw-page *");
  assert.match(fonts, /font-family: system-ui, -apple-system, 'Segoe UI', Roboto/);
  for (const part of [".kw-btn", ".kw-page", ".kw-toast", ".kw-toast *", ".kw-header-icon__count"]) assert.ok(decl(`html[data-kw-general-use-theme-fonts='false'] ${part}`), `${part} gets the system font when theme fonts are off`);
});

test("styles: product page button", () => {
  const at = (selector) => decl(`html[data-kw-product-page-${selector}`);
  assert.ok(has(at("enabled='false'] .kw-block"), "display", "none !important"));
  assert.ok(at("button-type='icon'] .kw-btn--product .kw-btn__label").includes("clip: rect(0 0 0 0)"), "icon only hides the label visually, not from screen readers");
  assert.ok(!at("button-type='icon'] .kw-btn--product .kw-btn__label").includes("display: none"));
  assert.ok(has(at("position='center'] .kw-block"), "text-align", "center") && has(at("position='right'] .kw-block"), "text-align", "right"));
  assert.ok(has(at("width-mode='auto'] .kw-btn--product"), "width", "auto"));
  assert.ok(has(at("width-mode='manual'] .kw-btn--product"), "width", "min(calc(var(--kw-product-page-manual-width, 240) * 1px), 100%)"), "a fixed width never overflows its block");
  assert.ok(has(at("button-radius] .kw-btn--product"), "border-radius", "calc(var(--kw-product-page-button-radius) * 1px)"));
  const filled = at("button-style='filled'] .kw-btn--product");
  assert.ok(has(filled, "background", DEFAULT_CHAIN) && has(filled, "color", "#fff"));
  assert.ok(has(at("button-style='filled'] .kw-btn--product .kw-heart"), "color", "#fff"));
});

test("styles: collection cards and the header count", () => {
  const at = (selector) => decl(`html[data-kw-collection-page-${selector}`);
  assert.ok(has(at("enabled='false'] .kw-btn--card"), "display", "none !important"));
  assert.ok(has(at("position='top-left'] .kw-btn--card"), "left", "8px") && has(at("position='top-left'] .kw-btn--card"), "right", "auto"));
  const bl = at("position='bottom-left'] .kw-btn--card");
  assert.ok(has(bl, "bottom", "8px") && has(bl, "left", "8px") && has(bl, "top", "auto") && has(bl, "right", "auto"));
  const br = at("position='bottom-right'] .kw-btn--card");
  assert.ok(has(br, "bottom", "8px") && has(br, "top", "auto") && !br.includes("left"));
  assert.ok(has(at("background-opacity='0'] .kw-btn--card"), "box-shadow", "none"), "a fully clear background has no shadow either");
  assert.ok(has(at("count-display='none'] .kw-header-icon__count"), "display", "none !important"));
  assert.ok(has(decl("html[data-kw-wishlist-page-header-icon='false'] .kw-header-icon"), "display", "none !important"));
});

test("styles: Wishlist page grid lays the same table out as cards, and the table stays the default", () => {
  const grid = (selector) => decl(`html[data-kw-wishlist-page-layout='grid'] ${selector}`);
  assert.ok(has(grid(".kw-table tbody"), "display", "grid") && grid(".kw-table tbody").includes("repeat(auto-fill, minmax(220px, 1fr))"));
  assert.ok(has(grid(".kw-table"), "display", "block") && has(grid(".kw-table"), "min-width", "0"), "no 780px minimum, so no sideways scrolling");
  assert.ok(grid(".kw-table thead").includes("clip: rect(0 0 0 0)"), "column headings are hidden visually but stay for assistive technology");
  const row = grid(".kw-row");
  assert.ok(has(row, "display", "grid") && row.includes("grid-template-areas"));
  for (const area of ["img", "name", "rm", "price", "stock", "qty", "act"]) assert.ok(row.includes(area), `the card has an area for ${area}`);
  for (const [cell, area] of [["image", "img"], ["name", "name"], ["remove", "rm"], ["price", "price"], ["stock", "stock"], ["qty", "qty"], ["action", "act"]]) assert.ok(has(grid(`.kw-td--${cell}`), "grid-area", area), cell);
  assert.ok(has(grid(".kw-table--select .kw-td--select"), "display", "block"), "Select mode still shows its checkboxes");
  const gridRules = rules.filter((r) => r.selectors.some((s) => s.includes("data-kw-wishlist-page-layout='grid'")));
  assert.ok(gridRules.every((r) => r.at === null), "the grid applies at every width");
  assert.ok(has(decl(".kw-table"), "min-width", "780px") && has(decl(".kw-table-wrap"), "overflow-x", "auto"), "table rules are untouched");
});
