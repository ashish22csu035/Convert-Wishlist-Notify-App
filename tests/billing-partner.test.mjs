// Tests for Shopify App Pricing subscription verification through the Partner API (partner-api-verifier.server.js), its opt-in wiring
// (billing-services.server.js), and how it drives the existing verification worker, quota reservation and parked-email wake-up, including the
// per-plan email attribution rule (M4): emails sent under Advance never count toward Enterprise.
//
// Run: node --test tests/billing-partner.test.mjs
//
// NOTHING here touches the network: the Partner API client is given a fake `fetch`, and the Admin client is a stub. No subscription is created,
// approved or cancelled. The pure tests run anywhere. The database tests WRITE rows, so they only run when DATABASE_URL (set in the
// environment) names an isolated kw_*test* database with the migrations applied; otherwise they are skipped and say so.
import { isTimezoneQuery, shopZoneAnswer } from "./helpers/shop-timezone.mjs";
import "./helpers/resolve-extensionless.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const dbUrl = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const dbTest = (name, fn) => test(name, { skip }, fn);
const prisma = skip ? null : new PrismaClient();

// The email modules load the Shopify client, which reads these when it is first imported (dummy values: nothing contacts Shopify).
process.env.SHOPIFY_API_KEY ||= "dummy-key";
process.env.SHOPIFY_API_SECRET ||= "dummy-secret-for-tests-only";
process.env.SHOPIFY_APP_URL ||= "https://app.example.invalid";
const { getEntitlements, restockEmailUsage } = await import("../app/models/entitlements.server.js");
const { claimNext } = skip ? {} : await import("../app/models/email-delivery.server.js"); // loads the Shopify client and its session table: only with a database
const { QUOTA_BLOCKED } = await import("../app/models/email-quota.server.js");
const P = await import("../app/models/partner-api-verifier.server.js");
const { getBillingServices, resetBillingConfigWarning } = await import("../app/models/billing-services.server.js");
const V = await import("../app/models/subscription-verification.server.js");
const R = await import("../app/models/plan-recommendation.server.js");
const { createShopifyqlSessionSource } = await import("../app/models/session-source.server.js");
const { runBillingJobs } = await import("../app/worker/billing-jobs.server.js");

