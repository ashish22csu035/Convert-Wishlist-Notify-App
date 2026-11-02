import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadMerchantContext } from "../utils/merchant.server";
import { getOnboarding, saveOnboardingIntent } from "../models/settings.server";
import { SetupChecklist } from "../components/setup-checklist";
import { getAttribution, getDashboard, hasOrderScope } from "../models/reporting.server";
import { describeItem, fetchCatalog } from "../models/catalog.server";
import { ActivitySwitch } from "../components/activity-switch";
import { describePeriod } from "../utils/period";
import {
  Card,
  eventInfo,
  EmptyState,
  Feed,
  Grid,
  KpiCard,
  MerchantErrorBoundary,
  NoShopState,
  Page,
  ProductCell,
  Split,
  ToggleKpiCard,
  WISHLIST_ITEM_MODES,
  attributionView,
  formatMoney,
  formatNumber,
  timeAgo,
  wishlistItemsView,
} from "../components/merchant-ui";

export const loader = async ({ request }) => {
  const { admin, scope, shop, domain, days, period, view } = await loadMerchantContext(request);
  if (!shop) return { days, period: view, dashboard: null };
  // The setup checklist is a convenience: if its data cannot be read (for example the migration has not been applied
  // yet) the Dashboard still loads, without the checklist.
  const onboarding = await getOnboarding(shop.id).catch((error) => {
    console.error("[dashboard] the setup checklist could not be loaded", error?.code ?? error?.name ?? "error");
    return null;
  });
  const dashboard = await getDashboard(shop, period);
  const attribution = await getAttribution(shop.id, period, { scopeGranted: hasOrderScope(scope) });
  const catalog = await fetchCatalog(admin, {
    productGids: [...dashboard.topProducts, ...dashboard.recent].map((row) => row.productGid),
    variantGids: dashboard.recent.map((row) => row.variantGid),
  });
  return {
    days,
    period: view,
    // eslint-disable-next-line no-undef
    setup: onboarding ? { ...onboarding, shop: domain, apiKey: process.env.SHOPIFY_API_KEY || "" } : null,
    dashboard: {
      ...dashboard,
      attribution,
      catalogAvailable: catalog.available,
      currencyCode: catalog.currencyCode,
      topProducts: dashboard.topProducts.map((row) => ({ ...row, item: describeItem(catalog, row) })),
      recent: dashboard.recent.map((row) => ({ ...row, item: describeItem(catalog, row) })),
    },
  };
};

// One checklist change per request (confirm / undo a step, dismiss, show again). The shop comes from the Admin session.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const intent = (await request.formData()).get("intent");
  try {
    const state = typeof intent === "string" ? await saveOnboardingIntent(session.shop, intent) : null;
    return { ok: Boolean(state) };
  } catch (error) {
    console.error("[dashboard] the setup checklist could not be saved", error?.code ?? error?.name ?? "error");
    return { ok: false };
  }
};

const feedText = (event) => {
  const info = eventInfo(event.type);
  const name = event.item.title ? `“${event.item.title}”${event.item.variantTitle ? ` (${event.item.variantTitle})` : ""}` : "a product";
  if (event.type === "RESTOCK_EMAIL_SENT") return `${info.verb} ${name}`;
  return `A customer ${info.verb} ${name}${info.suffix ? ` ${info.suffix}` : ""}`;
};

