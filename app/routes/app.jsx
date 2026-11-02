import { useEffect } from "react";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { authResponseBoundary, setAppRendered } from "../components/merchant-ui";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const navigation = useNavigation();

  useEffect(() => {
    setAppRendered(true); // from now on an authentication response is a client-side navigation, not a first page load
  }, []);

  // One loading indicator for every page change: a spinner centred in the content area (the app's own frame, so Shopify's
  // sidebar and header are never covered). While it shows, the page that is leaving fades out (css: html[data-kv-loading]),
  // so half-old content never sits next to a spinner. Nothing is added to or removed from the page flow, so nothing shifts.
  const loading = navigation.state === "loading";
  useEffect(() => {
    document.documentElement.toggleAttribute("data-kv-loading", loading);
    return () => document.documentElement.removeAttribute("data-kv-loading");
  }, [loading]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/wishlist">Wishlist</s-link>
        <s-link href="/app/notify-me">Notify Me</s-link>
        <s-link href="/app/customers">Engaged customers</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {loading ? (
        <div className="kv-loading" role="status" aria-live="polite">
          <s-spinner size="large" accessibilityLabel="Loading page" />
        </div>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  return authResponseBoundary(error) ?? boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
