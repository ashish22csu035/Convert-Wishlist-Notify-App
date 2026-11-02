// Notify Me Settings: the pure rules (app/utils/notify-settings-shared.js), the real email builder, the storefront script
// and stylesheet, the settings screen in jsdom, and persistence per shop (settings.server.js).
//
// Run: node --test tests/notify-settings.test.mjs
//
// The database tests WRITE rows, so they only run when DATABASE_URL (set in the environment) names an isolated kw_*test*
// database; otherwise they are skipped and say so. Nothing here sends a real email or talks to Shopify, and it cannot
// show how a real theme draws the button: see the notes in the final report.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { barDiscard, barSave, barShowing, canDiscard, canSave, installSaveBar, saveBars } from "./helpers/save-bar.mjs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import {
  DEFAULT_NOTIFY, NOTIFY_VARIABLES, effectiveNotify, fillTemplate, isNotifyDirty, mergeNotify, normalizeNotifyStored, notifyButtonStyle, publicNotifyButton,
  renderNotifyEmail, resolveNotify, inertEmailHtml, NOTIFY_PAGE_TYPES, NOTIFY_SUBSCRIBED_LABEL, sampleNotifyEmail, toSparseNotify, unknownVariables, validateNotify,
} from "../app/utils/notify-settings-shared.js";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { PrismaClient } = require("@prisma/client");
const mail = await import("../app/models/restock-email.server.js");

// ======================= defaults and validation =======================
test("an untouched shop gets today's button and today's email", () => {
  assert.deepEqual(DEFAULT_NOTIFY.button, { text: "Notify Me", style: "theme", bgColor: null, textColor: null });
  assert.deepEqual(DEFAULT_NOTIFY.email, { subject: "{{product}} is back in stock", heading: "", body: "Good news! {{product}} is back in stock.", ctaLabel: "View product" });
  for (const nothing of [null, undefined, "", "{", "[]", 7, {}, { button: null }, { email: [] }]) {
    assert.deepEqual(resolveNotify(nothing), DEFAULT_NOTIFY, JSON.stringify(nothing));
    assert.deepEqual(normalizeNotifyStored(nothing), { version: 1 });
  }
  assert.deepEqual(publicNotifyButton(null), {});
});

test("input is checked: lengths, types, colours, styles and variables", () => {
  const bad = (section, key, value) => Object.keys(validateNotify({ [section]: { [key]: value } }).errors);
  assert.deepEqual(bad("button", "text", ""), ["button.text"]);
  assert.deepEqual(bad("button", "text", "x".repeat(41)), ["button.text"]);
  assert.deepEqual(bad("button", "text", 5), ["button.text"]);
  assert.deepEqual(bad("button", "text", "Hi {{product}}"), ["button.text"], "no variables on the storefront button");
  assert.deepEqual(bad("button", "style", "neon"), ["button.style"]);
  for (const color of ["red", "rgb(1,2,3)", "url(x)", "#12", "#gggggg", "javascript:1", 7]) assert.deepEqual(bad("button", "bgColor", color), ["button.bgColor"], String(color));
  assert.deepEqual(bad("email", "subject", ""), ["email.subject"]);
  assert.deepEqual(bad("email", "subject", "x".repeat(151)), ["email.subject"]);
  assert.deepEqual(bad("email", "body", "x".repeat(1001)), ["email.body"]);
  assert.deepEqual(bad("email", "ctaLabel", "Go {{product}}"), ["email.ctaLabel"]);
  assert.deepEqual(bad("email", "subject", "Hi {{customer_name}}"), ["email.subject"], "there is no customer name variable");
  assert.match(validateNotify({ email: { body: "Hi {{ nope }}" } }).errors["email.body"], /Unknown variable \{\{nope\}\}/);

  assert.deepEqual(validateNotify({ button: { bgColor: "#ABC", style: "filled" }, email: { heading: "", subject: "Back: {{ PRODUCT }} at {{shop_name}}" } }), {
    values: { button: { bgColor: "#aabbcc", style: "filled" }, email: { heading: "", subject: "Back: {{ PRODUCT }} at {{shop_name}}" } },
    errors: {},
  });
  assert.deepEqual(validateNotify({ other: { x: 1 }, button: { nope: 1 } }), { values: {}, errors: {} }, "unknown sections and keys are ignored");
  assert.ok(validateNotify("{").errors.settings);
  assert.ok(validateNotify(JSON.stringify({ email: { body: "x".repeat(9000) } })).errors.settings, "oversized documents are refused");
  assert.ok(validateNotify([]).errors.settings);
  assert.deepEqual(unknownVariables("a {{product}} {{ x }} {{y}} {{x}}"), ["x", "y"]);
});

test("only changes are stored, but saved email text is kept even when it equals the default", () => {
  assert.deepEqual(toSparseNotify({ button: { text: "Notify Me", style: "filled" }, email: { subject: "{{product}} is back in stock", heading: "Hello" } }), {
    version: 1,
    button: { style: "filled" },
    email: { subject: "{{product}} is back in stock", heading: "Hello" },
  });
  assert.deepEqual(toSparseNotify(resolveNotify({})), { version: 1, email: DEFAULT_NOTIFY.email }, "a fully resolved untouched form keeps the email section explicit");
  assert.equal(isNotifyDirty(resolveNotify({}), {}), false, "dirty compares behaviour, not spelling");
  assert.equal(isNotifyDirty({ button: { text: "Tell me" } }, {}), true);
  assert.deepEqual(mergeNotify({ button: { text: "A" }, email: {} }, { button: { style: "outline" } }), { button: { text: "A", style: "outline" }, email: {} });
});