const NOW = new Date("2026-11-11T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RUN = Date.now().toString(36);
const quiet = { log() {}, error() {}, warn() {} };
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRET_TOKEN = "partner-token-that-must-never-appear-anywhere";
const APP = "gid://shopify/App/4242";
const PARTNERS_APP = "gid://partners/App/4242";
const API_KEY = "this-apps-own-api-key";
const PARTNER_URL = "https://partners.shopify.com/1234567/api/2026-10/graphql.json"; // a fixture in the documented shape; the real URL is supplied by the operator
const HANDLES = P.parsePlanHandles("advance=ADVANCE,enterprise=ENTERPRISE,basic=BASIC").handles;
const SHOP_DOMAIN = "example.myshopify.com";
const SHOP_GID = "gid://shopify/Shop/9001";
const ctxOf = (over = {}) => ({ appGid: APP, apiKey: API_KEY, shopGid: SHOP_GID, shopDomain: SHOP_DOMAIN, handles: HANDLES, now: NOW, ...over });
const cycle = (fromDays = -20, toDays = 10) => ({ startTime: iso(NOW.getTime() + fromDays * DAY), endTime: iso(NOW.getTime() + toDays * DAY) });
// An ActiveSubscription as the Partner API returns it, about this app and shop.
const activeSub = (over = {}, { shopGid = SHOP_GID, domain = SHOP_DOMAIN } = {}) => ({
  app: { id: APP, apiKey: API_KEY },
  shop: { id: shopGid, myshopifyDomain: domain },
  billingPeriod: "EVERY_30_DAYS",
  cancelAtEndOfCycle: false,
  trialEndsAt: null,
  currentBillingCycle: cycle(),
  items: [{ handle: "advance" }],
  pendingUpdate: null,
  legacySubscriptionId: null,
  ...over,
});
const interpret = (sub, over = {}) => P.interpretActiveSubscription({ activeSubscription: sub }, ctxOf(over));
const flat = (result) => (result.outcome === "error" ? `error:${result.kind}:${result.code}` : result.outcome);

// ======================= configuration =======================
test("the query is the documented activeSubscription(appId, shopId) and asks for no money fields", () => {
  assert.match(P.ACTIVE_SUBSCRIPTION_QUERY, /activeSubscription\(appId: \$appId, shopId: \$shopId\)/);
  for (const field of ["app { id apiKey }", "shop { id myshopifyDomain }", "billingPeriod", "cancelAtEndOfCycle", "trialEndsAt", "currentBillingCycle { startTime endTime }", "items { handle }", "pendingUpdate"]) assert.ok(P.ACTIVE_SUBSCRIPTION_QUERY.includes(field), field);
  assert.doesNotMatch(P.ACTIVE_SUBSCRIPTION_QUERY, /price|amount|usage|discount|mutation/i);
  assert.equal(P.DEFAULT_PARTNER_API_VERSION, undefined, "no API version is chosen by the code: the operator's URL carries it");
});

test("plan handles are configuration: exactly which handle is which plan, and nothing is guessed", () => {
  const parsed = P.parsePlanHandles("advance=ADVANCE, enterprise:ENTERPRISE ,basic=BASIC");
  assert.deepEqual([...parsed.handles.entries()], [["advance", "ADVANCE"], ["enterprise", "ENTERPRISE"], ["basic", "BASIC"]]);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(P.parsePlanHandles("advance=ADVANCE").problems, ["missing_enterprise"], "both paid plans must be mapped");
  assert.ok(P.parsePlanHandles("a=ADVANCE,b=ADVANCE,c=ENTERPRISE").problems.includes("plan_mapped_twice"));
  assert.ok(P.parsePlanHandles("a=ADVANCE,a=ENTERPRISE").problems.includes("duplicate_handle"));
  for (const bad of ["advance", "advance=GOLD,enterprise=ENTERPRISE", "ad vance=ADVANCE,enterprise=ENTERPRISE", "=ADVANCE", "a=b=c", undefined, ""]) assert.ok(P.parsePlanHandles(bad).problems.length > 0, String(bad));
});

const FULL_ENV = { BILLING_MECHANISM: "app_pricing", SHOPIFY_PARTNER_API_URL: PARTNER_URL, SHOPIFY_PARTNER_API_ACCESS_TOKEN: SECRET_TOKEN, SHOPIFY_APP_GID: APP, SHOPIFY_API_KEY: API_KEY, BILLING_PLAN_HANDLES: "advance=ADVANCE,enterprise=ENTERPRISE" };

test("the configuration check reports NAMES only, never a value, and is ready only when everything is present and readable", () => {
  const ready = P.readPartnerConfig(FULL_ENV);
  assert.deepEqual([ready.ready, ready.missing, ready.invalid], [true, [], []]);
  assert.deepEqual([ready.config.url, ready.config.appGid, ready.config.apiKey], [PARTNER_URL, APP, API_KEY]);
  const empty = P.readPartnerConfig({});
  assert.deepEqual([empty.ready, empty.config, empty.missing], [false, null, ["SHOPIFY_PARTNER_API_URL", "SHOPIFY_PARTNER_API_ACCESS_TOKEN", "SHOPIFY_APP_GID", "SHOPIFY_API_KEY", "BILLING_PLAN_HANDLES"]]);
  const bad = P.readPartnerConfig({ ...FULL_ENV, SHOPIFY_PARTNER_API_URL: "http://insecure.example", SHOPIFY_APP_GID: "4242", BILLING_PLAN_HANDLES: "advance=ADVANCE" });
  assert.deepEqual(bad.invalid, ["SHOPIFY_PARTNER_API_URL", "SHOPIFY_APP_GID", "BILLING_PLAN_HANDLES"]);
  assert.equal(bad.ready, false);
  for (const text of [JSON.stringify(empty), JSON.stringify(bad)]) assert.ok(!text.includes(SECRET_TOKEN) && !text.includes("insecure.example"), "no value is echoed");
});

test("every required setting is validated before the verifier can exist: one missing or malformed piece leaves it off", () => {
  const one = (name, value) => P.readPartnerConfig({ ...FULL_ENV, [name]: value });
  for (const name of ["SHOPIFY_PARTNER_API_URL", "SHOPIFY_PARTNER_API_ACCESS_TOKEN", "SHOPIFY_APP_GID", "SHOPIFY_API_KEY", "BILLING_PLAN_HANDLES"]) {
    assert.deepEqual([one(name, "").ready, one(name, "").missing], [false, [name]], `${name} missing`);
    assert.equal(one(name, "   ").ready, false, `${name} blank`);
  }
  for (const gid of ["4242", "gid://shopify/App/0", "gid://shopify/App/-1", "gid://shopify/App/abc", "gid://partners/App/4242", "gid://shopify/Shop/4242", "gid://shopify/App/4242/extra"]) assert.deepEqual(one("SHOPIFY_APP_GID", gid).invalid, ["SHOPIFY_APP_GID"], gid);
  for (const url of ["http://partners.shopify.com/x", "https://example.com/graphql.json", "https://partners.shopify.com.evil.example/x", "https://user:pw@partners.shopify.com/x", "not a url", "ftp://partners.shopify.com/x"]) assert.deepEqual(one("SHOPIFY_PARTNER_API_URL", url).invalid, ["SHOPIFY_PARTNER_API_URL"], url);
  assert.equal(one("SHOPIFY_PARTNER_API_URL", "https://partners.shopify.com/1/api/2026-07/graphql.json").ready, true);
});

test("the documented endpoint pattern and API version are accepted, and only that exact shape: the token can go nowhere else", () => {
  const url = (value) => P.validEndpoint(value);
  assert.equal(url("https://partners.shopify.com/1234567/api/2026-10/graphql.json"), true, "the documented endpoint with API version 2026-10");
  assert.equal(url("https://partners.shopify.com/1234567/api/2026-07/graphql.json"), true, "another dated version");
  assert.equal(url("https://partners.shopify.com/1234567/api/unstable/graphql.json"), true);
  for (const bad of [
    "https://partners.shopify.com/abc/api/2026-10/graphql.json", // the Partner ID is a number
    "https://partners.shopify.com/1234567/api/latest/graphql.json", // a version is YYYY-MM or unstable
    "https://partners.shopify.com/1234567/api/2026-10/graphql",
    "https://partners.shopify.com/1234567/graphql.json",
    "https://partners.shopify.com/1234567/api/2026-10/graphql.json?x=1",
    "https://partners.shopify.com/1234567/api/2026-10/graphql.json#x",
    "https://partners.shopify.com:8443/1234567/api/2026-10/graphql.json",
    "https://user:pw@partners.shopify.com/1234567/api/2026-10/graphql.json",
    "http://partners.shopify.com/1234567/api/2026-10/graphql.json",
    "https://admin.shopify.com/1234567/api/2026-10/graphql.json",
    "https://partners.shopify.com.evil.example/1234567/api/2026-10/graphql.json",
    "https://evil.example/1234567/api/2026-10/graphql.json",
    "", undefined, null, 5,
  ]) assert.equal(url(bad), false, String(bad));
  assert.equal(P.readPartnerConfig({ ...FULL_ENV, SHOPIFY_PARTNER_API_URL: "https://partners.shopify.com/1234567/api/2026-10/graphql.json" }).ready, true);
  assert.deepEqual(P.readPartnerConfig({ ...FULL_ENV, SHOPIFY_PARTNER_API_URL: "https://partners.shopify.com/1234567/api/2026-10/graphql" }).invalid, ["SHOPIFY_PARTNER_API_URL"]);
});

test("no endpoint URL is guessed: the source contains none, and without the operator's URL the verifier cannot exist", () => {
  const source = fs.readFileSync(path.resolve("app/models/partner-api-verifier.server.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/https:\/\/partners\./.test(source) && !/graphql\.json["`']/.test(source), "no Partner API URL is built or written in the code (only described in comments)");
  assert.equal(P.readPartnerConfig({ ...FULL_ENV, SHOPIFY_PARTNER_API_URL: undefined }).ready, false);
  assert.equal(typeof P.partnerEndpoint, "undefined");
});

test("app identity is the configured app id in its partners form AND this app's own API key", () => {
  assert.equal(P.partnersAppGid(APP), PARTNERS_APP);
  for (const bad of ["x", "", null, undefined, "gid://shopify/App/0", PARTNERS_APP]) assert.equal(P.partnersAppGid(bad), null, String(bad));
  const ok = { app: { id: PARTNERS_APP, apiKey: API_KEY } };
  assert.equal(P.identityMatches(ok, { appGid: APP, apiKey: API_KEY }), true);
  assert.equal(P.identityMatches({ app: { id: "gid://partners/App/1", apiKey: API_KEY } }, { appGid: APP, apiKey: API_KEY }), false, "another app's id");
  assert.equal(P.identityMatches({ app: { id: PARTNERS_APP, apiKey: "another-key" } }, { appGid: APP, apiKey: API_KEY }), false, "another app's key");
  assert.equal(P.identityMatches({ app: { id: APP, apiKey: API_KEY } }, { appGid: APP, apiKey: API_KEY }), false, "the wrong namespace of id");
  for (const bad of [null, undefined, {}, { app: null }, { app: {} }, "x"]) assert.equal(P.identityMatches(bad, { appGid: APP, apiKey: API_KEY }), false);
  assert.equal(P.identityMatches(ok, { appGid: APP, apiKey: "" }), false, "no expected key, no confirmation");
  assert.equal(P.identityMatches(ok, { appGid: "oops", apiKey: API_KEY }), false);
});

// ======================= interpreting the answer =======================
test("an active Advance or Enterprise subscription is a verified plan with the billing cycle exactly as Shopify reports it", () => {
  for (const [handle, plan] of [["advance", "ADVANCE"], ["enterprise", "ENTERPRISE"]]) {
    const result = interpret(activeSub({ items: [{ handle }], legacySubscriptionId: "gid://shopify/AppSubscription/77" }));
    assert.equal(result.outcome, "active");
    assert.deepEqual([result.plan, result.source, result.planHandle, result.shopifySubscriptionGid], [plan, "app_pricing", handle, "gid://shopify/AppSubscription/77"]);
    assert.deepEqual([result.periodStart.toISOString(), result.periodEnd.toISOString()], [iso(NOW.getTime() - 20 * DAY), iso(NOW.getTime() + 10 * DAY)]);
  }
});

test("no billing cycle length is assumed: a yearly cycle and an odd cycle are stored as reported", () => {
  const yearly = interpret(activeSub({ billingPeriod: "ANNUAL", currentBillingCycle: { startTime: iso(NOW.getTime() - 100 * DAY), endTime: iso(NOW.getTime() + 265 * DAY) } }));
  assert.deepEqual([yearly.outcome, (yearly.periodEnd - yearly.periodStart) / DAY], ["active", 365]);
  const odd = interpret(activeSub({ currentBillingCycle: { startTime: iso(NOW.getTime() - 2 * DAY), endTime: iso(NOW.getTime() + 12 * DAY) } }));
  assert.equal((odd.periodEnd - odd.periodStart) / DAY, 14);
});

test("a null answer is only a 'no contract' claim that must be confirmed; the free plan is a real subscription; a missing answer is nothing", () => {
  assert.deepEqual(P.interpretActiveSubscription({ activeSubscription: null }, ctxOf()), { outcome: "none", reason: "no_contract", requireRepeat: true });
  for (const bad of [undefined, null, {}, { somethingElse: 1 }, "x", [], { activeSubscription: "x" }, { activeSubscription: [] }]) assert.equal(flat(P.interpretActiveSubscription(bad, ctxOf())), "error:transient:invalid_response", JSON.stringify(bad));
  assert.deepEqual(interpret(activeSub({ items: [{ handle: "basic" }] })), { outcome: "none", reason: "free_plan" }, "a subscription to the free plan is evidence in itself, nothing to repeat");
});

test("a trial has no billing cycle: the plan is recorded, no period is invented, and the trial's end is when to look again", () => {
  const trialEnds = new Date(NOW.getTime() + 3 * DAY);
  const result = interpret(activeSub({ currentBillingCycle: null, trialEndsAt: trialEnds.toISOString(), items: [{ handle: "enterprise" }] }));
  assert.deepEqual([result.outcome, result.plan, result.trialEndsAt.getTime()], ["trial", "ENTERPRISE", trialEnds.getTime()]);
  assert.equal("periodStart" in result || "periodEnd" in result, false, "no dates were made up");
  assert.equal(flat(interpret(activeSub({ currentBillingCycle: null, trialEndsAt: null }))), "error:transient:billing_cycle_unavailable", "no cycle and no trial is inconsistent");
  assert.equal(flat(interpret(activeSub({ currentBillingCycle: null, trialEndsAt: iso(NOW.getTime() - HOUR) }))), "error:transient:billing_cycle_unavailable", "a trial that already ended with no cycle yet: look again");
  assert.equal(flat(interpret(activeSub({ currentBillingCycle: null, trialEndsAt: "not a date" }))), "error:transient:billing_cycle_unavailable");
});

test("cancellation at the end of the cycle keeps the plan until then, and a pending change does not apply early", () => {
  const cancelling = interpret(activeSub({ cancelAtEndOfCycle: true }));
  assert.deepEqual([cancelling.outcome, cancelling.plan], ["active", "ADVANCE"], "still active until the cycle ends");
  const changing = interpret(activeSub({ pendingUpdate: { billingPeriod: "EVERY_30_DAYS", items: [{ handle: "enterprise" }] } }));
  assert.deepEqual([changing.outcome, changing.plan], ["active", "ADVANCE"], "the CURRENT items decide; the change applies at the next cycle");
  for (const pending of [{ items: "x" }, { billingPeriod: "EVERY_30_DAYS" }, "x"]) assert.equal(flat(interpret(activeSub({ pendingUpdate: pending }))), "error:transient:invalid_response", JSON.stringify(pending));
});

test("a plan is recognised only by a configured handle: names, descriptions, unknown and ambiguous plans grant nothing", () => {
  assert.equal(flat(interpret(activeSub({ items: [{ handle: "enterprise-plus", name: "Enterprise", description: "Enterprise", displayName: "Enterprise" }] }))), "error:config:unknown_plan", "a display name is never read");
  assert.equal(flat(interpret(activeSub({ items: [{ handle: "Advance" }] }))), "error:config:unknown_plan", "handles match exactly");
  assert.equal(flat(interpret(activeSub({ items: [] }))), "error:config:unknown_plan");
  assert.equal(flat(interpret(activeSub({ items: [{ handle: "advance" }, { handle: "enterprise" }] }))), "error:config:ambiguous_plan");
  assert.equal(interpret(activeSub({ items: [{ handle: "usage-meter" }, { handle: "advance" }] })).plan, "ADVANCE", "an unmapped extra item (a usage meter) is ignored when exactly one plan is named");
  assert.equal(flat(interpret(activeSub({ items: [{ nothandle: "advance" }] }))), "error:transient:invalid_response");
  assert.equal(flat(interpret(activeSub({ items: "advance" }))), "error:transient:invalid_response");
});

test("an answer about another app or shop, or in a form we do not support, is never used", () => {
  assert.equal(flat(interpret(activeSub({ app: { id: "gid://shopify/App/1" } }))), "error:config:app_mismatch");
  assert.equal(flat(interpret(activeSub({ app: null }))), "error:config:app_mismatch");
  assert.equal(flat(interpret(activeSub({ app: { id: APP, apiKey: "another-apps-key" } }))), "error:config:app_mismatch", "the right id with another app's key");
  assert.equal(flat(interpret(activeSub({ app: { id: APP } }))), "error:config:app_mismatch", "no key in the answer");
  assert.equal(flat(interpret(activeSub(), { apiKey: "" })), "error:config:app_mismatch", "no expected key configured: nothing is accepted");
  assert.equal(flat(interpret(activeSub({ shop: { id: "gid://shopify/Shop/1", myshopifyDomain: SHOP_DOMAIN } }))), "error:config:shop_mismatch");
  assert.equal(flat(interpret(activeSub({ shop: { id: SHOP_GID, myshopifyDomain: "other.myshopify.com" } }))), "error:config:shop_mismatch");
  assert.equal(flat(interpret(activeSub({ shop: null }))), "error:config:shop_mismatch");
  assert.equal(flat(interpret(activeSub({ shop: { id: SHOP_GID, myshopifyDomain: `https://${SHOP_DOMAIN.toUpperCase()}/` } }))), "active", "the domain is compared as a domain");
  assert.equal(flat(interpret(activeSub({ billingPeriod: "WEEKLY" }))), "error:config:unsupported_billing_period");
  assert.equal(flat(interpret(activeSub({ cancelAtEndOfCycle: "no" }))), "error:transient:invalid_response");
});

test("an unusable or already-ended billing cycle is transient: nothing is granted and nothing is cancelled", () => {
  for (const bad of [{ startTime: "x", endTime: "y" }, { startTime: iso(NOW.getTime() + DAY), endTime: iso(NOW.getTime() - DAY) }, { startTime: iso(NOW.getTime()), endTime: iso(NOW.getTime()) }, {}, "cycle", { startTime: null, endTime: null }]) {
    assert.equal(flat(interpret(activeSub({ currentBillingCycle: bad }))), "error:transient:invalid_response", JSON.stringify(bad));
  }
  assert.equal(flat(interpret(activeSub({ currentBillingCycle: cycle(-31, -1) }))), "error:transient:period_not_current");
  assert.equal(flat(interpret(activeSub({ currentBillingCycle: { startTime: iso(NOW.getTime() - 30 * DAY), endTime: iso(NOW.getTime()) } }))), "error:transient:period_not_current", "ending exactly now is over");
});

// ======================= the Partner API client =======================
const fakeFetch = (reply) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const r = typeof reply === "function" ? await reply({ url, options, body: JSON.parse(options.body) }) : reply;
    if (r?.throws) throw r.throws;
    const status = r?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => { if (r?.badJson) throw new SyntaxError("bad json"); return r?.body ?? { data: {} }; } };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};
const clientWith = (fetchImpl, over = {}) => P.createPartnerApiClient({ url: PARTNER_URL, token: SECRET_TOKEN, fetchImpl, ...over });
const clientFailure = async (reply) => {
  try {
    await clientWith(fakeFetch(reply)).activeSubscription({ appId: APP, shopId: SHOP_GID });
    return "no failure";
  } catch (error) {
    assert.ok(!String(error.message).includes(SECRET_TOKEN), "the token is never in an error");
    return `${error.kind}:${error.code}`;
  }
};

test("the client sends the documented queries to the operator's https URL, with the token in the header only and no redirects", async () => {
  const fetchImpl = fakeFetch({ body: { data: { activeSubscription: null } } });
  const data = await clientWith(fetchImpl).activeSubscription({ appId: APP, shopId: SHOP_GID });
  assert.deepEqual(data, { activeSubscription: null });
  const [{ url, options }] = fetchImpl.calls;
  assert.equal(url, PARTNER_URL);
  assert.deepEqual([options.method, options.redirect, options.headers["X-Shopify-Access-Token"], options.headers["Content-Type"]], ["POST", "error", SECRET_TOKEN, "application/json"]);
  const body = JSON.parse(options.body);
  assert.deepEqual(body.variables, { appId: APP, shopId: SHOP_GID });
  assert.equal(body.query, P.ACTIVE_SUBSCRIPTION_QUERY);
  assert.ok(!options.body.includes(SECRET_TOKEN) && !url.includes(SECRET_TOKEN));
  const identity = fakeFetch({ body: { data: { app: { id: PARTNERS_APP, apiKey: API_KEY } } } });
  assert.deepEqual(await clientWith(identity).app({ appId: PARTNERS_APP }), { app: { id: PARTNERS_APP, apiKey: API_KEY } });
  assert.deepEqual([JSON.parse(identity.calls[0].options.body).variables, JSON.parse(identity.calls[0].options.body).query], [{ id: PARTNERS_APP }, P.APP_IDENTITY_QUERY]);
  assert.match(P.APP_IDENTITY_QUERY, /app\(id: \$id\) \{ id apiKey \}/);
  for (const bad of ["http://partners.shopify.com/x", "https://example.com/x", "https://user:pw@partners.shopify.com/x", "", undefined, "not a url"]) assert.throws(() => clientWith(fakeFetch({}), { url: bad }), TypeError, String(bad));
  assert.throws(() => P.createPartnerApiClient({ url: PARTNER_URL, token: "", fetchImpl: fakeFetch({}) }), TypeError);
  assert.throws(() => P.createPartnerApiClient({ url: PARTNER_URL, token: "t", fetchImpl: null }), TypeError);
});

test("the client classifies every failure; none of them can read as 'no subscription'", async () => {
  assert.equal(await clientFailure({ status: 401 }), "permission:http_401");
  assert.equal(await clientFailure({ status: 403 }), "permission:http_403");
  assert.equal(await clientFailure({ status: 404 }), "config:endpoint_not_found", "documented for an invalid API version");
  assert.equal(await clientFailure({ status: 400 }), "config:bad_request");
  assert.equal(await clientFailure({ status: 429 }), "transient:throttled");
  assert.equal(await clientFailure({ status: 500 }), "transient:http_500");
  assert.equal(await clientFailure({ status: 503 }), "transient:http_503");
  assert.equal(await clientFailure({ throws: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }), "transient:ECONNRESET");
  assert.equal(await clientFailure({ throws: Object.assign(new Error("aborted"), { name: "AbortError" }) }), "transient:AbortError");
  assert.equal(await clientFailure({ badJson: true }), "transient:invalid_response");
  assert.equal(await clientFailure({ body: "not an object" }), "transient:invalid_response");
  assert.equal(await clientFailure({ body: { errors: [{ message: "Access denied for activeSubscription", extensions: { code: "ACCESS_DENIED" } }] } }), "permission:access_denied");
  assert.equal(await clientFailure({ body: { errors: [{ message: "The client lacks the Manage apps permission" }] } }), "permission:access_denied");
  assert.equal(await clientFailure({ body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } }), "transient:throttled");
  assert.equal(await clientFailure({ body: { errors: [{ message: "Something else went wrong" }], data: { activeSubscription: null } } }), "transient:graphql_error", "errors win over a null answer");
});

