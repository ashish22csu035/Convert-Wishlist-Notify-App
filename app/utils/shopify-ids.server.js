const NUMERIC_ID = /^[0-9]{1,20}$/;
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const HANDLE = /^[\p{L}\p{N}_-]{1,255}$/u;

// Accepts a numeric id ("123") or a full GID ("gid://shopify/Product/123") and
// always returns the full GID, or null when the value is not valid for `type`.
export function toGid(type, value) {
  const text = String(value ?? "").trim();
  if (NUMERIC_ID.test(text)) return `gid://shopify/${type}/${text}`;
  const match = new RegExp(`^gid://shopify/${type}/([0-9]{1,20})$`).exec(text);
  return match ? text : null;
}

// "gid://shopify/Product/123" -> "123"
export function numericId(gid) {
  return gid ? String(gid).split("/").pop() : null;
}

export function toShopDomain(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return SHOP_DOMAIN.test(text) ? text : null;
}

export function cleanHandle(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return HANDLE.test(text) ? text : null;
}

// Strips control characters and caps the length of customer-visible text.
export function cleanTitle(value, max = 255) {
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
}
