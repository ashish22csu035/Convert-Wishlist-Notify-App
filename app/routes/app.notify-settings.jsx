import { data, isRouteErrorResponse, useLoaderData, useLocation, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getNotifySettings, saveNotifySettings } from "../models/settings.server";
import { safeErrorSummary } from "../utils/storefront-auth.server";
import { withEmbeddedParams } from "../utils/embedded-url";
import { MerchantErrorBoundary } from "../components/merchant-ui";
import { NotifySettingsForm } from "../components/notify-settings-form";

// /app/notify-settings: the Notify Me button on the storefront and the back-in-stock email. Same shape as
// /app/wishlist-settings: the shop always comes from the authenticated Admin session, nothing the browser sends can name
// another shop, and the Wishlist / Notify Me switches stay on /app/settings and are never touched here. Saving only
// stores settings; emails are sent by the restock worker, never by this page.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  try {
    return { settings: await getNotifySettings(session.shop) };
  } catch (error) {
    console.error("[notify-settings] the settings could not be loaded", JSON.stringify({ shop: session.shop, ...safeErrorSummary(error) }));
    throw data({ code: "notify_settings_unavailable" }, { status: 500 });
  }
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const raw = (await request.formData()).get("settings");
  if (typeof raw !== "string") return { ok: false, errors: { settings: "The settings could not be read." } };
  try {
    return await saveNotifySettings(session.shop, raw);
  } catch (error) {
    console.error("[notify-settings] the settings could not be saved", JSON.stringify({ shop: session.shop, ...safeErrorSummary(error) }));
    return { ok: false, errors: {}, failed: true };
  }
};

export default function NotifySettingsPage() {
  const { settings } = useLoaderData();
  return <NotifySettingsForm settings={settings} />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const { search } = useLocation();
  if (isRouteErrorResponse(error) && error.data?.code === "notify_settings_unavailable") {
    return (
      <s-page heading="Notify Me Settings">
        <s-banner tone="critical" heading="Notify Me Settings could not be loaded">
          The settings could not be read. Your Notify Me switch, subscriptions and emails are not affected. If this keeps happening after you reload, the app server may need to be restarted or updated: contact the app&apos;s developer.
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