// ======================= the verifier =======================
const adminFor = (shopGid = SHOP_GID) => {
  const calls = [];
  const getAdmin = async () => ({ admin: { graphql: async (query) => { calls.push(query); return { json: async () => ({ data: { shop: { id: shopGid } } }) }; } } });
  getAdmin.calls = calls;
  return getAdmin;
};
const IDENTITY_OK = { body: { data: { app: { id: PARTNERS_APP, apiKey: API_KEY } } } };
// Routes the two Partner API requests: the app identity query and the subscription query.
const routed = (activeReply, identityReply = IDENTITY_OK) => async (ctx) => {
  const reply = ctx.body.query.includes("KonvertAppIdentity") ? identityReply : activeReply;
  return typeof reply === "function" ? reply(ctx) : reply;
};
const verifierWith = (reply, { getAdmin = adminFor(), now = () => NOW, identity, appGid = APP, apiKey = API_KEY } = {}) => {
  const fetchImpl = fakeFetch(routed(reply, identity));
  const verifier = P.createPartnerApiVerifier({ client: clientWith(fetchImpl), appGid, apiKey, handles: HANDLES, getAdmin, now });
  return { verify: verifier, fetchImpl, getAdmin };
};
const identityCalls = (fetchImpl) => fetchImpl.calls.filter((call) => JSON.parse(call.options.body).query.includes("KonvertAppIdentity")).length;

