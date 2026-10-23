import { authenticate } from "../shopify.server";
import { getShopByDomain, parsePage, parsePeriod } from "../models/reporting.server";
import { periodView } from "./period";

// Every merchant screen starts here: the shop comes from the verified Shopify admin session, never
// from the request. `shop` is null when nothing has been recorded for the store yet.
// `period` is the date range from the URL (a preset such as ?days=30, or ?range=custom&from=..&to=.. in UTC days)
// and is handed to the reports as is; `days` is its length in days; `view` is the plain data the screen shows.
export async function loadMerchantContext(request) {
  const { session, admin } = await authenticate.admin(request);
  const shop = await getShopByDomain(session.shop);
  const params = new URL(request.url).searchParams;
  const period = parsePeriod(params);
  return { admin, scope: session.scope ?? "", domain: session.shop, shop, params, period, view: periodView(period), days: period.days, page: parsePage(params.get("page")) };
}
