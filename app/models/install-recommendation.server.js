import { ensureShop } from "./settings.server";
import { getSharedBillingServices } from "./billing-services.server";
import { enqueuePlanRecommendations } from "./plan-recommendation.server";

// What happens, once the app has authenticated a shop (the afterAuth hook in app/shopify.server.js: it runs when Shopify's token exchange creates
// a session, i.e. on install, re-install and token refresh; Shopify has no separate "app installed" webhook, so no webhook is added or registered).
//
// It only makes sure the shop has its ONE plan-recommendation row (PENDING, due now) so the worker picks it up on its next run. It never calls
// Shopify, never reads analytics and never waits for a lookup: the lookup belongs to the worker (scripts/worker.mjs -> runBillingJobs).
// Everything it does is idempotent: the same authentication repeated, or two at once, leaves exactly one row (UNIQUE(shopId)), a shop that
// already has a pending, running or finished row is untouched, and a row that was waiting for the read_reports scope is released once the
// session carries it (all of that is enqueuePlanRecommendations). With no session source configured it does nothing.
// It must NEVER break authentication: every failure is swallowed and logged as a code only.
export async function onShopAuthenticated(session, { services = getSharedBillingServices(), ensure = ensureShop, enqueue = enqueuePlanRecommendations, log = console } = {}) {
  const domain = session?.shop;
  if (session?.isOnline || typeof domain !== "string" || !domain || typeof services?.fetchSessions !== "function") return { enqueued: false };
  try {
    const shop = await ensure(domain);
    const summary = await enqueue({ fetchSessions: services.fetchSessions, shopIds: [shop.id] });
    return { enqueued: true, ...summary };
  } catch (error) {
    log.error(`[billing] could not schedule the plan recommendation after authentication: ${error?.code ?? error?.name ?? "error"}`);
    return { enqueued: false, failed: true };
  }
}
