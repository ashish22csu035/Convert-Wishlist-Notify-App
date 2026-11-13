// Executes the REAL loader of app/routes/app.manage-plan.jsx (bundled with esbuild, as the other route tests do) with Shopify authentication
// replaced by a recorder (tests/helpers/admin-redirect-stub.mjs) and the database module replaced by one that refuses every use. Nothing here
// calls Shopify or any network, and no database is touched.
//
// What this proves: the loader's own decisions (which address it asks for, with which target, from which inputs).
// What it does NOT prove: how Shopify's real redirect helper behaves inside Admin's iframe (App Bridge response, top-level navigation).
// That needs a real embedded session and stays a manual check.
//
// Run: node --test tests/billing-manage-plan-route.test.mjs
import "./helpers/resolve-extensionless.mjs";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

const OUT_DIR = path.resolve("node_modules/.cache/kw-manage-plan-route-test");
const TEMPLATE = "https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/pricing_plans"; // a FIXTURE of the shape an operator supplies
const NAMES = ["SHOPIFY_APP_HANDLE", "SHOPIFY_PLAN_SELECTION_URL_TEMPLATE"];
const savedEnv = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
const savedFetch = globalThis.fetch;
let loader;
let networkCalls = 0;

before(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `manage-plan-${Date.now().toString(36)}.mjs`);
  await build({
    entryPoints: ["app/routes/app.manage-plan.jsx"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    external: ["react", "react/jsx-runtime", "react-dom", "react-router", "@prisma/client"],
    plugins: [
      {
        name: "route-stubs", // Shopify authentication and the database module are replaced; the billing model itself is the real one
        setup(b) {
          b.onResolve({ filter: /^\.\.\/shopify\.server$/ }, () => ({ path: path.resolve("tests/helpers/admin-redirect-stub.mjs") }));
          b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({ path: path.resolve("tests/helpers/empty-db-module.mjs") }));
        },
      },
    ],
    logLevel: "silent",
  });
  ({ loader } = await import(pathToFileURL(outfile).href));
});

after(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
});

afterEach(() => {
  for (const name of NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  delete globalThis.__kwAuth;
  delete globalThis.__kwRedirects;
  globalThis.fetch = savedFetch;
});

// Runs the loader. `env` sets the two operator settings for this call only (a missing key = not set).
async function run({ env = {}, session = { shop: "cool-shop.myshopify.com" }, url = "https://app.example/app/manage-plan", headers } = {}) {
  for (const name of NAMES) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  globalThis.__kwRedirects = [];
  networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error("the loader must not use the network");
  };
  globalThis.__kwAuth = async () => ({ session });
  const response = await loader({ request: new Request(url, { headers }) });
  return { response, redirects: globalThis.__kwRedirects.slice() };
}

const GOOD = { SHOPIFY_APP_HANDLE: "my-app", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: TEMPLATE };
const withTemplate = (template) => ({ ...GOOD, SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: template });
const BACK_TO_PLAN = [{ url: "/app/plan", init: undefined }];

test("valid configuration: the loader redirects to the validated Shopify-hosted address, top level, once", async () => {
  const { response, redirects } = await run({ env: GOOD });
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].url, "https://admin.shopify.com/store/cool-shop/charges/my-app/pricing_plans");
  assert.deepEqual(redirects[0].init, { target: "_top" }, "outside the app's iframe");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), redirects[0].url);
  assert.equal(networkCalls, 0, "no request is made by the loader");
});

test("the destination comes from the authenticated session's shop, never from request parameters, headers or the form", async () => {
  const hostile =
    "https://app.example/app/manage-plan?shop=evil.myshopify.com&store_handle=evil&app_handle=evil&template=https://evil.example/x&url=https://evil.example&redirect=https://evil.example&host=ZXZpbC5teXNob3BpZnkuY29t";
  const { redirects } = await run({
    env: GOOD,
    session: { shop: "real-shop.myshopify.com" },
    url: hostile,
    headers: { "X-Forwarded-Host": "evil.example", Referer: "https://evil.example/", Origin: "https://evil.example", "X-Shopify-Shop-Domain": "evil.myshopify.com" },
  });
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].url, "https://admin.shopify.com/store/real-shop/charges/my-app/pricing_plans");
  assert.doesNotMatch(redirects[0].url, /evil/);
});

