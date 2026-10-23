import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadMerchantContext } from "../utils/merchant.server";
import { getAnalytics, getAttribution, hasOrderScope } from "../models/reporting.server";
import { describeItem, fetchCatalog } from "../models/catalog.server";
import { FunnelSwitch } from "../components/product-funnel";
import { buildFeatureFunnel } from "../utils/funnel";
import { describePeriod } from "../utils/period";
import { Card, EmptyState, Grid, KpiCard, MerchantErrorBoundary, NoShopState, Page, ProductCell, deltaOf, formatMoney, formatNumber } from "../components/merchant-ui";

export const loader = async ({ request }) => {
  const { admin, scope, shop, days, period, view } = await loadMerchantContext(request);
  if (!shop) return { days, period: view, analytics: null };
  const analytics = await getAnalytics(shop, period);
  const attribution = await getAttribution(shop.id, period, { scopeGranted: hasOrderScope(scope) });
  const catalog = await fetchCatalog(admin, { productGids: [...analytics.topProducts, ...(attribution.topProducts ?? [])].map((row) => row.productGid) });
  // Both funnels use this app's own records for the same period (the counts the Dashboard uses and the shared
  // attribution service); nothing is read from, or inferred about, store traffic.
  const funnels = {
    wishlist: buildFeatureFunnel("wishlist", { window: analytics.activity.window, attribution }),
    notifyMe: buildFeatureFunnel("notifyMe", { window: analytics.activity.window, attribution }),
  };
  return {
    days,
    period: view,
    funnels,
    analytics: {
      ...analytics,
      attribution: { ...attribution, topProducts: (attribution.topProducts ?? []).map((row) => ({ ...row, item: describeItem(catalog, row) })) },
      catalogAvailable: catalog.available,
      topProducts: analytics.topProducts.map((row) => ({ ...row, item: describeItem(catalog, row) })),
    },
  };
};

