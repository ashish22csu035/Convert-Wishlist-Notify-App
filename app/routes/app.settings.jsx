import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/reporting.server";
import { getSettings, saveSettings } from "../models/settings.server";
import { validateSettings } from "../utils/settings-shared";
import { MerchantErrorBoundary } from "../components/merchant-ui";
import { SettingsForm } from "../components/settings-form";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  return { settings: await getSettings(shop?.id) };
};

// The server is the authority: it validates again with the same rules as the screen, and only a
// successful write is reported as saved.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { values, errors } = validateSettings(await request.formData());
  if (Object.keys(errors).length) return { ok: false, errors, values };
  try {
    await saveSettings(session.shop, values);
  } catch {
    return { ok: false, errors: {}, values, failed: true };
  }
  return { ok: true, errors: {}, values };
};

export default function SettingsPage() {
  const { settings } = useLoaderData();
  return <SettingsForm settings={settings} />;
}

export function ErrorBoundary() {
  return <MerchantErrorBoundary />;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
