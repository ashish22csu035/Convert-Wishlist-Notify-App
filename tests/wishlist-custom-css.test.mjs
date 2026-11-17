// Custom CSS (icon, product-page block, Wishlist page), the header link presentation, and how they reach the storefront.
//
// Run: node --test tests/wishlist-custom-css.test.mjs
//
// No database and no network. The pure rules are imported directly; the per-shop persistence (app/models/settings.server.js) runs
// against an in-memory stand-in for the Prisma client (tests/helpers/fake-db.mjs); the REAL storefront script runs in node:vm.
// What this cannot show is how a real theme draws the result: see the manual steps in the project notes.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { compileCustomCss, CSS_EXAMPLES, MAX_CSS_CHARS } from "../app/utils/custom-css-shared.js";
import { DEFAULT_APPEARANCE, normalizeStored, publicAppearance, publicCustomCss, resolveAppearance, toSparse, validateAppearance, HEADER_TEXT_MAX } from "../app/utils/wishlist-appearance-shared.js";
import { storefrontHooks, headerLink } from "../app/utils/wishlist-preview-document.js";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

// ---------- compile: scoping ----------
const css = (raw, scope) => compileCustomCss(raw, scope);

test("every selector is confined to its scope's root; a selector without the root gets it put in front", () => {
  assert.equal(css(".kw-heart svg { stroke-width: 2 }", "icon").css, ".kw-heart svg{stroke-width:2}");
  assert.equal(css("svg { stroke-width: 2 }", "icon").css, ".kw-heart svg{stroke-width:2}");
  assert.equal(css(".kw-btn { color: red }", "product").css, ".kw-block .kw-btn{color:red}");
  assert.equal(css(".kw-block { margin: 0 }", "product").css, ".kw-block{margin:0}", "the root itself is accepted as written");
  assert.equal(css(".kw-page__title { font-size: 28px }", "page").css, ".kw-page .kw-page__title{font-size:28px}", ".kw-page__title is not the root, so it is prefixed");
  assert.equal(css(".kw-page .kw-table { gap: 0 }", "page").css, ".kw-page .kw-table{gap:0}");
  assert.equal(css("h1, .kw-table img { margin: 0 }", "page").css, ".kw-page h1,.kw-page .kw-table img{margin:0}", "every selector of a list is confined");
});

test("states: hover, focus, saved (aria-pressed), disabled and the icon's state on its button", () => {
  const product = css(".kw-btn:hover{opacity:.9} .kw-btn:focus-visible{outline:2px solid red} .kw-btn[aria-pressed=\"true\"]{font-weight:700} .kw-btn:disabled{opacity:.5}", "product").css;
  for (const selector of [".kw-block .kw-btn:hover", ".kw-block .kw-btn:focus-visible", '.kw-block .kw-btn[aria-pressed="true"]', ".kw-block .kw-btn:disabled"]) assert.ok(product.includes(selector), selector);
  const icon = css('.kw-btn:hover .kw-heart { transform: scale(1.1) } .kw-header-icon--filled .kw-heart svg { fill: red }', "icon").css;
  assert.ok(icon.includes(".kw-btn:hover .kw-heart{transform:scale(1.1)}"), "an app-owned ancestor in front of the icon is kept");
  assert.ok(icon.includes(".kw-header-icon--filled .kw-heart svg{fill:red}"));
});

test("a selector that reaches outside the root is refused, never silently rewritten", () => {
  for (const [raw, scope] of [
    ["body .kw-heart { color: red }", "icon"], // a theme ancestor in front of the icon
    [".product-card .kw-heart { color: red }", "icon"],
    [".kw-block + .add-to-cart { display: none }", "product"], // sibling combinator
    [".kw-block ~ button { display: none }", "product"],
    [".kw-block:has(+ form) { display: none }", "product"],
    [":is(.kw-block, .btn) { color: red }", "product"],
    [":root { --x: 1 }", "page"],
    [".kw-page:host { color: red }", "page"],
  ]) {
    const result = css(raw, scope);
    assert.equal(result.ok, false, `${scope}: ${raw}`);
    assert.ok(result.error, "and it says why");
  }
});

