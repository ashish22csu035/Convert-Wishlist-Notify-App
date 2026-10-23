/* eslint-disable react/prop-types -- plain JavaScript project: small local helper components are not given PropTypes */
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { describePeriod } from "../utils/period";
import { loadMerchantContext } from "../utils/merchant.server";
import { getAttribution, getDeliveries, getNotifyOverview, getSubscriptions, hasOrderScope, parseChoice } from "../models/reporting.server";
import { describeItem, fetchCatalog } from "../models/catalog.server";
import { DELIVERY_FILTERS, SUBSCRIPTION_FILTERS } from "../utils/dashboard-constants";
import {
  Card,
  EmptyState,
  Grid,
  KpiCard,
  MerchantErrorBoundary,
  NoShopState,
  Page,
  Pager,
  ParamSelect,
  ProductCell,
  STATUS_HELP,
  StatusBadge,
  Tabs,
  attributionView,
  deliveryReason,
  formatDate,
  formatNumber,
} from "../components/merchant-ui";

const TABS = [
  ["subscriptions", "Subscriptions"],
  ["emails", "Email activity"],
];

const reasonText = (code) => deliveryReason(code);

export const loader = async ({ request }) => {
  const { admin, scope, shop, days, period, view, page, params } = await loadMerchantContext(request);
  const tab = parseChoice(params.get("tab"), Object.fromEntries(TABS), "subscriptions");
  if (!shop) return { days, period: view, tab, page, overview: null };

  const overview = await getNotifyOverview(shop.id, period);
  const attribution = await getAttribution(shop.id, period, { scopeGranted: hasOrderScope(scope) });
  const filters = tab === "emails" ? DELIVERY_FILTERS : SUBSCRIPTION_FILTERS;
  const status = parseChoice(params.get("status"), filters, "all");
  const list = tab === "emails" ? await getDeliveries(shop.id, { status, page, days: period }) : await getSubscriptions(shop.id, { status, page });

  const catalog = await fetchCatalog(admin, {
    productGids: [...overview.requested, ...list.rows].map((row) => row.productGid).filter(Boolean),
    variantGids: [...overview.requested, ...overview.problems, ...list.rows].map((row) => row.variantGid).filter(Boolean),
  });
  const withItem = (row) => ({ ...row, item: describeItem(catalog, row) });
  return {
    days,
    period: view,
    tab,
    page,
    status,
    attribution,
    total: list.total,
    catalogAvailable: catalog.available,
    overview: { ...overview, requested: overview.requested.map(withItem), problems: overview.problems.map(withItem) },
    rows: list.rows.map(withItem),
  };
};

function ItemCell({ row, catalogAvailable }) {
  const fallback = row.productId ? `Product ${row.productId}` : `Variant ${row.variantId}`;
  return (
    <ProductCell
      title={row.item.title}
      fallback={fallback}
      subtitle={row.item.variantTitle ?? (row.item.found || !catalogAvailable ? `Variant ${row.variantId}` : "No longer in your catalog")}
      imageUrl={row.item.imageUrl}
      href={row.productId ? `shopify://admin/products/${row.productId}` : undefined}
    />
  );
}

function subscriptionReason(row) {
  if (row.status === "ACTIVE") return "Waiting for the item to come back in stock";
  if (row.status === "FULFILLED") return "Notified: a restock email was accepted by the mail server";
  if (row.status === "UNSUBSCRIBED") return row.unsubscribedAt ? `Customer opted out · ${formatDate(row.unsubscribedAt)}` : "Customer opted out";
  return "—";
}

function deliveryDetail(job) {
  if (job.errorCode) return reasonText(job.errorCode);
  if (job.status === "SENT") return "Accepted by the mail server";
  if (job.status === "PENDING" && job.nextAttemptAt) return `Next attempt ${formatDate(job.nextAttemptAt)}`;
  return "—";
}

