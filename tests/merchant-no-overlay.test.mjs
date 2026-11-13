// Issue regressions: no internal diagnostics panel in the merchant UI, and the app root sends Shopify's requests to /app.
//
// Run: node --test tests/merchant-no-overlay.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isAppEntryRequest } from "../app/utils/embedded-url.js";

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const appFiles = walk("app").filter((file) => /\.(jsx?|css)$/.test(file));

test("no merchant-facing code can render a diagnostics panel", () => {
  assert.equal(fs.existsSync("app/utils/diagnostics.client.js"), false, "the browser recorder is gone");
  for (const file of appFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const needle of ["Konvert diagnostics", "kw-diag", "__kwDiag", "diagnostics.client", "installDiagnostics"]) {
      assert.equal(source.includes(needle), false, `${file} must not mention ${needle}`);
    }
  }
});

test("server-side error logging is still there and logs no query string", () => {
  const entry = fs.readFileSync("app/entry.server.jsx", "utf8");
  assert.match(entry, /export function handleError/);
  assert.match(entry, /kw-error\.log/);
  assert.match(entry, /path: new URL\(request\.url\)\.pathname/, "path only, never the query (tokens, hmac)");
  assert.match(entry, /traceAppRequest/);
  assert.ok(fs.existsSync("app/utils/nav-trace.server.js"));
});

test("the root route sends anything Shopify opened (sidebar name, refresh, install) to /app and keeps the bare visit for login", () => {
  const params = (q) => new URLSearchParams(q);
  assert.equal(isAppEntryRequest(params("appLoadId=abc")), true, "sidebar app name");
  assert.equal(isAppEntryRequest(params("embedded=1&host=aG9zdA&shop=a.myshopify.com&id_token=x")), true, "refresh inside Admin");
  assert.equal(isAppEntryRequest(params("shop=a.myshopify.com&hmac=1&timestamp=1")), true, "install / OAuth start");
  assert.equal(isAppEntryRequest(params("host=aG9zdA")), true);
  assert.equal(isAppEntryRequest(params("")), false, "bare URL keeps the login form");
  assert.equal(isAppEntryRequest(params("utm_source=x")), false);
  const route = fs.readFileSync("app/routes/_index/route.jsx", "utf8");
  // The route uses the redirect helper of authenticate.admin, which copies the request's query (embedded, host, shop, id_token...) onto a
  // same-origin redirect itself, so the route hardcodes nothing and builds no query. The library behaviour is checked on the installed version.
  assert.match(route, /const \{ redirect \} = await authenticate\.admin\(request\)/);
  assert.match(route, /return redirect\("\/app"\)/);
  assert.equal(/embedded=|host=|shop=|searchParams/.test(route), false, "nothing hardcoded");
  const helper = fs.readFileSync("node_modules/@shopify/shopify-app-react-router/dist/esm/server/authenticate/admin/helpers/redirect.mjs", "utf8");
  assert.match(helper, /searchParams\.forEach\(\(value, key\) => \{\s*if \(!parsedUrl\.searchParams\.has\(key\)\)/, "the installed library carries the query to same-origin redirects: re-check the route if this fails after an upgrade");
  assert.equal(fs.existsSync("app/routes/app._index.jsx"), true, "the one Dashboard route is reused");
});