test("the older email columns are a fallback only for keys the new document does not have", () => {
  const legacy = { emailSubject: "Old: {{product}}", emailBody: "Old body", buttonLabel: "Old button" };
  assert.deepEqual(effectiveNotify(null, legacy).email, { subject: "Old: {{product}}", heading: "", body: "Old body", ctaLabel: "Old button" });
  assert.equal(effectiveNotify({ version: 1, email: { subject: "New" } }, legacy).email.subject, "New");
  assert.equal(effectiveNotify({ version: 1, email: { subject: "New" } }, legacy).email.body, "Old body");
  assert.deepEqual(effectiveNotify({ version: 1 }, { emailSubject: "  ", emailBody: null, buttonLabel: "" }).email, DEFAULT_NOTIFY.email);
});

test("the storefront gets the button section only, never the email text", () => {
  const stored = { version: 1, button: { text: "Tell me", style: "filled", bgColor: "#112233", textColor: "#fff" }, email: { subject: "Secret subject", body: "Secret body" }, evil: { x: 1 } };
  const sent = publicNotifyButton(stored);
  assert.deepEqual(sent, { text: "Tell me", style: "filled", bgColor: "#112233", textColor: "#ffffff" }, "valid values only, colours normalised, no email text and no unknown sections");
  assert.equal(JSON.stringify(sent).includes("Secret"), false);
});

// ======================= template rendering and escaping =======================
test("only the supported variables are filled; anything else stays as typed", () => {
  const values = { product: "Board", product_url: "https://s.example/p?variant=1", shop_name: "Snow Co" };
  assert.equal(fillTemplate("{{product}} / {{ PRODUCT }} / {{shop_name}} / {{product_url}}", values), "Board / Board / Snow Co / https://s.example/p?variant=1");
  assert.equal(fillTemplate("{{customer_name}} {{constructor}} {{__proto__}} {{product", values), "{{customer_name}} {{constructor}} {{__proto__}} {{product");
  assert.deepEqual(NOTIFY_VARIABLES.map((v) => v.token), ["product", "product_url", "shop_name"]);
});

test("merchant and customer-controlled text is escaped in the HTML and cannot break the subject", () => {
  const email = { subject: "Back: {{product}}", heading: "<b>Hi</b> {{shop_name}}", body: "Try {{product}}\r\nBcc: x@evil.com <img src=x onerror=alert(1)>", ctaLabel: "Buy \"now\" & save" };
  const values = { product: "Board <script>alert(1)</script>\r\nBcc: a@evil.com", product_url: "https://s.example/p?variant=1&a=\"x\"", shop_name: "O'Neil & Co" };
  const out = renderNotifyEmail(email, values, "https://app.example/unsub?t=1&u=2", "fallback");
  assert.equal(/[\r\n]/.test(out.subject), false);
  assert.equal(/<script|<img|<b>/.test(out.html), false, "no raw tags from either source");
  assert.ok(out.html.includes("&lt;script&gt;") && out.html.includes("&lt;img src=x onerror=alert(1)&gt;") && out.html.includes("&lt;b&gt;Hi&lt;/b&gt; O&#39;Neil &amp; Co"));
  assert.ok(out.html.includes('href="https://s.example/p?variant=1&amp;a=&quot;x&quot;"'), "the link attribute is escaped");
  assert.ok(out.html.includes("Buy &quot;now&quot; &amp; save"));
  assert.ok(out.html.includes('href="https://app.example/unsub?t=1&amp;u=2"'));
  assert.equal(out.text.includes("<"), true, "the plain-text part is plain text, not HTML");
});

test("the heading is optional, and the default email is exactly what shops got before", () => {
  const out = renderNotifyEmail(DEFAULT_NOTIFY.email, { product: "Board", product_url: "https://s.example/p?variant=1", shop_name: "S" }, "https://u.example/x", "fb");
  assert.equal(out.subject, "Board is back in stock");
  assert.equal(out.heading, "");
  assert.equal(
    out.text,
    "Good news! Board is back in stock.\n\nView product: https://s.example/p?variant=1\n\nYou are receiving this email because you asked to be notified when this item was back in stock.\nUnsubscribe: https://u.example/x\n",
  );
  assert.equal(out.html.includes("<h2"), false);
  assert.equal(
    out.html,
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;max-width:560px"><p>Good news! Board is back in stock.</p>` +
      `<p><a href="https://s.example/p?variant=1" style="display:inline-block;padding:12px 20px;background:#000;color:#fff;text-decoration:none;border-radius:4px">View product</a></p>` +
      `<p style="font-size:13px;color:#666">You are receiving this email because you asked to be notified when this item was back in stock.<br><a href="https://u.example/x" style="color:#666">Unsubscribe</a></p></div>`,
  );
  const withHeading = renderNotifyEmail({ ...DEFAULT_NOTIFY.email, heading: "It’s back!" }, { product: "Board", product_url: "https://s.example/p", shop_name: "S" }, "https://u.example/x", "fb");
  assert.ok(withHeading.html.includes("<h2") && withHeading.text.startsWith("It’s back!\n\n"));
});

