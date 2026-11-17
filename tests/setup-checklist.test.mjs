// Tests for the Dashboard setup checklist: the pure rules (app/utils/onboarding-shared.js, theme-editor.js), the real
// component (app/components/setup-checklist.jsx) rendered in jsdom inside a react-router stub, its placement on the
// Dashboard, and persistence per shop (settings.server.js getOnboarding / saveOnboardingIntent).
//
// Run: node --test tests/setup-checklist.test.mjs
//
// The database tests WRITE rows, so they only run when DATABASE_URL (set in the environment) names an isolated
// kw_*test* database; otherwise they are skipped and say so. Polaris web components are plain unknown elements in jsdom,
// so this proves the logic and wiring, not how Polaris draws the card.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { EMBED_HANDLE, ONBOARDING_DEFAULT, ONBOARDING_INTENTS, PRODUCT_BLOCK_HANDLE, applyOnboardingIntent, detectThemeSetup, guideView, normalizeOnboarding, setupChecklist } from "../app/utils/onboarding-shared.js";
import { DEFAULT_APPEARANCE } from "../app/utils/wishlist-appearance-shared.js";
import { themeEditorLinks } from "../app/utils/theme-editor.js";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { PrismaClient } = require("@prisma/client");

// ======================= pure rules =======================
const block = (handle, status, targets = []) => ({ handle, name: handle, target: "section", status, activations: targets.map((target) => ({ target, themeId: "gid://shopify/OnlineStoreTheme/1" })) });
const themeExt = (...blocks) => ({ handle: "konvert-wishlist", type: "theme_app_extension", activations: blocks });
const ON = [themeExt(block("wishlist-embed", "active", ["theme"]), block("wishlist-button", "active", ["template--123__main"]))];

test("the embed and product block are detected from Shopify's own activation data", () => {
  assert.deepEqual(detectThemeSetup(ON), { embed: true, product: true });
  assert.deepEqual(detectThemeSetup([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "available"))]), { embed: false, product: false });
  assert.deepEqual(detectThemeSetup([themeExt(block("wishlist-embed", "active", ["theme"]), block("wishlist-button", "unavailable"))]), { embed: true, product: false }, "the two are separate");
  assert.deepEqual(detectThemeSetup([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "active", ["template--123__main"]))]), { embed: false, product: true });
});

test("a product block that is active but only placed in a section group, or nowhere, is not the product page", () => {
  assert.equal(detectThemeSetup([themeExt(block("wishlist-button", "active", ["sectionGroup:header"]))]).product, false);
  assert.equal(detectThemeSetup([themeExt(block("wishlist-button", "active", []))]).product, false);
  assert.equal(detectThemeSetup([themeExt(block("wishlist-button", "active", ["sectionGroup:header", "template--9__main"]))]).product, true);
});

test("anything unexpected is unknown, never completed", () => {
  for (const bad of [undefined, null, "", 7, {}, [], [null], [{}], [{ type: "ui_extension", activations: [{ target: "x" }] }], [{ type: "theme_app_extension" }], [themeExt(block("something-else", "active", ["theme"]))], [themeExt(block("wishlist-embed", "weird"), block("wishlist-button", ""))]]) {
    const result = detectThemeSetup(bad);
    assert.deepEqual(result, { embed: null, product: null }, JSON.stringify(bad));
  }
  assert.equal(detectThemeSetup([themeExt(block("wishlist-button", "active", [null, { target: 5 }]))]).product, false);
  assert.equal(detectThemeSetup([themeExt(block("other-embed", "active", ["theme"]), block("wishlist-embed", "active", ["theme"]))]).embed, true, "matched by handle, whatever else is listed");
});

test("the progress count comes from the real step states; checking and unknown never count", () => {
  const view = (theme, appearanceSaved) => setupChecklist({}, { appearanceSaved, theme });
  assert.equal(view(undefined, true).completed, 1, "the theme steps are still being checked");
  assert.deepEqual(view(undefined, false).steps.map((s) => s.status), ["Action required", "Checking…", "Checking…"]);
  assert.equal(view({ embed: null, product: null }, true).completed, 1);
  assert.deepEqual(view({ embed: null, product: false }, false).steps.map((s) => s.status), ["Action required", "Can’t check", "Action required"]);
  assert.equal(view({ embed: true, product: false }, true).completed, 2);
  const all = view({ embed: true, product: true }, true);
  assert.deepEqual([all.completed, all.total, all.allDone], [3, 3, true]);
  assert.deepEqual(view({ embed: true, product: false }, true).steps.map((s) => s.status), ["Completed", "Completed", "Action required"]);
});