test("the verifier reads the shop's id from the Admin API, asks the Partner API about THAT app and shop, and never uses the Admin API's billing view", async () => {
  const { verify, fetchImpl, getAdmin } = verifierWith(({ body }) => ({ body: { data: { activeSubscription: activeSub({}, { shopGid: body.variables.shopId }) } } }));
  const result = await verify({ shop: { domain: SHOP_DOMAIN } });
  assert.equal(result.outcome, "active");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body).variables, { appId: APP, shopId: SHOP_GID });
  assert.equal(getAdmin.calls.length, 1);
  assert.match(getAdmin.calls[0], /shop \{ id \}/);
  assert.doesNotMatch(getAdmin.calls[0], /currentAppInstallation|activeSubscriptions|appSubscription/i);
});

test("the verifier never turns a failure into a cancellation or a grant", async () => {
  const outcome = async (reply, options) => flat(await verifierWith(reply, options).verify({ shop: { domain: SHOP_DOMAIN } }));
  const good = { body: { data: { activeSubscription: activeSub() } } };
  assert.equal(await outcome(good), "active");
  assert.equal(await outcome({ body: { data: { activeSubscription: null } } }), "none", "null with a confirmed identity");
  assert.equal(await outcome({ status: 401 }), "error:permission:http_401");
  assert.equal(await outcome({ status: 404 }), "error:config:endpoint_not_found");
  assert.equal(await outcome({ status: 429 }), "error:transient:throttled");
  assert.equal(await outcome({ status: 500 }), "error:transient:http_500");
  assert.equal(await outcome({ throws: new Error("network down") }), "error:transient:Error");
  assert.equal(await outcome(good, { getAdmin: async () => { throw new Error("no session for this shop"); } }), "error:transient:admin_session_unavailable");
  assert.equal(await outcome(good, { getAdmin: adminFor("not-a-gid") }), "error:transient:shop_id_unavailable");
  assert.equal(await outcome(good, { getAdmin: async () => ({ admin: { graphql: async () => { throw new Error("x"); } } }) }), "error:transient:admin_session_unavailable");
  assert.equal(await outcome({ body: { data: { activeSubscription: activeSub({ app: { id: "gid://shopify/App/1" } }) } } }), "error:config:app_mismatch");
  assert.equal(await outcome({ body: { data: { activeSubscription: activeSub({ items: [{ handle: "mystery" }] }) } } }), "error:config:unknown_plan");
  assert.throws(() => P.createPartnerApiVerifier({}), TypeError);
  assert.throws(() => P.createPartnerApiVerifier({ client: clientWith(fakeFetch({})), appGid: "4242", apiKey: API_KEY, handles: HANDLES, getAdmin: adminFor() }), TypeError);
  assert.throws(() => P.createPartnerApiVerifier({ client: clientWith(fakeFetch({})), appGid: APP, apiKey: "", handles: HANDLES, getAdmin: adminFor() }), TypeError, "no API key, no verifier");
});

test("a null answer is believed only after the identity of the configured app is confirmed; any failure to confirm is an error, never a cancellation", async () => {
  const NULL = { body: { data: { activeSubscription: null } } };
  const outcome = async (identity, options = {}) => flat(await verifierWith(NULL, { identity, ...options }).verify({ shop: { domain: SHOP_DOMAIN } }));
  const other = { body: { data: { app: { id: PARTNERS_APP, apiKey: "another-apps-key" } } } };
  assert.deepEqual(await verifierWith(NULL).verify({ shop: { domain: SHOP_DOMAIN } }), { outcome: "none", reason: "no_contract", requireRepeat: true });
  assert.equal(await outcome(other), "error:config:app_identity_mismatch", "the configured app id belongs to another app");
  assert.equal(await outcome({ body: { data: { app: { id: "gid://partners/App/1", apiKey: API_KEY } } } }), "error:config:app_identity_mismatch");
  assert.equal(await outcome({ body: { data: { app: null } } }), "error:config:app_identity_not_found");
  assert.equal(await outcome({ body: { data: {} } }), "error:config:app_identity_not_found");
  assert.equal(await outcome({ body: "nonsense" }), "error:transient:identity_invalid_response");
  assert.equal(await outcome({ status: 404 }), "error:config:identity_endpoint_not_found");
  assert.equal(await outcome({ status: 403 }), "error:permission:identity_http_403");
  assert.equal(await outcome({ status: 500 }), "error:transient:identity_http_500");
  assert.equal(await outcome({ throws: Object.assign(new Error("x"), { code: "ECONNRESET" }) }), "error:transient:identity_ECONNRESET");
  assert.equal(await outcome(IDENTITY_OK, { apiKey: "a-key-that-is-not-this-apps" }), "error:config:app_identity_mismatch", "the app's own key is what the answer is compared with");
  assert.equal(await outcome(IDENTITY_OK, { appGid: "gid://shopify/App/999" }), "error:config:app_identity_mismatch", "a wrong GID in the configuration");
});

test("the identity is confirmed once per half hour, only when a null needs it, and a failed confirmation is never remembered", async () => {
  let clock = NOW.getTime();
  const NULL = { body: { data: { activeSubscription: null } } };
  const { verify, fetchImpl } = verifierWith(NULL, { now: () => new Date(clock) });
  const run = () => verify({ shop: { domain: SHOP_DOMAIN } });
  await run();
  await run();
  assert.equal(identityCalls(fetchImpl), 1, "the second null reuses the confirmation");
  clock += 31 * MIN;
  await run();
  assert.equal(identityCalls(fetchImpl), 2, "asked again after the time-to-live");
  const withSub = verifierWith({ body: { data: { activeSubscription: activeSub() } } });
  await withSub.verify({ shop: { domain: SHOP_DOMAIN } });
  assert.equal(identityCalls(withSub.fetchImpl), 0, "a subscription answer needs no extra request: it carries the app's id and key itself");
  let attempt = 0;
  const flaky = verifierWith(NULL, { identity: () => (attempt++ < 2 ? { status: 500 } : IDENTITY_OK) });
  assert.equal(flat(await flaky.verify({ shop: { domain: SHOP_DOMAIN } })), "error:transient:identity_http_500");
  assert.equal(flat(await flaky.verify({ shop: { domain: SHOP_DOMAIN } })), "error:transient:identity_http_500", "the failure was not remembered as a confirmation: it is asked again, and fails again");
  assert.equal(flat(await flaky.verify({ shop: { domain: SHOP_DOMAIN } })), "none", "and once the identity is confirmed, the null is believed");
  assert.equal(identityCalls(flaky.fetchImpl), 3);
});

// ======================= wiring: opt-in, explicit mechanism, no Billing API path =======================
test("the Billing API verifier is gone and cannot be activated: no source file queries the Admin API's subscriptions", () => {
  const root = path.resolve("app");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const sources = walk(root).filter((file) => /\.(js|jsx|mjs)$/.test(file));
  assert.equal(fs.existsSync(path.join(root, "models", "billing-api-verifier.server.js")), false);
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, ""); // comments may explain why; code may not do it
    assert.doesNotMatch(text, /currentAppInstallation|appSubscriptionCreate|activeSubscriptions\s*\{/, `${path.relative(root, file)} must not read the Admin API's Billing API subscriptions`);
  }
});

test("only BILLING_MECHANISM=app_pricing builds the verifier; 'billing_api' and everything else build nothing, even with full Partner configuration", () => {
  const services = (env, over = {}) => getBillingServices(env, { getAdmin: async () => ({}), fetchImpl: fakeFetch({}), log: quiet, ...over });
  resetBillingConfigWarning();
  assert.equal(services({}).verify, null);
  for (const mechanism of ["billing_api", "Billing_API", "partner", "app-pricing", "managed_pricing", "1", "true", ""]) assert.equal(services({ ...FULL_ENV, BILLING_MECHANISM: mechanism }).verify, null, mechanism);
  assert.equal(typeof services(FULL_ENV).verify, "function");
  assert.equal(typeof services({ ...FULL_ENV, BILLING_MECHANISM: " App_Pricing " }).verify, "function");
  assert.equal(services(FULL_ENV).fetchSessions, null, "the two services are switched on separately");
});

