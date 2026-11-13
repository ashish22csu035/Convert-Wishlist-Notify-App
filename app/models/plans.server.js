// The plans and their limits: the ONE place to change them. Pure data, no database and no Shopify calls.
//
// No price is defined here on purpose: prices belong to Shopify's billing mechanism, not to this app.
//
// Which Shopify App Pricing plan HANDLE is which plan is configuration (BILLING_PLAN_HANDLES, see partner-api-verifier.server.js), not code:
// the handles are chosen in the Partner Dashboard.
//
// Limits (the starting values, meant to be edited here):
//   wishlistItems       active wishlist items across ALL customers of the shop combined (not per customer)
//   restockEmails       restock emails SENT; `period` says when the count starts over:
//                         "lifetime"        never (Basic: one allowance for the life of the shop's Basic use)
//                         "billing_period"  at the start of the merchant's own Shopify billing period, using the
//                                           boundaries Shopify reported (never a calendar month or a rolling window)
//   analyticsHistoryDays  how far back the merchant's reports may look

const plan = (key, label, paid, limits) => Object.freeze({ key, label, paid, ...limits });

export const PLANS = Object.freeze({
  BASIC: plan("BASIC", "Basic", false, {
    wishlistItems: 50,
    restockEmails: Object.freeze({ quota: 50, period: "lifetime" }),
    analyticsHistoryDays: 7,
  }),
  ADVANCE: plan("ADVANCE", "Advance", true, {
    wishlistItems: 2500,
    restockEmails: Object.freeze({ quota: 1500, period: "billing_period" }),
    analyticsHistoryDays: 30,
  }),
  ENTERPRISE: plan("ENTERPRISE", "Enterprise", true, {
    wishlistItems: 5000,
    restockEmails: Object.freeze({ quota: 3000, period: "billing_period" }),
    analyticsHistoryDays: 90,
  }),
});

export const PLAN_KEYS = Object.freeze(Object.keys(PLANS));

// What a shop gets while its subscription is missing or cannot be verified (a temporary state, never a stored downgrade).
export const FALLBACK_PLAN = "BASIC";

// Where a verified paid subscription may come from. The only real source is Shopify App Pricing, read through the Partner API
// (partner-api-verifier.server.js). A stored paid row grants entitlements only when its verificationSource is in this list, and a verifier's
// answer is recorded as a verification only when it names one of these (subscription-verification.server.js). Anything else (a label nobody
// defined, a row left by the removed Billing API mechanism, a copied test fixture) is "not verified", whatever else the row says. Tests use
// the SAME source with an injected verifier: there is no separate test source, so no test-only path exists in production code.
export const APP_PRICING_SOURCE = "app_pricing";
export const VERIFIED_SOURCES = Object.freeze([APP_PRICING_SOURCE]);

// A paid plan counts only while its last successful verification is younger than this.
export const VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Advisory only: more than this many sessions in the previous 30 days suggests Enterprise, otherwise Advance.
export const RECOMMENDATION_SESSION_THRESHOLD = 100000;

// Whether plan limits are ENFORCED (the store-wide wishlist cap and the restock-email quota). Everything is still measured and
// attributed either way, so the numbers are right on the day enforcement is switched on. Off unless BILLING_ENFORCEMENT=on:
// until a verified paid subscription can exist, every shop resolves to Basic, so switching it on earlier would put every
// merchant on Basic's limits with no way to leave them.
export const billingEnforced = (env = process.env) => String(env?.BILLING_ENFORCEMENT ?? "").trim().toLowerCase() === "on";

export const isPlanKey =(value) => typeof value === "string" && Object.hasOwn(PLANS, value);
export const getPlan = (key) => (isPlanKey(key) ? PLANS[key] : null);

// null for anything that is not a real, non-negative whole number: a missing or failed count never becomes a plan.
export function recommendedPlanForSessions(sessions) {
  if (typeof sessions !== "number" || !Number.isSafeInteger(sessions) || sessions < 0) return null;
  return sessions > RECOMMENDATION_SESSION_THRESHOLD ? "ENTERPRISE" : "ADVANCE";
}