test("the preview is the real renderer with sample data", () => {
  const sample = sampleNotifyEmail({ ...DEFAULT_NOTIFY.email, heading: "Hi from {{shop_name}}" });
  assert.equal(sample.subject, "Linen shirt (Medium) is back in stock");
  assert.ok(sample.html.includes("Hi from Your store") && sample.html.includes("Linen shirt (Medium)"));
});

// ======================= the real email builder =======================
const SHOP = { domain: "s.myshopify.com", name: "Snow Co" };
const BASE = { shop: SHOP, settings: null, variantGid: "gid://shopify/ProductVariant/42", recipient: "a@b.com", mailFrom: "x@y.com", unsubscribeLink: "https://app.example.invalid/notify/unsubscribe?t=abc", messageId: "<id@x>" };
const PRODUCT = { productTitle: "Board", handle: "board", onlineStoreUrl: null, variantTitle: "Default Title" };

test("real restock emails use the merchant's settings, and a shop with none gets the default email", () => {
  const plain = mail.buildRestockEmail({ ...BASE, product: PRODUCT });
  assert.equal(plain.subject, "Board is back in stock");
  assert.ok(plain.text.startsWith("Good news! Board is back in stock.\n\nView product: https://s.myshopify.com/products/board?variant=42"));

  const settings = { notifyMeSettings: { version: 1, email: { subject: "{{shop_name}}: {{product}} is here", heading: "Back!", body: "Grab {{product}}: {{product_url}}", ctaLabel: "Shop now" } } };
  const custom = mail.buildRestockEmail({ ...BASE, settings, product: PRODUCT });
  assert.equal(custom.subject, "Snow Co: Board is here");
  assert.ok(custom.text.startsWith("Back!\n\nGrab Board: https://s.myshopify.com/products/board?variant=42\n\nShop now: https://s.myshopify.com/products/board?variant=42"));
  assert.ok(custom.html.includes("<h2") && custom.html.includes(">Shop now</a>"));
  assert.deepEqual(custom.from, { name: "Snow Co", address: "x@y.com" });
});

test("the older email columns still work, and the new settings win over them", () => {
  const legacy = { emailSubject: "Back: {{product}}", emailBody: "It is here: {{product}}", buttonLabel: "Buy", senderName: "Snow Co", replyToEmail: "help@snow.com" };
  const old = mail.buildRestockEmail({ ...BASE, settings: legacy, product: PRODUCT });
  assert.deepEqual([old.subject, old.replyTo], ["Back: Board", "help@snow.com"]);
  assert.ok(old.text.includes("It is here: Board") && old.text.includes("Buy:"));
  const mixed = mail.buildRestockEmail({ ...BASE, settings: { ...legacy, notifyMeSettings: { version: 1, email: { subject: "New: {{product}}" } } }, product: PRODUCT });
  assert.equal(mixed.subject, "New: Board");
  assert.ok(mixed.text.includes("It is here: Board"), "keys the new document lacks still fall back");
});

test("nothing is invented: no product, no safe link or no recipient still means no email", () => {
  const settings = { notifyMeSettings: { version: 1, email: { body: "Hello {{product}}" } } };
  assert.equal(mail.buildRestockEmail({ ...BASE, settings, product: { productTitle: "", handle: "h" } }), null);
  assert.equal(mail.buildRestockEmail({ ...BASE, settings, product: { productTitle: "T", handle: "h", onlineStoreUrl: "javascript:alert(1)" } }), null);
  assert.equal(mail.buildRestockEmail({ ...BASE, settings, recipient: "", product: PRODUCT }), null);
  const hostile = mail.buildRestockEmail({ ...BASE, settings: { notifyMeSettings: { email: { subject: "{{customer_name}} {{product}}" } } }, product: PRODUCT });
  assert.equal(hostile.subject, "Board is back in stock", "an invalid stored template falls back to the default instead of sending {{customer_name}}");
});

// ======================= storefront =======================
const ASSETS = "extensions/konvert-wishlist/assets/";
const CORE = fs.readFileSync(ASSETS + "konvert-wishlist.js", "utf8");
const CSS = fs.readFileSync(ASSETS + "konvert-wishlist.css", "utf8").replace(/\r\n/g, "\n");
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function boot({ features, cache = null } = {}) {
  const attributes = {};
  const variables = {};
  const root = {
    lang: "en",
    setAttribute: (name, value) => { attributes[name] = String(value); },
    removeAttribute: (name) => { delete attributes[name]; },
    style: { setProperty: (name, value) => { variables[name] = String(value); }, removeProperty: (name) => { delete variables[name]; } },
    classList: { add() {}, remove() {}, contains: () => false },
  };
  const store = new Map(cache ? [["kw:features", JSON.stringify(cache)]] : []);
  const node = { textContent: JSON.stringify({ featuresPath: "/apps/konvert-notify/api/features", text: { notifyMe: "Notify Me" } }) };
  const document = { readyState: "complete", documentElement: root, head: { appendChild() {} }, body: {}, createElement: () => ({}), querySelectorAll: (s) => (s === "script[data-kw-config]" ? [node] : []), querySelector: () => null, addEventListener() {} };
  const window = { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, Shopify: { routes: { root: "/" } }, location: { assign() {} } };
  const fetch = async () => ({ ok: true, status: 200, json: async () => features });
  vm.runInContext(CORE, vm.createContext({ window, document, fetch, console: { warn() {}, log() {} } }));
  return { attributes, variables, kw: window.KonvertWishlist, settle: () => tick() };
}