test("incomplete configuration leaves the verifier OFF and warns once with names only; nothing is called at start-up", () => {
  const warnings = [];
  const fetchImpl = fakeFetch({});
  const log = { warn: (message) => warnings.push(message) };
  resetBillingConfigWarning();
  for (const env of [{ BILLING_MECHANISM: "app_pricing" }, { ...FULL_ENV, SHOPIFY_PARTNER_API_ACCESS_TOKEN: "" }, { ...FULL_ENV, SHOPIFY_APP_GID: "oops" }]) {
    assert.equal(getBillingServices(env, { getAdmin: async () => ({}), fetchImpl, log }).verify, null);
  }
  assert.equal(warnings.length, 1, "one warning, not one per call");
  assert.match(warnings[0], /SHOPIFY_PARTNER_API_URL/);
  assert.match(warnings[0], /SHOPIFY_API_KEY/);
  assert.match(warnings[0], /BILLING_PLAN_HANDLES/);
  assert.ok(!warnings[0].includes(SECRET_TOKEN));
  getBillingServices(FULL_ENV, { getAdmin: async () => ({}), fetchImpl, log });
  assert.equal(fetchImpl.calls.length, 0, "building the verifier makes no request");
  assert.equal(getBillingServices().verify, null, "the real environment of this test run switches nothing on");
});

// ======================= database: verification end to end =======================
const domains = [];
let seq = 5500000000;
const newShop = async (tag) => {
  const domain = `kw-bp-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});

const gidOf = new Map();
const shopGidFor = (shop) => {
  if (!gidOf.has(shop.id)) gidOf.set(shop.id, `gid://shopify/Shop/${70000 + gidOf.size}`);
  return gidOf.get(shop.id);
};
// A Partner API verifier for ONE shop, answering `respond({ shopGid, domain })` -> { activeSubscription | status | errors | throws }.
const partnerFor = (shop, respond, { delay = 0, identity, appGid = APP, apiKey = API_KEY, now = () => NOW } = {}) => {
  const shopGid = shopGidFor(shop);
  const reply = async () => {
    if (delay) await sleep(delay);
    const r = typeof respond === "function" ? respond({ shopGid, domain: shop.domain }) : respond;
    if (r && Object.hasOwn(r, "activeSubscription")) return { body: { data: { activeSubscription: r.activeSubscription } } };
    return r;
  };
  const fetchImpl = fakeFetch(routed(reply, identity));
  const verifier = P.createPartnerApiVerifier({ client: clientWith(fetchImpl), appGid, apiKey, handles: HANDLES, getAdmin: adminFor(shopGid), now });
  verifier.fetchImpl = fetchImpl;
  return verifier;
};
const subFor = (shop, over = {}) => activeSub(over, { shopGid: shopGidFor(shop), domain: shop.domain });
const verify = (shop, respond, now = NOW, extra = {}) => V.runSubscriptionVerification({ verify: partnerFor(shop, respond, extra.partner), now: () => now, shopIds: [shop.id], log: quiet, ...extra.run });
const dueRow = (shop, over = {}) => prisma.shopSubscription.create({ data: { shopId: shop.id, nextVerificationAt: new Date(NOW.getTime() - MIN), ...over } });
const rowOf = (shop) => prisma.shopSubscription.findUnique({ where: { shopId: shop.id } });
const redue = (shop) => prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: new Date(NOW.getTime() - MIN), verificationLeaseExpiresAt: null } });
const paidRow = (shop, over = {}) => prisma.shopSubscription.create({ data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date(NOW.getTime() - 13 * HOUR), currentPeriodStart: new Date(NOW.getTime() - 20 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY), nextVerificationAt: new Date(NOW.getTime() - MIN), ...over } });
async function seedEmails(shop, count, { status = "SENT", planAtSend = null, sentAt = null, reservedAt = null, nextAttemptAt = null, errorCode = null, outbound = false } = {}) {
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
  const variants = Array.from({ length: count }, () => `gid://shopify/ProductVariant/${(seq += 1)}`);
  await prisma.notifySubscription.createMany({ data: variants.map((variantGid, i) => ({ shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid, email: `n${i}@example.invalid`, consentedAt: NOW, consentSource: "test" })) });
  const subs = await prisma.notifySubscription.findMany({ where: { shopId: shop.id, actorId: actor.id }, select: { id: true, variantGid: true } });
  await prisma.emailDelivery.createMany({
    data: subs.map((sub) => ({ shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid: sub.variantGid, status, planAtSend, sentAt, reservedAt, nextAttemptAt, errorCode, ...(outbound ? { outboundMessageId: `<${sub.id}@example.invalid>`, leaseExpiresAt: new Date(NOW.getTime() - MIN) } : {}) })),
  });
  return (await prisma.emailDelivery.findMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } }, select: { id: true } })).map((row) => row.id);
}
const usage = async (shop, now = NOW) => restockEmailUsage(shop.id, await getEntitlements(shop.id, { now }));
const delivery = (id) => prisma.emailDelivery.findUnique({ where: { id } });

dbTest("a verified Advance or Enterprise subscription grants that plan with Shopify's own billing cycle, and the free row is upgraded only by the verifier", async () => {
  for (const [handle, plan] of [["advance", "ADVANCE"], ["enterprise", "ENTERPRISE"]]) {
    const shop = await newShop(`ok-${plan}`);
    await dueRow(shop);
    assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC");
    const summary = await verify(shop, () => ({ activeSubscription: subFor(shop, { items: [{ handle }], legacySubscriptionId: "gid://shopify/AppSubscription/55" }) }));
    assert.equal(summary.active, 1);
    const row = await rowOf(shop);
    assert.deepEqual([row.plan, row.status, row.verificationSource, row.planHandle, row.shopifySubscriptionGid, row.verifiedAt.getTime(), row.verificationFailures, row.lastVerificationError], [plan, "ACTIVE", "app_pricing", handle, "gid://shopify/AppSubscription/55", NOW.getTime(), 0, null]);
    assert.deepEqual([row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime()], [NOW.getTime() - 20 * DAY, NOW.getTime() + 10 * DAY], "exactly what Shopify reported");
    assert.equal(row.nextVerificationAt.getTime(), NOW.getTime() + 12 * HOUR, "refreshed about 12 hours later, well inside the 24-hour freshness");
    const view = await getEntitlements(shop.id, { now: NOW });
    assert.deepEqual([view.plan.key, view.state], [plan, "verified"]);
  }
});

dbTest("a missing contract (null) cancels a paid subscription; every API, permission and data failure leaves it untouched and is retried", async () => {
  const cancelled = await newShop("cancel");
  await paidRow(cancelled);
  const first = await verify(cancelled, () => ({ activeSubscription: null }));
  assert.equal(first.unconfirmed, 1);
  let row = await rowOf(cancelled);
  assert.deepEqual([row.status, row.plan, row.lastVerificationError, row.verifiedAt.getTime(), row.nextVerificationAt.getTime() - NOW.getTime()], ["ACTIVE", "ADVANCE", "no_contract_unconfirmed", NOW.getTime() - 13 * HOUR, 5 * MIN], "the first null only asks to be repeated");
  assert.equal((await getEntitlements(cancelled.id, { now: NOW })).plan.key, "ADVANCE", "nothing about the entitlement changed yet");
  const later = new Date(NOW.getTime() + 6 * MIN);
  await verify(cancelled, () => ({ activeSubscription: null }), later);
  row = await rowOf(cancelled);
  assert.deepEqual([row.status, row.plan, row.currentPeriodEnd.getTime(), row.verificationFailures, row.lastVerificationError], ["CANCELLED", "ADVANCE", NOW.getTime() + 10 * DAY, 0, null], "the second consecutive null cancels; history kept");
  assert.deepEqual([(await getEntitlements(cancelled.id, { now: later })).plan.key, (await getEntitlements(cancelled.id, { now: later })).reason], ["BASIC", "subscription_cancelled"]);
  assert.equal((row.nextVerificationAt.getTime() - later.getTime()) / HOUR, 24, "rechecked daily in case the merchant subscribes again");

  const failing = [
    ["401", { status: 401 }, "permission_http_401", 6 * HOUR],
    ["403", { status: 403 }, "permission_http_403", 6 * HOUR],
    ["denied", { body: { errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }] } }, "permission_access_denied", 6 * HOUR],
    ["404", { status: 404 }, "config_endpoint_not_found", 6 * HOUR],
    ["429", { status: 429 }, "throttled", MIN],
    ["500", { status: 500 }, "http_500", MIN],
    ["network", { throws: Object.assign(new Error("x"), { code: "ECONNRESET" }) }, "ECONNRESET", MIN],
    ["badjson", { badJson: true }, "invalid_response", MIN],
    ["errors-with-null", { body: { errors: [{ message: "boom" }], data: { activeSubscription: null } } }, "graphql_error", MIN],
    ["wrongapp", (ctx) => ({ activeSubscription: subFor(ctx.shop, { app: { id: "gid://shopify/App/1" } }) }), "config_app_mismatch", 6 * HOUR],
    ["unknownplan", (ctx) => ({ activeSubscription: subFor(ctx.shop, { items: [{ handle: "mystery" }] }) }), "config_unknown_plan", 6 * HOUR],
    ["malformed", { body: { data: {} } }, "invalid_response", MIN],
  ];
  for (const [tag, reply, code, wait] of failing) {
    const shop = await newShop(`fail-${tag}`);
    await paidRow(shop);
    const before = await rowOf(shop);
    await verify(shop, typeof reply === "function" ? () => reply({ shop }) : reply);
    row = await rowOf(shop);
    assert.deepEqual([row.status, row.plan, row.verifiedAt.getTime(), row.currentPeriodEnd.getTime(), row.verificationFailures, row.lastVerificationError], ["ACTIVE", "ADVANCE", before.verifiedAt.getTime(), before.currentPeriodEnd.getTime(), 1, code], tag);
    assert.equal(row.nextVerificationAt.getTime() - NOW.getTime(), wait, `${tag}: a retry is scheduled, and not in a tight loop`);
    assert.equal(row.verificationLeaseExpiresAt, null);
  }
});

