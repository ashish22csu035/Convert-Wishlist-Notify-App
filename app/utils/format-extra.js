// Display helpers added for the merchant screens: delivery reasons and status help.
// Pure (no React, no server imports); re-exported from format.js.

// Plain-language reasons for delivery codes, so the merchant never sees raw internal error codes.
const DELIVERY_REASONS = {
  subscription_not_active: "Customer unsubscribed or was already notified",
  already_covered: "Customer subscribed after the restock",
  out_of_stock_again: "Item sold out again before the email was sent",
  product_unavailable: "Product no longer available",
  notify_disabled: "Notify Me was switched off in Settings",
  no_recipient: "No valid recipient address",
  subscription_missing: "Subscription no longer exists",
  variant_mismatch: "Subscription no longer matches the item",
  shop_inactive: "Store inactive",
  max_attempts: "Gave up after repeated attempts",
  lease_expired: "Interrupted while sending; the result is unknown",
  send_outcome_unknown: "Connection lost while sending; it may or may not have arrived",
  shop_unavailable: "Shopify could not be reached; will retry",
  product_lookup_failed: "Product details could not be read; will retry",
};

export function deliveryReason(code) {
  if (!code) return null;
  if (DELIVERY_REASONS[code]) return DELIVERY_REASONS[code];
  if (String(code).startsWith("smtp_")) return "The mail server declined or could not be reached";
  return "Could not be sent";
}

// What each status means, shown as help text next to the filters.
export const STATUS_HELP = {
  ACTIVE: "Waiting for the item to come back in stock.",
  FULFILLED: "Notified: a restock email was accepted by the mail server.",
  UNSUBSCRIBED: "The customer opted out.",
  PENDING: "Queued: waiting for the email worker.",
  SENDING: "Being sent right now.",
  SENT: "Accepted by the mail server. This does not confirm it reached the inbox or was opened.",
  FAILED: "Could not be sent after the allowed attempts, or refused outright.",
  UNKNOWN: "The connection broke mid-send, so it may or may not have arrived. Never resent automatically.",
  SKIPPED: "No longer needed (for example the customer unsubscribed or the item sold out again).",
};
