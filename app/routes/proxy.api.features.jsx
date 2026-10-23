import { authenticateStorefront, logFailure, newRequestId, noStoreJson } from "../utils/storefront-auth.server";
import { getFeatureFlags } from "../models/settings.server";

// GET /apps/konvert-notify/api/features -> { wishlist: true, notifyMe: true }
// Which storefront features the merchant has switched on, so the theme script can hide the Wishlist or Notify
// Me interface. Works for logged-out visitors too. The shop comes only from the signed proxy query; nothing
// is created and no customer data is read. The write endpoints enforce the same switches on the server.
export const loader = async ({ request }) => {
  const requestId = newRequestId();
  let shopDomain;
  try {
    const identity = await authenticateStorefront(request);
    shopDomain = identity.shopDomain;
    return noStoreJson(await getFeatureFlags(shopDomain), 200, requestId);
  } catch (error) {
    if (error instanceof Response) throw error;
    logFailure("GET features", requestId, error, shopDomain);
    return noStoreJson({ error: "server_error", requestId }, 500, requestId);
  }
};
