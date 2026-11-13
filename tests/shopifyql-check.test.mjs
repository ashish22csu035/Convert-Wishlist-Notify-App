// The read-only development-store check (scripts/test-shopifyql-sessions.mjs and scripts/shopifyql-check-lib.mjs): it must run the APP'S query
// (previous 30 complete store-local days, store time zone, today excluded), parse the answer with the app's parser, and never refresh a token,
// write to the database or leave the one configured development store.
//
// Run: node --test tests/shopifyql-check.test.mjs
// NOTHING here calls Shopify or a database: every API answer is a mocked fetch, and the script itself is only started to see it REFUSE.
import "./helpers/resolve-extensionless.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const { resolveTargetShop, createStoredTokenGetAdmin, checkSessions } = await import("../scripts/shopifyql-check-lib.mjs");
const { buildSessionsQuery, sessionRange } = await import("../app/models/session-source.server.js");

const SHOP = "dev-store-example.myshopify.com";
const TOKEN = "shpat_THIS_IS_A_FAKE_TOKEN_0123456789";
const VERSION = "2026-07";
const NOW = new Date("2026-11-13T07:12:00.000Z");
const iso = (date) => date.toISOString();

// ---------- a mocked Shopify ----------
const tzAnswer = (zone) => ({ data: { shop: { ianaTimezone: zone } } });
const table = (rows, columns = [{ name: "sessions", dataType: "INTEGER", displayName: "Sessions" }]) => ({ data: { shopifyqlQuery: { tableData: { columns, rows }, parseErrors: [] } } });
// `answers` = { timezone, sessions }: each a body object, a Response, or a function returning one (or throwing).
function mockShopify({ timezone = tzAnswer("UTC"), sessions = table([{ sessions: "1234" }]) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const pick = body.query.includes("ianaTimezone") ? timezone : sessions;
    const answer = typeof pick === "function" ? pick() : pick;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, calls, sessionsCalls: () => calls.filter((call) => !call.body.query.includes("ianaTimezone")) };
}
const run = (mock, over = {}) => checkSessions({ shop: SHOP, accessToken: TOKEN, scope: "read_products,read_reports", apiVersion: VERSION, fetchImpl: mock.fetchImpl, now: () => NOW, ...over });

// ======================= which shop may be checked =======================
test("only the development store the CLI has configured for this app can be targeted; production and anything unverifiable are refused", () => {
  const project = { "key-a": { dev_store_url: "Dev-Store-Example.myshopify.com" }, "key-b": { dev_store_url: "other.myshopify.com" } };
  assert.deepEqual(resolveTargetShop({ apiKey: "key-a", projectJson: project }), { ok: true, shop: SHOP }, "taken from the app's own entry, lower-cased");
  assert.deepEqual(resolveTargetShop({ requested: SHOP, apiKey: "key-a", projectJson: project, nodeEnv: "development" }), { ok: true, shop: SHOP });
  for (const [tag, input] of [
    ["another shop, even one the CLI knows for a different app", { requested: "other.myshopify.com", apiKey: "key-a", projectJson: project }],
    ["a non-myshopify domain", { requested: "example.com", apiKey: "key-a", projectJson: project }],
    ["an empty --shop", { requested: "", apiKey: "key-a", projectJson: project }],
    ["production", { apiKey: "key-a", projectJson: project, nodeEnv: "production" }],
    ["production in capitals", { apiKey: "key-a", projectJson: project, nodeEnv: "PRODUCTION" }],
    ["no API key", { projectJson: project }],
    ["an unknown app key", { apiKey: "key-z", projectJson: project }],
    ["no project file", { apiKey: "key-a", projectJson: null }],
    ["a dev store entry that is not a shop domain", { apiKey: "key-a", projectJson: { "key-a": { dev_store_url: "https://evil.example/x" } } }],
    ["an entry without a dev store", { apiKey: "key-a", projectJson: { "key-a": {} } }],
  ]) {
    const result = resolveTargetShop(input);
    assert.equal(result.ok, false, tag);
    assert.ok(result.reason.length > 10 && !("shop" in result), `${tag}: a reason and no target`);
  }
});

