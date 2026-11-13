import prisma from "../db.server";
import { PLANS, PLAN_KEYS, VERIFICATION_MAX_AGE_MS, billingEnforced, recommendedPlanForSessions } from "./plans.server";
import { getEntitlements, restockEmailUsage, wishlistCapacity } from "./entitlements.server";
import { publicRecommendation } from "./plan-recommendation.server";
import { verifyShopOnDemand } from "./subscription-verification.server";

// What the merchant's Pricing page (/app/plan: the three plans, the recommendation, and the plan and usage details) shows, built ONLY from what the app already knows and has verified:
//   - the plan comes from resolveEntitlements (a paid plan is shown as the plan ONLY while it is verified and fresh; otherwise the page shows
//     Basic's limits and says plainly that the status could not be confirmed, which is never described as a cancellation)
//   - the usage comes from the same quota and capacity helpers the enforcement uses (email usage of the EFFECTIVE plan, attributed per plan; the
//     shop-wide wishlist count)
//   - every date comes from the stored subscription (verified period, trial end, last verification); a date that is not known is null and the
//     page says so. Nothing is estimated, and a count that could not be read is "unavailable", never 0.
// The result is plain JSON (dates as ISO strings), computed on the server, so the page itself holds no billing logic.

const iso = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null);

// ---------- the "Manage plan" action ----------
// Shopify hosts the plan selection page. Where to send the merchant needs two facts this repository cannot establish by itself, so both are
// supplied by the operator and the action stays DISABLED until they are:
//   SHOPIFY_APP_HANDLE                       the app's handle (from the app's Partner Dashboard / shopify.app.toml)
//   SHOPIFY_PLAN_SELECTION_URL_TEMPLATE      the plan selection page URL from Shopify's "Redirect to the plan selection page" guide, with the two
//                                            placeholders {store_handle} and {app_handle}, each exactly once
// The store handle is taken from the VERIFIED Admin session's shop domain (never from the request). The result must be https and on
// admin.shopify.com or the shop's own myshopify.com domain, with no credentials or port, or there is no link at all.
export const MANAGE_PLAN_PATH = "/app/manage-plan";
const APP_HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const STORE_DOMAIN = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/;
const count = (text, needle) => text.split(needle).length - 1;

export function buildManagePlanUrl({ template, appHandle, shopDomain }) {
  const store = STORE_DOMAIN.exec(String(shopDomain ?? "").trim().toLowerCase());
  const handle = String(appHandle ?? "").trim();
  const text = String(template ?? "").trim();
  if (!store || !APP_HANDLE.test(handle) || count(text, "{store_handle}") !== 1 || count(text, "{app_handle}") !== 1) return null;
  const filled = text.replace("{store_handle}", store[1]).replace("{app_handle}", handle);
  // Any brace left over is an unknown or malformed placeholder ({other}, {{x}}, {Store_Handle}). It is checked on the TEXT, before parsing,
  // because URL parsing percent-encodes braces in a path (they would reach the link as %7B and %7D and pass a check on the parsed address).
  if (/[{}]/.test(filled)) return null;
  try {
    const url = new URL(filled);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port || /[{}]/.test(url.href)) return null;
    return host === "admin.shopify.com" || host === `${store[1]}.myshopify.com` ? url.href : null;
  } catch {
    return null;
  }
}

// { available, missing: [names], invalid: [names] }. Names only, never a value.
export function readManagePlanConfig(env = process.env, shopDomain = "example-shop.myshopify.com") {
  const appHandle = String(env?.SHOPIFY_APP_HANDLE ?? "").trim();
  const template = String(env?.SHOPIFY_PLAN_SELECTION_URL_TEMPLATE ?? "").trim();
  const missing = [];
  const invalid = [];
  if (!appHandle) missing.push("SHOPIFY_APP_HANDLE");
  else if (!APP_HANDLE.test(appHandle)) invalid.push("SHOPIFY_APP_HANDLE");
  if (!template) missing.push("SHOPIFY_PLAN_SELECTION_URL_TEMPLATE");
  else if (!buildManagePlanUrl({ template, appHandle: APP_HANDLE.test(appHandle) ? appHandle : "app", shopDomain })) invalid.push("SHOPIFY_PLAN_SELECTION_URL_TEMPLATE");
  return { available: missing.length === 0 && invalid.length === 0, missing, invalid };
}