export default function Dashboard() {
  const { period, setup, dashboard: d } = useLoaderData();
  const words = describePeriod(period);
  if (!d) {
    return (
      <Page title="Dashboard" subtitle="Here’s how Wishlist and Notify Me are performing." period={period}>
        <NoShopState />
      </Page>
    );
  }
  const w = d.activity.window;
  const revenue = attributionView(d.attribution, period);
  const nothingYet = d.series.days.length === 0 || Object.values(d.activity.allTime).every((n) => n === 0);

  return (
    <Page title="Dashboard" subtitle="Here’s how Wishlist and Notify Me are performing." period={period}>
      <Grid>
        <ToggleKpiCard
          label="Wishlist items"
          icon="heart"
          tone="violet"
          options={WISHLIST_ITEM_MODES.map((mode) => ({ ...mode, ...wishlistItemsView(d, mode.key) }))}
          initial="active"
          hint="Active: items customers have saved right now. All-time: every add ever recorded, including items later removed. Neither depends on the date range."
        />
        <KpiCard label="Unique Wishlist users" value={d.wishlistUsers.current} icon="person" tone="violet" note={words.label} hint="Different logged-in customers who saved, removed or opened a Wishlist item in the date range." />
        <KpiCard label="Wishlist sessions" value={d.sessions.current} icon="chart-line" tone="violet" note={`${words.label} · 30-minute sessions`} hint="A session is one customer's Wishlist visit; it lasts a fixed 30 minutes from its start. Counted inside the date range." />
        <KpiCard label="Active Notify Me subscriptions" value={d.subscriptions.ACTIVE} icon="notification" tone="blue" note={`Current total · ${formatNumber(w.NOTIFY_SUBSCRIBED)} new ${words.within}`} hint="Customers who are right now waiting for a sold-out item to come back. This is a current total, not a count for the date range." />
        <KpiCard label="Restock emails sent" value={w.RESTOCK_EMAIL_SENT} icon="email" tone="blue" note={`${formatNumber(d.deliveries.FAILED + d.deliveries.UNKNOWN)} failed or unknown · ${formatNumber(d.deliveries.PENDING + d.deliveries.SENDING)} queued (all time)`} hint="Restock emails accepted by the mail server in the date range. Accepted does not confirm the email reached the inbox or was opened." />
        {revenue.options ? (
          <ToggleKpiCard label="Attributed revenue" icon="cart" tone="green" options={revenue.options} initial="overall" hint="Eligible Wishlist saves and successful Notify Me restock emails can remain attributable for the customer's lifetime, subject to existing matching and removal rules. The 7-day window applies only to qualifying Add to Cart activity from My Wishlist." />
        ) : (
          <KpiCard label="Attributed revenue" value={null} display={revenue.setup.display} icon="cart" note={revenue.setup.note} hint="Eligible Wishlist saves and successful Notify Me restock emails can remain attributable for the customer's lifetime, subject to existing matching and removal rules. The 7-day window applies only to qualifying Add to Cart activity from My Wishlist." />
        )}
      </Grid>

      {setup ? <SetupChecklist setup={setup} /> : null}

      <Split>
        <Card title="Activity" action={{ to: "/app/analytics", label: "View analytics" }}>
          {nothingYet ? (
            <EmptyState heading="No activity yet">Wishlist and Notify Me activity will appear here once customers use them.</EmptyState>
          ) : (
            <ActivitySwitch series={d.series} rangeLabel={words.label} />
          )}
        </Card>
        <Card title="Recent activity" action={{ to: "/app/wishlist?tab=activity", label: "View Wishlist log" }}>
          {d.recent.length === 0 ? (
            <EmptyState heading="No activity yet">Customer activity will be listed here as it happens.</EmptyState>
          ) : (
            <Feed
              items={d.recent.map((event) => ({
                id: event.id,
                text: feedText(event),
                label: eventInfo(event.type).label,
                time: timeAgo(event.occurredAt, d.now),
                icon: eventInfo(event.type).icon,
                tone: eventInfo(event.type).tone,
              }))}
            />
          )}
        </Card>
      </Split>

      <Card title="Top wishlisted products" action={{ to: "/app/wishlist", label: "View all" }} flush>
        {d.topProducts.length === 0 ? (
          <EmptyState heading="No saved products">Products customers save to their Wishlist will be listed here.</EmptyState>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header format="numeric">Price</s-table-header>
              <s-table-header format="numeric">Saves</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.topProducts.map((row) => (
                <s-table-row key={row.productId}>
                  <s-table-cell>
                    <ProductCell title={row.item.title} fallback={`Product ${row.productId}`} imageUrl={row.item.imageUrl} href={`shopify://admin/products/${row.productId}`} subtitle={row.item.found || !d.catalogAvailable ? null : "No longer in your catalog"} />
                  </s-table-cell>
                  <s-table-cell>{formatMoney(row.item.price, d.currencyCode) ?? "—"}</s-table-cell>
                  <s-table-cell>{formatNumber(row.saves)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {d.topProducts.length > 0 ? <p className="kv-note">Saves = customer saves of any variant of the product, right now. Price is the current starting price.</p> : null}
        {!d.catalogAvailable && d.topProducts.length > 0 ? <p className="kv-note">Product images and prices could not be loaded from Shopify just now.</p> : null}
      </Card>
    </Page>
  );
}

export function ErrorBoundary() {
  return <MerchantErrorBoundary />;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