// ======================= the client: one shop, the stored token as it is =======================
test("the client posts to the one shop with the stored token, never follows a redirect, and serves no other shop", async () => {
  const mock = mockShopify();
  const getAdmin = createStoredTokenGetAdmin({ shop: SHOP, accessToken: TOKEN, scope: "read_reports", apiVersion: VERSION, fetchImpl: mock.fetchImpl });
  const { admin, scope } = await getAdmin(SHOP);
  assert.equal(scope, "read_reports");
  await admin.graphql("query { shop { ianaTimezone } }");
  const call = mock.calls[0];
  assert.equal(call.url, `https://${SHOP}/admin/api/${VERSION}/graphql.json`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error", "the token is never sent to a redirect target");
  assert.equal(call.init.headers["X-Shopify-Access-Token"], TOKEN);
  await assert.rejects(() => getAdmin("someone-else.myshopify.com"), /only serves the one development store/);
  assert.equal(mock.calls.length, 1, "nothing was sent for the other shop");
  for (const bad of [{ shop: "example.com" }, { accessToken: "" }, { apiVersion: "" }]) {
    assert.throws(() => createStoredTokenGetAdmin({ shop: SHOP, accessToken: TOKEN, apiVersion: VERSION, ...bad }), TypeError);
  }
});

// ======================= the query: dates and time zone =======================
const CASES = [
  // [zone, now, SINCE, UNTIL, start instant, end instant (exclusive)]
  ["UTC", "2026-11-13T07:12:00Z", "2026-10-14", "2026-11-12", "2026-10-14T00:00:00.000Z", "2026-11-13T00:00:00.000Z"],
  ["Asia/Kolkata", "2026-11-13T07:12:00Z", "2026-10-14", "2026-11-12", "2026-10-13T18:30:00.000Z", "2026-11-12T18:30:00.000Z"],
  ["America/Los_Angeles", "2026-11-13T07:12:00Z", "2026-10-13", "2026-11-11", "2026-10-13T07:00:00.000Z", "2026-11-12T08:00:00.000Z"], // still Nov 12 there; spans the Nov 1 clock change
  ["Pacific/Kiritimati", "2026-11-13T07:12:00Z", "2026-10-14", "2026-11-12", "2026-10-13T10:00:00.000Z", "2026-11-12T10:00:00.000Z"], // UTC+14: already evening of Nov 13
  ["Pacific/Pago_Pago", "2026-11-13T07:12:00Z", "2026-10-13", "2026-11-11", "2026-10-13T11:00:00.000Z", "2026-11-12T11:00:00.000Z"], // UTC-11: evening of Nov 12
  ["UTC", "2026-11-13T00:00:00Z", "2026-10-14", "2026-11-12", "2026-10-14T00:00:00.000Z", "2026-11-13T00:00:00.000Z"], // the first instant of the new day: that day is "today"
  ["UTC", "2026-11-12T23:59:59Z", "2026-10-13", "2026-11-11", "2026-10-13T00:00:00.000Z", "2026-11-12T00:00:00.000Z"], // one second earlier: still the old day
  ["UTC", "2028-03-01T12:00:00Z", "2028-01-31", "2028-02-29", "2028-01-31T00:00:00.000Z", "2028-03-01T00:00:00.000Z"], // leap day inside the window
  ["America/New_York", "2026-03-20T12:00:00Z", "2026-02-18", "2026-03-19", "2026-02-18T05:00:00.000Z", "2026-03-20T04:00:00.000Z"], // clock change on Mar 8
];
for (const [zone, now, since, until, start, end] of CASES) {
  test(`the query for ${zone} at ${now}: ${since}..${until} in the store's zone, today excluded`, async () => {
    const mock = mockShopify({ timezone: tzAnswer(zone) });
    const result = await run(mock, { now: () => new Date(now) });
    assert.equal(result.ok, true);
    const expected = `FROM sessions SHOW sessions WITH TIMEZONE '${zone}' SINCE ${since} UNTIL ${until}`;
    assert.equal(result.query, expected, "exactly the app's query text");
    assert.equal(mock.sessionsCalls()[0].body.variables.query, expected, "and that is what was sent to Shopify");
    assert.deepEqual([iso(result.periodStart), iso(result.periodEnd)], [start, end]);
    // independent arithmetic on the dates sent: 30 inclusive local days, ending the day before the local today
    const days = (Date.parse(until) - Date.parse(since)) / 86400000 + 1;
    assert.equal(days, 30);
    const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    assert.ok(until < localToday, `UNTIL ${until} is before the store's local today ${localToday}`);
    assert.equal((Date.parse(localToday) - Date.parse(until)) / 86400000, 1, "the window ends on the day immediately before today");
    // the app's own builder gives the same text: the check duplicates none of it
    assert.equal(buildSessionsQuery(sessionRange(new Date(now), zone)), expected);
  });
}

test("a successful check makes exactly two read-only requests, the time zone first, and no mutation", async () => {
  const mock = mockShopify({ timezone: tzAnswer("Asia/Kolkata") });
  const result = await run(mock);
  assert.equal(result.sessions, 1234);
  assert.equal(mock.calls.length, 2);
  assert.match(mock.calls[0].body.query, /shop\s*\{\s*ianaTimezone/);
  assert.match(mock.calls[1].body.query, /shopifyqlQuery/);
  for (const call of mock.calls) assert.doesNotMatch(call.body.query, /\bmutation\b/i);
  assert.doesNotMatch(JSON.stringify(result), /shpat|FAKE_TOKEN/, "the token is not part of the result");
});

test("the time zone is the store's own: a missing or invalid zone is a failure, never UTC, and no sessions query is sent", async () => {
  for (const [zone, code, retryable] of [[null, "timezone_unavailable", true], ["", "timezone_unavailable", true], ["Not/AZone", "invalid_timezone", false], ["x'; DROP", "invalid_timezone", false]]) {
    const mock = mockShopify({ timezone: tzAnswer(zone) });
    const result = await run(mock);
    assert.deepEqual([result.ok, result.code, result.retryable], [false, code, retryable], String(zone));
    assert.equal(mock.sessionsCalls().length, 0);
    assert.ok(!("sessions" in result));
  }
  const noShop = mockShopify({ timezone: { data: {} } });
  assert.equal((await run(noShop)).code, "timezone_unavailable");
});

// ======================= parsing: values and shapes =======================
test("response parsing: a real count passes through (including a genuine zero and the 100,000 edge); nothing else becomes a number", async () => {
  for (const [cell, expected] of [["0", 0], ["1", 1], ["100000", 100000], ["100001", 100001], ["24500.0", 24500], [42, 42]]) {
    const result = await run(mockShopify({ sessions: table([{ sessions: cell }]) }));
    assert.deepEqual([result.ok, result.sessions], [true, expected], `cell ${JSON.stringify(cell)}`);
  }
  for (const cell of [null, undefined, "", "abc", "-5", "12.5", "1e3", "NaN", {}, [], true]) {
    const result = await run(mockShopify({ sessions: table([{ sessions: cell }]) }));
    assert.deepEqual([result.ok, result.code, result.retryable], [false, "invalid_value", false], `cell ${JSON.stringify(cell)}`);
    assert.ok(!("sessions" in result), "a failure carries no count");
  }
});

test("response parsing: missing, empty or malformed data is a failure with a code, never zero sessions", async () => {
  const cases = [
    ["no rows (unavailable, not zero)", table([]), "no_rows", true],
    ["two rows", table([{ sessions: "1" }, { sessions: "2" }]), "unexpected_rows", false],
    ["no sessions column", table([{ visitors: "9" }], [{ name: "visitors" }]), "missing_column", false],
    ["columns missing", { data: { shopifyqlQuery: { tableData: { rows: [] }, parseErrors: [] } } }, "no_data", true],
    ["tableData null", { data: { shopifyqlQuery: { tableData: null, parseErrors: [] } } }, "no_data", true],
    ["shopifyqlQuery null", { data: { shopifyqlQuery: null } }, "no_data", true],
    ["data null", { data: null }, "no_data", true],
    ["empty object", {}, "no_data", true],
    ["a JSON array", [], "no_data", true],
    ["a JSON string", "ok", "invalid_response", true],
  ];
  for (const [tag, body, code, retryable] of cases) {
    const result = await run(mockShopify({ sessions: body }));
    assert.deepEqual([result.ok, result.kind, result.code, result.retryable], [false, "transient", code, retryable], tag);
  }
});

// ======================= ShopifyQL and HTTP errors =======================
test("ShopifyQL parse errors are a permanent failure: the query is not verified and nothing is counted", async () => {
  const result = await run(mockShopify({ sessions: { data: { shopifyqlQuery: { tableData: null, parseErrors: ["Unexpected token near 'WITH'"] } } } }));
  assert.deepEqual([result.ok, result.kind, result.code, result.retryable], [false, "transient", "parse_error", false]);
  assert.match(result.query, /WITH TIMEZONE/, "the failing query text is reported so it can be read");
});

test("missing permission is reported as needs-access, in every form Shopify uses, and is never zero", async () => {
  const denied = { errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] };
  const found = [];
  for (const [tag, sessions] of [
    ["GraphQL ACCESS_DENIED", denied],
    ["HTTP 401", new Response("{}", { status: 401 })],
    ["HTTP 403", new Response("{}", { status: 403 })],
  ]) {
    const result = await run(mockShopify({ sessions }));
    assert.deepEqual([result.ok, result.kind], [false, "permission"], tag);
    found.push(result.code);
  }
  assert.deepEqual(found, ["access_denied", "http_401", "http_403"]);
  const deniedAtTimezone = await run(mockShopify({ timezone: denied }));
  assert.deepEqual([deniedAtTimezone.kind, deniedAtTimezone.code], ["permission", "access_denied"]);
});

test("a session without read_reports makes no request at all", async () => {
  for (const scope of ["", "read_products", "write_reports", undefined]) {
    const mock = mockShopify();
    const result = await run(mock, { scope });
    assert.deepEqual([result.ok, result.kind, result.code], [false, "permission", "scope_not_granted"], String(scope));
    assert.equal(mock.calls.length, 0, "nothing was sent to Shopify");
  }
});

test("temporary failures are retryable failures: throttling, server errors, a dropped connection and a body that is not JSON", async () => {
  const cases = [
    ["GraphQL THROTTLED", { errors: [{ extensions: { code: "THROTTLED" } }] }, "throttled"],
    ["other GraphQL error", { errors: [{ message: "boom" }] }, "graphql_error"],
    ["HTTP 429", new Response("{}", { status: 429 }), "throttled"],
    ["HTTP 500", new Response("{}", { status: 500 }), "http_500"],
    ["HTTP 503", new Response("{}", { status: 503 }), "http_503"],
    ["not JSON", new Response("<html>oops</html>", { status: 200 }), "SyntaxError"],
  ];
  for (const [tag, sessions, code] of cases) {
    const result = await run(mockShopify({ sessions }));
    assert.deepEqual([result.ok, result.kind, result.code, result.retryable], [false, "transient", code, true], tag);
  }
  const dropped = await run({ fetchImpl: async () => { throw Object.assign(new Error("connect ECONNRESET with shpat_THIS_IS_A_FAKE_TOKEN_0123456789"), { name: "FetchError", code: "ECONNRESET" }); } });
  assert.deepEqual([dropped.ok, dropped.kind, dropped.code], [false, "transient", "ECONNRESET"]);
  assert.doesNotMatch(JSON.stringify(dropped), /shpat|FAKE_TOKEN/, "an error message that contained the token is not carried into the result");
});

test("no failure result ever carries a token or a count", async () => {
  for (const sessions of [{ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }, table([]), new Response("{}", { status: 500 })]) {
    const result = await run(mockShopify({ sessions }));
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result).sort(), ["code", "kind", "ok", "query", "retryable"]);
    assert.doesNotMatch(JSON.stringify(result), /shpat|FAKE_TOKEN/);
  }
});