test("storefront: a shop that never customised the button is left alone", async () => {
  for (const features of [{ wishlist: true, notifyMe: true }, { wishlist: true, notifyMe: true, notifyButton: null }, { wishlist: true, notifyMe: true, notifyButton: {} }, { wishlist: true, notifyMe: true, notifyButton: "x" }]) {
    const page = boot({ features });
    await page.settle();
    assert.deepEqual(page.attributes, {}, JSON.stringify(features));
    assert.deepEqual(page.variables, {});
    assert.equal(page.kw.config.text.notifyMe, "Notify Me");
  }
});

test("storefront: the saved text, style and colours reach the page", async () => {
  const page = boot({ features: { wishlist: true, notifyMe: true, notifyButton: { text: "Tell me when it's back", style: "filled", bgColor: "#112233", textColor: "#ffffff" } } });
  await page.settle();
  assert.equal(page.kw.config.text.notifyMe, "Tell me when it's back");
  assert.deepEqual(page.attributes, { "data-kw-notify-style": "filled", "data-kw-notify-bg": "1", "data-kw-notify-text": "1" });
  assert.deepEqual(page.variables, { "--kw-notify-bg": "#112233", "--kw-notify-text": "#ffffff" });
});

test("storefront: hostile or malformed values are ignored, whatever the cache or server held", async () => {
  const hostile = { text: "x".repeat(41), style: "red; background:url(x)", bgColor: "red; } body { display:none", textColor: "javascript:alert(1)" };
  const page = boot({ features: { wishlist: true, notifyMe: true, notifyButton: hostile } });
  await page.settle();
  assert.deepEqual(page.attributes, {});
  assert.deepEqual(page.variables, {});
  assert.equal(page.kw.config.text.notifyMe, "Notify Me");
  const early = boot({ features: "fail", cache: { t: Date.now() - 1000, v: { wishlist: true, notifyMe: true, appearance: null, notifyButton: { style: "outline", bgColor: "#aabbcc" } } } });
  assert.equal(early.attributes["data-kw-notify-style"], "outline", "the last known look is applied before the network answers");
  assert.equal(early.variables["--kw-notify-bg"], "#aabbcc");
});

test("storefront stylesheet gives every attribute its effect, and matches the settings preview", () => {
  for (const needle of [
    'html[data-kw-notify-style="filled"] [data-kw-notify]',
    'html[data-kw-notify-style="outline"] [data-kw-notify]',
    "html:not([data-kw-notify-style])[data-kw-notify-bg] [data-kw-notify]",
    "html:not([data-kw-notify-style])[data-kw-notify-text] [data-kw-notify]",
    "var(--kw-notify-bg",
    "var(--kw-notify-text",
  ]) assert.ok(CSS.includes(needle), needle);
  assert.deepEqual(notifyButtonStyle({ style: "filled", bgColor: "#112233", textColor: "#ffffff" }), { background: "#112233", border: "1px solid #112233", color: "#ffffff" });
  assert.equal(notifyButtonStyle({ style: "outline", bgColor: "#112233" }).background, "transparent");
  assert.equal(notifyButtonStyle({ style: "filled" }).background, "#111111", "the same fallback colours as the stylesheet");
  assert.ok(CSS.includes("#111111") && CSS.includes("#ffffff"));
});

test("the extras script shows the configured text through the same text() lookup", () => {
  const extras = fs.readFileSync(ASSETS + "konvert-wishlist-extras.js", "utf8");
  assert.ok(extras.includes("text('notifyMe', 'Notify Me')"), "the button label comes from config.text.notifyMe, which the saved text overrides");
});

// ======================= the settings screen =======================
const OUT_DIR = path.resolve("node_modules/.cache/kw-notify-settings-test");
let Form;
let Settings;
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
  for (const name of ["window", "document", "HTMLElement", "Node", "Event", "MouseEvent"]) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now().toString(36);
  const bundle = async (entry, name) => {
    const outfile = path.join(OUT_DIR, `${name}-${stamp}.mjs`);
    await build({
      entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", jsx: "automatic", loader: { ".css": "empty" },
      external: ["react", "react/jsx-runtime", "react-dom", "react-router"],
      alias: { "@shopify/shopify-app-react-router/server": path.resolve("tests/helpers/shopify-server-stub.mjs") },
      logLevel: "silent",
    });
    return import(pathToFileURL(outfile).href);
  };
  Form = await bundle("app/components/notify-settings-form.jsx", "nsform");
  Settings = await bundle("app/components/settings-form.jsx", "settings");
  React = (await import("react")).default;
  ReactRouter = await import("react-router");
  ({ createRoot } = await import("react-dom/client"));
});

