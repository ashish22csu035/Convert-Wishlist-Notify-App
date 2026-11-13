// Tests for the merchant's Pricing page (/app/plan: three plans, the session-based recommendation, plan and usage): the view model (app/models/plan-usage.server.js), the page body
// (app/components/plan-usage.jsx), the route wiring (app/routes/app.plan.jsx, app.manage-plan.jsx, the navigation entry) and the safe
// construction of the "Manage plan" redirect.
//
// Run: node --test tests/plan-usage.test.mjs
//
// NOTHING here calls Shopify, the Partner API or any billing service, and no subscription is created, approved or cancelled. The pure tests and
// the rendering tests run anywhere. The database tests WRITE rows, so they only run when DATABASE_URL (set in the environment) names an isolated
// kw_*test* database with the migrations applied; otherwise they are skipped and say so.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const { build } = require("esbuild");

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

const { PLANS } = await import("../app/models/plans.server.js");
const { resolveEntitlements } = await import("../app/models/entitlements.server.js");
const U = await import("../app/models/plan-usage.server.js");

const NOW = new Date("2026-11-12T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const RUN = Date.now().toString(36);

// ======================= the Manage plan redirect: safe construction =======================
// The template below is a FIXTURE of the shape the operator supplies from Shopify's guide; the code never contains one.
const TEMPLATE = "https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/pricing_plans";

test("the Manage plan address is built only from the verified shop, a valid app handle and the operator's template", () => {
  const build = (over = {}) => U.buildManagePlanUrl({ template: TEMPLATE, appHandle: "my-app", shopDomain: "cool-shop.myshopify.com", ...over });
  assert.equal(build(), "https://admin.shopify.com/store/cool-shop/charges/my-app/pricing_plans");
  assert.equal(build({ shopDomain: "Cool-Shop.MyShopify.com" }), "https://admin.shopify.com/store/cool-shop/charges/my-app/pricing_plans", "the domain is normalised");
  assert.equal(build({ template: "https://{store_handle}.myshopify.com/admin/charges/{app_handle}/pricing_plans" }), "https://cool-shop.myshopify.com/admin/charges/my-app/pricing_plans", "the shop's own domain is allowed");
  // the pieces
  for (const shopDomain of ["", undefined, "evil.com", "cool-shop.myshopify.com.evil.com", "cool shop.myshopify.com", "https://cool-shop.myshopify.com", "cool-shop.myshopify.com/x", "-x.myshopify.com", "a@b.myshopify.com"]) assert.equal(build({ shopDomain }), null, String(shopDomain));
  for (const appHandle of ["", undefined, "my app", "my/app", "../app", "my-app/../x", "app?x=1", "app#x", "a.b", "-app", "x".repeat(65), "ap\np"]) assert.equal(build({ appHandle }), null, JSON.stringify(appHandle));
  // the template
  for (const template of ["", undefined, "http://admin.shopify.com/store/{store_handle}/charges/{app_handle}", "https://example.com/store/{store_handle}/charges/{app_handle}", "https://admin.shopify.com.evil.example/{store_handle}/{app_handle}", "https://user:pw@admin.shopify.com/{store_handle}/{app_handle}", "https://admin.shopify.com:8443/{store_handle}/{app_handle}", "https://admin.shopify.com/store/{store_handle}", "https://admin.shopify.com/{app_handle}", "https://admin.shopify.com/{store_handle}/{store_handle}/{app_handle}", "https://other-shop.myshopify.com/admin/{store_handle}/{app_handle}", "https://{store_handle}.evil.example/{app_handle}", "javascript:alert(1)//{store_handle}/{app_handle}"]) {
    assert.equal(build({ template }), null, String(template));
  }
  assert.doesNotMatch(U.buildManagePlanUrl.toString(), /https:\/\/admin/, "no destination is written in the code");
});

test("Manage plan is available only when BOTH operator settings are present and safe; the check names settings and never echoes a value", () => {
  const ok = { SHOPIFY_APP_HANDLE: "my-app", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: TEMPLATE };
  assert.deepEqual(U.readManagePlanConfig(ok), { available: true, missing: [], invalid: [] });
  assert.deepEqual(U.readManagePlanConfig({}), { available: false, missing: ["SHOPIFY_APP_HANDLE", "SHOPIFY_PLAN_SELECTION_URL_TEMPLATE"], invalid: [] });
  assert.deepEqual(U.readManagePlanConfig({ ...ok, SHOPIFY_APP_HANDLE: "" }).missing, ["SHOPIFY_APP_HANDLE"]);
  assert.deepEqual(U.readManagePlanConfig({ ...ok, SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: "" }).missing, ["SHOPIFY_PLAN_SELECTION_URL_TEMPLATE"]);
  const bad = U.readManagePlanConfig({ SHOPIFY_APP_HANDLE: "not a handle", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: "http://evil.example/{store_handle}/{app_handle}" });
  assert.deepEqual([bad.available, bad.invalid], [false, ["SHOPIFY_APP_HANDLE", "SHOPIFY_PLAN_SELECTION_URL_TEMPLATE"]]);
  assert.ok(!JSON.stringify(bad).includes("evil.example") && !JSON.stringify(bad).includes("not a handle"));
  assert.equal(U.readManagePlanConfig().available, false, "the real environment of this test run enables nothing");
});

test("the Manage plan route takes nothing from the request and redirects top-level; the page links to it only when it is available", () => {
  const route = fs.readFileSync("app/routes/app.manage-plan.jsx", "utf8").replace(/\/\/.*$/gm, "");
  assert.match(route, /session\.shop/, "the shop comes from the verified session");
  assert.match(route, /target: "_top"/, "Shopify's page is outside the iframe: a top-level redirect");
  assert.doesNotMatch(route, /request\.url|searchParams|formData|headers\.get|params\b/, "no request value can choose the destination");
  assert.doesNotMatch(route, /https?:\/\//, "no address is written in the route");
  assert.match(route, /redirect\("\/app\/plan"\)/, "without safe configuration the merchant simply returns to the page");
  const nav = fs.readFileSync("app/routes/app.jsx", "utf8");
  assert.equal((nav.match(/href="\/app\/plan"/g) ?? []).length, 1, "exactly one new navigation entry");
  assert.ok(nav.indexOf('href="/app/analytics"') < nav.indexOf('href="/app/plan"') && nav.indexOf('href="/app/plan"') < nav.indexOf('href="/app/settings"'));
  const page = fs.readFileSync("app/routes/app.plan.jsx", "utf8");
  assert.match(page, /loadMerchantContext/, "the shop is the verified session's");
  assert.match(page, /ErrorBoundary/);
});

// ======================= the view model =======================
const row = (over = {}) => ({
  plan: "ADVANCE",
  status: "ACTIVE",
  verificationSource: "app_pricing",
  verifiedAt: new Date(NOW.getTime() - HOUR),
  currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
  currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
  trialEndsAt: null,
  cancelAtPeriodEnd: null,
  verificationFailures: 0,
  nextVerificationAt: new Date(NOW.getTime() + 12 * HOUR),
  ...over,
});
const email = (quota, used, over = {}) => ({ quota, used, sent: used, reserved: 0, remaining: Math.max(0, quota - used), exceeded: used >= quota, period: "lifetime", ...over });
const wl = (limit, used) => ({ limit, used, remaining: Math.max(0, limit - used), overLimit: used > limit, canAdd: used < limit });
const viewOf = (subscription, over = {}) => {
  const entitlements = over.entitlements ?? resolveEntitlements(subscription, NOW);
  const plan = entitlements.plan;
  return U.buildPlanUsageView({
    entitlements,
    subscription,
    email: "email" in over ? over.email : email(plan.restockEmails.quota, 7, entitlements.billingPeriod ? { period: entitlements.billingPeriod } : {}),
    wishlist: "wishlist" in over ? over.wishlist : wl(plan.wishlistItems, 12),
    manageAvailable: over.manageAvailable ?? false,
    enforced: over.enforced ?? false,
    recommendation: over.recommendation,
    priceLabels: over.priceLabels,
    now: NOW,
  });
};

test("Basic, Advance and Enterprise are shown with their own limits, and only a verified paid plan is shown as paid", () => {
  const free = viewOf(row({ plan: "BASIC", verifiedAt: null, verificationSource: null, currentPeriodStart: null, currentPeriodEnd: null }));
  assert.deepEqual([free.status, free.plan, free.warning], ["free", { key: "BASIC", label: "Basic", verifiedPaid: false }, null]);
  assert.deepEqual([free.email.quota, free.email.scope, free.email.resetsAt, free.wishlist.limit], [50, "lifetime", null, 50], "Basic's allowance has no reset date");
  const none = viewOf(null);
  assert.deepEqual([none.status, none.plan.key, none.warning], ["free", "BASIC", null], "no subscription record at all is the free plan, not a warning");

  for (const [plan, quota, limit] of [["ADVANCE", 1500, 2500], ["ENTERPRISE", 3000, 5000]]) {
    const view = viewOf(row({ plan }));
    assert.deepEqual([view.status, view.plan, view.warning], ["verified", { key: plan, label: PLANS[plan].label, verifiedPaid: true }, null]);
    assert.deepEqual([view.email.quota, view.email.scope, view.email.resetsAt, view.wishlist.limit], [quota, "billing_period", iso(NOW.getTime() + 20 * DAY), limit], "the reset date is the verified period's end");
    assert.deepEqual(view.period, { start: iso(NOW.getTime() - 10 * DAY), end: iso(NOW.getTime() + 20 * DAY) });
    assert.equal(view.verification.lastVerifiedAt, iso(NOW.getTime() - HOUR));
    assert.equal(view.verification.checkingAgainAt, null, "no retry is shown when nothing failed");
  }
});

test("a paid plan is never shown unless it is verified: every unverifiable state shows Basic with the right explanation", () => {
  const cases = [
    ["stale", row({ verifiedAt: new Date(NOW.getTime() - 30 * HOUR) }), "temporary"],
    ["never verified", row({ verifiedAt: null, verificationSource: null }), "temporary"],
    ["period ended", row({ currentPeriodEnd: new Date(NOW.getTime() - HOUR) }), "temporary"],
    ["no period", row({ currentPeriodStart: null, currentPeriodEnd: null }), "temporary"],
    ["unknown plan", row({ plan: "GOLD" }), "temporary"],
    ["cancelled", row({ status: "CANCELLED" }), "inactive"],
    ["frozen", row({ status: "FROZEN" }), "inactive"],
    ["expired", row({ status: "EXPIRED" }), "inactive"],
    ["pending", row({ status: "PENDING" }), "pending"],
  ];
  for (const [tag, subscription, status] of cases) {
    const view = viewOf(subscription);
    assert.deepEqual([view.status, view.plan.key, view.plan.verifiedPaid], [status, "BASIC", false], tag);
    assert.ok(view.warning, tag);
    assert.equal(view.email.quota, 50, `${tag}: Basic's quota, not the paid plan's`);
  }
});

test("a temporary verification problem is never described as a cancellation", () => {
  for (const subscription of [row({ verifiedAt: new Date(NOW.getTime() - 30 * HOUR), verificationFailures: 3, nextVerificationAt: new Date(NOW.getTime() + 8 * MIN) }), row({ currentPeriodStart: null, currentPeriodEnd: null })]) {
    const view = viewOf(subscription);
    assert.equal(view.status, "temporary");
    assert.equal(view.warning.tone, "warning");
    assert.match(view.warning.title, /couldn't confirm/i);
    assert.match(view.warning.message, /not a cancellation/i);
    assert.match(view.warning.message, /nothing has been deleted/i);
    assert.doesNotMatch(`${view.warning.title} ${view.status}`, /cancelled|no longer active|inactive/i);
  }
  const retrying = viewOf(row({ verifiedAt: new Date(NOW.getTime() - 30 * HOUR), verificationFailures: 2, nextVerificationAt: new Date(NOW.getTime() + 4 * MIN) }));
  assert.deepEqual([retrying.lastConfirmedPlan, retrying.verification.lastVerifiedAt, retrying.verification.checkingAgainAt], ["Advance", iso(NOW.getTime() - 30 * HOUR), iso(NOW.getTime() + 4 * MIN)], "what was last confirmed, and when it will be checked again");
  const real = viewOf(row({ status: "CANCELLED" }));
  assert.match(real.warning.title, /no longer active/i, "a confirmed cancellation is the one thing described that way");
  assert.match(real.warning.message, /kept/i);
});

test("a trial and a cancellation at the end of the cycle are shown from what Shopify reported, and a missing date is never invented", () => {
  const trialEnds = new Date(NOW.getTime() + 5 * DAY);
  const trial = viewOf(row({ currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: trialEnds }));
  assert.deepEqual([trial.status, trial.plan.key, trial.trial], ["trial", "BASIC", { planLabel: "Advance", endsAt: iso(trialEnds.getTime()) }]);
  assert.equal(trial.warning.tone, "info");
  assert.match(trial.warning.title, /free trial of Advance/);
  assert.deepEqual([trial.period, trial.email.resetsAt, trial.email.scope], [null, null, "lifetime"], "no billing period yet: no period and no reset date");
  const ended = viewOf(row({ currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: new Date(NOW.getTime() - HOUR) }));
  assert.equal(ended.status, "temporary", "a trial whose end has passed with no billing period yet is not shown as a running trial");
  const staleTrial = viewOf(row({ currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: trialEnds, verifiedAt: new Date(NOW.getTime() - 30 * HOUR) }));
  assert.equal(staleTrial.status, "temporary");

  const cancelling = viewOf(row({ cancelAtPeriodEnd: true }));
  assert.deepEqual([cancelling.status, cancelling.plan.key, cancelling.cancellation], ["verified", "ADVANCE", { effectiveAt: iso(NOW.getTime() + 20 * DAY) }], "still on the paid plan until the period ends");
  assert.equal(viewOf(row({ cancelAtPeriodEnd: false })).cancellation, null);
  assert.equal(viewOf(row({ cancelAtPeriodEnd: null })).cancellation, null, "not known is not shown");
});

test("figures that could not be read are unavailable, never zero, and nothing is shown when the plan itself cannot be read", () => {
  const noEmail = viewOf(row(), { email: null });
  assert.deepEqual([noEmail.email, noEmail.wishlist.used], [null, 12]);
  const noWishlist = viewOf(row(), { wishlist: null });
  assert.deepEqual([noWishlist.wishlist, noWishlist.email.used], [null, 7]);
  const failed = U.buildPlanUsageView({ entitlements: { ...resolveEntitlements(null, NOW), lookupFailed: true, reason: "lookup_failed" }, now: NOW });
  assert.deepEqual([failed.status, failed.plan, failed.email, failed.wishlist, failed.warning.tone], ["unavailable", null, null, null, "warning"]);
  assert.match(failed.warning.message, /nothing about your plan has changed/i);
  assert.doesNotMatch(`${failed.warning.title} ${failed.warning.message}`, /cancel/i);
  assert.equal(U.buildPlanUsageView({ entitlements: null, now: NOW }).status, "unavailable");
  const over = viewOf(row({ plan: "BASIC", verifiedAt: null, verificationSource: null, currentPeriodStart: null, currentPeriodEnd: null }), { wishlist: wl(50, 80) });
  assert.deepEqual([over.wishlist.overLimit, over.wishlist.used, over.wishlist.limit], [true, 80, 50], "over the limit is shown as it is: nothing is hidden or trimmed");
});

test("the view carries whether limits are enforced and whether Manage plan is available, and is plain JSON", () => {
  assert.deepEqual([viewOf(row()).limitsEnforced, viewOf(row()).manage.available], [false, false]);
  assert.deepEqual([viewOf(row(), { enforced: true, manageAvailable: true }).limitsEnforced, viewOf(row(), { enforced: true, manageAvailable: true }).manage.available], [true, true]);
  const view = viewOf(row({ cancelAtPeriodEnd: true }), { manageAvailable: true });
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view, "survives serialisation unchanged: dates are ISO strings");
});

// ======================= the page body =======================
const OUT_DIR = path.resolve("node_modules/.cache/kw-plan-usage-test");
let PlanUsage;
let renderToStaticMarkup;
let React;
before(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `plan-usage-${Date.now().toString(36)}.mjs`);
  await build({
    entryPoints: ["app/components/plan-usage.jsx"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    external: ["react", "react/jsx-runtime", "react-dom", "react-router"],
    alias: { "@shopify/shopify-app-react-router/server": path.resolve("tests/helpers/shopify-server-stub.mjs") },
    logLevel: "silent",
  });
  ({ PlanUsage } = await import(pathToFileURL(outfile).href));
  React = (await import("react")).default;
  ({ renderToStaticMarkup } = await import("react-dom/server"));
});
after(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
});
const html = (view) => renderToStaticMarkup(React.createElement(PlanUsage, { view }));
const dec = (markup) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const text = (markup) => dec(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

test("the page shows the plan, the plan-specific email usage with its reset date, and the shop-wide wishlist usage", () => {
  const advance = text(html(viewOf(row(), { email: email(1500, 1400, { period: {} }), wishlist: wl(2500, 1200) })));
  assert.match(advance, /Advance Current plan/);
  assert.match(advance, /1,400 of 1,500/);
  assert.match(advance, /Resets 2026-12-02 12:00 UTC/, "the verified period's end");
  assert.match(advance, /1,200 of 2,500/);
  assert.match(advance, /Billing period 2026-11-02 12:00 UTC to 2026-12-02 12:00 UTC/);
  assert.match(advance, /Last confirmed with Shopify 2026-11-12 11:00 UTC/);
  const enterprise = text(html(viewOf(row({ plan: "ENTERPRISE" }), { email: email(3000, 5), wishlist: wl(5000, 0) })));
  assert.match(enterprise, /Enterprise/);
  assert.match(enterprise, /5 of 3,000/);
  assert.match(enterprise, /0 of 5,000/);
  const basic = text(html(viewOf(null)));
  assert.match(basic, /Basic Current plan/);
  assert.match(basic, /Basic's allowance does not reset on a schedule/);
  assert.doesNotMatch(basic, /Resets 20/);
  assert.match(basic, /Not confirmed yet/);
  assert.match(basic, /not being enforced yet/, "limits are shown for information while enforcement is off");
  assert.doesNotMatch(text(html(viewOf(row(), { enforced: true }))), /not being enforced yet/);
});

test("the page shows trials, pending cancellation and temporary problems in plain words, and never a zero for unknown figures", () => {
  const trial = html(viewOf(row({ currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: new Date(NOW.getTime() + 5 * DAY) })));
  assert.match(dec(trial), /heading="You're on a free trial of Advance"/, "the banner heading");
  assert.match(text(trial), /Advance trial ends 2026-11-17 12:00 UTC/);
  assert.match(trial, /tone="info"/);
  assert.doesNotMatch(text(trial), /Billing period 20/, "no invented billing period");
  const cancelling = text(html(viewOf(row({ cancelAtPeriodEnd: true }))));
  assert.match(cancelling, /Will cancel at the end of the billing period, 2026-12-02 12:00 UTC/);
  assert.match(cancelling, /Advance Current plan/);
  const temporary = html(viewOf(row({ verifiedAt: new Date(NOW.getTime() - 30 * HOUR), verificationFailures: 1, nextVerificationAt: new Date(NOW.getTime() + 6 * MIN) })));
  assert.match(temporary, /tone="warning"/);
  assert.match(dec(temporary), /heading="We couldn't confirm your subscription right now"/);
  assert.match(text(temporary), /not a cancellation/);
  assert.match(text(temporary), /Last confirmed plan Advance/);
  assert.match(text(temporary), /Checking again Around 2026-11-12 12:06 UTC/);
  assert.match(text(temporary), /Basic Current plan/, "never the unverified paid plan");
  assert.doesNotMatch(text(temporary), /cancelled/i);
  const unknown = text(html(viewOf(row(), { email: null, wishlist: null })));
  assert.match(unknown, /Unavailable Restock emails/);
  assert.match(unknown, /Unavailable Wishlist items/);
  assert.doesNotMatch(unknown, /\b0 of /);
  const failed = html(U.buildPlanUsageView({ entitlements: { ...resolveEntitlements(null, NOW), lookupFailed: true }, now: NOW }));
  assert.match(dec(failed), /heading="Plan details are temporarily unavailable"/);
  assert.match(text(failed), /Unavailable Current plan/);
});

test("Manage plan is a link only when it is available, and otherwise says so without any address", () => {
  const on = html(viewOf(row(), { manageAvailable: true }));
  assert.match(on, /<s-button[^>]*href="\/app\/manage-plan"/);
  assert.doesNotMatch(on, /manage-plan-unavailable/);
  const off = html(viewOf(row(), { manageAvailable: false }));
  assert.doesNotMatch(off, /href="\/app\/manage-plan"/);
  assert.match(off, /manage-plan-unavailable/);
  assert.match(text(off), /not available yet/);
  assert.ok(!/https?:\/\//.test(on.replace(/tone="[^"]*"/g, "")), "no external address is rendered");
});


// ======================= the Pricing page: plans, recommendation, navigation =======================
const { PLAN_KEYS, RECOMMENDATION_SESSION_THRESHOLD, recommendedPlanForSessions } = await import("../app/models/plans.server.js");

const reco = (over = {}) => ({
  status: "SUCCEEDED",
  sessions30d: 24500,
  periodStart: new Date("2026-10-12T00:00:00.000Z"),
  periodEnd: new Date("2026-11-11T00:00:00.000Z"),
  fetchedAt: new Date(NOW.getTime() - 2 * HOUR),
  recommendedPlan: "ADVANCE",
  ...over,
});
const recoView = (row, options = {}) => U.buildRecommendationView(row, { now: NOW, ...options });
const noPlan = row({ plan: "BASIC", verifiedAt: null, verificationSource: null, currentPeriodStart: null, currentPeriodEnd: null });
const cardOf = (markup, key) => new RegExp(`<section[^>]*data-plan="${key}"[^>]*>.*?</section>`, "s").exec(markup)?.[0] ?? "";

test("the sidebar says Pricing and opens the existing /app/plan page; there is one entry and one route, no duplicate", () => {
  const nav = fs.readFileSync("app/routes/app.jsx", "utf8");
  assert.match(nav, /<s-link href="\/app\/plan">Pricing<\/s-link>/);
  assert.equal((nav.match(/href="\/app\/plan"/g) ?? []).length, 1);
  assert.doesNotMatch(nav, />Plan<\/s-link>/, "the old label is gone");
  assert.deepEqual([...nav.matchAll(/<s-link href="([^"]+)">([^<]+)<\/s-link>/g)].map((m) => [m[1], m[2]]), [
    ["/app", "Dashboard"], ["/app/wishlist", "Wishlist"], ["/app/notify-me", "Notify Me"], ["/app/customers", "Engaged customers"], ["/app/analytics", "Analytics"], ["/app/plan", "Pricing"], ["/app/settings", "Settings"],
  ], "every other entry and route is unchanged");
  assert.ok(fs.existsSync("app/routes/app.plan.jsx"), "the page keeps its route");
  assert.deepEqual(fs.readdirSync("app/routes").filter((name) => /pricing|app\.plans?[.-]/i.test(name)), ["app.plan.jsx"], "no second pricing route");
  const page = fs.readFileSync("app/routes/app.plan.jsx", "utf8");
  assert.match(page, /<Page title="Pricing"/);
  assert.match(page, /PlanUsage/);
});

test("all three plans are shown, in order, with the limits from the plan definitions", () => {
  const view = viewOf(null);
  assert.deepEqual(view.plans.map((card) => card.key), ["BASIC", "ADVANCE", "ENTERPRISE"]);
  assert.deepEqual(
    view.plans.map((card) => [card.label, card.paid, card.wishlistItems, card.restockEmails.quota, card.restockEmails.period, card.analyticsHistoryDays]),
    [["Basic", false, 50, 50, "lifetime", 7], ["Advance", true, 2500, 1500, "billing_period", 30], ["Enterprise", true, 5000, 3000, "billing_period", 90]],
  );
  for (const card of view.plans) {
    const plan = PLANS[card.key];
    assert.deepEqual([card.wishlistItems, card.restockEmails.quota, card.restockEmails.period, card.analyticsHistoryDays], [plan.wishlistItems, plan.restockEmails.quota, plan.restockEmails.period, plan.analyticsHistoryDays], `${card.key} comes from plans.server.js`);
  }
  const markup = html(viewOf(null));
  assert.equal((markup.match(/data-plan="/g) ?? []).length, 3);
  const basic = text(cardOf(markup, "BASIC"));
  assert.match(basic, /Basic/);
  assert.match(basic, /Free/);
  assert.match(basic, /Up to 50 active wishlist items across your whole store/);
  assert.match(basic, /50 restock emails in total while you use Basic/);
  assert.match(basic, /7 days of analytics/);
  const advance = text(cardOf(markup, "ADVANCE"));
  assert.match(advance, /Up to 2,500 active wishlist items across your whole store/);
  assert.match(advance, /1,500 restock emails per billing period/);
  assert.match(advance, /30 days of analytics/);
  const enterprise = text(cardOf(markup, "ENTERPRISE"));
  assert.match(enterprise, /Up to 5,000 active wishlist items across your whole store/);
  assert.match(enterprise, /3,000 restock emails per billing period/);
  assert.match(enterprise, /90 days of analytics/);
  const compare = text(markup);
  assert.match(compare, /Compare plans/);
  assert.match(compare, /Active wishlist items \(whole store\) 50 2,500 5,000/);
  assert.match(compare, /Restock emails 50 in total 1,500 per billing period 3,000 per billing period/);
  assert.match(compare, /Analytics history 7 days 30 days 90 days/);
  const failed = html(U.buildPlanUsageView({ entitlements: { ...resolveEntitlements(null, NOW), lookupFailed: true }, now: NOW }));
  assert.equal((failed.match(/data-plan="/g) ?? []).length, 3, "all three plans are shown even when the merchant's own plan could not be read");
  assert.equal((failed.match(/data-current="true"/g) ?? []).length, 0, "and none is claimed as current");
});

test("no price, currency or plan limit is written in the page or its view model: prices come only from operator configuration", () => {
  for (const file of ["app/components/plan-usage.jsx", "app/models/plan-usage.server.js"]) {
    const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    assert.doesNotMatch(source, /[$€£₹¥]\s?\d|\d\s?(USD|INR|EUR|GBP)\b|\/\s?(month|mo|year)\b/i, `${file} has no price`);
    assert.doesNotMatch(source, /\b(2500|5000|1500|3000)\b|\b2,500\b|\b5,000\b|\b1,500\b|\b3,000\b/, `${file} repeats no plan limit`);
  }
  const labels = (env) => U.readPlanPriceLabels({ BILLING_PLAN_PRICE_LABELS: JSON.stringify(env) });
  assert.deepEqual(U.readPlanPriceLabels({}), { labels: {}, invalid: false });
  assert.deepEqual(labels({ ADVANCE: " Price A ", ENTERPRISE: "Price E", BASIC: "ignored", OTHER: "x" }), { labels: { ADVANCE: "Price A", ENTERPRISE: "Price E" }, invalid: false }, "only the paid plans, trimmed");
  assert.deepEqual(labels({ ADVANCE: "Price A" }).labels, { ADVANCE: "Price A" });
  for (const bad of [{ ADVANCE: "<b>x</b>", ENTERPRISE: "ok" }, { ADVANCE: 5 }, { ADVANCE: "" }, { ADVANCE: "x".repeat(41) }, { ADVANCE: "line\nbreak" }, ["a"], null]) {
    assert.deepEqual(labels(bad), { labels: {}, invalid: true }, JSON.stringify(bad));
  }
  assert.deepEqual(U.readPlanPriceLabels({ BILLING_PLAN_PRICE_LABELS: "not json" }), { labels: {}, invalid: true });
  assert.deepEqual(U.readPlanPriceLabels({ BILLING_PLAN_PRICE_LABELS: '{"ADVANCE":"ok","ENTERPRISE":7}' }), { labels: {}, invalid: true }, "one bad label removes all: no partial set");

  const none = html(viewOf(null));
  assert.match(text(cardOf(none, "ADVANCE")), /Pricing not available yet/, "no label and no Manage plan: an unavailable state, not a guessed price");
  assert.doesNotMatch(text(none), /[$€£₹]\s?\d/);
  const withManage = html(viewOf(null, { manageAvailable: true }));
  assert.match(text(cardOf(withManage, "ADVANCE")), /Price shown on Shopify's plan page/);
  const labelled = html(viewOf(null, { priceLabels: { ADVANCE: "Advance price text", ENTERPRISE: "Enterprise price text" } }));
  assert.match(text(cardOf(labelled, "ADVANCE")), /Advance price text/);
  assert.match(text(cardOf(labelled, "ENTERPRISE")), /Enterprise price text/);
  assert.match(text(cardOf(labelled, "BASIC")), /Free/);
});

test("more than 100,000 sessions recommends Enterprise; exactly 100,000 and fewer recommend Advance", () => {
  assert.equal(RECOMMENDATION_SESSION_THRESHOLD, 100000);
  for (const [sessions, plan] of [[100001, "ENTERPRISE"], [250000, "ENTERPRISE"], [100000, "ADVANCE"], [99999, "ADVANCE"], [24500, "ADVANCE"], [1, "ADVANCE"], [0, "ADVANCE"]]) {
    assert.equal(recommendedPlanForSessions(sessions), plan, String(sessions));
    const view = recoView(reco({ sessions30d: sessions, recommendedPlan: plan }));
    assert.deepEqual([view.state, view.plan, "sessions" in view], ["ready", plan, false], `${sessions} sessions`);
  }
  // the plan is derived from the count, so a stored plan that disagrees with it is never shown
  assert.equal(recoView(reco({ sessions30d: 100000, recommendedPlan: "ENTERPRISE" })).plan, "ADVANCE");
  assert.equal(recoView(reco({ sessions30d: 100001, recommendedPlan: "ADVANCE" })).plan, "ENTERPRISE");
  // a genuine zero IS a real count and is shown as zero (it arrives as a stored number, never from missing data)
  assert.deepEqual([recoView(reco({ sessions30d: 0 })).plan, recoView(reco({ sessions30d: 0 })).state], ["ADVANCE", "ready"]);
  const ready = recoView(reco());
  assert.equal(ready.updatedAt, iso(NOW.getTime() - 2 * HOUR));
  assert.deepEqual(Object.keys(ready).sort(), ["plan", "state", "updatedAt"], "no count, threshold or period leaves the server");
});

test("the recommendation is shown above the plan cards without any session count, threshold or period", () => {
  const markup = html(viewOf(noPlan, { recommendation: recoView(reco({ sessions30d: 24500 })) }));
  assert.ok(markup.indexOf('data-testid="plan-recommendation"') !== -1 && markup.indexOf('data-testid="plan-recommendation"') < markup.indexOf('data-testid="plan-cards"'), "above the cards");
  const words = text(markup);
  assert.match(words, /Recommended for your store/);
  assert.match(words, /Based on your store's activity over the past 30 days, we recommend the Advance plan\./);
  assert.doesNotMatch(words, /24,500|24500|100,000|100000|recorded|threshold/i, "neither the count nor the boundary is shown");
  assert.match(words, /Updated 2026-11-12 10:00 UTC/);
  assert.match(words, /only a suggestion: your plan does not change unless you choose a plan on Shopify/);
  const big = text(html(viewOf(noPlan, { recommendation: recoView(reco({ sessions30d: 123456 })) })));
  assert.match(big, /we recommend the Enterprise plan/);
  assert.doesNotMatch(big + html(viewOf(noPlan, { recommendation: recoView(reco({ sessions30d: 123456 })) })), /123,456|123456|100,000|100000/);
  // the figure on the page is the stored one: no example number is built into the page
  assert.doesNotMatch(text(html(viewOf(noPlan, { recommendation: recoView(reco({ sessions30d: 777 })) }))), /24,500/);
});

test("missing, inconsistent or unavailable analytics never produce a count or a recommendation", () => {
  const cases = [
    ["no row", null, "gathering"],
    ["pending", reco({ status: "PENDING", sessions30d: null, recommendedPlan: null, fetchedAt: null }), "gathering"],
    ["running", reco({ status: "RUNNING", sessions30d: null, recommendedPlan: null, fetchedAt: null }), "gathering"],
    ["failed, no count", reco({ status: "FAILED", sessions30d: null, recommendedPlan: null, fetchedAt: null }), "unavailable"],
    ["needs access", reco({ status: "NEEDS_ACCESS", sessions30d: null, recommendedPlan: null, fetchedAt: null }), "unavailable"],
    ["success without a count", reco({ sessions30d: null, recommendedPlan: null }), "gathering"],
    ["count without advice", reco({ recommendedPlan: null }), "gathering"],
    ["undefined count", reco({ sessions30d: undefined }), "gathering"],
    ["negative count", reco({ sessions30d: -5 }), "gathering"],
    ["fractional count", reco({ sessions30d: 12.5 }), "gathering"],
    ["string count", reco({ sessions30d: "24500" }), "gathering"],
    ["NaN count", reco({ sessions30d: Number.NaN }), "gathering"],
    ["no fetch time", reco({ fetchedAt: null }), "gathering"],
    ["no period", reco({ periodStart: null, periodEnd: null }), "gathering"],
    ["inverted period", reco({ periodStart: new Date("2026-11-11T00:00:00Z"), periodEnd: new Date("2026-10-12T00:00:00Z") }), "gathering"],
    ["invalid date", reco({ fetchedAt: new Date("nope") }), "gathering"],
    ["fetched in the future", reco({ fetchedAt: new Date(NOW.getTime() + DAY) }), "gathering"],
  ];
  for (const [tag, rowValue, state] of cases) {
    const view = recoView(rowValue);
    assert.deepEqual([view.state, view.plan, view.updatedAt], [state, null, null], tag);
    const markup = html(viewOf(noPlan, { recommendation: view }));
    assert.doesNotMatch(text(markup), /recorded|we recommend the|\b0 sessions/i, `${tag}: no count and no recommendation on the page`);
    assert.equal((markup.match(/data-recommended="true"/g) ?? []).length, 0, `${tag}: no card is marked recommended`);
    assert.equal((markup.match(/data-plan="/g) ?? []).length, 3, `${tag}: all three plans are still shown`);
  }
  assert.deepEqual([recoView(reco(), { readFailed: true }).state, recoView(reco(), { readFailed: true }).plan], ["unavailable", null], "a stored result that could not be read is never guessed");
  assert.deepEqual([recoView(reco({ fetchedAt: new Date(NOW.getTime() - 3 * MIN) })).state, recoView(reco({ fetchedAt: new Date(NOW.getTime() + 3 * MIN) })).state], ["ready", "ready"], "a few minutes of clock skew is tolerated");
  for (const days of [31, 90, 400]) {
    const old = recoView(reco({ fetchedAt: new Date(NOW.getTime() - days * DAY), sessions30d: 150000, recommendedPlan: "ENTERPRISE" }));
    assert.deepEqual([old.state, old.plan], ["ready", "ENTERPRISE"], `a completed recommendation from ${days} days ago is still shown: only the worker replaces it`);
    assert.deepEqual(Object.keys(old).sort(), ["plan", "state", "updatedAt"], "the view still carries no count, threshold or period");
  }
  for (const status of ["FAILED", "NEEDS_ACCESS", "PENDING", "RUNNING"]) {
    assert.equal(recoView(reco({ status, fetchedAt: new Date(NOW.getTime() - 90 * DAY) })).state, "ready", `an earlier valid result is kept while a later attempt is ${status}`);
  }
  assert.match(text(html(viewOf(noPlan, { recommendation: recoView(null) }))), /We're still gathering your store's analytics to recommend the best plan\./);
  assert.match(text(html(viewOf(noPlan, { recommendation: recoView(reco({ status: "NEEDS_ACCESS", sessions30d: null, recommendedPlan: null, fetchedAt: null })) }))), /We couldn't gather your store's analytics yet, so there is no recommendation right now\./);
  assert.ok(!JSON.stringify(recoView(reco({ status: "FAILED", sessions30d: null, errorCode: "access_denied" }))).includes("access_denied"), "internal error codes never reach the page");
});
test("current plan and recommended plan are independent: every combination is marked correctly, and both can apply to one card", () => {
  const currents = { BASIC: noPlan, ADVANCE: row({ plan: "ADVANCE" }), ENTERPRISE: row({ plan: "ENTERPRISE" }) };
  const recommendations = { ADVANCE: recoView(reco({ sessions30d: 30000 })), ENTERPRISE: recoView(reco({ sessions30d: 150000 })), none: recoView(null) };
  for (const [current, subscriptionRow] of Object.entries(currents)) {
    for (const [recommended, recommendation] of Object.entries(recommendations)) {
      const markup = html(viewOf(subscriptionRow, { recommendation }));
      for (const key of PLAN_KEYS) {
        const card = cardOf(markup, key);
        assert.equal(card.includes('data-current="true"'), key === current, `${current}/${recommended}: ${key} current`);
        assert.equal(card.includes('data-recommended="true"'), key === recommended, `${current}/${recommended}: ${key} recommended`);
        assert.equal(/Current plan<\/s-badge>/.test(card), key === current);
        assert.equal(/Recommended<\/s-badge>/.test(card), key === recommended);
      }
      const both = current === recommended;
      assert.equal(/You are already on the recommended plan\./.test(text(markup)), both, `${current}/${recommended}: the "already on it" note only when they match`);
    }
  }
  const same = cardOf(html(viewOf(currents.ADVANCE, { recommendation: recommendations.ADVANCE })), "ADVANCE");
  assert.ok(/Current plan<\/s-badge>/.test(same) && /Recommended<\/s-badge>/.test(same) && /kv-plan current recommended/.test(same), "one card is both current and recommended");
  // a paid plan that cannot be confirmed is shown as Basic: that is the current card, while the recommendation is unaffected
  const temporary = html(viewOf(row({ verifiedAt: new Date(NOW.getTime() - 30 * HOUR) }), { recommendation: recommendations.ADVANCE }));
  assert.ok(cardOf(temporary, "BASIC").includes('data-current="true"') && cardOf(temporary, "ADVANCE").includes('data-recommended="true"') && !cardOf(temporary, "ADVANCE").includes('data-current="true"'));
});

test("a recommendation changes nothing: the merchant's plan, status, usage and billing view are identical with or without it, and the page can start nothing", () => {
  for (const subscriptionRow of [noPlan, row({ plan: "ADVANCE" }), row({ plan: "ENTERPRISE", cancelAtPeriodEnd: true }), row({ verifiedAt: new Date(NOW.getTime() - 30 * HOUR) })]) {
    const without = viewOf(subscriptionRow, { recommendation: recoView(null), manageAvailable: true });
    for (const sessions of [10, 100000, 100001, 900000]) {
      const withReco = viewOf(subscriptionRow, { recommendation: recoView(reco({ sessions30d: sessions })), manageAvailable: true });
      const withoutReco = ({ recommendation, ...rest }) => rest; // eslint-disable-line no-unused-vars
      assert.deepEqual(withoutReco(withReco), withoutReco(without), `${sessions} sessions: plan, status, email, wishlist, period, trial, cancellation, warning and Manage plan are unchanged`);
    }
  }
  const frozen = Object.freeze(reco());
  assert.doesNotThrow(() => recoView(frozen), "the stored row is only read");
  // source: the view model, the page and the route contain no way to subscribe, change a plan, call Shopify or run analytics
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  const server = strip(fs.readFileSync("app/models/plan-usage.server.js", "utf8"));
  const component = strip(fs.readFileSync("app/components/plan-usage.jsx", "utf8"));
  const route = strip(fs.readFileSync("app/routes/app.plan.jsx", "utf8"));
  assert.doesNotMatch(server, /shopSubscription\.(create|update|upsert|delete)|\$executeRaw|\bfetch\(|createPartnerApi|runBillingJobs|fetchSessions|appSubscription|admin\.graphql|SHOPIFY_PARTNER|BILLING_MECHANISM|SESSION_ANALYTICS_SOURCE/);
  assert.deepEqual([...server.matchAll(/db\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g)].map((m) => m[0]), [], "the Pricing view model writes nothing at all");
  assert.doesNotMatch(server, /requestRecommendationRecheck|recommendationIsStale|RECOMMENDATION_MAX_AGE_MS|enqueuePlanRecommendations/, "and cannot enqueue or reset a recommendation");
  assert.doesNotMatch(component, /\bfetch\(|useFetcher|<form|onSubmit|method="post"|action=/i, "the page can submit nothing");
  assert.doesNotMatch(route, /action\b|\bfetch\(|useFetcher/);
  assert.deepEqual([...component.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((href, i, all) => all.indexOf(href) === i), ["/app/manage-plan"], "the only link on the page is Manage plan, which only redirects to Shopify's own page");
  assert.equal(U.recommendationIsStale, undefined, "there is no stale check any more");
});

test("billing stays safe while it is switched off: limits are described as not enforced, no plan can be chosen without a verified Manage plan, and nothing is invented", () => {
  const off = html(viewOf(noPlan, { recommendation: recoView(reco({ sessions30d: 150000 })), manageAvailable: false }));
  assert.match(text(off), /Plan limits are shown for information and are not being enforced yet\./);
  assert.doesNotMatch(off, /choose-(BASIC|ADVANCE|ENTERPRISE)/, "no plan button without the Shopify configuration");
  assert.doesNotMatch(off, /href="\/app\/manage-plan"/);
  assert.match(off, /manage-plan-unavailable/);
  assert.match(text(off), /Plan changes are not configured yet\./);
  assert.match(text(cardOf(off, "ENTERPRISE")), /Pricing not available yet/);
  // with the configuration, only the plans the merchant is not on get a button, and each one only leads to Shopify's own page
  const on = html(viewOf(row({ plan: "ADVANCE" }), { recommendation: recoView(reco({ sessions30d: 150000 })), manageAvailable: true }));
  assert.ok(!cardOf(on, "ADVANCE").includes("choose-ADVANCE"), "no button on the current plan");
  for (const key of ["BASIC", "ENTERPRISE"]) assert.match(cardOf(on, key), new RegExp(`<s-button[^>]*href="/app/manage-plan"[^>]*data-testid="choose-${key}"|<s-button[^>]*data-testid="choose-${key}"[^>]*href="/app/manage-plan"`));
  assert.match(cardOf(on, "ENTERPRISE"), /variant="primary"/, "the recommended plan gets the primary button");
  assert.match(cardOf(on, "BASIC"), /variant="secondary"/);
  assert.ok(!/https?:\/\//.test(on.replace(/tone="[^"]*"/g, "")), "no external address is rendered");
  // enforcement on: the notice goes away, the plans and the recommendation stay
  const enforced = text(html(viewOf(row(), { enforced: true })));
  assert.doesNotMatch(enforced, /not being enforced yet/);
  assert.match(enforced, /Compare plans/);
  // the existing useful details are all still on the page
  const full = text(html(viewOf(row({ cancelAtPeriodEnd: true }), { email: email(1500, 1400, { period: {} }), wishlist: wl(2500, 1200) })));
  for (const expected of [/Advance Current plan/, /1,400 of 1,500/, /1,200 of 2,500/, /Resets 2026-12-02 12:00 UTC/, /Plan status Confirmed with Shopify/, /Will cancel at the end of the billing period/, /Last confirmed with Shopify 2026-11-12 11:00 UTC/]) assert.match(full, expected);
  const temporary = text(html(viewOf(row({ verifiedAt: new Date(NOW.getTime() - 30 * HOUR) }))));
  assert.match(temporary, /Last confirmed plan Advance/);
});

// ======================= database: the loader =======================
const domains = [];
let seq = 4400000000;
const newShop = async (tag) => {
  const domain = `kw-pu-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "USD" } });
};
after(async () => {
  if (prisma) {
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});
const subscription = (shop, over = {}) => prisma.shopSubscription.create({ data: { shopId: shop.id, plan: "ADVANCE", status: "ACTIVE", verificationSource: "app_pricing", verifiedAt: new Date(NOW.getTime() - HOUR), currentPeriodStart: new Date(NOW.getTime() - 10 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY), ...over } });
async function seedEmails(shop, count, { status = "SENT", planAtSend = null, sentAt = null, reservedAt = null } = {}) {
  const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
  const variants = Array.from({ length: count }, () => `gid://shopify/ProductVariant/${(seq += 1)}`);
  await prisma.notifySubscription.createMany({ data: variants.map((variantGid, i) => ({ shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/1", variantGid, email: `n${i}@example.invalid`, consentedAt: NOW, consentSource: "test" })) });
  const subs = await prisma.notifySubscription.findMany({ where: { shopId: shop.id, actorId: actor.id }, select: { id: true, variantGid: true } });
  await prisma.emailDelivery.createMany({ data: subs.map((sub) => ({ shopId: shop.id, subscriptionId: sub.id, restockCycle: 1, variantGid: sub.variantGid, status, planAtSend, sentAt, reservedAt })) });
}
async function seedItems(shop, customers, each) {
  for (let c = 0; c < customers; c += 1) {
    const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
    await prisma.wishlistItem.createMany({ data: Array.from({ length: each }, (_, i) => ({ shopId: shop.id, actorId: actor.id, productGid: `gid://shopify/Product/${i + 1}`, variantGid: `gid://shopify/ProductVariant/${i + 1}`, productTitle: "Item", productHandle: "item" })) });
  }
}
const load = (shop, over = {}) => U.loadPlanUsage(shop.id, { now: NOW, env: {}, shopDomain: shop.domain, ...over });

dbTest("the loader shows a verified plan's real usage: plan-attributed emails, the shop-wide wishlist count, the verified period", async () => {
  const shop = await newShop("advance");
  await subscription(shop);
  await seedEmails(shop, 14, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - DAY) });
  await seedEmails(shop, 9, { planAtSend: "BASIC", sentAt: new Date(NOW.getTime() - 50 * DAY) }); // Basic-era mail: not Advance usage
  await seedEmails(shop, 3, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - 40 * DAY) }); // an earlier period
  await seedEmails(shop, 2, { status: "SENDING", planAtSend: "ADVANCE", reservedAt: NOW });
  await seedItems(shop, 3, 4); // three customers, 12 items together
  const view = await load(shop);
  assert.deepEqual([view.status, view.plan.key, view.plan.verifiedPaid], ["verified", "ADVANCE", true]);
  assert.deepEqual([view.email.quota, view.email.used, view.email.sent, view.email.reserved, view.email.resetsAt], [1500, 16, 14, 2, iso(NOW.getTime() + 20 * DAY)]);
  assert.deepEqual([view.wishlist.used, view.wishlist.limit, view.wishlist.overLimit], [12, 2500, false]);
  assert.equal(view.verification.lastVerifiedAt, iso(NOW.getTime() - HOUR));
});

dbTest("M4 on the page: after an upgrade to Enterprise in the same period, Advance emails are not Enterprise usage", async () => {
  const shop = await newShop("m4");
  await subscription(shop, { plan: "ADVANCE" });
  await seedEmails(shop, 30, { planAtSend: "ADVANCE", sentAt: new Date(NOW.getTime() - DAY) });
  assert.equal((await load(shop)).email.used, 30);
  await prisma.shopSubscription.update({ where: { shopId: shop.id }, data: { plan: "ENTERPRISE" } });
  const view = await load(shop);
  assert.deepEqual([view.plan.key, view.email.quota, view.email.used], ["ENTERPRISE", 3000, 0]);
  await seedEmails(shop, 4, { planAtSend: "ENTERPRISE", sentAt: new Date(NOW.getTime() - HOUR) });
  assert.equal((await load(shop)).email.used, 4);
});

dbTest("the loader shows Basic's lifetime usage including legacy sends, and never another shop's data", async () => {
  const shop = await newShop("basic");
  const other = await newShop("basic-other");
  await seedEmails(shop, 6, { planAtSend: null, sentAt: new Date(NOW.getTime() - 400 * DAY) }); // legacy
  await seedEmails(shop, 4, { planAtSend: "BASIC", sentAt: NOW });
  await seedEmails(shop, 8, { planAtSend: "ADVANCE", sentAt: NOW }); // paid-era mail
  await seedEmails(other, 25, { planAtSend: "BASIC", sentAt: NOW });
  await seedItems(shop, 2, 5);
  await seedItems(other, 1, 40);
  const view = await load(shop);
  assert.deepEqual([view.status, view.plan.key, view.email.used, view.email.quota, view.email.resetsAt], ["free", "BASIC", 10, 50, null]);
  assert.deepEqual([view.wishlist.used, view.wishlist.limit], [10, 50]);
  const otherView = await load(other);
  assert.deepEqual([otherView.email.used, otherView.wishlist.used], [25, 40]);
});

dbTest("temporary problems, missing periods and trials come out of the real stored rows as the page expects", async () => {
  const stale = await newShop("stale");
  await subscription(stale, { verifiedAt: new Date(NOW.getTime() - 30 * HOUR), verificationFailures: 2, nextVerificationAt: new Date(NOW.getTime() + 4 * MIN), lastVerificationError: "http_503" });
  const staleView = await load(stale);
  assert.deepEqual([staleView.status, staleView.plan.key, staleView.plan.verifiedPaid, staleView.lastConfirmedPlan, staleView.verification.checkingAgainAt], ["temporary", "BASIC", false, "Advance", iso(NOW.getTime() + 4 * MIN)]);
  assert.ok(!JSON.stringify(staleView).includes("http_503"), "internal error codes never reach the page");
  const trial = await newShop("trial");
  await subscription(trial, { currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: new Date(NOW.getTime() + 3 * DAY) });
  const trialView = await load(trial);
  assert.deepEqual([trialView.status, trialView.trial.planLabel, trialView.period], ["trial", "Advance", null]);
  const cancelling = await newShop("cancelling");
  await subscription(cancelling, { cancelAtPeriodEnd: true });
  assert.deepEqual((await load(cancelling)).cancellation, { effectiveAt: iso(NOW.getTime() + 20 * DAY) });
  const gone = await newShop("gone");
  await subscription(gone, { status: "CANCELLED" });
  const goneView = await load(gone);
  assert.deepEqual([goneView.status, goneView.plan.key], ["inactive", "BASIC"]);
});

dbTest("a part that cannot be read is unavailable, not zero; an unreadable plan shows nothing; Manage plan follows the configuration", async () => {
  const shop = await newShop("failing");
  await subscription(shop);
  await seedItems(shop, 1, 3);
  const noEmail = { ...prisma, emailDelivery: { count: async () => { throw new Error("db blip"); } }, shopSubscription: prisma.shopSubscription, wishlistItem: prisma.wishlistItem };
  const partial = await load(shop, { db: noEmail });
  assert.deepEqual([partial.status, partial.email, partial.wishlist.used], ["verified", null, 3]);
  const unreadable = { shopSubscription: { findUnique: async () => { throw Object.assign(new Error("connection lost"), { code: "P1001" }); } }, emailDelivery: prisma.emailDelivery, wishlistItem: prisma.wishlistItem };
  const quiet = console.error;
  console.error = () => {};
  let nothing;
  try {
    nothing = await load(shop, { db: unreadable });
  } finally {
    console.error = quiet;
  }
  assert.deepEqual([nothing.status, nothing.plan, nothing.email, nothing.wishlist], ["unavailable", null, null, null], "a failed read is not presented as the free plan");
  assert.equal((await load(shop, { env: { SHOPIFY_APP_HANDLE: "my-app", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: TEMPLATE } })).manage.available, true);
  assert.equal((await load(shop, { env: { BILLING_ENFORCEMENT: "on" } })).limitsEnforced, true);
});

dbTest("the loader reads the stored recommendation for THIS shop only, creates nothing, and never touches the subscription", async () => {
  const shop = await newShop("reco-ready");
  const other = await newShop("reco-other");
  await prisma.planRecommendation.create({ data: { shopId: shop.id, status: "SUCCEEDED", sessions30d: 150000, periodStart: new Date("2026-10-12T00:00:00Z"), periodEnd: new Date("2026-11-11T00:00:00Z"), fetchedAt: new Date(NOW.getTime() - HOUR), recommendedPlan: "ENTERPRISE" } });
  await prisma.planRecommendation.create({ data: { shopId: other.id, status: "SUCCEEDED", sessions30d: 1234, periodStart: new Date("2026-10-12T00:00:00Z"), periodEnd: new Date("2026-11-11T00:00:00Z"), fetchedAt: new Date(NOW.getTime() - HOUR), recommendedPlan: "ADVANCE" } });
  const before = await prisma.shopSubscription.count({ where: { shopId: shop.id } });
  const view = await load(shop);
  assert.deepEqual([view.recommendation.state, view.recommendation.plan, JSON.stringify(view).includes("150000")], ["ready", "ENTERPRISE", false]);
  assert.deepEqual([view.status, view.plan.key], ["free", "BASIC"], "recommending Enterprise does not move the merchant off Basic");
  assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id } }), before, "no subscription row is created or changed by viewing the page");
  assert.deepEqual([(await load(other)).recommendation.plan, "sessions" in (await load(other)).recommendation], ["ADVANCE", false], "each shop sees its own advice");
  const rowAfter = await prisma.planRecommendation.findUnique({ where: { shopId: shop.id } });
  assert.equal(rowAfter.status, "SUCCEEDED", "a fresh result is left alone");
});

dbTest("a shop with no stored recommendation sees 'gathering', no row is created by viewing the page, and a failed or unreadable one is 'unavailable'", async () => {
  const none = await newShop("reco-none");
  const view = await load(none);
  assert.deepEqual([view.recommendation.state, view.recommendation.plan], ["gathering", null]);
  assert.equal(await prisma.planRecommendation.count({ where: { shopId: none.id } }), 0, "the page never schedules a first lookup: the worker's enqueue does, and only with a session source");
  const denied = await newShop("reco-denied");
  await prisma.planRecommendation.create({ data: { shopId: denied.id, status: "NEEDS_ACCESS", errorCode: "access_denied" } });
  const deniedView = await load(denied);
  assert.deepEqual([deniedView.recommendation.state, deniedView.recommendation.plan], ["unavailable", null]);
  assert.ok(!JSON.stringify(deniedView).includes("access_denied"));
  assert.equal((await prisma.planRecommendation.findUnique({ where: { shopId: denied.id } })).status, "NEEDS_ACCESS", "NEEDS_ACCESS is not re-queued by the page");
  const pending = await newShop("reco-pending");
  await prisma.planRecommendation.create({ data: { shopId: pending.id } });
  assert.equal((await load(pending)).recommendation.state, "gathering");
  const unreadable = { ...prisma, planRecommendation: { findUnique: async () => { throw new Error("db blip"); } }, shopSubscription: prisma.shopSubscription, emailDelivery: prisma.emailDelivery, wishlistItem: prisma.wishlistItem };
  const blip = await load(pending, { db: unreadable });
  assert.deepEqual([blip.recommendation.state, blip.recommendation.plan, blip.plan.key], ["unavailable", null, "BASIC"], "an unreadable result is not a zero and does not hide the plan");
  assert.equal((blip.plans ?? []).length, 3);
});

dbTest("opening or refreshing Pricing never enqueues, resets or re-runs a recommendation, however old the stored result is", async () => {
  const snapshot = async (shop) => JSON.stringify(await prisma.planRecommendation.findUnique({ where: { shopId: shop.id } }));
  const base = { sessions30d: 150000, recommendedPlan: "ENTERPRISE" };
  const old = new Date(NOW.getTime() - 400 * DAY);
  const states = [
    ["completed long ago", { status: "SUCCEEDED", ...base, periodStart: new Date(old.getTime() - 30 * DAY), periodEnd: old, fetchedAt: old }, "ready"],
    ["completed recently", { status: "SUCCEEDED", sessions30d: 24500, recommendedPlan: "ADVANCE", periodStart: new Date(NOW.getTime() - 31 * DAY), periodEnd: new Date(NOW.getTime() - DAY), fetchedAt: new Date(NOW.getTime() - HOUR) }, "ready"],
    ["pending", { status: "PENDING" }, "gathering"],
    ["failed", { status: "FAILED", errorCode: "http_500", attempts: 5 }, "unavailable"],
    ["needs access", { status: "NEEDS_ACCESS", errorCode: "access_denied" }, "unavailable"],
  ];
  let longAgo = null;
  for (const [tag, data, state] of states) {
    const shop = await newShop(`reco-${tag.replace(/s/g, "-")}`);
    await prisma.planRecommendation.create({ data: { shopId: shop.id, ...data } });
    if (tag === "completed long ago") longAgo = shop;
    const before = await snapshot(shop);
    const views = [await load(shop), await load(shop), await load(shop, { now: new Date(NOW.getTime() + 60 * DAY) })];
    for (const view of views) assert.equal(view.recommendation.state, state, tag);
    assert.equal(await snapshot(shop), before, `${tag}: three page loads changed nothing in the row (status, attempts, schedule, result, timestamps)`);
    assert.equal(await prisma.shopSubscription.count({ where: { shopId: shop.id } }), 0, `${tag}: no subscription is touched`);
  }
  const none = await newShop("reco-norow");
  assert.equal((await load(none)).recommendation.state, "gathering");
  assert.equal(await prisma.planRecommendation.count({ where: { shopId: none.id } }), 0, "a shop with no row does not get one from a page visit");
  const completed = await load(longAgo);
  assert.deepEqual([completed.recommendation.state, completed.recommendation.plan], ["ready", "ENTERPRISE"], "a completed recommendation from long ago is still displayed");
  assert.doesNotMatch(JSON.stringify(completed), /150000|100000|periodStart|periodEnd|sessions/i, "no raw count, threshold or period in the returned page data");
});

dbTest("billing stays off by default: the Pricing view carries no verified plan, no enforcement and no Manage plan unless the operator configured them", async () => {
  const shop = await newShop("pricing-off");
  const view = await load(shop, { env: {} });
  assert.deepEqual([view.limitsEnforced, view.manage.available, view.plan.key, view.plan.verifiedPaid], [false, false, "BASIC", false]);
  assert.deepEqual(view.plans.map((card) => card.price), [null, null, null], "no price without operator text");
  const priced = await load(shop, { env: { BILLING_PLAN_PRICE_LABELS: JSON.stringify({ ADVANCE: "Advance label", ENTERPRISE: "Enterprise label" }) } });
  assert.deepEqual(priced.plans.map((card) => card.price), [null, "Advance label", "Enterprise label"]);
  assert.deepEqual([priced.limitsEnforced, priced.manage.available], [false, false], "labels alone enable neither Manage plan nor enforcement");
});

// ======================= Phase 1: the unconfigured Pricing page and stricter template checking =======================
test("unconfigured: a clear notice says plan changes are not set up, Basic stays the current free plan, and nothing suggests a purchase is possible", () => {
  const off = html(viewOf(null, { manageAvailable: false }));
  const words = text(off);
  assert.match(off, /data-testid="manage-plan-unconfigured"/);
  assert.match(dec(off), /heading="Plan changes are not configured yet"/);
  assert.match(words, /Paid plans can't be purchased from this page yet\. Your store stays on the free Basic plan until plan selection is set up\. Nothing is charged\./);
  assert.match(words, /Basic Current plan/, "Basic is still the current free plan");
  assert.match(text(cardOf(off, "BASIC")), /Free/);
  for (const key of ["ADVANCE", "ENTERPRISE"]) {
    assert.match(text(cardOf(off, key)), /Pricing not available yet/);
    assert.doesNotMatch(cardOf(off, key), /<s-button|choose-|href=/, "no purchase control on a paid plan card");
  }
  assert.doesNotMatch(off, /href="\/app\/manage-plan"/);
  assert.doesNotMatch(words, /SHOPIFY_|BILLING_|environment|\benv\b|https?:\/\//i, "no setting name, value or address is shown to a merchant");
  assert.match(words, /Compare plans/, "the plans, comparison and usage are all still there");
  assert.match(words, /Restock emails/);
});

test("unconfigured, but a verified paid plan exists: the notice does not claim the shop is on Basic", () => {
  const off = text(html(viewOf(row(), { manageAvailable: false })));
  assert.match(off, /Choosing or changing a plan from this page is not set up yet\. Your current plan is unchanged\./);
  assert.doesNotMatch(off, /stays on the free Basic plan/);
  assert.match(off, /Advance Current plan/);
});

test("configured: no unconfigured notice, and the choose buttons are back", () => {
  const on = html(viewOf(noPlan, { manageAvailable: true }));
  assert.doesNotMatch(on, /manage-plan-unconfigured|Plan changes are not configured yet/);
  assert.match(on, /data-testid="choose-ADVANCE"/);
  assert.match(on, /data-testid="manage-plan"/);
});

test("a template with an unknown or malformed placeholder is rejected, not sent to Shopify with %7B...%7D in it", () => {
  const build = (template) => U.buildManagePlanUrl({ template, appHandle: "my-app", shopDomain: "cool-shop.myshopify.com" });
  const base = "https://admin.shopify.com/store/{store_handle}/charges/{app_handle}";
  assert.equal(build(base + "/pricing_plans"), "https://admin.shopify.com/store/cool-shop/charges/my-app/pricing_plans", "the good shape still works");
  for (const bad of [base + "/{other}", base + "/{{x}}", base + "?x={other}", base + "#{x}", "https://admin.shopify.com/store/{Store_Handle}/charges/{app_handle}", base + "/}", "https://admin.shopify.com/store/{store_handle}/charges/{ app_handle }", base + "/{store_handle}"]) {
    assert.equal(build(bad), null, bad);
  }
  assert.equal(build("  " + base + "  "), "https://admin.shopify.com/store/cool-shop/charges/my-app", "surrounding spaces are trimmed, as before");
});

test("malformed templates make the configuration unusable, naming the setting and never echoing the value", () => {
  const ok = { SHOPIFY_APP_HANDLE: "my-app", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: TEMPLATE };
  for (const template of ["https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/{other}", "https://admin.shopify.com/store/{store_handle}", "https://admin.shopify.com/{app_handle}", "not a url {store_handle} {app_handle}"]) {
    const config = U.readManagePlanConfig({ ...ok, SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: template });
    assert.deepEqual([config.available, config.missing, config.invalid], [false, [], ["SHOPIFY_PLAN_SELECTION_URL_TEMPLATE"]], template);
    assert.equal(JSON.stringify(config).includes("admin.shopify.com"), false);
  }
  assert.deepEqual(U.readManagePlanConfig({ ...ok, SHOPIFY_APP_HANDLE: "../x" }).invalid, ["SHOPIFY_APP_HANDLE"]);
});

test("the operator hint is one server-log line, once, with setting NAMES only, and nothing when configured", () => {
  const lines = [];
  const log = { warn: (line) => lines.push(line) };
  U.resetManagePlanConfigLog();
  assert.equal(U.logManagePlanConfigOnce(U.readManagePlanConfig({ SHOPIFY_APP_HANDLE: "secret-looking-handle" }), log), true);
  assert.equal(U.logManagePlanConfigOnce(U.readManagePlanConfig({}), log), false, "once per process");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Missing: SHOPIFY_PLAN_SELECTION_URL_TEMPLATE\./);
  assert.equal(lines[0].includes("secret-looking-handle"), false, "no value is ever logged");
  U.resetManagePlanConfigLog();
  assert.equal(U.logManagePlanConfigOnce(U.readManagePlanConfig({ SHOPIFY_APP_HANDLE: "my-app", SHOPIFY_PLAN_SELECTION_URL_TEMPLATE: TEMPLATE }), log), false, "a working configuration logs nothing");
  assert.equal(lines.length, 1);
  U.resetManagePlanConfigLog();
});