test("stored state holds only the dismissal; the old manual flags are ignored", () => {
  for (const bad of [null, undefined, "", "{", "[]", 7, [], { dismissed: "true" }, { dismissed: 1 }]) {
    assert.deepEqual(normalizeOnboarding(bad), ONBOARDING_DEFAULT, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeOnboarding({ embedConfirmed: true, productConfirmed: true, dismissed: true }), { dismissed: true });
  assert.equal(setupChecklist({ embedConfirmed: true, productConfirmed: true }, { theme: { embed: false, product: false } }).completed, 0, "an old confirmation completes nothing");
  assert.deepEqual(applyOnboardingIntent({ embedConfirmed: true, dismissed: false }, "dismiss"), { dismissed: true }, "and is dropped on the next write");
});

test("only dismiss and reopen are accepted; there is no way to confirm a step by hand", () => {
  assert.deepEqual(applyOnboardingIntent(null, "dismiss"), { dismissed: true });
  assert.deepEqual(applyOnboardingIntent({ dismissed: true }, "reopen"), { dismissed: false });
  for (const bad of ["embed_done", "product_done", "embed_undo", "configure_done", "", "toString", "__proto__", null, undefined, 3]) assert.equal(applyOnboardingIntent(null, bad), null, String(bad));
  assert.deepEqual([...ONBOARDING_INTENTS].sort(), ["dismiss", "reopen"]);
});

test("theme editor links point at this extension's own blocks and never guess an id", () => {
  const links = themeEditorLinks("demo.myshopify.com", "key123");
  assert.equal(links.embedUrl, "https://demo.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=key123/wishlist-embed");
  assert.equal(links.blockUrl, "https://demo.myshopify.com/admin/themes/current/editor?template=product&addAppBlockId=key123/wishlist-button&target=mainSection");
  assert.deepEqual(themeEditorLinks("demo.myshopify.com", ""), { embedUrl: "https://demo.myshopify.com/admin/themes/current/editor?context=apps", blockUrl: "https://demo.myshopify.com/admin/themes/current/editor?template=product" });
  for (const [file, handle] of [["wishlist-embed.liquid", EMBED_HANDLE], ["wishlist-button.liquid", PRODUCT_BLOCK_HANDLE]]) {
    assert.ok(fs.existsSync(`extensions/konvert-wishlist/blocks/${file}`), `${handle} is a real block file`);
    assert.equal(file, `${handle}.liquid`, "the detected handle is the block's file name");
  }
  assert.match(fs.readFileSync("extensions/konvert-wishlist/blocks/wishlist-button.liquid", "utf8"), /"enabled_on":\s*\{\s*"templates":\s*\["product"\]/, "the product block can only be placed on product templates");
});

test("the Dashboard shows the checklist after the KPI cards and before Activity, Recent activity and Top products", () => {
  const source = fs.readFileSync("app/routes/app._index.jsx", "utf8");
  const at = (needle) => {
    const i = source.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  const kpis = at("</Grid>");
  const checklist = at("<SetupChecklist");
  assert.ok(kpis < checklist && checklist < at('<Card title="Activity"') && checklist < at('<Card title="Recent activity"') && checklist < at('<Card title="Top wishlisted products"'));
  assert.equal(source.indexOf("</Grid>"), source.lastIndexOf("</Grid>"), "the KPI grid is unchanged: still one grid");
  assert.match(source, /session\.shop/, "the action takes the shop from the Admin session");
  assert.equal(/formData\(\)\)\.get\("(shop|domain)"/.test(source), false, "never from the form");
});

// ======================= the component =======================
const OUT_DIR = path.resolve("node_modules/.cache/kw-setup-checklist-test");
const SHOP_A = "alpha-store.myshopify.com";
let Checklist;
let React;
let ReactRouter;
let createRoot;
let dom;
let root;
let container;
const h = (...args) => React.createElement(...args);

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: "http://localhost/" });
  for (const name of ["window", "document", "HTMLElement", "Node", "Event", "MouseEvent"]) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? dom.window : dom.window[name], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `checklist-${Date.now().toString(36)}.mjs`);
  await build({ entryPoints: ["app/components/setup-checklist.jsx"], outfile, bundle: true, format: "esm", platform: "node", jsx: "automatic", external: ["react", "react/jsx-runtime", "react-dom", "react-router"],
    plugins: [
      {
        name: "raw-text", // Vite's virtual storefront stylesheet (pulled in by the settings form's preview), as text
        setup(b) {
          b.onResolve({ filter: /^virtual:konvert-storefront-css$/ }, () => ({ path: path.resolve("extensions/konvert-wishlist/assets/konvert-wishlist.css"), namespace: "raw-text" }));
          b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")), namespace: "raw-text" }));
          b.onLoad({ filter: /.*/, namespace: "raw-text" }, (args) => ({ contents: fs.readFileSync(args.path, "utf8"), loader: "text" }));
        },
      },
    ],
    logLevel: "silent",
  });
  Checklist = await import(pathToFileURL(outfile).href);
  React = (await import("react")).default;
  ReactRouter = await import("react-router");
  ({ createRoot } = await import("react-dom/client"));
});