function DeliveryTable({ rows, catalogAvailable }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Item</s-table-header>
        <s-table-header>Status</s-table-header>
        <s-table-header format="numeric">Restock cycle</s-table-header>
        <s-table-header format="numeric">Attempts</s-table-header>
        <s-table-header>Sent (UTC)</s-table-header>
        <s-table-header>Result</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((job) => (
          <s-table-row key={job.id}>
            <s-table-cell>
              <ItemCell row={job} catalogAvailable={catalogAvailable} />
            </s-table-cell>
            <s-table-cell>
              <StatusBadge status={job.status} />
            </s-table-cell>
            <s-table-cell>{job.restockCycle}</s-table-cell>
            <s-table-cell>{job.attempts}</s-table-cell>
            <s-table-cell>{formatDate(job.sentAt)}</s-table-cell>
            <s-table-cell>{deliveryDetail(job)}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export default function NotifyMePage() {
  const data = useLoaderData();
  const { period, tab, page, overview: o } = data;
  const words = describePeriod(period);
  const revenue = attributionView(data.attribution, period);
  const revenueOption = revenue.options?.find((option) => option.key === "notifyMe");
  const revenueSetup = revenue.setup;
  const filters = tab === "emails" ? DELIVERY_FILTERS : SUBSCRIPTION_FILTERS;
  return (
    <Page title="Notify Me" subtitle="Customers waiting for restocks, and the emails sent to them." period={period}>
      {!o ? (
        <NoShopState />
      ) : (
        <>
          <Grid>
            <KpiCard label="Active subscriptions" value={o.subscriptions.ACTIVE} icon="notification" tone="blue" note={`Current total · ${formatNumber(o.window.subscribed)} new ${words.within}`} hint="Customers who are waiting for a sold-out item right now. This is a current total; the note shows new sign-ups in the date range." />
            <KpiCard label="Customers notified" value={o.subscriptions.FULFILLED} icon="check-circle" tone="blue" note="All time" hint="Subscriptions that have been completed because a restock email was accepted by the mail server. It counts subscriptions, not people, and not the date range." />
            <KpiCard label="Emails sent" value={o.deliveries.SENT} icon="email" tone="blue" note={`All time · ${formatNumber(o.window.emailsSent)} ${words.within}`} hint="Emails accepted by the mail server. Accepted does not confirm they reached the inbox or were opened." />
            <KpiCard label="Queued or sending" value={o.deliveries.PENDING + o.deliveries.SENDING} icon="clock" tone="blue" note="Right now" hint="Emails waiting for the email worker, or being sent at this moment. Run the worker to send queued mail." />
            {revenueOption ? (
              <KpiCard label="Notify Me-attributed revenue" value={revenueOption.value} display={revenueOption.display} icon="cart" tone="green" note={revenueOption.details.join(" · ")} hint={revenueOption.hint} />
            ) : (
              <KpiCard label="Notify Me-attributed revenue" value={null} display={revenueSetup.display} icon="cart" note={revenueSetup.note} hint="Revenue from items bought after a restock email for that exact variant was sent, 7-day last touch." />
            )}
          </Grid>

          {o.problems.length > 0 ? (
            <Card title={`Failed and unknown emails (${formatNumber(o.deliveries.FAILED + o.deliveries.UNKNOWN)} in total)`} flush>
              {o.problems.some((job) => job.status === "UNKNOWN") ? (
                <div style={{ padding: "0 16px 8px" }}>
                  <s-banner tone="warning" heading="Some emails have an unknown result">
                    The connection broke while these were being sent, so it is not known whether they arrived. They are never sent again automatically.
                  </s-banner>
                </div>
              ) : null}
              <DeliveryTable rows={o.problems} catalogAvailable={data.catalogAvailable} />
              <p className="kv-note">Showing the 10 most recent. Filter “Email activity” by Failed or Unknown for the full list.</p>
            </Card>
          ) : null}

          <Tabs tabs={TABS} active={tab} />

          <Card flush>
            <div className="kv-toolbar">
              <div style={{ minWidth: 200 }}>
                <ParamSelect label="Status" param="status" value={data.status} options={Object.entries(filters)} />
              </div>
            </div>
            <ul className="kv-legend-list">
              {Object.keys(filters)
                .filter((key) => key !== "all")
                .map((key) => (
                  <li key={key}>
                    <strong>{filters[key]}</strong>: {STATUS_HELP[key]}
                  </li>
                ))}
            </ul>
            <p className="kv-note" style={{ paddingTop: 8 }}>
              {tab === "emails"
                ? `Showing emails queued ${words.within} (UTC). “Sent” means accepted by the mail server, not confirmed delivered or opened.`
                : "Showing every subscription, newest first. This list is not limited by the date range. “Last email” is the result of the latest restock email for that subscription."}
            </p>
            {data.rows.length === 0 ? (
              tab === "emails" ? (
                <EmptyState heading="No emails">{data.status === "all" ? `No restock emails were queued ${words.within}. They are queued when an item customers are waiting for comes back in stock.` : "No emails in this period have this status."}</EmptyState>
              ) : (
                <EmptyState heading="No subscriptions">{data.status === "all" ? "Customers who ask to be notified about sold-out items will appear here." : "No subscriptions have this status."}</EmptyState>
              )
            ) : tab === "emails" ? (
              <DeliveryTable rows={data.rows} catalogAvailable={data.catalogAvailable} />
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Item</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Subscribed (UTC)</s-table-header>
                  <s-table-header>Last email</s-table-header>
                  <s-table-header>Why this status</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.rows.map((row) => (
                    <s-table-row key={row.id}>
                      <s-table-cell>
                        <ItemCell row={row} catalogAvailable={data.catalogAvailable} />
                      </s-table-cell>
                      <s-table-cell>
                        <StatusBadge status={row.status} />
                      </s-table-cell>
                      <s-table-cell>{formatDate(row.createdAt)}</s-table-cell>
                      <s-table-cell>{row.lastEmail ? `${row.lastEmail.status === "SENT" ? "Sent" : row.lastEmail.status === "PENDING" ? "Queued" : row.lastEmail.status.charAt(0) + row.lastEmail.status.slice(1).toLowerCase()} · ${formatDate(row.lastEmail.at)}` : "None yet"}</s-table-cell>
                      <s-table-cell>{subscriptionReason(row)}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            <Pager page={page} total={data.total} noun={tab === "emails" ? "emails" : "subscriptions"} />
          </Card>

          <div className="kv-grid two">
            <Card title="Most requested items" flush>
              {o.requested.length === 0 ? (
                <EmptyState heading="No active subscriptions">Items customers are waiting for will be listed here.</EmptyState>
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Item</s-table-header>
                    <s-table-header format="numeric">Waiting customers</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {o.requested.map((row) => (
                      <s-table-row key={row.variantGid}>
                        <s-table-cell>
                          <ItemCell row={row} catalogAvailable={data.catalogAvailable} />
                        </s-table-cell>
                        <s-table-cell>{formatNumber(row.subscribers)}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
            </Card>
            <Card title="Why emails were skipped" flush>
              {o.skipReasons.length === 0 ? (
                <EmptyState heading="Nothing skipped">Emails that are skipped, and why, will be listed here.</EmptyState>
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Reason</s-table-header>
                    <s-table-header format="numeric">Emails</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {o.skipReasons.map((row) => (
                      <s-table-row key={row.reason}>
                        <s-table-cell>{reasonText(row.reason)}</s-table-cell>
                        <s-table-cell>{formatNumber(row.count)}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
            </Card>
          </div>
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