after(async () => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  dom?.window.close();
  await prisma?.$disconnect();
});

const act = (fn) => React.act(async () => fn());
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byText = (selector, text) => [...container.querySelectorAll(selector)].find((el) => el.textContent.trim() === text);
const field = (label) => container.querySelector(`[label="${label}"]`);
const type = (el, value) => act(() => { el.value = value; fire(el, "input"); });
const saveButton = () => barSave(document);
const unmount = () => React.act(async () => root.unmount());

async function mountForm({ settings = resolveNotify({}), action } = {}) {
  const posted = [];
  const Stub = ReactRouter.createRoutesStub([
    {
      path: "/",
      Component: () => h(Form.NotifySettingsForm, { settings }),
      action: async ({ request }) => {
        const raw = (await request.formData()).get("settings");
        posted.push(raw);
        if (action) return action(raw);
        const { values, errors } = validateNotify(raw);
        if (Object.keys(errors).length) return { ok: false, errors };
        return { ok: true, errors: {}, settings: resolveNotify(mergeNotify(settings, values)) };
      },
    },
    { path: "/app/settings", Component: () => h("div", { id: "settings-page" }, "settings") },
  ]);
  container = document.getElementById("root");
  container.innerHTML = "";
  root = createRoot(container);
  await React.act(async () => root.render(h(Stub, { initialEntries: ["/?embedded=1&host=abc"] })));
  await act(() => sleep(20));
  return { posted };
}

test("screen: it opens on the Button tab with defaults and a preview, and Email has its own fields and preview", async () => {
  await mountForm();
  assert.equal(field("Button text").getAttribute("value"), "Notify Me");
  assert.ok(field("Button style") && field("Background color") && field("Text color"));
  assert.equal(container.querySelector(".kv-np-notify").textContent, "Notify Me");
  await click(byText('button[role="tab"]', "Email"));
  assert.equal(field("Email subject").getAttribute("value"), "{{product}} is back in stock");
  assert.ok(field("Email heading") && field("Email body") && field("Button label"));
  const frame = container.querySelector("iframe");
  assert.equal(frame.getAttribute("sandbox"), "", "the preview frame is fully sandboxed");
  assert.match(frame.getAttribute("srcdoc"), /Linen shirt \(Medium\) is back in stock|Good news! Linen shirt \(Medium\) is back in stock\./);
  assert.match(field("Email subject").getAttribute("details"), /\{\{product\}\}.*\{\{product_url\}\}.*\{\{shop_name\}\}/, "the supported variables are listed, and only those");
  assert.equal(/customer_name/.test(field("Email subject").getAttribute("details")), false);
  await unmount();
});

test("screen: edits update the previews, Save sends one JSON document and confirms, Discard goes back", async () => {
  const { posted } = await mountForm();
  assert.equal(canSave(), false, "nothing to save yet");
  await type(field("Button text"), "Tell me");
  assert.equal(container.querySelector(".kv-np-notify").textContent, "Tell me");
  await act(() => { field("Button style").value = "filled"; fire(field("Button style"), "change"); });
  assert.equal(container.querySelector(".kv-np-notify").style.background !== "", true);
  await click(byText('button[role="tab"]', "Email"));
  await type(field("Email heading"), "Back <b>now</b>");
  assert.match(container.querySelector("iframe").getAttribute("srcdoc"), /Back &lt;b&gt;now&lt;\/b&gt;/, "the heading is escaped in the preview too");
  assert.equal(barShowing(), true, "the native Save bar is showing");
  await click(barDiscard());
  assert.equal(barShowing(), false, "Discard hides the bar");
  await click(byText('button[role="tab"]', "Button"));
  assert.equal(field("Button text").getAttribute("value"), "Notify Me");

  await type(field("Button text"), "Tell me");
  await click(saveButton());
  await act(() => sleep(20));
  assert.equal(posted.length, 1);
  assert.equal(JSON.parse(posted[0]).button.text, "Tell me");
  const banner = container.querySelector('s-banner[tone="success"]');
  assert.equal(banner.getAttribute("heading"), "Notify Me settings saved");
  assert.match(banner.textContent, /Saving sends no email/);
  await unmount();
});