after(async () => {
  delete window.shopify;
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  dom?.window.close();
  await prisma?.$disconnect();
});

const act = (fn) => React.act(async () => fn());
const click = (el) => act(() => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byText = (selector, text) => [...container.querySelectorAll(selector)].find((el) => el.textContent.trim() === text);
const label = (text) => container.querySelector(`button[aria-label="${text}"]`);
const unmount = () => React.act(async () => root.unmount());
// Per step, as the merchant sees it: the Completed pill, a disabled button while Shopify is being asked, the "isn't counted" help, or an action.
const statuses = () =>
  [...container.querySelectorAll("li.kv-setup-step")].map((li) =>
    li.querySelector(".kv-setup-status") ? "Completed" : li.querySelector("s-button[disabled]") ? "Checking…" : /isn’t counted/.test(li.textContent) ? "Can’t check" : "Action required",
  );

// A stand-in for the Shopify Admin's App Bridge: `answer` is what shopify.app.extensions() resolves to (an Error is
// thrown instead). Pass null to simulate no App Bridge at all. `calls` counts the requests made.
function fakeShopify(answer) {
  const state = { calls: 0, answer };
  if (answer === null) delete window.shopify;
  else {
    window.shopify = {
      app: {
        extensions: async () => {
          state.calls += 1;
          if (state.answer instanceof Error) throw state.answer;
          return state.answer;
        },
      },
    };
  }
  return state;
}

// A stand-in for the Dashboard route: the loader reads a per-shop store, the action applies the same pure rule the real
// action does. Remounting with the same store is a page reload.
async function mountChecklist({ store = new Map(), shop = SHOP_A, appearanceSaved = false } = {}) {
  const posted = [];
  const read = () => ({ state: normalizeOnboarding(store.get(shop)), appearanceSaved, shop, apiKey: "key123" });
  const Page = () => h(Checklist.SetupChecklist, { setup: ReactRouter.useLoaderData() });
  const Stub = ReactRouter.createRoutesStub([
    {
      path: "/",
      Component: Page,
      loader: () => read(),
      action: async ({ request }) => {
        const intent = (await request.formData()).get("intent");
        posted.push(intent);
        const next = applyOnboardingIntent(store.get(shop), intent);
        if (next) store.set(shop, next);
        return { ok: Boolean(next) };
      },
    },
    { path: "/app/wishlist-settings", Component: () => h("div", { id: "settings-page" }, "settings"), action: async () => ({ ok: true, appearance: DEFAULT_APPEARANCE }) },
    { path: "/app/wishlist-settings-data", loader: () => ({ ok: true, appearance: DEFAULT_APPEARANCE, shop, apiKey: "key123" }) },
  ]);
  container = document.getElementById("root");
  container.innerHTML = "";
  root = createRoot(container);
  await React.act(async () => root.render(h(Stub, { initialEntries: ["/?embedded=1&host=abc&days=30"] })));
  await act(() => sleep(30));
  return { store, posted };
}

test("it shows the header, the real progress, a checkmark or pending mark per step and the right statuses", async () => {
  fakeShopify([themeExt(block("wishlist-embed", "active", ["theme"]), block("wishlist-button", "available"))]);
  await mountChecklist({ appearanceSaved: true });
  assert.equal(container.querySelector("h3").textContent, "Get started with Konvert Wishlist And Notify");
  assert.match(container.textContent, /Complete these steps to enable Wishlist and Notify Me on your storefront\./);
  assert.match(container.textContent, /2\/3 completed/);
  assert.equal(container.querySelector(".kv-setup-count").textContent, "2/3 completed", "the counter sits under the description");
  assert.equal(container.querySelector(".kv-setup-head .kv-setup-count"), null, "and not beside the heading");
  assert.equal(container.querySelector('[role="progressbar"]'), null);
  assert.equal(container.querySelectorAll("li s-button[disabled]").length, 1, "the completed embed step has a disabled button; the others stay actionable");
  assert.deepEqual([...container.querySelectorAll("li s-button")].map((b) => b.textContent), ["Design Your Wishlist in Wishlist Settings", "Activated", "Set up product page"]);
  assert.deepEqual(statuses(), ["Completed", "Completed", "Action required"]);
  assert.equal(container.querySelectorAll("li svg.kv-setup-tick path[stroke='#fff']").length, 2);
  assert.deepEqual([...container.querySelectorAll("li strong")].map((e) => e.textContent), ["Design your Wishlist", "Activate your app in your theme", "Add the Wishlist block to the product page"]);
  await unmount();
});

test("there are no manual confirmation buttons or flags anywhere", async () => {
  fakeShopify([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "available"))]);
  await mountChecklist();
  assert.equal(/Mark as (not )?done/.test(container.textContent), false);
  const source = ["app/components/setup-checklist.jsx", "app/routes/app._index.jsx", "app/models/settings.server.js"].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(/embed_done|product_done|embedConfirmed|productConfirmed|Mark as/.test(source), false, "no trace of the manual flags in the app code");
  await unmount();
});

