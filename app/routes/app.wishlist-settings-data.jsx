import { authenticate } from "../shopify.server";
import { getAppearance } from "../models/settings.server";
import { safeErrorSummary } from "../utils/storefront-auth.server";

// Read-only data for the Wishlist Settings dialog on the Dashboard. It returns the same values as the /app/wishlist-settings
// loader, but answers { ok: false } instead of throwing, so a failure shows inside the dialog and never replaces the Dashboard
// with an error page. The shop comes from the Admin session only. Saving still goes to /app/wishlist-settings (its action).
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  try {
    // eslint-disable-next-line no-undef
    return { ok: true, appearance: await getAppearance(session.shop), shop: session.shop, apiKey: process.env.SHOPIFY_API_KEY || "" };
  } catch (error) {
    console.error("[wishlist-settings] the appearance settings could not be loaded", JSON.stringify({ shop: session.shop, ...safeErrorSummary(error) }));
    return { ok: false };
  }
};
