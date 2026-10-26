// Server-side diagnostics only: the request trace (app/utils/nav-trace.server.js) writes to %TEMP%. The browser panel that used to
// sit beside it was removed; tests/merchant-no-overlay.test.mjs asserts it can no longer appear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAppRequest } from "../app/utils/nav-trace.server.js";

const SECRET = "SUPERSECRET-session-token-value";

// ======================= server request trace =======================
const req = (url, headers = {}, method = "GET") => new Request(url, { method, headers });
const res = (status = 200, headers = {}) => ({ status, headers: new Headers(headers) });
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

test("server trace: a route-data request is described by path, parameter names, header presence and status, never by value", () => {
  const entry = describeAppRequest(req(`https://app.example/app/wishlist-settings.data?embedded=1&host=h&shop=s&id_token=${SECRET}`, { authorization: `Bearer ${SECRET}`, "user-agent": BROWSER, cookie: `a=${SECRET}` }), res(200, { "content-type": "text/x-script; charset=utf-8" }));
  assert.deepEqual({ ...entry, at: "x" }, {
    at: "x", kind: "data", method: "GET", path: "/app/wishlist-settings", hasAuthorizationHeader: true, hasIdTokenParam: true,
    paramNames: ["embedded", "host", "id_token", "shop"], botLikeUserAgent: false, status: 200, contentType: "text/x-script", redirectPath: null,
  });
  assert.equal(JSON.stringify(entry).includes(SECRET), false);
});

test("server trace: a request without an Authorization header, a bot user agent (which Shopify answers with 410) and redirects are all visible", () => {
  const none = describeAppRequest(req("https://app.example/app/wishlist-settings.data?embedded=1", { "user-agent": BROWSER }), res(202));
  assert.deepEqual([none.hasAuthorizationHeader, none.hasIdTokenParam, none.status, none.kind], [false, false, 202, "data"]);
  const bot = describeAppRequest(req("https://app.example/app/settings", { "user-agent": "curl/8.4.0" }), res(410));
  assert.deepEqual([bot.botLikeUserAgent, bot.status, bot.kind], [true, 410, "document"]);
  const redirect = describeAppRequest(req("https://app.example/app/settings?embedded=1", { "user-agent": BROWSER }), res(302, { location: `/auth/session-token?shopify-reload=${SECRET}&id_token=${SECRET}` }));
  assert.equal(redirect.redirectPath, "/auth/session-token", "only the destination path");
  assert.equal(JSON.stringify(redirect).includes(SECRET), false);
});

test("server trace: only /app and /auth requests are traced", () => {
  for (const url of ["https://app.example/apps/konvert-notify/api/wishlist", "https://app.example/proxy/api/features", "https://app.example/webhooks/orders", "https://app.example/assets/x.js", "https://app.example/"]) {
    assert.equal(describeAppRequest(req(url), res()), null, url);
  }
  for (const url of ["https://app.example/app", "https://app.example/app/settings", "https://app.example/auth/session-token", "https://app.example/auth/login"]) assert.ok(describeAppRequest(req(url), res()), url);
});