test("native Save bar: one Shopify bar, shown only while something changed, kept across tabs and after a failed save; the page has no Save buttons of its own", async () => {
  let failNext = true;
  const { posted } = await mountForm({ action: (raw) => (failNext ? ((failNext = false), { ok: false, errors: {}, failed: true }) : { ok: true, errors: {}, settings: resolveNotify(mergeNotify(resolveNotify({}), validateNotify(raw).values)) }) });
  assert.equal(saveBars().length, 1, "exactly one bar");
  assert.equal(saveBars()[0].id, "notify-settings-save-bar");
  assert.equal(barShowing(), false, "no change, no bar");
  for (const label of ["Save", "Discard", "Saving…"]) assert.equal(byText("s-button", label), undefined, `no page-level ${label} button`);
  assert.equal(container.textContent.includes("Unsaved changes"), false);
  await type(field("Button text"), "Tell me");
  assert.equal(barShowing(), true);
  await click(byText('button[role="tab"]', "Email")); // switching tabs keeps the edit and the bar
  assert.equal(barShowing(), true);
  await type(field("Email heading"), "Hello");
  await click(saveButton());
  await act(() => sleep(30));
  assert.equal(posted.length, 1);
  assert.equal(barShowing(), true, "a failed save does not hide the bar");
  assert.equal(canSave(), true, "and Save can be pressed again");
  await click(byText('button[role="tab"]', "Button"));
  assert.equal(field("Button text").getAttribute("value"), "Tell me", "the edit survived the failed save");
  await click(saveButton());
  await act(() => sleep(30));
  assert.equal(posted.length, 2);
  assert.deepEqual([JSON.parse(posted[1]).button.text, JSON.parse(posted[1]).email.heading], ["Tell me", "Hello"], "both tabs' edits are in the one save");
  assert.equal(barShowing(), false, "hidden only after the server confirmed");
  assert.equal(saveBars().length, 1);
  await type(field("Button text"), "Something else");
  await click(barDiscard());
  assert.equal(posted.length, 2, "Discard sends nothing");
  assert.equal(field("Button text").getAttribute("value"), "Tell me", "back to the last SAVED value");
  assert.equal(barShowing(), false);
  await unmount();
});

test("screen: an unknown variable or an empty field is flagged and cannot be saved", async () => {
  const { posted } = await mountForm();
  await click(byText('button[role="tab"]', "Email"));
  await type(field("Email body"), "Hi {{customer_name}}");
  assert.match(field("Email body").getAttribute("error"), /Unknown variable \{\{customer_name\}\}/);
  assert.equal(canSave(), false);
  await click(saveButton());
  assert.equal(posted.length, 0, "no request is made");
  await type(field("Email body"), "");
  assert.ok(field("Email body").getAttribute("error"));
  await unmount();
});

test("screen: Reset to defaults only resets the current tab", async () => {
  await mountForm({ settings: resolveNotify({ button: { text: "Tell me" }, email: { heading: "Hi" } }) });
  await click(byText("s-button", "Reset to defaults"));
  assert.equal(field("Button text").getAttribute("value"), "Notify Me");
  await click(byText('button[role="tab"]', "Email"));
  assert.equal(field("Email heading").getAttribute("value"), "Hi");
  await unmount();
});


// ---- preview: viewport, page types, local-only Notify Me, inert email button ----
const pressed = (label) => [...container.querySelectorAll(".kv-seg-btn")].find((el) => el.textContent === label);
const notifyBtn = () => container.querySelector(".kv-np-notify");

test("screen preview: Desktop/Mobile and the page types switch at once and keep unsaved edits across tabs", async () => {
  await mountForm();
  assert.equal(container.querySelector(".kv-np-canvas").dataset.viewport, "desktop");
  assert.equal(pressed("Desktop").getAttribute("aria-pressed"), "true");
  await type(field("Button text"), "Tell me");
  await click(pressed("Mobile"));
  assert.equal(container.querySelector(".kv-np-canvas").dataset.viewport, "mobile");
  assert.equal(notifyBtn().textContent, "Tell me", "unsaved text shows in the preview");
  await click(pressed("Wishlist page"));
  assert.match(container.querySelector(".kv-np-canvas").textContent, /My Wishlist/);
  assert.equal(notifyBtn().textContent, "Tell me");
  await click(byText('button[role="tab"]', "Email"));
  assert.equal(container.querySelector("iframe").closest(".kv-np-email").className.includes("kv-np-email--mobile"), true, "Mobile applies to the email too");
  await click(byText('button[role="tab"]', "Button"));
  assert.equal(field("Button text").getAttribute("value"), "Tell me", "switching tabs keeps the edit");
  assert.equal(container.querySelector(".kv-np-canvas").dataset.viewport, "mobile");
  assert.equal(pressed("Wishlist page").getAttribute("aria-pressed"), "true");
  await unmount();
});

test("screen preview: only Product and Wishlist page options exist, Product is the default", async () => {
  await mountForm();
  const labels = [...container.querySelectorAll(".kv-seg-btn")].map((el) => el.textContent);
  assert.equal(labels.includes("Collection page"), false);
  assert.equal(pressed("Product page").getAttribute("aria-pressed"), "true");
  assert.equal(pressed("Wishlist page").getAttribute("aria-pressed"), "false");
  assert.equal(NOTIFY_PAGE_TYPES.map((page) => page.key).join(), "product,wishlist");
  await unmount();
});

test("screen preview: on Mobile the product page shows the button, the photo is short enough to leave room, and it stays local", async () => {
  await mountForm();
  await type(field("Button text"), "Tell me");
  await click(pressed("Mobile"));
  assert.equal(container.querySelector(".kv-np-canvas").dataset.viewport, "mobile");
  assert.equal(notifyBtn().textContent, "Tell me");
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  assert.match(css, /\.kv-np-canvas\[data-viewport="mobile"\] \.kv-np-img--lg \{ aspect-ratio: 4 \/ 3; \}/, "the mobile photo box is shorter, so the button is inside the 600px canvas; the photo still fills the full width (object-fit cover)");
  await click(notifyBtn());
  assert.equal(notifyBtn().textContent, "You're on the list!");
  await click(pressed("Desktop"));
  assert.equal(notifyBtn().textContent, "You're on the list!", "the local preview state survives the size toggle");
  await unmount();
});