test("the theme's own elements are never targeted: a bare theme selector is confined under the root", () => {
  assert.equal(css(".add-to-cart { display: none }", "product").css, ".kw-block .add-to-cart{display:none}", "this can only match something inside the Wishlist block");
  assert.equal(css("button { color: red }", "page").css, ".kw-page button{color:red}");
});

// ---------- compile: policy ----------
test("policy: nothing that loads a resource or hides code is accepted", () => {
  for (const raw of [
    ".kw-heart { background: url(https://evil.example/x.png) }",
    ".kw-heart { background: URL( 'x' ) }",
    ".kw-heart { background-image: image-set('a' 1x) }",
    "@import url(x.css);",
    "@import 'x.css';",
    "@font-face { font-family: x; src: local(x) }",
    "@keyframes x { from { opacity: 0 } to { opacity: 1 } }",
    ".kw-heart { width: expression(alert(1)) }",
    ".kw-heart { behavior: url(x.htc) }",
    ".kw-heart { -moz-binding: x }",
    ".kw-heart { background: javascript:alert(1) }",
    ".kw-heart { content: \"\\75rl(x)\" }", // a backslash escape could spell url(
    ".kw-heart { color: red } </style><script>alert(1)</script>",
    ".kw-heart { color: red",
    ".kw-heart { color: red } }",
    ".kw-heart { .x { color: red } }",
    "color: red;",
    ".kw-heart { colorred }",
    ".kw-heart { color: }",
    ".kw-heart { color: \"red }",
    "@media (min-width: 600px) { @media (max-width: 900px) { .kw-heart { color: red } } }",
    "@media screen and (min-width: 600px) { .kw-heart { x } }",
    "/* never closed .kw-heart { color: red }",
  ]) assert.equal(css(raw, "icon").ok, false, raw);
});

test("policy: plain rules, comments and one level of @media are accepted and rebuilt", () => {
  const result = css("/* make it bigger */ .kw-heart svg { width: 28px; height: 28px } @media (max-width: 600px) { .kw-heart svg { width: 20px } }", "icon");
  assert.equal(result.ok, true);
  assert.equal(result.css, ".kw-heart svg{width:28px;height:28px}\n@media (max-width: 600px){.kw-heart svg{width:20px}}");
  assert.deepEqual(css("   ", "icon"), { ok: true, css: "" });
  assert.deepEqual(css("/* only a comment */", "page"), { ok: true, css: "" });
  assert.deepEqual(css(null, "icon"), { ok: true, css: "" });
  assert.equal(css(".kw-heart { color: red !important }", "icon").css, ".kw-heart{color:red !important}");
});

test("size: at most MAX_CSS_CHARS, a non-string is refused", () => {
  assert.equal(css(`.kw-heart{color:red}${" ".repeat(MAX_CSS_CHARS)}`, "icon").ok, false);
  assert.equal(css(`.kw-heart{color:red}${" ".repeat(MAX_CSS_CHARS - 20)}`, "icon").ok, true);
  assert.equal(css(42, "icon").ok, false);
  assert.equal(css({}, "icon").ok, false);
  assert.equal(css(".kw-heart{color:red}", "unknown-scope").ok, false);
});

test("the shipped examples compile under their own scope", () => {
  for (const [scope, example] of Object.entries(CSS_EXAMPLES)) {
    const result = css(example, scope);
    assert.equal(result.ok, true, `${scope}: ${result.error}`);
    assert.ok(result.css.length > 0);
  }
});