test("both theme steps complete only when Shopify reports them active", async () => {
  fakeShopify(ON);
  await mountChecklist({ appearanceSaved: true });
  assert.equal(container.textContent.trim(), "", "all three confirmed: the guide hides itself, nothing to dismiss");
  await unmount();

  fakeShopify([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "available"))]);
  await mountChecklist({ appearanceSaved: true });
  assert.deepEqual(statuses(), ["Completed", "Action required", "Action required"]);
  assert.match(container.textContent, /1\/3 completed/);
  await unmount();
});

test("opening a theme editor completes nothing, and each action goes to the right destination", async () => {
  const shopify = fakeShopify([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "available"))]);
  const { store, posted } = await mountChecklist();
  const embed = byText("s-button", "Activate app embed");
  const product = byText("s-button", "Set up product page");
  assert.equal(embed.getAttribute("href"), "https://alpha-store.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=key123/wishlist-embed");
  assert.equal(embed.getAttribute("target"), "_blank");
  assert.equal(product.getAttribute("href"), "https://alpha-store.myshopify.com/admin/themes/current/editor?template=product&addAppBlockId=key123/wishlist-button&target=mainSection");
  assert.notEqual(embed.getAttribute("href"), product.getAttribute("href"), "the embed and the product block are separate actions");
  const callsBefore = shopify.calls;
  await click(embed);
  await click(product);
  assert.deepEqual(posted, [], "nothing was sent");
  assert.equal(store.size, 0, "nothing was saved");
  assert.equal(shopify.calls, callsBefore, "clicking a link does not even ask Shopify again");
  assert.match(container.textContent, /0\/3 completed/);

  await click(byText("s-button", "Design Your Wishlist in Wishlist Settings"));
  assert.equal(container.querySelector("#settings-page"), null, "Design your Wishlist does not leave the Dashboard");
  await unmount();
});

test("while Shopify has not answered yet the steps say Checking and count for nothing", async () => {
  let release;
  fakeShopify(null);
  window.shopify = { app: { extensions: () => new Promise((resolve) => { release = () => resolve(ON); }) } };
  await mountChecklist({ appearanceSaved: true });
  assert.equal(container.textContent.trim(), "", "step 1 is done, so the guide could still turn out complete: nothing is drawn while Shopify has not answered (no flash)");
  await act(() => release());
  await act(() => sleep(10));
  assert.equal(container.textContent.trim(), "", "complete: hidden");
  await unmount();

  // Step 1 not done: the guide can never be complete, so it is drawn at once, with the theme steps Checking and counting for nothing.
  window.shopify = { app: { extensions: () => new Promise(() => {}) } };
  await mountChecklist({ appearanceSaved: false });
  assert.deepEqual(statuses(), ["Action required", "Checking…", "Checking…"]);
  assert.match(container.textContent, /0\/3 completed/);
  await unmount();
});

