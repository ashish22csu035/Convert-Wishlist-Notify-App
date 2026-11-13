import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadMerchantContext } from "../utils/merchant.server";
import { loadPlanUsage, logManagePlanConfigOnce, readManagePlanConfig, verifyForPricingPage } from "../models/plan-usage.server";
import { getSharedBillingServices } from "../models/billing-services.server";
import { EmptyState, MerchantErrorBoundary, NoShopState, Page } from "../components/merchant-ui";
import { PlanUsage } from "../components/plan-usage";

// The shop comes from the verified Admin session (loadMerchantContext), never from the request: nothing in the URL (including the plan_handle
// and shop parameters Shopify appends when it redirects a merchant here after they approve a plan) is read or trusted. Opening this page runs the
// bounded, lease-protected subscription check (verifyForPricingPage: see plan-usage.server.js); with the billing settings off there is no verifier
// and nothing is asked. Everything shown is built on the server from what the app has verified.
export const loader = async ({ request }) => {
  const { shop, domain } = await loadMerchantContext(request);
  if (!shop) return { view: null };
  let verify = null;
  try {
    verify = getSharedBillingServices().verify;
  } catch {
    verify = null; // an unreadable billing configuration is "not checked", never a failed page
  }
  const check = await verifyForPricingPage(shop.id, { verify });
  logManagePlanConfigOnce(readManagePlanConfig(process.env, domain)); // names of missing settings, once, in the server log only
  return { view: await loadPlanUsage(shop.id, { shopDomain: domain, check }) };
};

export default function PlanPage() {
  const { view } = useLoaderData();
  const navigation = useNavigation();
  return (
    <Page title="Pricing" subtitle="Compare plans, see what we recommend for your store, and check what you have used.">
      {!view ? (
        navigation.state === "loading" ? (
          <EmptyState heading="Loading your plan…">One moment.</EmptyState>
        ) : (
          <NoShopState />
        )
      ) : (
        <PlanUsage view={view} />
      )}
    </Page>
  );
}

export function ErrorBoundary() {
  return <MerchantErrorBoundary />;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
