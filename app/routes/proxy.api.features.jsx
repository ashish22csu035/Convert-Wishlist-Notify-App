import { authenticateStorefront, logFailure, newRequestId, noStoreJson } from "../utils/storefront-auth.server";
import { getStorefrontFeatures } from "../models/settings.server";

// GET /apps/konvert-notify/api/features -> { wishlist: true, notifyMe: true, appearance: { version: 1, ... } }
// Which storefront features the merchant has switched on, so the theme script can hide the Wishlist or Notify
// Me interface, and how the merchant styled the Wishlist (a sparse, validated, display-only document: an empty
// one means "unchanged"). Works for logged-out visitors too. The shop comes only from the signed proxy query;
// nothing is created and no customer data is read. The write endpoints enforce the same switches on the server.
export const loader = async ({ request }) => {
  const requestId = newRequestId();
  let shopDomain;
  try {
    const identity = await authenticateStorefront(request);
    shopDomain = identity.shopDomain;
    return noStoreJson(await getStorefrontFeatures(shopDomain), 200, requestId);
  } catch (error) {
    if (error instanceof Response) throw error;
    logFailure("GET features", requestId, error, shopDomain);
    return noStoreJson({ error: "server_error", requestId }, 500, requestId);
  }
};