export default function AnalyticsPage() {
  const { days, period, analytics: a, funnels } = useLoaderData();
  const words = describePeriod(period);
  if (!a) {
    return (
      <Page title="Analytics" subtitle="Wishlist and Notify Me performance." period={period}>
        <NoShopState />
      </Page>
    );
  }
  const w = a.activity.window;
  const p = a.activity.previous;

  return (
    <Page title="Analytics" subtitle="Wishlist and Notify Me performance." period={period}>
      <Grid>
        <KpiCard label="Products added to Wishlist" value={w.WISHLIST_ADDED} icon="heart" tone="violet" delta={p ? deltaOf(w.WISHLIST_ADDED, p.WISHLIST_ADDED) : null} days={days} note={p ? undefined : words.label} hint="Add events recorded in the date range, including items removed later." />
        <KpiCard label="Products removed from Wishlist" value={w.WISHLIST_REMOVED} icon="minus-circle" tone="violet" delta={p ? deltaOf(w.WISHLIST_REMOVED, p.WISHLIST_REMOVED) : null} days={days} note={p ? undefined : words.label} hint="Remove events recorded in the date range." />
        <KpiCard label="Notify Me subscriptions" value={w.NOTIFY_SUBSCRIBED} icon="notification" tone="blue" delta={p ? deltaOf(w.NOTIFY_SUBSCRIBED, p.NOTIFY_SUBSCRIBED) : null} days={days} note={p ? undefined : words.label} hint="New sign-ups in the date range." />
        <KpiCard label="Restock emails sent" value={w.RESTOCK_EMAIL_SENT} icon="email" tone="blue" delta={p ? deltaOf(w.RESTOCK_EMAIL_SENT, p.RESTOCK_EMAIL_SENT) : null} days={days} note={p ? undefined : words.label} hint="Emails accepted by the mail server in the date range. This does not confirm delivery to the inbox or opens." />
      </Grid>

      <Grid>
        <KpiCard label="Wishlist sessions" value={a.sessionActivity.wishlist.current} icon="chart-line" tone="violet" delta={deltaOf(a.sessionActivity.wishlist.current, a.sessionActivity.wishlist.previous)} days={days} note={a.sessionActivity.wishlist.previous === null ? (a.sessionActivity.wishlist.current === null ? "Some Wishlist events have no session recorded" : words.label) : undefined} hint="Distinct browsing sessions with Wishlist activity (a save, removal or open of a saved product) in the date range. Each session counts once however much it does. These are sessions, not customers and not total events." />
        <KpiCard label="Notify Me sessions" value={a.sessionActivity.notifyMe.current} icon="chart-line" tone="blue" delta={deltaOf(a.sessionActivity.notifyMe.current, a.sessionActivity.notifyMe.previous)} days={days} note={a.sessionActivity.notifyMe.previous === null ? (a.sessionActivity.notifyMe.current === null ? "Some Notify Me events have no session recorded" : words.label) : undefined} hint="Distinct browsing sessions in which a customer signed up for Notify Me in the date range. Each session counts once. These are sessions, not customers and not total events; emails sent from the worker are not sessions." />
      </Grid>

      <Card title="Product funnel">
        <FunnelSwitch funnels={funnels} rangeLabel={words.label} />
      </Card>

      <div className="kv-grid two">
        <Card title="Most wishlisted products" action={{ to: "/app/wishlist", label: "View all" }} flush>
          {a.topProducts.length === 0 ? (
            <EmptyState heading="No saved products">Products customers save will be ranked here.</EmptyState>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header format="numeric">Saves</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {a.topProducts.map((row) => (
                  <s-table-row key={row.productId}>
                    <s-table-cell>
                      <ProductCell title={row.item.title} fallback={`Product ${row.productId}`} imageUrl={row.item.imageUrl} href={`shopify://admin/products/${row.productId}`} />
                    </s-table-cell>
                    <s-table-cell>{formatNumber(row.saves)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </Card>
        <Card title="Top customers by activity" action={{ to: "/app/customers?sort=activity", label: "View all" }} flush>
          {a.topCustomers.length === 0 ? (
            <EmptyState heading="No customer activity">Customers with the most activity in this period will be ranked here.</EmptyState>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Customer</s-table-header>
                <s-table-header format="numeric">Saved items</s-table-header>
                <s-table-header format="numeric">Active Notify Me</s-table-header>
                <s-table-header format="numeric">{`Activity (${words.label})`}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {a.topCustomers.map((row) => (
                  <s-table-row key={row.customerId}>
                    <s-table-cell>
                      <s-link href={`shopify://admin/customers/${row.customerId}`}>Customer {row.customerId}</s-link>
                    </s-table-cell>
                    <s-table-cell>{formatNumber(row.savedItems)}</s-table-cell>
                    <s-table-cell>{formatNumber(row.activeSubscriptions)}</s-table-cell>
                    <s-table-cell>{formatNumber(row.activity)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </Card>
      </div>

      <Card title="Attributed revenue">
        {a.attribution.state !== "ready" ? (
          <EmptyState heading={a.attribution.state === "waiting" ? "Waiting for orders" : "Order permission needed"}>
            {a.attribution.state === "waiting"
              ? "The order permission is granted, but no order has been received yet. Revenue appears after an order is paid."
              : "Approve the order permission (read_orders) in Shopify so paid orders can be matched to Wishlist and Notify Me. No revenue is shown until orders are collected."}
          </EmptyState>
        ) : a.attribution.mixedCurrency ? (
          <EmptyState heading="Revenue not shown">Orders in this period use more than one currency, and different currencies are never added together.</EmptyState>
        ) : (
          <>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Source</s-table-header>
                <s-table-header format="numeric">Attributed orders</s-table-header>
                <s-table-header format="numeric">Attributed revenue</s-table-header>
                <s-table-header format="numeric">Full value of those orders</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {[
                  ["Overall", a.attribution.overall],
                  ["Wishlist", a.attribution.wishlist],
                  ["Notify Me", a.attribution.notifyMe],
                ].map(([label, row]) => (
                  <s-table-row key={label}>
                    <s-table-cell>{label}</s-table-cell>
                    <s-table-cell>{formatNumber(row.orders)}</s-table-cell>
                    <s-table-cell>{formatMoney(row.revenue, a.attribution.currency)}</s-table-cell>
                    <s-table-cell>{formatMoney(row.orderValue, a.attribution.currency)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        )}
      </Card>

      {a.attribution.state === "ready" && !a.attribution.mixedCurrency ? (
        <Card title="Products that earned attributed revenue" flush>
          {a.attribution.topProducts.length === 0 ? (
            <EmptyState heading="No attributed purchases">No order in this period matched a Wishlist save or a sent restock email.</EmptyState>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header format="numeric">Attributed orders</s-table-header>
                <s-table-header format="numeric">Attributed revenue</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {a.attribution.topProducts.map((row) => (
                  <s-table-row key={row.productId}>
                    <s-table-cell>
                      <ProductCell title={row.item.title} fallback={`Product ${row.productId}`} imageUrl={row.item.imageUrl} href={`shopify://admin/products/${row.productId}`} />
                    </s-table-cell>
                    <s-table-cell>{formatNumber(row.orders)}</s-table-cell>
                    <s-table-cell>{formatMoney(row.revenue, a.attribution.currency)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </Card>
      ) : null}

    </Page>
  );
}

export function ErrorBoundary() {
  return <MerchantErrorBoundary />;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