test("screen preview: clicking Notify Me changes local state only, and Reset preview restores it", async () => {
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { requests.push(args); return Promise.reject(new Error("no requests expected")); };
  const { posted } = await mountForm();
  try {
    for (const page of ["Product page", "Wishlist page"]) {
      await click(pressed(page));
      assert.equal(notifyBtn().textContent, "Notify Me");
      await click(notifyBtn());
      assert.equal(notifyBtn().textContent, "You're on the list!", "the live theme's own success wording");
      assert.equal(notifyBtn().disabled, true);
      assert.equal(byText("s-button", "Reset preview").hasAttribute("disabled"), false);
      await click(byText("s-button", "Reset preview"));
      assert.equal(notifyBtn().textContent, "Notify Me");
      assert.equal(notifyBtn().disabled, false);
    }
    await click(notifyBtn());
    assert.equal(barShowing(), false, "a preview click is not a settings edit");
    assert.equal(requests.length, 0, "no request of any kind");
    assert.equal(posted.length, 0, "nothing was saved");
    const code = fs.readFileSync("app/components/notify-preview.jsx", "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|konvert-notify|useFetcher|useSubmit/.test(code), false, "the preview code has no way to reach a backend");
  } finally {
    globalThis.fetch = realFetch;
  }
  await unmount();
});

test("screen preview: the email follows unsaved edits and its button is inert", async () => {
  await mountForm();
  await click(byText('button[role="tab"]', "Email"));
  await type(field("Email subject"), "Back: {{product}}");
  await type(field("Email heading"), "Hello");
  await type(field("Email body"), "It is here");
  await type(field("Button label"), "Go see it");
  const html = container.querySelector("iframe").getAttribute("srcdoc");
  assert.match(html, /Hello/);
  assert.match(html, /It is here/);
  assert.match(html, /Go see it/);
  assert.match(container.textContent, /Back: Linen shirt \(Medium\)/);
  assert.equal(/href=/.test(html), false, "no link in the preview document: a click cannot navigate or open a tab");
  assert.match(html, /role="button"[^>]*>Go see it<\/a>/);
  assert.equal(container.querySelector("iframe").getAttribute("sandbox"), "");
  await unmount();
});

test("inertEmailHtml removes every href but keeps the look", () => {
  const html = sampleNotifyEmail(DEFAULT_NOTIFY.email).html;
  assert.match(html, /href=/, "the real email has links");
  const inert = inertEmailHtml(html);
  assert.equal(/href=/.test(inert), false);
  assert.match(inert, /background:#000;color:#fff/);
});

test("the storefront supports Notify Me on product and Wishlist pages only, with the wording the preview uses", () => {
  const extras = fs.readFileSync("extensions/konvert-wishlist/assets/konvert-wishlist-extras.js", "utf8");
  assert.match(extras, /config\.pageType !== 'product'/, "the product page is the only page type that relabels Add to cart");
  assert.match(extras, /kind === 'out' && row\.item\.variantId/, "sold-out Wishlist rows get Notify Me");
  assert.equal(/CARD_PAGE_TYPES[^\n]*notify/i.test(extras), false);
  const locale = JSON.parse(fs.readFileSync("extensions/konvert-wishlist/locales/en.default.json", "utf8"));
  assert.equal(locale.kw.notify_subscribed, NOTIFY_SUBSCRIBED_LABEL);
});

test("screen: a failed save keeps the edits and says so", async () => {
  await mountForm({ action: () => ({ ok: false, errors: {}, failed: true }) });
  await type(field("Button text"), "Tell me");
  await click(saveButton());
  await act(() => sleep(20));
  assert.match(container.textContent, /Something went wrong while saving/);
  assert.equal(field("Button text").getAttribute("value"), "Tell me");
  await unmount();
});

test("the Settings page links to Notify Me Settings, and the route reads the shop from the session", async () => {
  container = document.getElementById("root");
  container.innerHTML = "";
  root = createRoot(container);
  const Stub = ReactRouter.createRoutesStub([{ path: "/", Component: () => h(Settings.SettingsForm, { settings: { wishlistEnabled: true, notifyMeEnabled: true } }) }, { path: "/app/notify-settings", Component: () => h("div", { id: "notify-page" }, "notify") }]);
  await React.act(async () => root.render(h(Stub, { initialEntries: ["/?embedded=1"] })));
  await click(byText("s-button", "Notify Me Settings"));
  assert.ok(container.querySelector("#notify-page"));
  await unmount();

  const route = fs.readFileSync("app/routes/app.notify-settings.jsx", "utf8");
  assert.match(route, /authenticate\.admin\(request\)/);
  assert.match(route, /getNotifySettings\(session\.shop\)/);
  assert.match(route, /saveNotifySettings\(session\.shop, raw\)/);
  assert.equal(/get\("(shop|domain)"\)/.test(route), false, "the shop never comes from the form");
});

// ======================= persistence per shop (database) =======================
const dbUrl = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const prisma = skip ? null : new PrismaClient();
const dbTest = (name, fn) => test(name, { skip }, fn);
const RUN = Date.now().toString(36);
const domains = [];
const newShop = async (tag) => {
  const domain = `kw-ns-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
});

dbTest("a shop with nothing saved gets the defaults; saving stores only this column and sends no email", async () => {
  const model = await import("../app/models/settings.server.js");
  const shop = await newShop("a");
  assert.deepEqual(await model.getNotifySettings(shop.domain), DEFAULT_NOTIFY);
  assert.deepEqual(await model.getNotifySettings("unknown-shop.myshopify.com"), DEFAULT_NOTIFY);

  await model.saveSettings(shop.domain, { wishlistEnabled: false, notifyMeEnabled: true });
  await prisma.shopSettings.update({ where: { shopId: shop.id }, data: { emailSubject: "Old subject", senderName: "Snow Co" } });
  const deliveriesBefore = await prisma.emailDelivery.count({ where: { shopId: shop.id } });

  const saved = await model.saveNotifySettings(shop.domain, JSON.stringify({ button: { text: "Tell me", style: "filled", bgColor: "#112233" }, email: { heading: "It is back" } }));
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.button.text, "Tell me");
  assert.equal(saved.settings.email.subject, "Old subject", "what the screen showed (the older column) is kept, not lost");

  const row = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } });
  assert.equal(row.wishlistEnabled, false, "the switches are untouched");
  assert.deepEqual([row.emailSubject, row.senderName], ["Old subject", "Snow Co"], "the older columns are untouched");
  assert.deepEqual(row.notifyMeSettings.button, { text: "Tell me", style: "filled", bgColor: "#112233" });
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id } }), deliveriesBefore, "saving queued and sent nothing");
  assert.deepEqual(await model.getNotifySettings(shop.domain), saved.settings, "it survives a fresh read");

  const second = await model.saveNotifySettings(shop.domain, { email: { subject: "{{product}} restocked" } });
  assert.equal(second.settings.button.text, "Tell me", "a partial save keeps the rest");
  assert.equal(second.settings.email.heading, "It is back");
  const reset = await model.saveNotifySettings(shop.domain, { email: { subject: "{{product}} is back in stock" } });
  assert.equal(reset.settings.email.subject, "{{product}} is back in stock", "a saved default is not replaced by the older column");
});

dbTest("invalid input is refused and nothing is written; shops are isolated", async () => {
  const model = await import("../app/models/settings.server.js");
  const a = await newShop("b");
  const b = await newShop("c");
  const refused = await model.saveNotifySettings(a.domain, { email: { subject: "Hi {{customer_name}}" }, button: { text: "ok" } });
  assert.equal(refused.ok, false);
  assert.ok(refused.errors["email.subject"]);
  assert.equal(await prisma.shopSettings.findUnique({ where: { shopId: a.id } }), null, "not even the valid part was written");

  await model.saveNotifySettings(a.domain, { button: { text: "Shop A" } });
  assert.equal((await model.getNotifySettings(b.domain)).button.text, "Notify Me", "shop B is untouched");
  await model.saveNotifySettings(b.domain, { button: { text: "Shop B" } });
  assert.equal((await model.getNotifySettings(a.domain)).button.text, "Shop A");
});

dbTest("the features answer carries the button for the shop, only once customised, and never the email text", async () => {
  const model = await import("../app/models/settings.server.js");
  const shop = await newShop("d");
  assert.equal("notifyButton" in (await model.getStorefrontFeatures(shop.domain)), false, "untouched shops get the same answer as before");
  await model.saveNotifySettings(shop.domain, { button: { text: "Tell me", bgColor: "#112233" }, email: { subject: "Secret {{product}}", body: "Secret body" } });
  const features = await model.getStorefrontFeatures(shop.domain);
  assert.deepEqual(features.notifyButton, { text: "Tell me", bgColor: "#112233" });
  assert.equal(JSON.stringify(features).includes("Secret"), false);
  const other = await newShop("e");
  assert.equal("notifyButton" in (await model.getStorefrontFeatures(other.domain)), false);
});

dbTest("the real worker path reads the saved template: the settings row loaded like the sender loads it renders the custom email", async () => {
  const model = await import("../app/models/settings.server.js");
  const shop = await newShop("f");
  await model.saveNotifySettings(shop.domain, { email: { subject: "{{shop_name}}: {{product}} is back", heading: "Hello", ctaLabel: "Get it" } });
  const settings = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } }); // the same query email-delivery.server.js uses
  const built = mail.buildRestockEmail({ ...BASE, shop: { domain: shop.domain, name: "Snow Co" }, settings, product: PRODUCT });
  assert.equal(built.subject, "Snow Co: Board is back");
  assert.ok(built.html.includes(">Hello</h2>") && built.html.includes(">Get it</a>"));
  assert.match(fs.readFileSync("app/models/email-delivery.server.js", "utf8"), /prisma\.shopSettings\.findUnique\(\{ where: \{ shopId: job\.shopId \} \}\)/, "the sender loads the whole settings row, including notifyMeSettings");
});
