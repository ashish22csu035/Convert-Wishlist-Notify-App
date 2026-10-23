import {
  authenticateStorefront,
  logFailure,
  newRequestId,
  noStoreJson,
} from "../utils/storefront-auth.server";
import { parseVariantIds } from "../utils/inventory.server";
import { fetchSellableCaps } from "../models/inventory.server";

// Storefront URL: /apps/konvert-notify/api/inventory?ids=1,2 (App Proxy -> /proxy/api/inventory)
//
// Tells the My Wishlist page how many units of each variant can be bought, so
// the quantity selector can respect the store's real inventory policy. Requires
// a verified logged-in customer (signed proxy request). The shop comes only from
// the signed query; the Admin API is called server-side and no token is exposed.
// If Shopify cannot be reached the answer is { unavailable: true } and the page
// simply stops limiting quantity: Shopify's cart still validates every add.
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

    try {
      const variants = await fetchSellableCaps(shopDomain, ids);
      return noStoreJson({ variants, unavailable: false }, 200, requestId);
    } catch (error) {
      logFailure("GET inventory", requestId, error, shopDomain);
      return noStoreJson({ variants: {}, unavailable: true }, 200, requestId);
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    logFailure("GET inventory", requestId, error, shopDomain);
    return noStoreJson({ error: "server_error", requestId }, 500, requestId);
  }
};
