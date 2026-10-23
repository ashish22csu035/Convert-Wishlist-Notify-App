// Pure display helpers for the merchant screens (no React, no server imports).
import { describePeriod } from "./period.js";

const NUMBER = new Intl.NumberFormat("en-US");
export const formatNumber = (value) => (typeof value === "number" ? NUMBER.format(value) : "Unavailable");

export function formatMoney(amount, currencyCode) {
  const value = Number(amount);
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode || "USD" }).format(value);
  } catch {
    return NUMBER.format(value);
  }
}

// Fixed UTC format so the server render and the browser render always agree.
export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// "5 minutes ago", measured against the time the server loaded the page, so it never differs between
// server and browser. Older than a week falls back to the exact date.
export function timeAgo(value, now) {
  const then = new Date(value).getTime();
  const base = new Date(now).getTime();
  if (Number.isNaN(then) || Number.isNaN(base)) return "—";
  const seconds = Math.max(0, Math.round((base - then) / 1000));
  if (seconds < 60) return "just now";
  const unit = (n, name) => `${n} ${name}${n === 1 ? "" : "s"} ago`;
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), "hour");
  if (seconds < 7 * 86400) return unit(Math.floor(seconds / 86400), "day");
  return formatDate(value);
}

// Real period-over-period change in percent, or null when there is nothing meaningful to compare against.
export function deltaOf(current, previous) {
  if (typeof current !== "number" || typeof previous !== "number" || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// The two readings of the Dashboard's "Wishlist items" card, from figures the dashboard already holds:
//   active    rows in WishlistItem right now (a removal deletes its row), so removed items are not counted;
//             a snapshot of today, so the dashboard's date range does not apply to it
//   all-time  WISHLIST_ADDED events since tracking began; removals do not subtract from it
// Never mixes the two, and never turns a missing figure into 0.
export const WISHLIST_ITEM_MODES = [
  { key: "active", label: "Active" },
  { key: "all", label: "All-time" },
];

export function wishlistItemsView(dashboard, mode) {
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  if (mode === "all") {
    return { value: number(dashboard?.activity?.allTime?.WISHLIST_ADDED), caption: "Total wishlist additions, including items later removed" };
  }
  return { value: number(dashboard?.wishlist?.savedItems), caption: "Currently saved by customers" };
}

// The Dashboard's attributed-revenue card. Pure: turns the attribution report into what the card shows.
//   state "needs_access" / "waiting": a setup message, never a number (nothing has been collected)
//   state "ready": one option per feature; a confirmed zero is shown as zero
// Revenue is the net revenue of the eligible purchased line items, not the order total.
export const ATTRIBUTION_MODES = [
  { key: "overall", label: "Overall" },
  { key: "wishlist", label: "Wishlist" },
  { key: "notifyMe", label: "Notify Me" },
];

// The long explanations live in a tooltip (the card's (i) icon), not on the card: the card itself shows the
// figure, the order count and, when there are orders, the full value of those orders.
const ATTRIBUTION_CAPTIONS = {
  overall: "Revenue from purchased items credited to Wishlist or Notify Me. Each order is counted once.",
  wishlist: "Revenue from purchased products customers had saved to their Wishlist.",
  notifyMe: "Revenue from items bought after a restock email for them was sent.",
};
export const ATTRIBUTION_FOOTNOTE = "Only the eligible purchased items are counted, not the whole order. Last touch within 7 days: it shows association, not proof of cause.";
const ATTRIBUTION_ORDER_DATES = "Orders are dated by when they were placed, within the date range. Refunds on the credited items are subtracted.";

// `range` is a number of days (a preset) or the period the screen shows ({ kind, days, from, to }).
export function rangeWords(range) {
  if (range && typeof range === "object" && range.kind === "custom") return describePeriod(range).label;
  return `last ${typeof range === "object" ? range.days : range} days`;
}

export function attributionView(attribution, range) {
  if (!attribution || attribution.state === "needs_access") {
    return { setup: { display: "Set up", note: "Approve the new order permission (read_orders) in Shopify to start tracking orders and revenue." } };
  }
  if (attribution.state === "waiting") {
    return { setup: { display: "Waiting for orders", note: "No orders have been received yet. Revenue appears here after an order is paid." } };
  }
  const options = ATTRIBUTION_MODES.map(({ key, label }) => {
    const result = attribution[key];
    const unavailable = !result || result.revenue === null;
    const orders = result?.orders ?? 0;
    const details = unavailable ? [] : [`${formatNumber(orders)} attributed ${orders === 1 ? "order" : "orders"} · ${rangeWords(range)}`];
    if (!unavailable && orders > 0) details.push(`Full order value: ${formatMoney(result.orderValue, attribution.currency)}`);
    return {
      key,
      label,
      value: unavailable ? null : orders,
      display: unavailable ? undefined : formatMoney(result.revenue, attribution.currency) ?? undefined,
      details,
      hint: `${ATTRIBUTION_CAPTIONS[key]} ${ATTRIBUTION_FOOTNOTE} ${ATTRIBUTION_ORDER_DATES}`,
      unavailableNote: "Orders in more than one currency cannot be added together.",
    };
  });
  return { options };
}

export { STATUS_HELP, deliveryReason } from "./format-extra.js";
