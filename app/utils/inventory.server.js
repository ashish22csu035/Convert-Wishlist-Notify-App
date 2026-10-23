// Pure helpers for the storefront inventory lookup (no Shopify or database
// imports, so they can be unit-tested directly).

const NUMERIC_ID = /^[0-9]{1,20}$/;

// Highest quantity the storefront will ever be told about. It only limits what
// is shown in the quantity selector; Shopify's cart still validates the real stock.
export const MAX_REPORTED = 99;
export const MAX_VARIANTS_PER_REQUEST = 50;

// "1,2,3" -> ["1","2","3"]. Returns null for anything that is not a short list
// of numeric variant ids.
export function parseVariantIds(value) {
  const parts = String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > MAX_VARIANTS_PER_REQUEST) return null;
  if (!parts.every((part) => NUMERIC_ID.test(part))) return null;
  return [...new Set(parts)];
}

// Maximum quantity a customer can buy for one variant, following the store's
// actual selling policy:
//   - inventory not tracked            -> null (no limit)
//   - policy CONTINUE (oversell allowed) -> null (no limit)
//   - tracked and policy DENY          -> sellable online quantity, never below 0
// `null` means "do not limit"; it never means "sold out". Shopify's cart remains
// the final authority either way.
export function sellableCap(variant) {
  if (!variant) return null;
  const tracked = variant.inventoryItem?.tracked;
  if (tracked === false) return null;
  if (variant.inventoryPolicy === "CONTINUE") return null;
  if (variant.inventoryPolicy !== "DENY") return null;
  const quantity = variant.sellableOnlineQuantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) return null;
  return Math.min(Math.max(Math.trunc(quantity), 0), MAX_REPORTED);
}

// The ONE definition of "can a customer buy this variant online right now" used by Notify Me and the
// inventory webhook. Shopify updates its inventory fields at slightly different moments, so two signals
// are compared instead of trusting either:
//   sellableOnlineQuantity  stock at online-fulfilling locations, committed units already deducted
//   availableForSale        Shopify's own verdict
// Result:
//   "available"    both agree it can be bought (or stock is untracked / overselling is allowed)
//   "unavailable"  both agree it cannot (tracked, overselling denied, nothing sellable)
//   "unsettled"    they contradict each other (a stale field, or stock only at a non-online location):
//                  NOT proof of either state, so callers re-read later and never change state on it.
// A negative quantity (more committed than on hand) is not sellable, but it is never clamped into
// evidence of availability either.
export function classifyAvailability(variant) {
  if (!variant) return "unsettled";
  const verdict = typeof variant.availableForSale === "boolean" ? variant.availableForSale : null;
  const quantity = variant.sellableOnlineQuantity;
  const limited = variant.inventoryItem?.tracked !== false && variant.inventoryPolicy === "DENY";
  if (!limited) return verdict === false ? "unsettled" : "available";
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return verdict === false ? "unavailable" : "available"; // no quantity reported: not limiting, as before
  }
  if (quantity > 0) return verdict === false ? "unsettled" : "available";
  return verdict === true ? "unsettled" : "unavailable";
}