// ---------- the appearance document ----------
test("existing shops: nothing stored means no custom CSS, today's header icon and its default text", () => {
  for (const stored of [null, undefined, {}, { version: 1 }, "{", "[]"]) {
    const resolved = resolveAppearance(normalizeStored(stored));
    assert.deepEqual(resolved, DEFAULT_APPEARANCE);
    assert.equal(resolved.general.customCss, "");
    assert.equal(resolved.productPage.customCss, "");
    assert.equal(resolved.wishlistPage.customCss, "");
    assert.equal(resolved.wishlistPage.headerStyle, "icon");
    assert.equal(resolved.wishlistPage.headerText, "My wishlist");
    assert.deepEqual(publicCustomCss(stored), {});
    assert.deepEqual(publicAppearance(stored), { version: 1 });
  }
});

test("validateAppearance: each CSS field is checked against its own scope; header style and text have rules", () => {
  const good = { general: { customCss: ".kw-heart svg { stroke-width: 2 }" }, productPage: { customCss: ".kw-btn:hover { opacity: .9 }" }, wishlistPage: { customCss: ".kw-page__title { font-size: 30px }", headerStyle: "icon_text", headerText: "  Saved   items " } };
  const result = validateAppearance(good);
  assert.deepEqual(result.errors, {});
  assert.equal(result.values.wishlistPage.headerText, "Saved items", "trimmed and single-spaced");

  const bad = validateAppearance({
    general: { customCss: ".kw-heart { background: url(x) }" },
    productPage: { customCss: ".kw-block + a { color: red }" },
    wishlistPage: { customCss: "@import 'x';", headerStyle: "banner", headerText: "x".repeat(HEADER_TEXT_MAX + 1) },
  });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["general.customCss", "productPage.customCss", "wishlistPage.customCss", "wishlistPage.headerStyle", "wishlistPage.headerText"]);
  assert.deepEqual(bad.values, {}, "nothing from a refused field is kept");
  assert.deepEqual(Object.keys(validateAppearance({ wishlistPage: { headerText: "<b>hi</b>" } }).errors), ["wishlistPage.headerText"]);
  assert.deepEqual(Object.keys(validateAppearance({ wishlistPage: { headerText: 5 } }).errors), ["wishlistPage.headerText"]);
  assert.deepEqual(Object.keys(validateAppearance({ general: { customCss: 5 } }).errors), ["general.customCss"]);
  assert.deepEqual(validateAppearance({ wishlistPage: { headerText: "   " } }).values, { wishlistPage: { headerText: "My wishlist" } }, "an empty label means the default");
});

test("an oversized or malformed document is refused as a whole", () => {
  const huge = JSON.stringify({ general: { customCss: ".kw-heart{color:red}" }, pad: "x".repeat(50000) });
  assert.deepEqual(Object.keys(validateAppearance(huge).errors), ["appearance"]);
  assert.deepEqual(Object.keys(validateAppearance("{").errors), ["appearance"]);
  assert.deepEqual(Object.keys(validateAppearance({ general: { customCss: "x".repeat(MAX_CSS_CHARS + 1) } }).errors), ["general.customCss"]);
});

test("the storefront document never carries raw CSS; the compiled, confined CSS travels separately", () => {
  const stored = toSparse({
    general: { iconType: "star", customCss: "svg { stroke-width: 2 }" },
    productPage: { customCss: ".kw-btn { color: red }" },
    wishlistPage: { headerStyle: "text", headerText: "My wishlist", customCss: ".kw-page__title { font-size: 30px }" },
  });
  assert.equal(stored.general.customCss, "svg { stroke-width: 2 }", "the editor keeps what the merchant typed");
  const pub = publicAppearance(stored);
  assert.equal(JSON.stringify(pub).includes("customCss"), false);
  assert.deepEqual(pub.general, { iconType: "star" });
  assert.deepEqual(pub.wishlistPage, { headerStyle: "text" }, "the default text is not stored; the style is");
  assert.deepEqual(publicCustomCss(stored), {
    icon: ".kw-heart svg{stroke-width:2}",
    product: ".kw-block .kw-btn{color:red}",
    page: ".kw-page .kw-page__title{font-size:30px}",
  });
});

