import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { describePeriod } from "../utils/period";
import { loadMerchantContext } from "../utils/merchant.server";
import { cleanQuery, getAttribution, getWishlistActivity, getWishlistOverview, getWishlistProducts, hasOrderScope, parseChoice } from "../models/reporting.server";
import { describeItem, fetchCatalog } from "../models/catalog.server";
import { WISHLIST_ACTIVITY_FILTERS, WISHLIST_SORTS } from "../utils/dashboard-constants";
import {
  Card,
  EVENT,
  EmptyState,
  Grid,
  KpiCard,
  MerchantErrorBoundary,
  NoShopState,
  Page,
  Pager,
  ParamSelect,
  ProductCell,
  SearchBox,
  Tabs,
  attributionView,
  formatDate,
  formatMoney,
  formatNumber,
} from "../components/merchant-ui";

const TABS = [
  ["products", "Wishlisted products"],
  ["activity", "Wishlist activity log"],
];

export const loader = async ({ request }) => {
  const { admin, scope, shop, days, period, view, page, params } = await loadMerchantContext(request);
  const tab = parseChoice(params.get("tab"), Object.fromEntries(TABS), "products");
  if (!shop) return { days, period: view, tab, page, overview: null };

  const q = cleanQuery(params.get("q"));
  const sort = parseChoice(params.get("sort"), WISHLIST_SORTS, "saves");
  const overview = await getWishlistOverview(shop.id, period);
  const attribution = await getAttribution(shop.id, period, { scopeGranted: hasOrderScope(scope) });
  const type = parseChoice(params.get("type"), WISHLIST_ACTIVITY_FILTERS, "all");

  if (tab === "activity") {
    const list = await getWishlistActivity(shop.id, { page, days: period, type });
    const catalog = await fetchCatalog(admin, { productGids: list.rows.map((r) => r.productGid), variantGids: list.rows.map((r) => r.variantGid) });
    return { days, period: view, tab, page, overview, attribution, type, q, sort, total: list.total, rows: list.rows.map((row) => ({ ...row, item: describeItem(catalog, row) })), catalogAvailable: catalog.available };
  }

  const list = await getWishlistProducts(shop.id, { q, sort, page });
  const catalog = await fetchCatalog(admin, { productGids: list.rows.map((r) => r.productGid), variantGids: list.rows.map((r) => r.variantGid) });
  return {
    days,
    period: view,
    tab,
    page,
    overview,
    attribution,
    q,
    sort,
    total: list.total,
    rows: list.rows.map((row) => ({ ...row, item: describeItem(catalog, { ...row, fallbackTitle: row.fallbackTitle }) })),
    catalogAvailable: catalog.available,
    currencyCode: catalog.currencyCode,
  };
};