// The operator-facing hint for an unconfigured Manage plan: one line in the SERVER log, once per process, naming the settings that need
// attention (never a value, never shown to merchants). The merchant sees only the plain explanation on the page.
let manageConfigLogged = false;
export const resetManagePlanConfigLog = () => {
  manageConfigLogged = false;
};
export function logManagePlanConfigOnce(config, log = console) {
  if (!config || config.available || manageConfigLogged) return false;
  manageConfigLogged = true;
  log.warn(`[billing] Manage plan is OFF, so the Pricing page offers no plan selection. Missing: ${config.missing.join(", ") || "none"}. Unusable: ${config.invalid.join(", ") || "none"}.`);
  return true;
}

// ---------- the prices shown on the Pricing page ----------
// Prices belong to Shopify (the plans configured in the Partner Dashboard), and this app cannot read them without the Partner API, which is off. So
// the page shows a price ONLY when the operator supplies the exact text to show, and the text is display-only: it is never used for billing.
//   BILLING_PLAN_PRICE_LABELS   JSON such as {"ADVANCE":"<text>","ENTERPRISE":"<text>"}: a plan's label as the merchant will see it on Shopify
// Anything unreadable (not JSON, not an object, a label that is not a short plain string) shows NO prices at all rather than a partial or guessed
// set. Without a label the card says where the price is shown, or that pricing is not available yet. The authoritative amount is always Shopify's page.
const PRICE_LABEL = /^[^<>\p{Cc}]{1,40}$/u;

export function readPlanPriceLabels(env = process.env) {
  const raw = String(env?.BILLING_PLAN_PRICE_LABELS ?? "").trim();
  if (!raw) return { labels: {}, invalid: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { labels: {}, invalid: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { labels: {}, invalid: true };
  const labels = {};
  for (const key of PLAN_KEYS.filter((plan) => PLANS[plan].paid)) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] !== "string" || !PRICE_LABEL.test(parsed[key].trim())) return { labels: {}, invalid: true };
    labels[key] = parsed[key].trim();
  }
  return { labels, invalid: false };
}

// The three plan cards, straight from the plan definitions (plans.server.js): no limit is written a second time here.
export function buildPlanCards(priceLabels = {}) {
  return PLAN_KEYS.map((key) => {
    const plan = PLANS[key];
    return {
      key,
      label: plan.label,
      paid: plan.paid,
      wishlistItems: plan.wishlistItems,
      restockEmails: { quota: plan.restockEmails.quota, period: plan.restockEmails.period },
      analyticsHistoryDays: plan.analyticsHistoryDays,
      price: plan.paid ? priceLabels[key] ?? null : null,
    };
  });
}

// ---------- the recommendation shown above the plans ----------
// It only READS the stored result of the existing lookup (PlanRecommendation, filled by the worker through the session source); the page never
// queries analytics. A count is shown only when it is a real stored count with a real period; otherwise there is NO number and no
// recommended plan, and the reason is one of two plain states: "gathering" (not looked up yet, or being looked up again) or "unavailable" (the last
// lookup could not be completed, or the stored result could not be read). A missing count is never zero.
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const asDate = (value) => (value instanceof Date ? value : typeof value === "string" ? new Date(value) : new Date(NaN));
const validDate = (date) => !Number.isNaN(date.getTime());

// The stored result as { plan, sessions, start, end, fetched } when it is complete and consistent, else null. The plan is derived again from the
// count by the one agreed rule, so a stored plan that disagreed with its own count could never be shown.
function storedResult(row) {
  const stored = publicRecommendation(row);
  if (!stored) return null;
  const plan = recommendedPlanForSessions(stored.sessions30d);
  const [start, end, fetched] = [asDate(stored.periodStart), asDate(stored.periodEnd), asDate(stored.fetchedAt)];
  if (!plan || ![start, end, fetched].every(validDate) || start >= end) return null;
  return { plan, sessions: stored.sessions30d, start, end, fetched };
}

const recommendationAge = (result, now) => now.getTime() - result.fetched.getTime();

export function buildRecommendationView(row, { now = new Date(), readFailed = false } = {}) {
  const empty = (state) => ({ state, plan: null, updatedAt: null });
  if (readFailed) return empty("unavailable");
  const result = storedResult(row);
  if (result) {
    const age = recommendationAge(result, now);
    // A completed result stays shown however old it is: only a newer valid result written by the worker replaces it, never a page visit.
    if (age >= -CLOCK_SKEW_MS) {
      return {
        // Deliberately ONLY the plan and a date: the session count, the threshold and the period never leave the server, so nothing in the page
        // data (or its markup) can reveal how close a store is to the Enterprise boundary.
        state: "ready",
        plan: result.plan,
        updatedAt: iso(result.fetched),
      };
    }
  }
  return empty(row?.status === "NEEDS_ACCESS" || row?.status === "FAILED" ? "unavailable" : "gathering");
}

