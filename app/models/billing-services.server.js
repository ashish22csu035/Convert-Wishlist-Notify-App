import { APP_PRICING_SOURCE, createPartnerApiClient, createPartnerApiVerifier, readPartnerConfig } from "./partner-api-verifier.server";
import { createShopifyqlSessionSource } from "./session-source.server";

// The two outside lookups the billing jobs need, supplied in one place so the jobs themselves never know where data comes from:
//
//   verify({ shop, subscription, signal })       -> what the merchant's Shopify subscription really is (see subscription-verification.server.js)
//   fetchSessions({ shopId, shopDomain, signal }) -> { sessions, periodStart, periodEnd } for the previous 30 days (see plan-recommendation.server.js)
//
// BOTH ARE OFF unless switched on explicitly and completely:
//
//   BILLING_MECHANISM=app_pricing      the ONLY accepted value. The app is distributed publicly and billed with Shopify App Pricing, whose
//                                      subscription status comes from the Partner API (partner-api-verifier.server.js). Any other value,
//                                      including the former "billing_api", builds NOTHING: the Admin API's Billing API view of subscriptions
//                                      knows nothing about App Pricing and would report cancellations that did not happen, so there is no
//                                      code path from this setting to it (that verifier no longer exists).
//                                      It also needs SHOPIFY_PARTNER_API_URL, SHOPIFY_PARTNER_API_ACCESS_TOKEN, SHOPIFY_APP_GID, SHOPIFY_API_KEY
//                                      and BILLING_PLAN_HANDLES (see the header of partner-api-verifier.server.js). If any is missing or unreadable
//                                      the verifier stays OFF and one warning lists the NAMES (never a value) that need attention.
//   SESSION_ANALYTICS_SOURCE=shopifyql builds the ShopifyQL session source (session-source.server.js); it needs read_reports on the shop
//                                      and Level 2 protected customer data approval.
//
// A service that is off is null: its worker step then does nothing, no subscription is ever marked verified, and no recommendation is ever
// invented. Neither service creates, approves or cancels anything: both only read.
//
// The Admin client (used only to read the shop's own id) comes from getShopAdmin, loaded on first use so that importing this file costs nothing.
const adminFor = (shopDomain) => import("./shopify-lookup.server").then((module) => module.getShopAdmin(shopDomain));

let warned = false;
export const resetBillingConfigWarning = () => {
  warned = false;
};

function buildVerifier(env, { getAdmin, fetchImpl, log }) {
  const check = readPartnerConfig(env);
  if (!check.ready) {
    if (!warned) {
      warned = true;
      log.warn(`[billing] BILLING_MECHANISM=app_pricing but the Partner API configuration is incomplete, so subscriptions are NOT verified. Missing: ${check.missing.join(", ") || "none"}. Unreadable: ${check.invalid.join(", ") || "none"}.`);
    }
    return null;
  }
  const { url, token, appGid, apiKey, handles } = check.config;
  return createPartnerApiVerifier({ client: createPartnerApiClient({ url, token, ...(fetchImpl ? { fetchImpl } : {}) }), appGid, apiKey, handles, getAdmin });
}

export function getBillingServices(env = process.env, { getAdmin = adminFor, fetchImpl, log = console } = {}) {
  const mechanism = String(env?.BILLING_MECHANISM ?? "").trim().toLowerCase();
  const source = String(env?.SESSION_ANALYTICS_SOURCE ?? "").trim().toLowerCase();
  return {
    verify: mechanism === APP_PRICING_SOURCE ? buildVerifier(env, { getAdmin, fetchImpl, log }) : null,
    fetchSessions: source === "shopifyql" ? createShopifyqlSessionSource({ getAdmin }) : null,
  };
}

// The same services for the WEB process (the Pricing page's verification check), built once: the verifier keeps a short-lived identity check
// in memory (see partner-api-verifier.server.js), which would be useless if every page load built a new one. The environment does not change
// while the process runs, so building once is exact. With the billing settings off, `verify` is null and the page never asks anyone anything.
let shared = null;
export const getSharedBillingServices = (env = process.env) => (shared ??= getBillingServices(env));
export const resetSharedBillingServices = () => {
  shared = null;
};
