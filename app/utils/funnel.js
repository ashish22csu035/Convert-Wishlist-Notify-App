// The Wishlist and Notify Me funnels on the Analytics screen. Pure.
//
// Built only from events and attributions this app records, for the selected period. Each stage is a real
// number or unavailable (null: never shown as zero). They are counts for the same period, NOT a cohort: a
// customer who opens a Wishlist item or receives a restock email this week may have saved or subscribed last
// month, so a later stage is not a subset of an earlier one and no percentage between stages is shown.
// Add to cart and checkout are not recorded for these features and are never inferred.

import { formatMoney } from "./format.js";

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

const ATTRIBUTION_REASON = {
  needs_access: "Needs the read_orders permission so paid orders can be matched.",
  waiting: "No orders have been received yet.",
};

function stage(key, label, value, extra = {}) {
  const real = count(value);
  return { key, label, count: real, available: real !== null, reason: real === null ? extra.reason ?? null : null, ...(real !== null && extra.display ? { display: extra.display } : {}) };
}

// attribution: the result of reporting.getAttribution; feature: "wishlist" | "notifyMe".
function purchaseStages(attribution, feature) {
  const state = attribution?.state;
  if (state !== "ready") {
    const reason = ATTRIBUTION_REASON[state] ?? ATTRIBUTION_REASON.needs_access;
    return [stage("orders", "Attributed orders", null, { reason }), stage("revenue", "Attributed revenue", null, { reason })];
  }
  const result = attribution[feature];
  const mixed = Boolean(attribution.mixedCurrency) || !result || result.revenue === null;
  return [
    stage("orders", "Attributed orders", result?.orders ?? null, { reason: "Orders could not be matched." }),
    stage("revenue", "Attributed revenue", mixed ? null : Number(result.revenue), {
      reason: "Orders in more than one currency cannot be added together.",
      display: mixed ? undefined : formatMoney(result.revenue, attribution.currency) ?? undefined,
    }),
  ];
}

export function buildFeatureFunnel(feature, { window = {}, attribution = null } = {}) {
  if (feature === "notifyMe") {
    return {
      feature,
      title: "Notify Me",
      stages: [
        stage("subscribed", "Subscriptions", window.NOTIFY_SUBSCRIBED),
        stage("sent", "Restock emails sent", window.RESTOCK_EMAIL_SENT),
        ...purchaseStages(attribution, "notifyMe"),
      ],
      note: "Only emails the mail server accepted count as sent; queued, failed, skipped and unknown ones do not. Each figure is for the same period but can come from earlier events (an email can go to someone who subscribed last month), so no percentage between stages is shown.",
    };
  }
  return {
    feature: "wishlist",
    title: "Wishlist",
    stages: [
      stage("saved", "Products saved", window.WISHLIST_ADDED),
      stage("opened", "Opened from Wishlist", window.WISHLIST_PRODUCT_CLICKED),
      ...purchaseStages(attribution, "wishlist"),
    ],
    note: "Add to cart and checkout from the Wishlist are not tracked, so there are no steps between an open and an order. Each figure is for the same period but can come from earlier saves, so no percentage between stages is shown.",
  };
}

// True when the funnel has nothing to show: every real count is zero (unavailable stages do not count as activity).
export const isEmptyFunnel = (stages) => stages.every((item) => !item.available || item.count === 0);