// ======================= the script itself =======================
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const script = strip(fs.readFileSync("scripts/test-shopifyql-sessions.mjs", "utf8"));
const lib = strip(fs.readFileSync("scripts/shopifyql-check-lib.mjs", "utf8"));

test("the script is read-only and refresh-free: it only loads one session, uses no token-renewing helper and writes nothing", () => {
  for (const [name, source] of [["script", script], ["lib", lib]]) {
    assert.doesNotMatch(source, /getShopAdmin|unauthenticated|authenticate\.|refreshToken\s*:|exchange|requestToken|refreshAccessToken/i, `${name}: nothing that could renew a token`);
    assert.doesNotMatch(source, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|storeSession|deleteSession)\(|\$executeRaw|\$queryRaw|planRecommendation|shopSubscription|requestRecommendationRecheck|enqueuePlanRecommendations|runPlanRecommendations|recordSession/, `${name}: no database write, no PlanRecommendation or subscription access`);
    assert.doesNotMatch(source, /\bmutation\b/i, `${name}: no mutation`);
  }
  assert.match(script, /sessionStorage\.loadSession\(/);
  assert.match(script, /isExpired\(NEAR_EXPIRY_MS\)/, "an expired or nearly expired token is refused, not refreshed");
  assert.equal((script.match(/sessionStorage\.\w+\(/g) ?? []).join(), "sessionStorage.loadSession(", "the only storage call is the read");
});

test("the script runs the app's lookup and holds no query or parsing logic of its own", () => {
  assert.match(lib, /createShopifyqlSessionSource/);
  assert.match(script, /checkSessions\(/);
  for (const [name, source] of [["script", script], ["lib", lib]]) {
    assert.doesNotMatch(source, /FROM sessions|SINCE|UNTIL|shopifyqlQuery|ianaTimezone|parseErrors|tableData/, `${name}: no ShopifyQL text or response handling of its own`);
  }
  assert.doesNotMatch(fs.readFileSync("scripts/test-shopifyql-sessions.mjs", "utf8").replace(/\/\/.*$/gm, ""), /-30d/, "the old fixed relative range is gone");
});

test("the script never prints a token or secret: the only values logged are the shop, versions, dates, the query and the result", () => {
  const logged = [...script.matchAll(/console\.(?:log|error)\(([^;]*)\);/g)].map((m) => m[1]).join("\n");
  assert.doesNotMatch(logged, /accessToken|refreshToken|SHOPIFY_API_SECRET|DATABASE_URL(?!\s+is)/);
  assert.match(script, /knownSecrets = \[\.\.\.secretsFromEnv\(\), session\.accessToken, session\.refreshToken\]/, "the token is registered for scrubbing before any request");
});

// The script is started only to watch it refuse: every case below stops before any connection or request.
const refuses = (env, args = []) =>
  spawnSync(process.execPath, ["scripts/test-shopifyql-sessions.mjs", ...args], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, WORKER_SKIP_DOTENV: "1", ...env },
    encoding: "utf8",
    timeout: 30000,
  });

test("the script refuses, before connecting, in production, without a readable local database URL, or for any shop that is not the configured dev store", () => {
  const local = "mysql://u:p@127.0.0.1:3306/db";
  const cases = [
    ["production", { NODE_ENV: "production", DATABASE_URL: local, SHOPIFY_API_KEY: "k" }, [], /NODE_ENV is production/],
    ["no database URL", { SHOPIFY_API_KEY: "k" }, [], /DATABASE_URL is missing/],
    ["a remote database", { DATABASE_URL: "mysql://u:p@db.example.invalid:3306/db", SHOPIFY_API_KEY: "k" }, [], /REMOTE database host/],
    ["no API key (the dev store cannot be identified)", { DATABASE_URL: local }, [], /SHOPIFY_API_KEY is not set/],
    ["an app key with no configured dev store", { DATABASE_URL: local, SHOPIFY_API_KEY: "no-such-app-key" }, [], /no development store is configured/],
    ["another shop on the command line", { DATABASE_URL: local, SHOPIFY_API_KEY: "no-such-app-key" }, ["--shop=somebody-else.myshopify.com"], /Nothing was connected/],
  ];
  for (const [tag, env, args, message] of cases) {
    const result = refuses(env, args);
    assert.equal(result.status, 1, tag);
    assert.match(result.stderr, /FAILED \(no session count\)/, tag);
    assert.match(result.stderr, message, tag);
    assert.doesNotMatch(result.stdout + result.stderr, /OK:|sessions in the previous/, `${tag}: no count printed`);
    assert.doesNotMatch(result.stdout + result.stderr, /u:p@|mysql:\/\//, `${tag}: the database URL is never printed`);
  }
});

// ======================= the app URL the Shopify library insists on (regression) =======================
// `npm run test:shopifyql` failed with "Detected an empty appUrl configuration": app/shopify.server.js passes process.env.SHOPIFY_APP_URL || "" to
// shopifyApp(), `shopify app dev` injects SHOPIFY_APP_URL, but a plain node script only has .env, which carries APP_PUBLIC_URL. The script now
// bridges the two the way scripts/worker.mjs does, without bypassing the library's own check.
const { resolveAppUrl } = await import("../scripts/shopifyql-check-lib.mjs");
const projectKey = (() => {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(".shopify/project.json", "utf8")))[0] ?? null;
  } catch {
    return null;
  }
})();
const cleanEnv = (extra) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, WORKER_SKIP_DOTENV: "1", ...extra });