test("an API error, a malformed answer or no App Bridge leaves the steps unknown, never completed", async () => {
  for (const answer of [new Error("network"), "garbage", null, [], { not: "an array" }]) {
    fakeShopify(answer);
    await mountChecklist({ appearanceSaved: true });
    assert.deepEqual(statuses(), ["Completed", "Can’t check", "Can’t check"], String(answer));
    assert.match(container.textContent, /1\/3 completed/);
    assert.match(container.textContent, /isn’t counted as done/);
    assert.ok(byText("s-button", "Activate app embed"), "the editor links are still offered");
    await unmount();
  }
});

test("returning to the tab asks Shopify again and picks up a change made in the theme editor; there is no Recheck button", async () => {
  const shopify = fakeShopify([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "available"))]);
  await mountChecklist({ appearanceSaved: true });
  assert.deepEqual(statuses(), ["Completed", "Action required", "Action required"]);
  assert.equal(shopify.calls, 1, "one request when the Dashboard opens");

  shopify.answer = [themeExt(block("wishlist-embed", "active", ["theme"]), block("wishlist-button", "available"))]; // the merchant enabled the embed
  assert.equal(byText("button", "Recheck"), undefined, "the Recheck button is gone");
  await act(() => sleep(3100));
  await act(() => window.dispatchEvent(new window.Event("focus")));
  await act(() => sleep(10));
  assert.equal(shopify.calls, 2);
  assert.deepEqual(statuses(), ["Completed", "Completed", "Action required"]);
  assert.match(container.textContent, /2\/3 completed/);

  shopify.answer = new Error("down"); // a later failed recheck must not keep a stale green tick
  await act(() => sleep(3100));
  await act(() => window.dispatchEvent(new window.Event("focus")));
  await act(() => sleep(10));
  assert.deepEqual(statuses(), ["Completed", "Can’t check", "Can’t check"]);
  await unmount();
});

test("coming back to the tab rechecks, but a burst of focus events makes one request", async () => {
  const shopify = fakeShopify([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "available"))]);
  await mountChecklist();
  assert.equal(shopify.calls, 1);
  for (let i = 0; i < 5; i += 1) await act(() => window.dispatchEvent(new window.Event("focus")));
  assert.equal(shopify.calls, 1, "focus right after loading is throttled");

  await act(() => sleep(3100));
  shopify.answer = ON;
  await act(() => window.dispatchEvent(new window.Event("focus")));
  await act(() => sleep(10));
  assert.equal(shopify.calls, 2);
  assert.deepEqual(statuses(), ["Action required", "Completed", "Completed"]);
  await unmount();
  const afterUnmount = shopify.calls;
  await act(() => window.dispatchEvent(new window.Event("focus")));
  assert.equal(shopify.calls, afterUnmount, "no listeners are left behind");
});

test("collapse hides the steps and expands them again; it is a view choice and saves nothing", async () => {
  fakeShopify(ON);
  const { posted } = await mountChecklist();
  assert.equal(label("Collapse setup guide").getAttribute("aria-expanded"), "true");
  await click(label("Collapse setup guide"));
  assert.equal(container.querySelector("ol"), null);
  assert.match(container.textContent, /2\/3 completed/, "progress stays visible");
  assert.equal(label("Expand setup guide").getAttribute("aria-expanded"), "false");
  await click(label("Expand setup guide"));
  assert.equal(container.querySelectorAll("li").length, 3);
  assert.deepEqual(posted, []);
  await unmount();
});

test("dismissing is saved and persists; while setup is incomplete it can be shown again", async () => {
  fakeShopify(ON);
  const first = await mountChecklist();
  await click(label("Dismiss setup guide"));
  assert.deepEqual(first.posted, ["dismiss"]);
  assert.equal(container.querySelector("h3"), null, "the full checklist is gone");
  assert.match(container.textContent, /Setup guide hidden · 2 of 3 steps completed/);
  await unmount();

  const reloaded = await mountChecklist({ store: first.store });
  assert.equal(container.querySelector("h3"), null, "still dismissed after reload");
  await click(byText("button", "Show setup guide"));
  assert.deepEqual(reloaded.posted, ["reopen"]);
  assert.equal(container.querySelector("h3").textContent, "Get started with Konvert Wishlist And Notify");
  await unmount();
});

test("once every step is done and the guide is dismissed, nothing is shown", async () => {
  fakeShopify(ON);
  await mountChecklist({ store: new Map([[SHOP_A, { dismissed: true }]]), appearanceSaved: true });
  assert.equal(container.textContent.trim(), "");
  await unmount();
});

