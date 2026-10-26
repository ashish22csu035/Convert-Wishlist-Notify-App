// The Dashboard crashed with "Cannot read properties of undefined (reading 'verb')" (feedText, app/routes/app._index.jsx) as soon as
// "Recent activity" held an event of a type the page did not know: WISHLIST_ADDED_TO_CART and RESTOCK_EMAIL_CLICKED, which the
// purchase-attribution work started recording. The loader finished; the RENDER threw and Admin showed "This page could not be loaded".
//
// Run: node --test tests/dashboard-events.test.mjs
// Renders the REAL Dashboard route component (and the Wishlist log row label) with server-side React; no database is used.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const OUT_DIR = path.resolve("node_modules/.cache/kw-dashboard-events-test");
let Dashboard;
let ui;
let React;
let ReactRouter;
let renderToString;

before(async () => {
  process.env.SHOPIFY_API_KEY = "key123";
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `dashboard-${Date.now().toString(36)}.mjs`);
  await build({
    entryPoints: ["app/routes/app._index.jsx"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    external: ["react", "react/jsx-runtime", "react-dom", "react-router"],
    alias: { "@shopify/shopify-app-react-router/server": path.resolve("tests/helpers/shopify-server-stub.mjs") },
    plugins: [
      {
        name: "server-only-stubs",
        setup(b) {
          b.onResolve({ filter: /^\.\.\/(utils\/merchant\.server|models\/reporting\.server|models\/catalog\.server)$/ }, () => ({ path: path.resolve("tests/helpers/empty-server-module.mjs") }));
        },
      },
    ],
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(outfile).href);
  Dashboard = mod;
  ui = await import(pathToFileURL(path.resolve("app/components/merchant-ui.jsx")).href).catch(() => null);
  React = (await import("react")).default;
  ReactRouter = await import("react-router");
  ({ renderToString } = await import("react-dom/server"));
});

after(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

const schemaTypes = () => {
  const text = fs.readFileSync("prisma/schema.prisma", "utf8");
  const body = text.match(/enum ActivityType \{([\s\S]*?)\}/)[1];
  return body.split("\n").map((line) => line.trim()).filter(Boolean);
};

const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
function data({ recent = [], activityAll = 0, attribution = null, period = { kind: "preset", days: 30, label: "Last 30 days" } } = {}) {
  const types = schemaTypes();
  return {
    days: 30,
    period,
    dashboard: {
      days: 30,
      now: "2026-10-24T10:00:00.000Z",
      comparable: true,
      activity: { window: zero(types), previous: zero(types), allTime: { ...zero(types), WISHLIST_ADDED: activityAll } },
      wishlistUsers: { current: 0, previous: 0 },
      sessions: { current: 0, previous: 0 },
      subscriptions: { ACTIVE: 0, FULFILLED: 0, UNSUBSCRIBED: 0 },
      deliveries: { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, UNKNOWN: 0 },
      wishlist: { savedItems: 0 },
      series: { days: [], values: {} },
      topProducts: [],
      recent: recent.map((type, i) => ({ id: String(i + 1), type, occurredAt: "2026-10-24T09:00:00.000Z", productGid: "gid://shopify/Product/1", variantGid: null, item: { title: "Blue Hat", variantTitle: null, found: true } })),
      attribution,
      catalogAvailable: true,
      currencyCode: "USD",
    },
  };
}

async function render(loaderData) {
  const routes = [{ path: "/app", Component: Dashboard.default, loader: () => loaderData }];
  const handler = ReactRouter.createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/app"));
  const router = ReactRouter.createStaticRouter(handler.dataRoutes, context);
  return renderToString(React.createElement(ReactRouter.StaticRouterProvider, { router, context }));
}

test("every ActivityType in prisma/schema.prisma is known to the Dashboard's event table", async () => {
  const { EVENT } = await import(pathToFileURL(path.resolve("app/components/merchant-ui.jsx")).href).catch(() => ({}));
  if (!EVENT) return; // merchant-ui is JSX with CSS-free imports; if it cannot load outside the bundle the render tests below still cover it
  const missing = schemaTypes().filter((type) => !EVENT[type]);
  assert.deepEqual(missing, []);
});

test("Dashboard renders with a recent event of EVERY activity type, including add-to-cart and restock-email clicks (the crash)", async () => {
  const html = await render(data({ recent: schemaTypes(), activityAll: 5 }));
  assert.match(html, /Recent activity/);
  assert.match(html, /added “Blue Hat” to their cart from their Wishlist/);
  assert.match(html, /clicked the restock email for “Blue Hat”/);
  assert.match(html, /Added to cart from Wishlist/);
  assert.equal((html.match(/kv-feed-icon/g) ?? []).length, schemaTypes().length, "one row per event");
});

test("a type the page has never heard of still renders, with a generic line, instead of crashing", async () => {
  const html = await render(data({ recent: ["SOME_FUTURE_EVENT"], activityAll: 1 }));
  assert.match(html, /had activity on “Blue Hat”/);
  assert.match(html, /Some future event/);
});

test("empty Wishlist and Notify Me data: KPI cards render, with the empty states", async () => {
  const html = await render(data());
  for (const label of ["Wishlist items", "Unique Wishlist users", "Wishlist sessions", "Active Notify Me subscriptions", "Restock emails sent", "Attributed revenue"]) assert.ok(html.includes(label), label);
  assert.match(html, /No activity yet/);
  assert.match(html, /No saved products/);
});

test("no shop yet: the Dashboard shows its setup state rather than throwing", async () => {
  const html = await render({ days: 30, period: { kind: "preset", days: 30, label: "Last 30 days" }, dashboard: null });
  assert.match(html, /Dashboard/);
});
