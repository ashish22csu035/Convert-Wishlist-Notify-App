import { data, isRouteErrorResponse, useLoaderData, useLocation, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getAppearance, saveAppearance } from "../models/settings.server";
import { safeErrorSummary } from "../utils/storefront-auth.server";
import { withEmbeddedParams } from "../utils/embedded-url";
import { MerchantErrorBoundary } from "../components/merchant-ui";
import { WishlistSettingsForm } from "../components/wishlist-settings-form";

// /app/wishlist-settings: how the Wishlist looks and behaves on the storefront. A route of its own (not nested under
// /app/settings, which has no Outlet). The shop always comes from the authenticated Admin session; nothing the browser
// sends can name another shop. The Wishlist / Notify Me switches stay on /app/settings and are never touched here.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request); // a failed login throws its own response, which passes straight through
  let appearance;
  try {
    // A shop that never customised anything (no row, or a NULL column) comes back as the defaults.
    appearance = await getAppearance(session.shop);
  } catch (error) {
    // Typically the app server is running a database client older than the database (or the migration is missing).
    // Say so in the server log, and give the merchant a specific message instead of a blank or generic error page.
    console.error("[wishlist-settings] the appearance settings could not be loaded", JSON.stringify({ shop: session.shop, ...safeErrorSummary(error) }));
    throw data({ code: "appearance_unavailable" }, { status: 500 });
  }
  return {
    appearance,
    shop: session.shop,
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

// The server is the authority: it validates again with the rules the screen uses, and only a successful write is
// reported as saved. Only the appearance column is written.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const raw = (await request.formData()).get("appearance");
  if (typeof raw !== "string") return { ok: false, errors: { appearance: "The settings could not be read." } };
  try {
    return await saveAppearance(session.shop, raw);
  } catch (error) {
    console.error("[wishlist-settings] the appearance settings could not be saved", JSON.stringify({ shop: session.shop, ...safeErrorSummary(error) }));
    return { ok: false, errors: {}, failed: true };
  }
};

export default function WishlistSettingsPage() {
  const { appearance, shop, apiKey } = useLoaderData();
  return <WishlistSettingsForm appearance={appearance} shop={shop} apiKey={apiKey} />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const { search } = useLocation();
  if (isRouteErrorResponse(error) && error.data?.code === "appearance_unavailable") {
    return (
      <s-page heading="Wishlist Settings">
        <s-banner tone="critical" heading="Wishlist Settings could not be loaded">
          The appearance settings could not be read. Your Wishlist and Notify Me switches and your storefront are not affected. If this keeps happening after you reload, the app server may need to be restarted or updated: contact the app&apos;s developer.
        </s-banner>
        <p>
          <s-button onClick={() => window.location.reload()}>Reload page</s-button>{" "}
          <s-button onClick={() => navigate(withEmbeddedParams("/app/settings", search))}>Back to Settings</s-button>
        </p>
      </s-page>
    );
  }
  return <MerchantErrorBoundary />;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