// ---------- the subscription check run when the Pricing page opens ----------
// This is the ONLY place a merchant's own visit can start a subscription verification, and it is the existing on-demand check
// (verifyShopOnDemand), so every protection of the worker applies to it unchanged: the per-shop lease (two simultaneous visits make ONE request),
// the retry backoff after a failure, the spacing of the two answers that confirm a cancellation, and a one-minute minimum between checks. It is
// also the landing for Shopify App Pricing's welcome link: after a merchant approves a plan Shopify redirects to the plan's welcome link, which
// the operator points at /app/plan in the Partner Dashboard, and this check then asks Shopify what the subscription really is. Nothing in the
// request is read (the redirect's plan_handle and shop parameters are NOT trusted): only the verified session's shop is checked.
// Time is bounded (PAGE_VERIFY_TIMEOUT_MS, shorter than the worker's) so a slow Partner API can never hold the page. A failure of any kind is
// a failed check, never a cancellation: nothing about the subscription changes (see applyVerification). With no verifier (the billing
// settings are off) nothing is asked and nothing is written. Never throws.
export const PAGE_VERIFY_TIMEOUT_MS = 6 * 1000;

export async function verifyForPricingPage(shopId, { verify, now = () => new Date(), timeoutMs = PAGE_VERIFY_TIMEOUT_MS, db = prisma } = {}) {
  if (typeof verify !== "function") return { enabled: false, status: "unavailable" };
  try {
    const { status } = await verifyShopOnDemand(shopId, { verify, now, timeoutMs, db });
    return { enabled: true, status };
  } catch (error) {
    console.error("[billing] pricing page check failed", JSON.stringify({ kind: error?.constructor?.name ?? "Error", code: error?.code ?? null }));
    return { enabled: true, status: "error" };
  }
}

// ---------- the view ----------

// What the page can honestly say about the subscription CHECK itself (separate from the plan, which resolveEntitlements decides):
//   not_checked        verification is not switched on, so a paid subscription cannot be known
//   pending            enabled, but no check has completed yet (or one is running right now)
//   verified           the last check succeeded and is recent
//   stale              the last successful check is older than a paid plan may rely on
//   temporary_failure  the last attempt failed: the plan is unchanged, and the next attempt is scheduled
function verificationCheckState({ enabled, checkStatus, subscription, verifiedAt, fresh }) {
  if (!enabled) return "not_checked";
  if (checkStatus === "in_progress" || !subscription) return "pending";
  if (subscription.verificationFailures > 0) return "temporary_failure";
  if (!verifiedAt) return "pending";
  return fresh ? "verified" : "stale";
}

const INACTIVE = { subscription_cancelled: "cancelled", subscription_frozen: "frozen", subscription_expired: "expired" };