test("resolveAppUrl: SHOPIFY_APP_URL wins, APP_PUBLIC_URL is the fallback, only an https (or localhost http) origin is accepted, and nothing is invented", () => {
  assert.deepEqual(resolveAppUrl({ SHOPIFY_APP_URL: "https://dev.example.invalid/path?x=1", APP_PUBLIC_URL: "https://other.example.invalid" }), { ok: true, url: "https://dev.example.invalid", source: "SHOPIFY_APP_URL" });
  assert.deepEqual(resolveAppUrl({ APP_PUBLIC_URL: " https://app.example.invalid/ " }), { ok: true, url: "https://app.example.invalid", source: "APP_PUBLIC_URL" });
  assert.deepEqual(resolveAppUrl({ SHOPIFY_APP_URL: "", APP_PUBLIC_URL: "https://app.example.invalid" }).source, "APP_PUBLIC_URL", "an empty value is the same as unset, as in worker.mjs");
  assert.equal(resolveAppUrl({ APP_PUBLIC_URL: "http://localhost:3000" }).ok, true);
  assert.equal(resolveAppUrl({ APP_PUBLIC_URL: "http://127.0.0.1:3000" }).ok, true);
  for (const env of [{}, { SHOPIFY_APP_URL: "   " }, { APP_PUBLIC_URL: "http://app.example.invalid" }, { APP_PUBLIC_URL: "ftp://app.example.invalid" }, { APP_PUBLIC_URL: "not a url" }, { SHOPIFY_APP_URL: "http://app.example.invalid", APP_PUBLIC_URL: "https://app.example.invalid" }]) {
    const result = resolveAppUrl(env);
    assert.equal(result.ok, false, JSON.stringify(env));
    assert.ok(!("url" in result) && result.reason.length > 10, "a reason, never a made-up URL");
  }
});