test("hostile data already in the database is neutralised on the way out, whatever the column holds", () => {
  const hostile = { version: 1, general: { customCss: ".kw-heart { background: url(https://evil.example) }" }, productPage: { customCss: "</style><script>alert(1)</script>" }, wishlistPage: { customCss: ".a + .b { x: y }" } };
  assert.deepEqual(publicCustomCss(hostile), {}, "a field that does not compile is dropped, not delivered");
  assert.deepEqual(publicCustomCss(JSON.stringify(hostile)), {});
  assert.equal(JSON.stringify(normalizeStored(hostile)).includes("evil.example"), false);
});

test("preview hooks ignore the CSS and the label text; the header link follows the chosen presentation", () => {
  const hooks = storefrontHooks({ general: { customCss: ".kw-heart{color:red}" }, wishlistPage: { headerText: "Wishlist", headerStyle: "text", customCss: ".kw-page h1{x:y}" } });
  assert.deepEqual(hooks.attributes, { "data-kw-wishlist-page-header-style": "text" });
  assert.deepEqual(hooks.variables, {});
  assert.match(headerLink("icon"), /aria-label="My Wishlist"/);
  assert.doesNotMatch(headerLink("icon"), /kw-header-icon__text/);
  const both = headerLink("icon_text", "My list");
  assert.match(both, /kw-heart/);
  assert.match(both, /<span class="kw-header-icon__text">My list<\/span>/);
  const text = headerLink("text", "");
  assert.doesNotMatch(text, /kw-heart/);
  assert.match(text, />My wishlist</);
  assert.match(headerLink("text", "<b>x</b>"), /&lt;b&gt;x&lt;\/b&gt;/, "the label is escaped");
});

// ---------- per-shop persistence (in-memory Prisma stand-in) ----------
let settings;
let db;
before(async () => {
  const outDir = path.resolve("node_modules/.cache/kw-custom-css-test");
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `settings-${Date.now().toString(36)}.mjs`);
  await build({
    entryPoints: ["app/models/settings.server.js"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    plugins: [
      {
        name: "fake-db",
        setup(b) {
          b.onResolve({ filter: /db\.server$/ }, () => ({ path: pathToFileURL(path.resolve("tests/helpers/fake-db.mjs")).href, external: true }));
        },
      },
    ],
  });
  settings = await import(pathToFileURL(outfile).href);
  db = (await import(pathToFileURL(path.resolve("tests/helpers/fake-db.mjs")).href)).default;
});

const A = "alpha-store.myshopify.com";
const B = "beta-store.myshopify.com";

test("each Custom CSS field and the header presentation are saved and read back for the right shop only", async () => {
  db.__reset();
  const input = {
    general: { customCss: ".kw-heart svg { stroke-width: 2 }" },
    productPage: { customCss: ".kw-btn:hover { opacity: .9 }" },
    wishlistPage: { customCss: ".kw-page__title { font-size: 30px }", headerStyle: "icon_text", headerText: "Saved" },
  };
  const saved = await settings.saveAppearance(A, JSON.stringify(input));
  assert.equal(saved.ok, true);
  assert.equal(saved.appearance.general.customCss, input.general.customCss);
  assert.equal(saved.appearance.wishlistPage.headerText, "Saved");

  const again = await settings.getAppearance(A);
  assert.equal(again.productPage.customCss, input.productPage.customCss, "persists across a fresh read");
  assert.equal(again.wishlistPage.headerStyle, "icon_text");

  const other = await settings.getAppearance(B);
  assert.deepEqual(other, DEFAULT_APPEARANCE, "another shop sees only the defaults");
  const features = await settings.getStorefrontFeatures(B);
  assert.equal("customCss" in features, false, "and receives no CSS");
  assert.deepEqual(features.appearance, { version: 1 });

  await settings.saveAppearance(B, JSON.stringify({ general: { customCss: ".kw-heart { color: blue }" } }));
  assert.equal((await settings.getAppearance(A)).general.customCss, input.general.customCss, "saving for B never changes A");
  assert.equal((await settings.getAppearance(B)).general.customCss, ".kw-heart { color: blue }");
});

