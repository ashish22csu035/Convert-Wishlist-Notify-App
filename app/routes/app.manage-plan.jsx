import { authenticate } from "../shopify.server";
import { buildManagePlanUrl } from "../models/plan-usage.server";

// "Manage plan": sends the merchant to Shopify's hosted plan selection page (Shopify App Pricing), following Shopify's guidance that the page is
// outside the app's iframe and needs a TOP-LEVEL redirect (`target: "_top"`).
//
// The destination is built from exactly two things: the shop domain of the VERIFIED Admin session, and operator configuration
// (SHOPIFY_APP_HANDLE and SHOPIFY_PLAN_SELECTION_URL_TEMPLATE, see plan-usage.server.js). Nothing in the request (a query parameter, a form
// field, a header) can choose or change the address. If the configuration is missing or unsafe there is no destination, and the merchant is
// simply returned to the Plan and usage page. This route creates, approves and cancels nothing: Shopify's own page does that.
export const loader = async ({ request }) => {
  const { session, redirect } = await authenticate.admin(request);
  const url = buildManagePlanUrl({
    // eslint-disable-next-line no-undef
    template: process.env.SHOPIFY_PLAN_SELECTION_URL_TEMPLATE,
    // eslint-disable-next-line no-undef
    appHandle: process.env.SHOPIFY_APP_HANDLE,
    shopDomain: session.shop,
  });
  if (!url) return redirect("/app/plan");
  return redirect(url, { target: "_top" });
};