test("root cause reproduced: importing the app's Shopify configuration without SHOPIFY_APP_URL throws the library's empty appUrl error; with a URL it loads and makes no request", () => {
  const root = pathToFileURL(`${process.cwd()}/`).href;
  const code = `import { register } from "node:module"; register("./scripts/resolve-hooks.mjs", "${root}");
    const { apiVersion } = await import("${root}app/shopify.server.js");
    console.log("loaded " + apiVersion);
    process.exit(0);`;
  const base = { DATABASE_URL: "mysql://u:p@127.0.0.1:1/none", SHOPIFY_API_KEY: "test-key", SHOPIFY_API_SECRET: "test-secret" };
  const without = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: cleanEnv(base), encoding: "utf8", timeout: 60000 });
  assert.notEqual(without.status, 0);
  assert.match(without.stderr, /empty appUrl configuration/, "the library's own check, which stays in force");
  const withUrl = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: cleanEnv({ ...base, SHOPIFY_APP_URL: "https://app.example.invalid" }), encoding: "utf8", timeout: 60000 });
  assert.equal(withUrl.status, 0, withUrl.stderr.slice(0, 300));
  assert.match(withUrl.stdout, /^loaded \d{4}-\d{2}$/m);
});

const scriptRun = (extra) =>
  spawnSync(process.execPath, ["scripts/test-shopifyql-sessions.mjs"], { env: cleanEnv({ DATABASE_URL: "mysql://u:p@127.0.0.1:1/none", SHOPIFY_API_KEY: projectKey ?? "k", SHOPIFY_API_SECRET: "test-secret", ...extra }), encoding: "utf8", timeout: 90000 });