export function buildPlanUsageView({ entitlements, subscription, email, wishlist, manageAvailable = false, enforced = false, recommendation, priceLabels = {}, verificationEnabled = false, checkStatus = null, now = new Date() }) {
  // The plans and the recommendation are shown whatever the state of the merchant's own plan, so they are part of every view.
  const base = { manage: { available: manageAvailable }, limitsEnforced: enforced, plans: buildPlanCards(priceLabels), recommendation: recommendation ?? buildRecommendationView(null, { now }) };
  if (!entitlements || entitlements.lookupFailed) {
    return {
      ...base,
      status: "unavailable",
      plan: null,
      email: null,
      wishlist: null,
      trial: null,
      cancellation: null,
      verification: { check: null, lastVerifiedAt: null, checkingAgainAt: null },
      warning: { tone: "warning", title: "Plan details are temporarily unavailable", message: "We couldn't load your plan details just now. Nothing about your plan has changed. Please try again shortly." },
    };
  }

  const effective = entitlements.plan;
  const stored = subscription ? PLANS[subscription.plan] ?? null : null;
  const period = entitlements.billingPeriod;
  const verifiedAt = subscription?.verifiedAt instanceof Date ? subscription.verifiedAt : null;
  const fresh = verifiedAt !== null && now.getTime() - verifiedAt.getTime() <= VERIFICATION_MAX_AGE_MS && now.getTime() >= verifiedAt.getTime();

  let status = "free";
  let warning = null;
  let trial = null;
  let cancellation = null;
  let lastConfirmedPlan = null;

  if (entitlements.state === "verified") {
    status = "verified";
    if (subscription?.cancelAtPeriodEnd === true && period) cancellation = { effectiveAt: iso(period.end) };
  } else if (entitlements.state === "fallback") {
    const reason = entitlements.reason;
    if (INACTIVE[reason]) {
      status = "inactive";
      warning = { tone: "info", title: `Your ${stored?.label ?? "paid"} subscription is no longer active`, message: "Basic limits apply now. Your wishlist items, subscriptions and history are kept." };
    } else if (reason === "subscription_pending") {
      status = "pending";
      warning = { tone: "info", title: "Your plan change is waiting for approval", message: "Basic limits apply until Shopify confirms your subscription." };
    } else if (reason === "billing_period_unknown" && stored?.paid && subscription?.status === "ACTIVE" && fresh && subscription.trialEndsAt instanceof Date && subscription.trialEndsAt > now) {
      status = "trial";
      trial = { planLabel: stored.label, endsAt: iso(subscription.trialEndsAt) };
      warning = { tone: "info", title: `You're on a free trial of ${stored.label}`, message: `Shopify has not reported a billing period yet, so Basic limits apply until your first billing period starts. Your trial ends on the date below.` };
    } else if (reason === "no_subscription") {
      status = "free"; // no subscription record at all: the free plan, nothing to warn about
    } else {
      status = "temporary";
      lastConfirmedPlan = stored?.paid && verifiedAt ? stored.label : null;
      warning = { tone: "warning", title: "We couldn't confirm your subscription right now", message: "Basic limits apply for now while we keep checking with Shopify. This is not a cancellation, and nothing has been deleted." };
    }
  }

  const check = verificationCheckState({ enabled: verificationEnabled, checkStatus, subscription, verifiedAt, fresh });
  // A shop on the free plan whose latest check could not be completed: nothing is wrong with the plan it has, but a plan it chose on Shopify a
  // moment ago cannot show yet, and it should be told why rather than see the free plan with no explanation.
  if (status === "free" && check === "temporary_failure") {
    warning = { tone: "info", title: "We couldn't check for subscription changes just now", message: "If you recently chose a paid plan on Shopify, it will show here as soon as we can confirm it. Nothing has been changed or deleted." };
  }

  const emailView = email
    ? {
        quota: email.quota,
        used: email.used,
        sent: email.sent,
        reserved: email.reserved,
        remaining: email.remaining,
        exceeded: email.exceeded,
        scope: effective.restockEmails.period,
        resetsAt: effective.restockEmails.period === "billing_period" ? iso(email.period?.end ?? period?.end) : null,
      }
    : null;

  return {
    ...base,
    status,
    plan: { key: effective.key, label: effective.label, verifiedPaid: entitlements.state === "verified" },
    lastConfirmedPlan,
    email: emailView,
    wishlist: wishlist ? { limit: wishlist.limit, used: wishlist.used, remaining: wishlist.remaining, overLimit: wishlist.overLimit } : null,
    period: period ? { start: iso(period.start), end: iso(period.end) } : null,
    trial,
    cancellation,
    verification: {
      check,
      lastVerifiedAt: iso(verifiedAt),
      checkingAgainAt: subscription && subscription.verificationFailures > 0 ? iso(subscription.nextVerificationAt) : null,
    },
    warning,
  };
}

// ---------- loading it ----------

// Reads what the page needs for ONE shop. A part that cannot be read is null (shown as unavailable), never a made-up number.
// `check` = what verifyForPricingPage returned for this visit ({ enabled, status }); without it the page reports verification as not checked.
export async function loadPlanUsage(shopId, { now = new Date(), db = prisma, env = process.env, shopDomain, check = null } = {}) {
  const entitlements = await getEntitlements(shopId, { now, db });
  const manageAvailable = readManagePlanConfig(env, shopDomain).available;
  const priceLabels = readPlanPriceLabels(env).labels;
  const attempt = async (read) => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
  // One cheap READ of the stored result. It is the ONLY recommendation work this page does: the lookup belongs to the worker (queued by the
  // install trigger), and opening or refreshing this page never enqueues, resets or re-runs anything.
  const readRecommendation = async () => {
    let row;
    try {
      row = await db.planRecommendation.findUnique({ where: { shopId } });
    } catch {
      return buildRecommendationView(null, { now, readFailed: true });
    }
    return buildRecommendationView(row, { now });
  };
  if (entitlements.lookupFailed) {
    return buildPlanUsageView({ entitlements, manageAvailable, enforced: billingEnforced(env), recommendation: await readRecommendation(), priceLabels, now });
  }
  const [subscription, email, wishlist, recommendation] = await Promise.all([
    attempt(() => db.shopSubscription.findUnique({ where: { shopId } })),
    attempt(() => restockEmailUsage(shopId, entitlements, { db })),
    attempt(() => wishlistCapacity(shopId, entitlements, { db })),
    readRecommendation(),
  ]);
  return buildPlanUsageView({ entitlements, subscription, email, wishlist, manageAvailable, enforced: billingEnforced(env), recommendation, priceLabels, verificationEnabled: check?.enabled === true, checkStatus: check?.status ?? null, now });
}
