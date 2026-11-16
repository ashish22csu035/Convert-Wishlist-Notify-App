// The Wishlist and Notify Me Product Funnels on the Analytics screen. Pure.
//
// Built only from what this app records. Each stage is a real number or unavailable (null: never shown as zero).
// The stages are counts, NOT a cohort: a customer who adds to the cart this week may have saved last month, so a later
// stage is not a subset of an earlier one and no percentage between stages is shown.
//
// What each stage counts (the unit is part of the definition):
//   Wishlist   Products saved       save EVENTS, all time (a product saved, removed and saved again is two)
//              Added to cart        cart additions confirmed by Shopify's cart from the Wishlist page, in the selected dates (events)
//              Checkout initiated   checkouts of a logged-in customer holding a product they added from the Wishlist in the
//                                   last 7 days, in the selected dates (one per checkout)
//              Attributed revenue   revenue of the matching eligible order line items, and the distinct orders they sit on
//   Notify Me  Total subscriptions  every subscription ever created, active or not, all time (rows)
//              Restock emails sent  emails the mail server accepted, in the selected dates (queued, failed, skipped and
//                                   unknown deliveries never count)
//              Added to cart        the emailed variant added to the cart after the customer came from the email's link (one per
//                                   email, only for a signed-in customer; a real zero when none, unavailable only when the day
//                                   summaries are not calculated yet). Counted from when this tracking started.
//              Checkout initiated   checkouts holding a variant the customer was emailed a restock notice for in the last 7 days
//              Attributed revenue   as above
// Date scope: "all-time" stages ignore the selected dates; every other stage follows them.

import { formatMoney } from "./format.js";

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

const ATTRIBUTION_REASON = {
  needs_access: "Needs the read_orders permission so paid orders can be matched.",
  waiting: "No orders have been received yet.",
};

const NOT_CALCULATED = "Not calculated yet. It appears after the next summary refresh.";

function stage(key, label, value, extra = {}) {
  const real = count(value);
  return {
    key,
    label,
    count: real,
    available: real !== null,
    reason: real === null ? extra.reason ?? NOT_CALCULATED : null,
    scope: extra.scope ?? "range",
    ...(real !== null && extra.display ? { display: extra.display } : {}),
    ...(extra.orders !== undefined ? { orders: extra.orders } : {}),
  };
}

// attribution: the result of reporting.getAttribution; feature: "wishlist" | "notifyMe".
function revenueStage(attribution, feature) {
  const state = attribution?.state;
  if (state !== "ready") {
    return stage("revenue", "Attributed revenue", null, { reason: ATTRIBUTION_REASON[state] ?? ATTRIBUTION_REASON.needs_access, orders: null });
  }
  const result = attribution[feature];
  const orders = count(result?.orders);
  const mixed = Boolean(attribution.mixedCurrency) || !result || result.revenue === null;
  return stage("revenue", "Attributed revenue", mixed ? null : Number(result.revenue), {
    reason: orders === null ? "Orders could not be matched." : "Orders in more than one currency cannot be added together.",
    display: mixed ? undefined : formatMoney(result.revenue, attribution.currency) ?? undefined,
    orders,
  });
}

// summary: reporting.getFunnelSummary; attribution: reporting.getAttribution.
export function buildFeatureFunnel(feature, { summary = null, attribution = null } = {}) {
  const range = summary?.range ?? {};
  const allTime = summary?.allTime ?? {};
  // A figure built from fewer days than the range holds is a lower bound: the screen says so under the funnel.
  const partial = Boolean((summary?.range?.coverage && !summary.range.coverage.complete) || (summary?.allTime?.coverage && !summary.allTime.coverage.complete));
  if (feature === "notifyMe") {
    return {
      feature,
      title: "Notify Me",
      partial,
      stages: [
        stage("subscribed", "Total subscriptions", allTime.notifySubscriptions, { scope: "all-time" }),
        stage("sent", "Restock emails sent", range.restockEmailsSent),
        stage("cart", "Added to cart", range.notifyAddedToCart),
        stage("checkout", "Checkout initiated", range.notifyCheckouts),
        revenueStage(attribution, "notifyMe"),
      ],
    };
  }
  return {
    feature: "wishlist",
    title: "Wishlist",
    partial,
    stages: [
      stage("saved", "Products saved", allTime.wishlistSaved, { scope: "all-time" }),
      stage("cart", "Added to cart", range.wishlistAddedToCart),
      stage("checkout", "Checkout initiated", range.wishlistCheckouts),
      revenueStage(attribution, "wishlist"),
    ],
  };
}

// True when the funnel has nothing to show: every real figure is zero (unavailable stages do not count as activity).
export const isEmptyFunnel = (stages) => stages.every((item) => !item.available || (item.count === 0 && !item.orders));