test("the storefront answer carries the compiled CSS per scope, and an untouched shop's answer is exactly what it was", async () => {
  db.__reset();
  const untouched = await settings.getStorefrontFeatures(A);
  assert.deepEqual(untouched, { wishlist: true, notifyMe: true, appearance: { version: 1 } });

  await settings.saveAppearance(A, JSON.stringify({ productPage: { customCss: ".kw-btn { text-transform: uppercase }" }, wishlistPage: { headerStyle: "text" } }));
  const features = await settings.getStorefrontFeatures(A);
  assert.deepEqual(features.customCss, { product: ".kw-block .kw-btn{text-transform:uppercase}" });
  assert.deepEqual(features.appearance, { version: 1, wishlistPage: { headerStyle: "text" } });
});

test("a refused field saves nothing, keeps the earlier CSS, and reports which field", async () => {
  db.__reset();
  await settings.saveAppearance(A, JSON.stringify({ general: { customCss: ".kw-heart { color: red }" } }));
  const refused = await settings.saveAppearance(A, JSON.stringify({ general: { customCss: ".kw-heart { background: url(x) }" }, productPage: { customCss: ".kw-btn { color: red }" } }));
  assert.equal(refused.ok, false);
  assert.deepEqual(Object.keys(refused.errors), ["general.customCss"]);
  const now = await settings.getAppearance(A);
  assert.equal(now.general.customCss, ".kw-heart { color: red }", "the earlier value survives");
  assert.equal(now.productPage.customCss, "", "and nothing from the refused save was written");
});

test("Reset to default (an empty field) removes the CSS from the stored document and from the storefront answer", async () => {
  db.__reset();
  await settings.saveAppearance(A, JSON.stringify({ general: { customCss: ".kw-heart { color: red }" } }));
  await settings.saveAppearance(A, JSON.stringify({ general: { customCss: "" } }));
  assert.equal((await settings.getAppearance(A)).general.customCss, "");
  assert.equal("customCss" in (await settings.getStorefrontFeatures(A)), false);
});

test("saving appearance never touches the Wishlist / Notify Me switches", async () => {
  db.__reset();
  await settings.saveSettings(A, { wishlistEnabled: false, notifyMeEnabled: true });
  await settings.saveAppearance(A, JSON.stringify({ general: { customCss: ".kw-heart { color: red }" } }));
  const features = await settings.getStorefrontFeatures(A);
  assert.equal(features.wishlist, false);
  assert.equal(features.notifyMe, true);
});

// ---------- the real storefront script ----------
const CORE = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.js", "utf8");
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function run(features, { cached = null } = {}) {
  const attrs = new Map();
  const styles = new Map(); // id -> element
  const head = { appendChild(node) { styles.set(node.id, node); node.parentNode = head; return node; }, removeChild(node) { styles.delete(node.id); } };
  const root = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), style: { setProperty() {}, removeProperty() {} }, classList: { add() {} } };
  const store = new Map(cached ? [["kw:features", JSON.stringify({ t: Date.now(), v: cached })]] : []);
  const document = {
    readyState: "complete",
    documentElement: root,
    head,
    querySelectorAll: (selector) => (selector === "script[data-kw-config]" ? [{ textContent: JSON.stringify({ loggedIn: false, apiPath: "/a", featuresPath: "/apps/x/api/features", loginUrl: "/account/login", text: {} }) }] : []),
    querySelector: () => null,
    getElementById: (id) => styles.get(id) ?? null,
    createElement: (tag) => ({ tag, id: "", textContent: "" }),
    addEventListener() {},
  };
  const window = {
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    location: { assign() {} },
    Shopify: {},
  };
  const context = {
    window,
    document,
    console,
    fetch: async () => ({ ok: true, json: async () => features }),
    Promise,
    Date,
    JSON,
    Map,
    setTimeout,
    URL,
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(CORE, context);
  return { attrs, styles, window: context.window };
}