dbTest("an unusable answer never upgrades a free shop, and a recommendation never does either", async () => {
  const shop = await newShop("never-grant");
  await dueRow(shop);
  const bad = [
    { status: 500 },
    { body: { data: {} } },
    (s) => ({ activeSubscription: subFor(s, { items: [{ handle: "enterprise-gold" }] }) }),
    (s) => ({ activeSubscription: subFor(s, { items: [{ handle: "enterprise" }, { handle: "advance" }] }) }),
    (s) => ({ activeSubscription: subFor(s, { items: [{ handle: "enterprise" }], app: { id: "gid://shopify/App/9" } }) }),
    (s) => ({ activeSubscription: subFor(s, { items: [{ handle: "enterprise" }], shop: { id: "gid://shopify/Shop/1", myshopifyDomain: "x.myshopify.com" } }) }),
    (s) => ({ activeSubscription: subFor(s, { items: [{ handle: "enterprise" }], currentBillingCycle: cycle(-31, -1) }) }),
    (s) => ({ activeSubscription: subFor(s, { items: [{ handle: "enterprise" }], currentBillingCycle: null, trialEndsAt: null }) }),
    (s) => ({ activeSubscription: subFor(s, { items: [{ handle: "basic" }] }) }),
  ];
  for (const reply of bad) {
    await redue(shop);
    await verify(shop, typeof reply === "function" ? () => reply(shop) : reply);
    const row = await rowOf(shop);
    assert.deepEqual([row.plan, row.verifiedAt === null || row.plan === "BASIC"], ["BASIC", true]);
    assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC");
  }
  await R.ensurePlanRecommendation(shop.id, { now: new Date(NOW.getTime() - MIN) });
  const source = createShopifyqlSessionSource({ getAdmin: async () => ({ scope: "read_reports", admin: { graphql: async (query) => ({ json: async () => (isTimezoneQuery(query) ? shopZoneAnswer("UTC") : { data: { shopifyqlQuery: { tableData: { columns: [{ name: "sessions" }], rows: [{ sessions: "900000" }] }, parseErrors: [] } } }) }) } }), now: () => NOW });
  await R.runPlanRecommendations({ fetchSessions: source, now: () => NOW, shopIds: [shop.id], log: quiet });
  assert.equal((await prisma.planRecommendation.findUnique({ where: { shopId: shop.id } })).recommendedPlan, "ENTERPRISE");
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC", "advice is not proof of payment");
  assert.equal((await rowOf(shop)).plan, "BASIC");
});

dbTest("a trial is recorded without a made-up period: Basic entitlements until the first billing cycle, and a check at the trial's end", async () => {
  const shop = await newShop("trial");
  await dueRow(shop);
  const trialEnds = new Date(NOW.getTime() + 3 * HOUR);
  const summary = await verify(shop, () => ({ activeSubscription: subFor(shop, { currentBillingCycle: null, trialEndsAt: trialEnds.toISOString(), items: [{ handle: "advance" }] }) }));
  assert.equal(summary.trial, 1);
  let row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, row.verificationSource, row.verifiedAt.getTime(), row.currentPeriodStart, row.currentPeriodEnd, row.verificationFailures], ["ADVANCE", "ACTIVE", "app_pricing", NOW.getTime(), null, null, 0]);
  assert.equal(row.nextVerificationAt.getTime(), trialEnds.getTime(), "checked again exactly when the trial ends");
  const during = await getEntitlements(shop.id, { now: NOW });
  assert.deepEqual([during.plan.key, during.state, during.reason], ["BASIC", "fallback", "billing_period_unknown"], "no billing period yet, so no period-based quota can be granted");
  // the first cycle exists once the trial is over
  const after = new Date(trialEnds.getTime() + MIN);
  const cycleNow = { startTime: iso(trialEnds.getTime()), endTime: iso(trialEnds.getTime() + 30 * DAY) };
  await verify(shop, () => ({ activeSubscription: subFor(shop, { currentBillingCycle: cycleNow, trialEndsAt: null }) }), after);
  row = await rowOf(shop);
  assert.deepEqual([row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime()], [trialEnds.getTime(), trialEnds.getTime() + 30 * DAY]);
  assert.deepEqual([(await getEntitlements(shop.id, { now: after })).plan.key, (await getEntitlements(shop.id, { now: after })).state], ["ADVANCE", "verified"]);
  // a long trial is still rechecked within 12 hours
  const long = await newShop("trial-long");
  await dueRow(long);
  await verify(long, () => ({ activeSubscription: subFor(long, { currentBillingCycle: null, trialEndsAt: iso(NOW.getTime() + 10 * DAY) }) }));
  assert.equal((await rowOf(long)).nextVerificationAt.getTime(), NOW.getTime() + 12 * HOUR);
});

dbTest("cancellation at the end of the cycle keeps the plan until the cycle's end, which is when it is checked; then the contract is gone", async () => {
  const shop = await newShop("cancel-eoc");
  await dueRow(shop);
  const endsSoon = NOW.getTime() + 5 * HOUR;
  await verify(shop, () => ({ activeSubscription: subFor(shop, { cancelAtEndOfCycle: true, currentBillingCycle: { startTime: iso(endsSoon - 30 * DAY), endTime: iso(endsSoon) } }) }));
  let row = await rowOf(shop);
  assert.deepEqual([row.plan, row.status, (await getEntitlements(shop.id, { now: NOW })).state], ["ADVANCE", "ACTIVE", "verified"]);
  assert.equal(row.nextVerificationAt.getTime(), endsSoon, "checked exactly when the cycle ends");
  const atEnd = new Date(endsSoon + MIN);
  await verify(shop, () => ({ activeSubscription: null }), atEnd);
  assert.equal((await rowOf(shop)).status, "ACTIVE", "the first null at the cycle's end waits for its repeat");
  await verify(shop, () => ({ activeSubscription: null }), new Date(atEnd.getTime() + 6 * MIN));
  row = await rowOf(shop);
  assert.equal(row.status, "CANCELLED");
  assert.equal((await getEntitlements(shop.id, { now: atEnd })).plan.key, "BASIC");
});

dbTest("a pending plan change applies only when Shopify reports it: Advance stays Advance until the next cycle, then Enterprise starts with its own quota", async () => {
  const shop = await newShop("pending");
  await dueRow(shop);
  const nextStart = NOW.getTime() + 2 * HOUR;
  const pending = { billingPeriod: "EVERY_30_DAYS", items: [{ handle: "enterprise" }] };
  await verify(shop, () => ({ activeSubscription: subFor(shop, { pendingUpdate: pending, currentBillingCycle: { startTime: iso(nextStart - 30 * DAY), endTime: iso(nextStart) } }) }));
  assert.equal((await rowOf(shop)).plan, "ADVANCE");
  await seedEmails(shop, 700, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - DAY) });
  const later = new Date(nextStart + MIN);
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { items: [{ handle: "enterprise" }], currentBillingCycle: { startTime: iso(nextStart), endTime: iso(nextStart + 30 * DAY) } }) }), later);
  const row = await rowOf(shop);
  assert.deepEqual([row.plan, row.planHandle, row.currentPeriodStart.getTime()], ["ENTERPRISE", "enterprise", nextStart]);
  const fresh = await usage(shop, later);
  assert.deepEqual([fresh.quota, fresh.used], [3000, 0], "Advance emails are not Enterprise usage");
});

dbTest("an ended billing period is Basic until Shopify reports a new one, and the new cycle starts its own quota", async () => {
  const shop = await newShop("renewal");
  const oldEnd = new Date(NOW.getTime() - HOUR);
  await paidRow(shop, { verifiedAt: new Date(NOW.getTime() - 2 * HOUR), currentPeriodStart: new Date(oldEnd.getTime() - 30 * DAY), currentPeriodEnd: oldEnd, nextVerificationAt: oldEnd });
  await seedEmails(shop, 1500, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - 10 * DAY) });
  assert.equal((await getEntitlements(shop.id, { now: NOW })).reason, "billing_period_ended");
  await verify(shop, () => ({ activeSubscription: subFor(shop, { currentBillingCycle: { startTime: iso(oldEnd.getTime() - 30 * DAY), endTime: iso(oldEnd.getTime()) } }) })); // Shopify has not moved on yet
  assert.equal((await rowOf(shop)).currentPeriodEnd.getTime(), oldEnd.getTime(), "an ended cycle never replaces the stored one");
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC");
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { currentBillingCycle: { startTime: iso(oldEnd.getTime()), endTime: iso(oldEnd.getTime() + 30 * DAY) } }) }));
  const renewed = await usage(shop);
  assert.deepEqual([(await getEntitlements(shop.id, { now: NOW })).plan.key, renewed.used, renewed.remaining], ["ADVANCE", 0, 1500], "the old cycle's emails are outside the new cycle");
});