const needsProject = projectKey ? false : "no .shopify/project.json here, so the configured development store cannot be identified";

test("the script with only APP_PUBLIC_URL (what .env has) gets past the library configuration: no appUrl error, and it stops at the unreachable test database without any count", { skip: needsProject }, () => {
  const result = scriptRun({ APP_PUBLIC_URL: "https://app.example.invalid" });
  const out = result.stdout + result.stderr;
  assert.doesNotMatch(out, /empty appUrl|Invalid appUrl/);
  assert.match(result.stdout, /app URL for the library configuration: taken from APP_PUBLIC_URL \(not contacted\)/);
  assert.match(result.stdout, /Admin API version: \d{4}-\d{2}/, "the Shopify configuration loaded");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED \(no session count\)/);
  assert.doesNotMatch(out, /OK:|sessions in the previous|example\.invalid|u:p@/, "no count, and neither the URL value nor the database URL is printed");
});

test("the script with no usable app URL refuses with a clear message before it connects, instead of the library's error", { skip: needsProject }, () => {
  for (const extra of [{}, { APP_PUBLIC_URL: "http://app.example.invalid" }, { SHOPIFY_APP_URL: "garbage" }]) {
    const result = scriptRun(extra);
    assert.equal(result.status, 1, JSON.stringify(extra));
    assert.match(result.stderr, /(neither SHOPIFY_APP_URL nor APP_PUBLIC_URL is set|must be an https URL).*Nothing was connected/);
    assert.doesNotMatch(result.stdout + result.stderr, /Admin API version|empty appUrl|session could not be read/, "it stopped before the library and the database");
  }
});

test("the app URL bridge is the only addition: the script still sets nothing but SHOPIFY_APP_URL in the environment and still uses no token-renewing helper", () => {
  const source = script;
  assert.deepEqual([...source.matchAll(/process\.env\.(\w+)\s*=[^=]/g)].map((m) => m[1]), ["SHOPIFY_APP_URL"]);
  assert.match(source, /resolveAppUrl\(process\.env\)/);
  assert.ok(source.indexOf("resolveAppUrl(process.env)") < source.indexOf('await import("../app/shopify.server.js")'), "set before the library configuration is read");
  assert.doesNotMatch(source, /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i, "no URL is written in the script");
});