export default function WishlistPage() {
  const data = useLoaderData();
  const { period, tab, page, overview } = data;
  const words = describePeriod(period);
  const revenue = attributionView(data.attribution, period);
  const revenueOption = revenue.options?.find((option) => option.key === "wishlist");
  const revenueSetup = revenue.setup;
  return (
    <Page title="Wishlist" subtitle="Products customers save, and what they do with them." period={period}>
      {!overview ? (
        <NoShopState />
      ) : (
        <>
          <Grid>
            <KpiCard label="Saved items" value={overview.totals.savedItems} icon="heart" tone="violet" note="Current total: one per customer and variant" hint="How many items customers have saved right now. Removed items are not counted, and it does not depend on the date range." />
            <KpiCard label="Wishlisted products" value={overview.totals.products} icon="product" tone="violet" note="Current total: distinct products" hint="Different products with at least one saved variant right now. Saved items can be higher, because one product can be saved in several variants or by several customers." />
            <KpiCard label="Customers with saved items" value={overview.totals.customers} icon="person" tone="violet" note="Current total" hint="Logged-in customers who have at least one item saved right now." />
            <KpiCard label={`Added (${words.label})`} value={overview.window.added} icon="plus-circle" tone="violet" note={`${formatNumber(overview.window.removed)} removed · ${formatNumber(overview.window.clicked)} opened, same period`} hint="Add events recorded in the date range (event time, UTC). It counts every add, including items removed later." />
            {revenueOption ? (
              <KpiCard label="Wishlist-attributed revenue" value={revenueOption.value} display={revenueOption.display} icon="cart" tone="green" note={revenueOption.details.join(" · ")} hint="Revenue from purchased products customers had saved to their Wishlist, 7-day last touch. Only the matching items are counted, not the whole order. Uses the order date and the same data as the Dashboard and Analytics." />
            ) : (
              <KpiCard label="Wishlist-attributed revenue" value={null} display={revenueSetup.display} icon="cart" note={revenueSetup.note} hint="Revenue from purchased products customers had saved to their Wishlist, 7-day last touch." />
            )}
          </Grid>

          <Tabs tabs={TABS} active={tab} />

          <Card flush>
            {tab === "products" ? (
              <>
                <div className="kv-toolbar">
                  <SearchBox value={data.q} placeholder="Search saved products" />
                  <div style={{ minWidth: 180 }}>
                    <ParamSelect label="Sort by" param="sort" value={data.sort} options={Object.entries(WISHLIST_SORTS)} />
                  </div>
                </div>
                {data.rows.length === 0 ? (
                  <EmptyState heading={data.q ? "No matching products" : "No saved products"}>{data.q ? "Try a different search." : "Products customers save to their Wishlist will be listed here."}</EmptyState>
                ) : (
                  <s-table>
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Product</s-table-header>
                      <s-table-header format="numeric">Price</s-table-header>
                      <s-table-header format="numeric">Customers saving</s-table-header>
                      <s-table-header>Last saved (UTC)</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {data.rows.map((row) => (
                        <s-table-row key={`${row.productGid}|${row.variantGid}`}>
                          <s-table-cell>
                            <ProductCell
                              title={row.item.title}
                              fallback={`Product ${row.productId}`}
                              subtitle={row.item.variantTitle ?? (row.item.found || !data.catalogAvailable ? null : "No longer in your catalog")}
                              imageUrl={row.item.imageUrl}
                              href={`shopify://admin/products/${row.productId}`}
                            />
                          </s-table-cell>
                          <s-table-cell>{formatMoney(row.item.price, data.currencyCode) ?? "—"}</s-table-cell>
                          <s-table-cell>{formatNumber(row.saves)}</s-table-cell>
                          <s-table-cell>{formatDate(row.lastSavedAt)}</s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                )}
                <Pager page={page} total={data.total} noun="saved variants" />
                <p className="kv-note">Each row is one product variant. “Customers saving” is how many customers have it saved right now; this list is not limited by the date range. Revenue is shown as a total above, not per product, because an order is credited to the item that matched the customer’s last touch.</p>
              </>
            ) : (
              <>
                <div className="kv-toolbar">
                  <div style={{ minWidth: 200 }}>
                    <ParamSelect label="Activity type" param="type" value={data.type} options={Object.entries(WISHLIST_ACTIVITY_FILTERS)} />
                  </div>
                </div>
                <p className="kv-note" style={{ paddingTop: 8 }}>
                  Showing events {words.within}, by event time (UTC). Product names are the current names in your catalog.
                </p>
                {data.rows.length === 0 ? (
                  <EmptyState heading="No Wishlist activity">{data.type === "all" ? `No Wishlist activity ${words.within}.` : "No activity of this type in the selected period."}</EmptyState>
                ) : (
                  <s-table>
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Product</s-table-header>
                      <s-table-header>Activity</s-table-header>
                      <s-table-header>Customer</s-table-header>
                      <s-table-header>Event time (UTC)</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {data.rows.map((row) => (
                        <s-table-row key={row.id}>
                          <s-table-cell>
                            <ProductCell title={row.item.title} fallback={row.productGid ? `Product ${row.productGid.split("/").pop()}` : "Unknown product"} subtitle={row.item.variantTitle} imageUrl={row.item.imageUrl} />
                          </s-table-cell>
                          <s-table-cell>{EVENT[row.type].label}</s-table-cell>
                          <s-table-cell>
                            <s-link href={`shopify://admin/customers/${row.customerId}`}>
                              <span className="kv-id">Customer {row.customerId}</span>
                            </s-link>
                          </s-table-cell>
                          <s-table-cell>{formatDate(row.occurredAt)}</s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                )}
                <Pager page={page} total={data.total} noun="activities" />
              </>
            )}
          </Card>
        </>
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