dbTest("a successful verification wakes parked mail: claimed under the verified plan, and an UNKNOWN delivery is never touched or resent", async () => {
  const shop = await newShop("wake");
  await paidRow(shop, { verifiedAt: new Date(NOW.getTime() - 30 * HOUR) }); // stale: Basic until verified again
  await seedEmails(shop, 50, { planAtSend: "BASIC", sentAt: new Date(NOW.getTime() - 100 * DAY) });
  const [pendingId] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() - MIN) });
  const [unknownId] = await seedEmails(shop, 1, { status: "UNKNOWN", planAtSend: "BASIC", reservedAt: new Date(NOW.getTime() - 3 * DAY), outbound: true });
  assert.equal(await claimNext({ now: NOW, shopIds: [shop.id], enforce: true }), null);
  assert.equal((await delivery(pendingId)).errorCode, QUOTA_BLOCKED);
  await verify(shop, () => ({ activeSubscription: subFor(shop) })); // the SAME plan and period
  const job = await claimNext({ now: NOW, shopIds: [shop.id], enforce: true });
  assert.deepEqual([job.id, job.planAtSend], [pendingId, "ADVANCE"]);
  assert.equal((await delivery(unknownId)).status, "UNKNOWN");
  assert.equal(await claimNext({ now: NOW, shopIds: [shop.id], enforce: true }), null, "the UNKNOWN row is never a candidate");
});

dbTest("M4: Advance -> Enterprise in the same cycle, then a downgrade and a re-upgrade: every plan keeps its own count", async () => {
  const shop = await newShop("m4");
  await dueRow(shop);
  await seedEmails(shop, 3, { planAtSend: "BASIC", sentAt: new Date(NOW.getTime() - 40 * DAY) });
  await verify(shop, () => ({ activeSubscription: subFor(shop, { items: [{ handle: "advance" }] }) }));
  await seedEmails(shop, 1400, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - DAY) });
  const advance = await usage(shop);
  assert.deepEqual([advance.quota, advance.used, advance.remaining], [1500, 1400, 100]);

  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { items: [{ handle: "enterprise" }] }) })); // same cycle
  assert.equal((await rowOf(shop)).plan, "ENTERPRISE");
  const enterprise = await usage(shop);
  assert.deepEqual([enterprise.quota, enterprise.used, enterprise.sent, enterprise.reserved, enterprise.remaining], [3000, 0, 0, 0, 3000], "the 1,400 Advance emails are not Enterprise usage");
  const [pendingId] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() - MIN) });
  const job = await claimNext({ now: NOW, shopIds: [shop.id], enforce: true });
  assert.deepEqual([job.id, job.planAtSend], [pendingId, "ENTERPRISE"]);
  assert.equal((await usage(shop)).used, 1);
  assert.equal(await prisma.emailDelivery.count({ where: { shopId: shop.id, planAtSend: "ADVANCE" } }), 1400);

  await redue(shop);
  await verify(shop, () => ({ activeSubscription: null }));
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: null })); // the repeat
  assert.equal((await rowOf(shop)).status, "CANCELLED");
  const basic = await usage(shop);
  assert.deepEqual([basic.quota, basic.used], [50, 3], "Basic lifetime usage: only the Basic-era emails");

  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { items: [{ handle: "advance" }] }) }));
  const again = await usage(shop);
  assert.deepEqual([again.quota, again.sent, again.reserved, again.used], [1500, 1400, 0, 1400], "the Advance emails sent earlier in the same cycle count again; the Enterprise reservation does not");
});

dbTest("lease recovery: an expired claim is taken over, and the slow first worker's late answer cannot overwrite the new one", async () => {
  const shop = await newShop("lease");
  await paidRow(shop, { verifiedAt: new Date("2020-01-01"), nextVerificationAt: new Date("2020-01-01") });
  const real = () => new Date();
  const slow = V.runSubscriptionVerification({ verify: partnerFor(shop, () => ({ activeSubscription: null }), { delay: 350 }), now: real, leaseMs: 80, timeoutMs: 3000, shopIds: [shop.id], log: quiet });
  await sleep(180); // worker A's lease has run out while it is still waiting for its answer
  const takeover = await V.runSubscriptionVerification({ verify: partnerFor(shop, () => ({ activeSubscription: subFor(shop, { currentBillingCycle: { startTime: iso(Date.now() - 5 * DAY), endTime: iso(Date.now() + 25 * DAY) } }) })), now: real, shopIds: [shop.id], log: quiet });
  assert.equal(takeover.active, 1, "worker B took the row over");
  const first = await slow;
  assert.equal(first.stale, 1, "worker A's late cancellation found it no longer held the row");
  const row = await rowOf(shop);
  assert.deepEqual([row.status, row.plan, row.verificationFailures, row.verificationLeaseExpiresAt], ["ACTIVE", "ADVANCE", 0, null]);
  const claims = await Promise.all([V.claimDueVerification({ now: new Date(), shopIds: [shop.id] }), V.claimDueVerification({ now: new Date(), shopIds: [shop.id] })]);
  assert.ok(claims.filter(Boolean).length <= 1, "never two claims of one row");
});

dbTest("transient failures back off with a bound and never cancel; a successful check afterwards clears the retry state", async () => {
  const shop = await newShop("backoff");
  await paidRow(shop);
  const delays = [];
  let at = NOW;
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { nextVerificationAt: at, verificationLeaseExpiresAt: null } });
    await verify(shop, { status: 503 }, at);
    const row = await rowOf(shop);
    delays.push((row.nextVerificationAt.getTime() - at.getTime()) / MIN);
    assert.deepEqual([row.status, row.plan, row.verificationFailures], ["ACTIVE", "ADVANCE", attempt]);
    at = row.nextVerificationAt;
  }
  assert.deepEqual(delays, [1, 2, 4, 8, 16, 32, 64, 120, 120], "1, 2, 4 ... minutes, capped at 2 hours");
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop) }));
  const row = await rowOf(shop);
  assert.deepEqual([row.verificationFailures, row.lastVerificationError, row.status], [0, null, "ACTIVE"]);
});

dbTest("REGRESSION: a wrong app id can never cancel anyone, however often it is verified", async () => {
  const shops = [];
  for (const [tag, plan] of [["wrong-a", "ADVANCE"], ["wrong-b", "ENTERPRISE"], ["wrong-c", "ADVANCE"]]) {
    const shop = await newShop(tag);
    await paidRow(shop, { plan });
    shops.push(shop);
  }
  const NULL = () => ({ activeSubscription: null }); // what Shopify answers for an app id that has no subscribers
  const other = { body: { data: { app: { id: "gid://partners/App/999", apiKey: "another-apps-key" } } } };
  const scenarios = [
    ["another real app", { identity: other, appGid: "gid://shopify/App/999" }, "config_app_identity_mismatch"],
    ["the right id, a wrong API key configured", { apiKey: "wrong-key" }, "config_app_identity_mismatch"],
    ["an id that does not exist", { identity: { body: { data: { app: null } } }, appGid: "gid://shopify/App/123456" }, "config_app_identity_not_found"],
    ["the identity query is refused", { identity: { status: 403 }, appGid: "gid://shopify/App/999" }, "permission_identity_http_403"],
    ["the identity endpoint is not found", { identity: { status: 404 } , appGid: "gid://shopify/App/999" }, "config_identity_endpoint_not_found"],
    ["the identity query fails", { identity: { status: 500 }, appGid: "gid://shopify/App/999" }, "transient_identity_http_500".replace("transient_", "")],
  ];
  for (const [tag, options, code] of scenarios) {
    for (const shop of shops) {
      const before = await rowOf(shop);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await redue(shop);
        await verify(shop, NULL, NOW, { partner: options });
        const row = await rowOf(shop);
        assert.deepEqual([row.status, row.plan, row.verifiedAt.getTime(), row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime()], ["ACTIVE", before.plan, before.verifiedAt.getTime(), before.currentPeriodStart.getTime(), before.currentPeriodEnd.getTime()], `${tag} #${attempt}: no state change`);
        assert.equal(row.lastVerificationError, code, `${tag}: recorded as a configuration/identity failure, not as 'no contract'`);
        assert.notEqual(row.lastVerificationError, "no_contract_unconfirmed");
      }
      assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, before.plan, `${tag}: still entitled`);
    }
  }
  // the same wrong id answering with a subscription of ANOTHER app is rejected too
  const shop = shops[0];
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { app: { id: "gid://shopify/App/999", apiKey: "another-apps-key" } }) }));
  assert.equal((await rowOf(shop)).lastVerificationError, "config_app_mismatch");
  assert.equal((await rowOf(shop)).status, "ACTIVE");
  // and once the configuration is right, the same shops verify normally
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop) }));
  assert.deepEqual([(await rowOf(shop)).lastVerificationError, (await rowOf(shop)).verificationFailures], [null, 0]);
});

