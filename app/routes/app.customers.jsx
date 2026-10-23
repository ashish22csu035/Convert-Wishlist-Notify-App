import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadMerchantContext } from "../utils/merchant.server";
import { cleanQuery, getCustomersReport, parseChoice } from "../models/reporting.server";
import { CUSTOMER_SORTS } from "../utils/dashboard-constants";
import { describePeriod } from "../utils/period";
import { Card, EmptyState, InfoPopover, MerchantErrorBoundary, NoShopState, Page, Pager, ParamSelect, SearchBox, formatDate, formatNumber } from "../components/merchant-ui";

export const loader = async ({ request }) => {
  const { shop, days, period, view, page, params } = await loadMerchantContext(request);
  if (!shop) return { days, period: view, page, report: null };
  const q = cleanQuery(params.get("q"));
  const sort = parseChoice(params.get("sort"), CUSTOMER_SORTS, "recent");
  return { days, period: view, page, q, sort, report: await getCustomersReport(shop.id, { days: period, q, sort, page }) };
};

// What the numbers on this screen mean, in one place behind the (i) button.
function CustomersInfo() {
  return (
    <InfoPopover label="About these figures">
      <ul>
        <li>
          <strong>Saved items</strong> and <strong>Active Notify Me</strong> are current totals, right now.
        </li>
        <li>
          <strong>Activity</strong> counts Wishlist and Notify Me events inside the selected date range, in UTC.
        </li>
        <li>A customer can have activity even if they currently have no saved items.</li>
        <li>Customers are identified by Shopify customer ID. Names and email addresses are not stored or shown in this view.</li>
      </ul>
    </InfoPopover>
  );
}

export default function CustomersPage() {
  const { period, page, report, q, sort } = useLoaderData();
  const words = describePeriod(period);
  return (
    <Page title="Engaged customers" subtitle="Logged-in customers who use Wishlist or Notify Me." period={period} actions={<CustomersInfo />}>
      {!report ? (
        <NoShopState />
      ) : (
        <>
          <div className="kv-summary">
            <div className="kv-summary-tile">
              <strong>{formatNumber(report.everyone)}</strong>
              <span>{report.everyone === 1 ? "Customer" : "Customers"}</span>
            </div>
            <div className="kv-summary-tile">
              <strong>{formatNumber(report.savedItems)}</strong>
              <span>Active wishlisted {report.savedItems === 1 ? "item" : "items"}</span>
            </div>
          </div>
          <Card flush>
            <div className="kv-toolbar">
              <SearchBox value={q} placeholder="Search by customer ID" />
              <div style={{ minWidth: 200 }}>
                <ParamSelect label="Sort by" param="sort" value={sort} options={Object.entries(CUSTOMER_SORTS)} />
              </div>
            </div>
            {report.customers.length === 0 ? (
              <EmptyState heading={q ? "No matching customers" : "No engaged customers yet"}>
                {q ? "Search by the numeric customer ID shown in the table." : sort === "activity" ? `No customers had activity ${words.within}.` : "Customers appear here after they save a product or ask to be notified."}
              </EmptyState>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Customer</s-table-header>
                  <s-table-header format="numeric">Saved items (now)</s-table-header>
                  <s-table-header format="numeric">Active Notify Me (now)</s-table-header>
                  <s-table-header format="numeric">{`Activity (${words.label})`}</s-table-header>
                  <s-table-header>Last active (UTC)</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {report.customers.map((customer) => (
                    <s-table-row key={customer.customerId}>
                      <s-table-cell>
                        <s-link href={`shopify://admin/customers/${customer.customerId}`}>
                          <span className="kv-id">Customer {customer.customerId}</span>
                        </s-link>
                      </s-table-cell>
                      <s-table-cell>{formatNumber(customer.savedItems)}</s-table-cell>
                      <s-table-cell>{formatNumber(customer.activeSubscriptions)}</s-table-cell>
                      <s-table-cell>{formatNumber(customer.recentActivity)}</s-table-cell>
                      <s-table-cell>{formatDate(customer.lastSeenAt)}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            <Pager page={page} total={report.total} noun="customers" />
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
