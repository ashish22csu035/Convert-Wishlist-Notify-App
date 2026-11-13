import { authenticate } from "../shopify.server";
import { getShopByDomain, parsePage, parsePeriod } from "../models/reporting.server";
import { ensureShop } from "../models/settings.server";
import { limitPeriod, periodView } from "./period";
import { billingEnforced } from "../models/plans.server";
import { analyticsHistoryDays, getEntitlements } from "../models/entitlements.server";

// Every merchant screen starts here: the shop comes from the verified Shopify admin session, never
// from the request. A store seen for the first time gets its shop row here (ensureShop), so a new install shows real
// zeros and the setup checklist instead of a "nothing recorded" page. `shop` is only null in code paths that stub it.
// `period` is the date range from the URL (a preset such as ?days=30, or ?range=custom&from=..&to=.. in UTC days)
// and is handed to the reports as is; `days` is its length in days; `view` is the plain data the screen shows.
export async function loadMerchantContext(request) {
  const { session, admin } = await authenticate.admin(request);
  const shop = (await getShopByDomain(session.shop)) ?? (await ensureShop(session.shop));
  const params = new URL(request.url).searchParams;
  let period = parsePeriod(params);
  // Server-side analytics history limit (7 / 30 / 90 days by plan): applied only while billing enforcement is on, and shortening the range,
  // never refusing it. A hand-edited URL cannot get past it, because the period is limited here, before any report is read.
  if (shop && billingEnforced()) period = limitPeriod(period, analyticsHistoryDays(await getEntitlements(shop.id)));
  return { admin, scope: session.scope ?? "", domain: session.shop, shop, params, period, view: periodView(period), days: period.days, page: parsePage(params.get("page")) };
}
