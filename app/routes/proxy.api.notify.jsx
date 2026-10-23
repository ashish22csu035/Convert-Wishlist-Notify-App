import {
  authenticateStorefront,
  logFailure,
  newRequestId,
  noStoreJson,
} from "../utils/storefront-auth.server";
import { toGid } from "../utils/shopify-ids.server";
import { WishlistError, recordNotifyMeOpen } from "../models/wishlist.server";
import { LookupError } from "../models/shopify-lookup.server";
import { listActiveSubscriptions, subscribeToNotify } from "../models/notify.server";
import { getFeatureFlags } from "../models/settings.server";
import { parseVariantIds } from "../utils/inventory.server";

// GET /apps/konvert-notify/api/notify?ids=1,2 -> { subscribed: ["1"] }
// Which of these variants the signed-in customer is already subscribed to, so every page
// can show the real state. Shop and customer come only from the signed proxy query; a
// logged-out visitor gets nothing. Nothing is created and no email is returned.
export const loader = async ({ request }) => {
  const requestId = newRequestId();
  let shopDomain;
  try {
    const identity = await authenticateStorefront(request);
    shopDomain = identity.shopDomain;
    if (!identity.customerGid) {
      return noStoreJson({ error: "login_required" }, 401, requestId);
    }
    const ids = parseVariantIds(new URL(request.url).searchParams.get("ids"));
    if (!ids) return noStoreJson({ error: "invalid_request" }, 400, requestId);
    const subscribed = await listActiveSubscriptions(
      identity,
      ids.map((id) => `gid://shopify/ProductVariant/${id}`),
    );
    return noStoreJson({ subscribed }, 200, requestId);
  } catch (error) {
    if (error instanceof Response) throw error;
    logFailure("GET notify", requestId, error, shopDomain);
    return noStoreJson({ error: "server_error", requestId }, 500, requestId);
  }
};

// Storefront URL: /apps/konvert-notify/api/notify (App Proxy -> /proxy/api/notify)
// op "open": starts a NOTIFY_ME engagement session.
// op "subscribe": one-click subscription. Only the variant id comes from the body;
// shop and customer come from the signed proxy query, the email from the Admin API.
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
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return noStoreJson({ error: "unsupported_media_type" }, 415, requestId);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return noStoreJson({ error: "invalid_json" }, 400, requestId);
    }
    if (!body || typeof body !== "object" || !["open", "subscribe"].includes(body.op)) {
      return noStoreJson({ error: "invalid_request" }, 400, requestId);
    }

    // The merchant switched Notify Me off: no new subscriptions or engagement. Existing subscriptions,
    // sent-email records and history are untouched, and turning it back on restores everything.
    if (!(await getFeatureFlags(identity.shopDomain)).notifyMe) {
      return noStoreJson({ error: "feature_disabled" }, 403, requestId);
    }

    let result;
    if (body.op === "subscribe") {
      const rawId = body.variantId;
      const variantGid =
        typeof rawId === "string" || typeof rawId === "number" ? toGid("ProductVariant", rawId) : null;
      if (!variantGid) return noStoreJson({ error: "invalid_request" }, 400, requestId);
      result = await subscribeToNotify(identity, variantGid, { storefrontSoldOut: body.storefrontSoldOut === true });
    } else {
      result = await recordNotifyMeOpen(identity);
    }
    return noStoreJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof WishlistError || error instanceof LookupError) {
      return noStoreJson({ error: error.code }, error.status, requestId);
    }
    logFailure("POST notify", requestId, error, shopDomain);
    return noStoreJson({ error: "server_error", requestId }, 500, requestId);
  }
};