test("the shop is taken from the session when two different shops ask in turn", async () => {
  const a = await run({ env: GOOD, session: { shop: "alpha.myshopify.com" } });
  const b = await run({ env: GOOD, session: { shop: "beta.myshopify.com" } });
  assert.match(a.redirects[0].url, /\/store\/alpha\//);
  assert.match(b.redirects[0].url, /\/store\/beta\//);
});

test("missing configuration returns safely to /app/plan: no top-level target, nothing leaves the app", async () => {
  for (const env of [{}, { SHOPIFY_APP_HANDLE: "my-app" }, { SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: TEMPLATE }, { SHOPIFY_APP_HANDLE: "", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: "" }, { SHOPIFY_APP_HANDLE: "   ", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: "   " }]) {
    const { redirects } = await run({ env });
    assert.deepEqual(redirects, BACK_TO_PLAN, `settings present: ${Object.keys(env).join(",") || "none"}`);
  }
});

test("invalid or disallowed configuration is rejected safely, back to /app/plan", async () => {
  const bad = [
    withTemplate("http://admin.shopify.com/store/{store_handle}/charges/{app_handle}"), // not https
    withTemplate("https://evil.example/store/{store_handle}/charges/{app_handle}"), // another host
    withTemplate("https://admin.shopify.com.evil.example/{store_handle}/{app_handle}"), // look-alike host
    withTemplate("https://user:pw@admin.shopify.com/{store_handle}/{app_handle}"), // credentials
    withTemplate("https://admin.shopify.com:8443/{store_handle}/{app_handle}"), // port
    withTemplate("javascript:alert(1)//{store_handle}/{app_handle}"),
    withTemplate("https://admin.shopify.com/store/{store_handle}"), // no {app_handle}
    withTemplate("https://admin.shopify.com/{app_handle}"), // no {store_handle}
    withTemplate("https://admin.shopify.com/{store_handle}/{store_handle}/{app_handle}"), // a placeholder twice
    withTemplate("https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/{other}"), // an unknown placeholder
    withTemplate("https://other-shop.myshopify.com/admin/{store_handle}/{app_handle}"), // another shop's domain
    { ...GOOD, SHOPIFY_APP_HANDLE: "my app" },
    { ...GOOD, SHOPIFY_APP_HANDLE: "../x" },
    { ...GOOD, SHOPIFY_APP_HANDLE: "app?x=1" },
  ];
  for (const env of bad) {
    const { redirects } = await run({ env });
    assert.deepEqual(redirects, BACK_TO_PLAN, JSON.stringify(env).slice(0, 140));
  }
});

test("a session whose shop is not a myshopify.com domain gets no destination", async () => {
  for (const shop of ["evil.com", "cool-shop.myshopify.com.evil.com", "", undefined, "https://cool-shop.myshopify.com", "-x.myshopify.com"]) {
    const { redirects } = await run({ env: GOOD, session: { shop } });
    assert.deepEqual(redirects, BACK_TO_PLAN, String(shop));
  }
});

test("an unauthenticated request never reaches the redirect: the authentication response is thrown through", async () => {
  process.env.SHOPIFY_APP_HANDLE = GOOD.SHOPIFY_APP_HANDLE;
  process.env.SHOPIFY_PLAN_SELECTION_URL_TEMPLATE = GOOD.SHOPIFY_PLAN_SELECTION_URL_TEMPLATE;
  globalThis.__kwRedirects = [];
  const refusal = new Response("login", { status: 401 });
  globalThis.__kwAuth = async () => {
    throw refusal;
  };
  await assert.rejects(loader({ request: new Request("https://app.example/app/manage-plan") }), (thrown) => thrown === refusal);
  assert.deepEqual(globalThis.__kwRedirects, [], "no redirect was asked for");
});

test("the route is a read-only redirect: it exports no action and never touches the subscription", () => {
  const source = fs.readFileSync("app/routes/app.manage-plan.jsx", "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /export (const|async function|function) action\b/);
  assert.doesNotMatch(source, /shopSubscription|prisma|fetch\(|admin\.graphql/);
});