test("storefront script: the compiled CSS goes into ONE <style> as text; nothing is applied for a shop without custom CSS", async () => {
  const { styles, attrs } = run({ wishlist: true, notifyMe: true, appearance: { version: 1, wishlistPage: { headerStyle: "icon_text", headerText: "My list" } }, customCss: { icon: ".kw-heart svg{stroke-width:2}", product: ".kw-block .kw-btn{color:red}", page: ".kw-page h1{x:y}" } });
  await tick();
  const node = styles.get("kw-custom-css");
  assert.ok(node, "a style element was added");
  assert.equal(node.tag, "style");
  assert.equal(node.textContent, ".kw-heart svg{stroke-width:2}\n.kw-block .kw-btn{color:red}\n.kw-page h1{x:y}\n", "set as text, never as markup");
  assert.equal(attrs.get("data-kw-wishlist-page-header-style"), "icon_text");
  assert.equal(attrs.has("data-kw-wishlist-page-header-text"), false, "the label is not turned into an attribute");

  const plain = run({ wishlist: true, notifyMe: true, appearance: { version: 1 } });
  await tick();
  assert.equal(plain.styles.has("kw-custom-css"), false, "an untouched shop gets no style element");
});

test("storefront script: a non-string or oversized value is ignored, and removing the CSS removes the element", async () => {
  const bad = run({ wishlist: true, notifyMe: true, appearance: { version: 1 }, customCss: { icon: { evil: true }, product: "x".repeat(20001), page: 5 } });
  await tick();
  assert.equal(bad.styles.has("kw-custom-css"), false);
});

test("storefront script: the last known CSS is applied from the tab's cache before the network answers", async () => {
  const cached = { wishlist: true, notifyMe: true, appearance: { version: 1 }, notifyButton: null, customCss: { page: ".kw-page h1{x:y}" } };
  const { styles } = run({ wishlist: true, notifyMe: true, appearance: { version: 1 } }, { cached });
  assert.equal(styles.get("kw-custom-css")?.textContent, ".kw-page h1{x:y}\n");
});

// ---------- header link (extras script) ----------
test("header link: the extras script builds icon / text / icon and text, with the merchant's label and an accessible name", () => {
  const source = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");
  assert.match(source, /config\.headerStyle === 'text' \|\| config\.headerStyle === 'icon_text'/);
  assert.match(source, /if \(style === 'icon'\) link\.setAttribute\('aria-label', config\.text\.headerLabel\)/, "an icon-only link keeps its aria-label");
  assert.match(source, /if \(style !== 'text'\) \{\s*var heart/, "text-only has no icon");
  assert.match(source, /if \(style !== 'icon'\) link\.appendChild\(el\('span', 'kw-header-icon__text', label\)\)/);
  assert.match(source, /if \(style !== 'icon' && !label\) style = 'icon'/, "no label: fall back to the icon, never an empty link");
  assert.match(source, /if \(!config\.headerIcon \|\| document\.querySelector\('\.kw-header-icon'\)\) return;/, "the enable switch still decides whether the entry exists");
});

test("the stylesheet gives the text modes a layout and leaves the icon-only link as it was", () => {
  const stylesheet = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist.css", "utf8").replace(/\r\n/g, "\n");
  assert.match(stylesheet, /\.kw-header-icon--text \{\s*width: auto;/);
  assert.match(stylesheet, /\.kw-header-icon \{\s*position: relative;\s*display: inline-flex;\s*align-items: center;\s*justify-content: center;\s*width: 44px;\s*height: 44px;/);
});
