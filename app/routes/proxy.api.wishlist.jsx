import {
  authenticateStorefront,
  logFailure,
  newRequestId,
  noStoreJson,
} from "../utils/storefront-auth.server";
import { getFeatureFlags } from "../models/settings.server";
import { cleanHandle, cleanTitle, toGid } from "../utils/shopify-ids.server";
import {
  WishlistError,
  addToWishlist,
  listWishlist,
  recordWishlistOpen,
  recordWishlistClick,
  recordWishlistCartAdd,
  removeFromWishlist,
} from "../models/wishlist.server";

// Storefront URL: /apps/konvert-notify/api/wishlist (App Proxy -> /proxy/api/wishlist)
//
// Identity comes only from Shopify's signed proxy parameters (see
// authenticateStorefront). Nothing in the body is used to pick a shop or customer.

function parseBody(body) {
  if (!body || typeof body !== "object") return null;
  // "open" = the My Wishlist page was opened. It carries no product: only the
  // signed query identifies the customer.
  if (body.op === "open") return { op: "open" };
  if (!["add", "remove", "click", "cart_add"].includes(body.op)) return null;

  const productGid = toGid("Product", body.productId);
  if (!productGid) return null;

  let variantGid = null;
  if (body.variantId !== undefined && body.variantId !== null && body.variantId !== "") {
    variantGid = toGid("ProductVariant", body.variantId);
    if (!variantGid) return null;
  }

  if (body.op === "cart_add" && !variantGid) return null;
  if (body.op !== "add") return { op: body.op, productGid, variantGid };

  // A wishlist item is a specific variant: an add without one is refused.
  if (!variantGid) return null;

  const handle = cleanHandle(body.handle);
  if (!handle) return null;
  return {
    op: "add",
    productGid,
    variantGid,
    handle,
    title: cleanTitle(body.title) ?? handle,
  };
}

export const loader = async ({ request }) => {
  const requestId = newRequestId();
  let shopDomain;
  try {
    const identity = await authenticateStorefront(request);
    shopDomain = identity.shopDomain;
    if (!identity.customerGid) {
      return noStoreJson({ loggedIn: false, items: [], count: 0 }, 200, requestId);
    }
    const items = await listWishlist(identity);
    return noStoreJson({ loggedIn: true, items, count: items.length }, 200, requestId);
  } catch (error) {
    if (error instanceof Response) throw error;
    logFailure("GET wishlist", requestId, error, shopDomain);
    return noStoreJson({ error: "server_error", requestId }, 500, requestId);
  }
};

export const action = async ({ request }) => {
  const requestId = newRequestId();
  let shopDomain;
  try {
    const identity = await authenticateStorefront(request);
    shopDomain = identity.shopDomain;

    if (request.method !== "POST") {
      return noStoreJson({ error: "method_not_allowed" }, 405, requestId);
    }
    if (!identity.customerGid) {
      return noStoreJson({ error: "login_required" }, 401, requestId);
    }
    // JSON only: a cross-site HTML form cannot send this content type, which
    // blocks cross-site request forgery against logged-in customers.
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return noStoreJson({ error: "unsupported_media_type" }, 415, requestId);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return noStoreJson({ error: "invalid_json" }, 400, requestId);
    }
    const input = parseBody(body);
    if (!input) return noStoreJson({ error: "invalid_request" }, 400, requestId);

    // The merchant switched Wishlist off: no new Wishlist activity. Removing a saved item stays possible so
    // customers can always clean up their list; nothing already stored is touched.
    if (input.op !== "remove" && !(await getFeatureFlags(identity.shopDomain)).wishlist) {
      return noStoreJson({ error: "feature_disabled" }, 403, requestId);
    }

    let result;
    if (input.op === "add") result = await addToWishlist(identity, input);
    else if (input.op === "remove") result = await removeFromWishlist(identity, input);
    else if (input.op === "open") result = await recordWishlistOpen(identity);
    else if (input.op === "cart_add") result = await recordWishlistCartAdd(identity, input);
    else result = await recordWishlistClick(identity, input);
    return noStoreJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof WishlistError) {
      return noStoreJson({ error: error.code }, error.status, requestId);
    }
    logFailure("POST wishlist", requestId, error, shopDomain);
    return noStoreJson({ error: "server_error", requestId }, 500, requestId);
  }
};