test("two shops keep separate dismissals", async () => {
  fakeShopify(ON);
  const store = new Map();
  await mountChecklist({ store, shop: SHOP_A });
  await click(label("Dismiss setup guide"));
  await unmount();
  await mountChecklist({ store, shop: "beta-store.myshopify.com" });
  assert.equal(container.querySelector("h3").textContent, "Get started with Konvert Wishlist And Notify");
  await unmount();
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
  const domain = `kw-onb-${tag}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
});

dbTest("the dismissal is stored per shop and survives a fresh read", async () => {
  const { getOnboarding, saveOnboardingIntent } = await import("../app/models/settings.server.js");
  const a = await newShop("a");
  const b = await newShop("b");
  assert.deepEqual(await getOnboarding(a.id), { state: ONBOARDING_DEFAULT, appearanceSaved: false }, "a shop with no settings row starts empty");

  await saveOnboardingIntent(a.domain, "dismiss");
  assert.deepEqual((await getOnboarding(a.id)).state, { dismissed: true });
  assert.deepEqual(await getOnboarding(b.id), { state: ONBOARDING_DEFAULT, appearanceSaved: false }, "the other shop is untouched");

  await saveOnboardingIntent(a.domain, "reopen");
  assert.deepEqual((await getOnboarding(a.id)).state, ONBOARDING_DEFAULT);
  for (const bad of ["nonsense", "embed_done", "product_done"]) assert.equal(await saveOnboardingIntent(a.domain, bad), null, bad);
});

dbTest("rows written by the first version of the checklist still read safely and are cleaned on the next write", async () => {
  const { getOnboarding, saveOnboardingIntent } = await import("../app/models/settings.server.js");
  const shop = await newShop("legacy");
  await prisma.shopSettings.create({ data: { shopId: shop.id, onboarding: { embedConfirmed: true, productConfirmed: true, dismissed: true } } });
  assert.deepEqual((await getOnboarding(shop.id)).state, { dismissed: true }, "the old confirmations are ignored");
  await saveOnboardingIntent(shop.domain, "reopen");
  const row = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } });
  assert.deepEqual(row.onboarding, { dismissed: false }, "and dropped from the stored document");
});

dbTest("saving Wishlist Settings completes step 1, and checklist writes never disturb the other settings", async () => {
  const { getOnboarding, saveOnboardingIntent, saveAppearance, saveSettings, getSettings, getAppearance } = await import("../app/models/settings.server.js");
  const shop = await newShop("c");
  await saveSettings(shop.domain, { wishlistEnabled: false, notifyMeEnabled: true });
  await saveOnboardingIntent(shop.domain, "dismiss");
  assert.equal((await getOnboarding(shop.id)).appearanceSaved, false, "dismissing is not a saved configuration");
  assert.deepEqual(await getSettings(shop.id), { wishlistEnabled: false, notifyMeEnabled: true });

  assert.equal((await saveAppearance(shop.domain, { wishlistPage: { layout: "grid" } })).ok, true);
  const after = await getOnboarding(shop.id);
  assert.equal(after.appearanceSaved, true);
  assert.equal(after.state.dismissed, true, "saving the appearance keeps the checklist state");
  assert.equal((await getAppearance(shop.domain)).wishlistPage.layout, "grid");
  assert.equal(setupChecklist(after.state, { appearanceSaved: after.appearanceSaved, theme: { embed: null, product: null } }).completed, 1);
});

dbTest("a store seen for the first time gets its own shop row, once, and nothing else is created or touched", async () => {
  const { ensureShop } = await import("../app/models/settings.server.js");
  const domain = `kw-onb-first-${RUN}.myshopify.com`;
  const other = await newShop("first-other");
  domains.push(domain);
  assert.equal(await prisma.shop.findUnique({ where: { domain } }), null, "a fresh install has no row yet");

  const [one, two] = await Promise.all([ensureShop(domain), ensureShop(domain)]); // two screens loading at once
  assert.equal(one.id, two.id, "both callers get the same row");
  assert.equal(one.domain, domain);
  assert.equal(await prisma.shop.count({ where: { domain } }), 1);
  assert.equal(await prisma.shopSettings.count({ where: { shopId: one.id } }), 0, "no settings are invented");
  assert.equal((await ensureShop(domain)).installedAt.getTime(), one.installedAt.getTime(), "a later visit does not reset the install time");
  assert.equal((await prisma.shop.findUnique({ where: { id: other.id } })).currencyCode, "USD", "another shop is untouched");
});

test("Design your Wishlist opens the real Wishlist Settings form in a dialog over the Dashboard; Cancel closes it", async () => {
  fakeShopify(ON);
  await mountChecklist();
  const button = byText("s-button", "Design Your Wishlist in Wishlist Settings");
  assert.equal(button.getAttribute("href"), null, "not a link to another page");
  const modal = container.querySelector("s-modal#wishlist-settings-modal");
  assert.ok(modal, "the dialog element exists");
  assert.equal(modal.getAttribute("heading"), "Wishlist Settings");
  assert.equal(modal.querySelector('[role="tab"]'), null, "nothing is loaded until it is opened");
  let shown = 0;
  let hidden = 0;
  modal.showOverlay = () => { shown += 1; };
  modal.hideOverlay = () => { hidden += 1; modal.dispatchEvent(new window.Event("afterhide")); };
  await click(button);
  await act(() => sleep(50));
  assert.equal(shown, 1, "the dialog was shown");
  assert.deepEqual([...modal.querySelectorAll('[role="tab"]')].map((t) => t.textContent), ["General", "Product page", "Collection page", "Wishlist page"], "the existing settings form is inside it");
  assert.ok(byText("s-button", "Save"), "Save is in the dialog footer");
  assert.equal(container.querySelector("#settings-page"), null, "the Settings route was not opened");
  assert.match(container.textContent, /Get started with Konvert/, "the Dashboard is still mounted");
  await click(byText("s-button", "Cancel"));
  await act(() => sleep(20));
  assert.equal(hidden, 1);
  assert.equal(modal.querySelector('[role="tab"]'), null, "closed: the form is gone, the Dashboard stays");
  assert.match(container.textContent, /Get started with Konvert/);
  await unmount();
});

test("on a phone the step panel is one column with room for the long button label, and the illustration shrinks and moves under the text", () => {
  const css = fs.readFileSync("app/styles/merchant.css", "utf8");
  assert.match(css, /\.kv-setup-panel \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/s, "desktop: text left, illustration right");
  const phone = css.slice(css.indexOf("@media (max-width: 560px)"));
  assert.match(phone, /\.kv-setup-step \.kv-setup-panel \{\s*grid-template-columns: minmax\(0, 1fr\);\s*padding-inline: 8px;/);
  assert.match(phone, /\.kv-setup-step \.kv-setup-svg \{\s*width: 112px;/);
});

// ---- expandable steps ----
const rowOf = (key) => container.querySelector(`#kv-step-${key}`);
const panelOf = (key) => container.querySelector(`#kv-step-panel-${key}`);
const openKeys = () => ["configure", "embed", "product"].filter((k) => !panelOf(k).hasAttribute("hidden"));

test("steps expand and collapse like a disclosure: one open at a time, the first incomplete one open to start", async () => {
  fakeShopify([themeExt(block("wishlist-embed", "available"), block("wishlist-button", "available"))]);
  await mountChecklist({ appearanceSaved: true });
  assert.deepEqual(openKeys(), ["embed"], "step 1 is done, so the first step still to do is open");
  assert.equal(rowOf("embed").getAttribute("aria-expanded"), "true");
  assert.equal(rowOf("embed").getAttribute("aria-controls"), "kv-step-panel-embed");
  assert.equal(panelOf("embed").getAttribute("aria-labelledby"), "kv-step-embed");
  await click(rowOf("product"));
  assert.deepEqual(openKeys(), ["product"], "opening one closes the other");
  assert.equal(rowOf("embed").getAttribute("aria-expanded"), "false");
  await click(rowOf("product"));
  assert.deepEqual(openKeys(), [], "clicking an open step closes it, and it stays closed");
  await click(rowOf("configure"));
  assert.deepEqual(openKeys(), ["configure"]);
  assert.match(container.textContent, /1\/3 completed/, "the counter is unaffected by opening steps");
  await unmount();
});

test("the row is a real button holding only the indicator, title, pill and chevron; the action lives in the panel", async () => {
  fakeShopify(ON);
  await mountChecklist();
  assert.deepEqual(openKeys(), ["configure"], "the first step that is not complete is the one open");
  for (const key of ["configure", "embed", "product"]) {
    const row = rowOf(key);
    assert.equal(row.tagName, "BUTTON");
    assert.equal(row.getAttribute("type"), "button");
    assert.equal(row.querySelector("s-button"), null, `${key}: no button nested inside the disclosure button`);
    assert.ok(panelOf(key).querySelector("s-button"), `${key}: the action is below the description`);
    assert.match(row.textContent, /ompleted/);
  }
  await unmount();
});

test("each step has its own decorative illustration beside its text, local SVG, hidden from assistive technology", async () => {
  fakeShopify(ON);
  await mountChecklist();
  for (const key of ["configure", "embed", "product"]) {
    const art = panelOf(key).querySelector(".kv-setup-art");
    assert.equal(art.getAttribute("aria-hidden"), "true", key);
    assert.ok(art.querySelector("svg.kv-setup-svg"), `${key} has an inline svg`);
    assert.equal(art.querySelector("img, image, use"), null, `${key}: no external image`);
  }
  const markup = [...container.querySelectorAll(".kv-setup-svg")].map((s) => s.innerHTML);
  assert.equal(new Set(markup).size, 3, "three different illustrations");
  assert.equal(/https?:/.test(fs.readFileSync("app/components/setup-illustrations.jsx", "utf8").replace(/xmlns="[^"]*"/g, "")), false, "nothing is fetched from anywhere");
  await unmount();
});

test("Activated buttons are disabled and carry no link, so they cannot start the setup again", async () => {
  fakeShopify(ON);
  await mountChecklist();
  for (const key of ["embed", "product"]) {
    const button = panelOf(key).querySelector("s-button");
    assert.equal(button.textContent.trim(), "Activated");
    assert.equal(button.hasAttribute("disabled"), true);
    assert.equal(button.getAttribute("href"), null);
  }
  await unmount();
});

// ---- the guide follows the real setup state ----
test("guideView: hidden only when all three steps are confirmed; unknown, checking-with-step-1-done and incomplete are not", () => {
  const view = (state, opts) => guideView(setupChecklist(state, opts), opts);
  const on = { embed: true, product: true };
  assert.equal(view(null, { appearanceSaved: true, theme: on }), "hidden");
  assert.equal(view({ dismissed: true }, { appearanceSaved: true, theme: on }), "hidden", "a stale dismissed flag does not matter once complete");
  assert.equal(view(null, { appearanceSaved: true, theme: { embed: false, product: true } }), "guide", "embed switched off: the guide returns");
  assert.equal(view(null, { appearanceSaved: true, theme: { embed: true, product: false } }), "guide", "block removed: the guide returns");
  assert.equal(view(null, { appearanceSaved: true, theme: { embed: null, product: true } }), "guide", "cannot verify: never counted as complete");
  assert.equal(view(null, { appearanceSaved: false, theme: on }), "guide", "settings never saved");
  assert.equal(view({ dismissed: true }, { appearanceSaved: true, theme: { embed: false, product: true } }), "bar", "closed while incomplete: the one-line bar");
  assert.equal(view(null, { appearanceSaved: true, theme: undefined }), "wait", "first answer pending and step 1 done: nothing drawn yet");
  assert.equal(view(null, { appearanceSaved: false, theme: undefined }), "guide", "step 1 not done: cannot be complete, drawn at once");
});

test("complete setup hides the guide by itself and clears a stale closed flag; a later change brings the full guide back", async () => {
  const shopify = fakeShopify(ON);
  const store = new Map([[SHOP_A, { dismissed: true }]]);
  const { posted } = await mountChecklist({ store, appearanceSaved: true });
  assert.equal(container.textContent.trim(), "", "hidden without any click");
  assert.deepEqual(posted, ["reopen"], "the stale closed flag is cleared once");

  shopify.answer = [themeExt(block("wishlist-embed", "available"), block("wishlist-button", "active", ["template--123__main"]))]; // the merchant switched the embed off
  await act(() => sleep(3100));
  await act(() => window.dispatchEvent(new window.Event("focus")));
  await act(() => sleep(10));
  assert.equal(container.querySelector("h3")?.textContent, "Get started with Konvert Wishlist And Notify", "the full guide is back, not the one-line bar");
  assert.deepEqual(statuses(), ["Completed", "Action required", "Completed"]);
  await unmount();
});

test("a failed or unreadable Shopify answer never hides the guide", async () => {
  for (const answer of [new Error("down"), "garbage", []]) {
    fakeShopify(answer);
    await mountChecklist({ appearanceSaved: true });
    assert.ok(container.querySelector("h3"), String(answer));
    assert.deepEqual(statuses(), ["Completed", "Can’t check", "Can’t check"]);
    await unmount();
  }
});