dbTest("cancellation needs two CONSECUTIVE confirmed nulls: an answer in between starts it over, and the free plan needs no repeat", async () => {
  const make = async (tag, over = {}) => {
    const shop = await newShop(tag);
    await paidRow(shop, over);
    return shop;
  };
  const NULL = () => ({ activeSubscription: null });
  const marker = async (shop) => (await rowOf(shop)).lastVerificationError;
  // null, then a real subscription: the marker is cleared and the shop is untouched
  const back = await make("seq-back");
  await verify(back, NULL);
  assert.equal(await marker(back), "no_contract_unconfirmed");
  await redue(back);
  await verify(back, () => ({ activeSubscription: subFor(back) }));
  assert.deepEqual([await marker(back), (await rowOf(back)).status], [null, "ACTIVE"]);
  await redue(back);
  await verify(back, NULL);
  assert.equal((await rowOf(back)).status, "ACTIVE", "a fresh first null again");
  // null, an API error, null: the error replaces the marker, so the second null is a FIRST one again
  const broken = await make("seq-error");
  await verify(broken, NULL);
  await redue(broken);
  await verify(broken, { status: 500 });
  assert.equal(await marker(broken), "http_500");
  await redue(broken);
  await verify(broken, NULL);
  assert.deepEqual([(await rowOf(broken)).status, await marker(broken)], ["ACTIVE", "no_contract_unconfirmed"]);
  await redue(broken);
  await verify(broken, NULL);
  assert.equal((await rowOf(broken)).status, "CANCELLED");
  // an unconfirmable identity between two nulls also resets it
  const idless = await make("seq-identity");
  await verify(idless, NULL);
  await redue(idless);
  await verify(idless, NULL, NOW, { partner: { identity: { status: 500 } } });
  await redue(idless);
  await verify(idless, NULL);
  assert.equal((await rowOf(idless)).status, "ACTIVE");
  // the free plan is a real subscription: immediate, no repeat
  const downgraded = await make("seq-free");
  await verify(downgraded, () => ({ activeSubscription: subFor(downgraded, { items: [{ handle: "basic" }] }) }));
  const row = await rowOf(downgraded);
  assert.deepEqual([row.status, (await getEntitlements(downgraded.id, { now: NOW })).plan.key], ["CANCELLED", "BASIC"]);
  // a free Basic row that gets null changes nothing at all
  const free = await newShop("seq-basic");
  await dueRow(free);
  await verify(free, NULL);
  assert.deepEqual([(await rowOf(free)).plan, (await rowOf(free)).status], ["BASIC", "ACTIVE"]);
});

dbTest("trial start and expiry: a trial that never converts is cancelled only after two confirmed nulls, and never held paid entitlements", async () => {
  const shop = await newShop("trial-expiry");
  await dueRow(shop);
  const trialEnds = new Date(NOW.getTime() + 2 * HOUR);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { currentBillingCycle: null, trialEndsAt: trialEnds.toISOString() }) }));
  assert.equal((await rowOf(shop)).plan, "ADVANCE");
  assert.equal((await getEntitlements(shop.id, { now: NOW })).plan.key, "BASIC", "during the trial: no period, so Basic entitlements");
  const afterTrial = new Date(trialEnds.getTime() + MIN);
  assert.equal((await getEntitlements(shop.id, { now: afterTrial })).plan.key, "BASIC");
  await verify(shop, () => ({ activeSubscription: null }), afterTrial); // the merchant never converted
  assert.equal((await rowOf(shop)).status, "ACTIVE");
  await verify(shop, () => ({ activeSubscription: null }), new Date(afterTrial.getTime() + 6 * MIN));
  const row = await rowOf(shop);
  assert.equal(row.status, "CANCELLED");
  assert.equal((await getEntitlements(shop.id, { now: new Date(afterTrial.getTime() + 7 * MIN) })).plan.key, "BASIC");
});

dbTest("annual billing: the cycle is stored as reported, the email quota covers the whole cycle, and renewal starts a new one", async () => {
  const shop = await newShop("annual");
  await dueRow(shop);
  const start = NOW.getTime() - 100 * DAY;
  const end = NOW.getTime() + 265 * DAY;
  await verify(shop, () => ({ activeSubscription: subFor(shop, { billingPeriod: "ANNUAL", currentBillingCycle: { startTime: iso(start), endTime: iso(end) } }) }));
  const row = await rowOf(shop);
  assert.deepEqual([row.currentPeriodStart.getTime(), row.currentPeriodEnd.getTime(), (row.currentPeriodEnd - row.currentPeriodStart) / DAY], [start, end, 365]);
  assert.equal(row.nextVerificationAt.getTime(), NOW.getTime() + 12 * HOUR, "still rechecked every 12 hours");
  await seedEmails(shop, 5, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - 90 * DAY) }); // inside the yearly cycle
  await seedEmails(shop, 7, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - 120 * DAY) }); // before it
  assert.equal((await usage(shop)).used, 5, "the quota window is the reported cycle, not a month");
  // renewal: a new yearly cycle
  const later = new Date(end + HOUR);
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { billingPeriod: "ANNUAL", currentBillingCycle: { startTime: iso(end), endTime: iso(end + 365 * DAY) } }) }), later);
  assert.deepEqual([(await usage(shop, later)).used, (await getEntitlements(shop.id, { now: later })).plan.key], [0, "ADVANCE"]);
});

dbTest("a Partner API that never answers is cut off as a transient failure and changes nothing", async () => {
  const shop = await newShop("hung");
  await paidRow(shop);
  const before = await rowOf(shop);
  const started = Date.now();
  await verify(shop, () => ({ activeSubscription: subFor(shop) }), NOW, { partner: { delay: 1500 }, run: { timeoutMs: 60 } });
  assert.ok(Date.now() - started < 1400, "the worker did not wait for the slow answer");
  const row = await rowOf(shop);
  assert.deepEqual([row.status, row.plan, row.verifiedAt.getTime(), row.verificationFailures, row.lastVerificationError], ["ACTIVE", "ADVANCE", before.verifiedAt.getTime(), 1, "timeout"]);
  await sleep(1600); // the abandoned call finishes in the background and writes nothing
  assert.equal((await rowOf(shop)).verificationFailures, 1);
});

dbTest("the trial end and 'cancels at the end of the cycle' are stored from what Shopify reported, for the Plan page, and cleared when they no longer apply", async () => {
  const shop = await newShop("details");
  await dueRow(shop);
  const trialEnds = new Date(NOW.getTime() + 3 * DAY);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { currentBillingCycle: null, trialEndsAt: trialEnds.toISOString(), cancelAtEndOfCycle: false }) }));
  let row = await rowOf(shop);
  assert.deepEqual([row.trialEndsAt.getTime(), row.cancelAtPeriodEnd], [trialEnds.getTime(), false]);
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { cancelAtEndOfCycle: true }) })); // a billing cycle now exists, and the merchant asked to cancel
  row = await rowOf(shop);
  assert.deepEqual([row.trialEndsAt, row.cancelAtPeriodEnd, row.status], [null, true, "ACTIVE"]);
  await redue(shop);
  await verify(shop, { status: 500 }); // a failure changes neither
  row = await rowOf(shop);
  assert.deepEqual([row.trialEndsAt, row.cancelAtPeriodEnd], [null, true]);
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: subFor(shop, { cancelAtEndOfCycle: false }) }));
  assert.equal((await rowOf(shop)).cancelAtPeriodEnd, false, "the merchant changed their mind");
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: null }));
  await redue(shop);
  await verify(shop, () => ({ activeSubscription: null }));
  row = await rowOf(shop);
  assert.deepEqual([row.status, row.trialEndsAt, row.cancelAtPeriodEnd], ["CANCELLED", null, null], "no stale 'cancels at the end' note on a cancelled row");
});

dbTest("when the Partner API verifier and the analytics source both fail, the billing step returns normally and the emails still flow", async () => {
  const shop = await newShop("worker");
  await dueRow(shop);
  await R.ensurePlanRecommendation(shop.id, { now: new Date(NOW.getTime() - MIN) });
  const [emailId] = await seedEmails(shop, 1, { status: "PENDING", nextAttemptAt: new Date(NOW.getTime() - MIN) });
  const services = {
    verify: partnerFor(shop, { status: 503 }),
    fetchSessions: createShopifyqlSessionSource({ getAdmin: async () => ({ scope: "read_reports", admin: { graphql: async () => { throw Object.assign(new Error("x"), { response: { code: 500 } }); } } }), now: () => NOW }),
  };
  const result = await runBillingJobs({ services, shopIds: [shop.id], log: quiet });
  assert.equal(result.verification.failed, 1, "the failure is recorded, not thrown");
  assert.equal(result.recommendations.failed, 1);
  const job = await claimNext({ now: NOW, shopIds: [shop.id], enforce: true });
  assert.equal(job.id, emailId, "email processing is unaffected");
  const throwing = await runBillingJobs({ services: { verify: async () => { throw new Error("verifier exploded"); }, fetchSessions: async () => { throw new Error("source exploded"); } }, shopIds: [shop.id], log: quiet });
  assert.ok(throwing.verification && throwing.recommendations, "a throwing service is isolated too");
  assert.equal((await rowOf(shop)).plan, "BASIC", "no failure granted or removed anything");
});
