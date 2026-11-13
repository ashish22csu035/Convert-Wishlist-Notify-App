// The testable parts of scripts/test-shopifyql-sessions.mjs (the read-only check of the plan recommendation's session lookup).
//
// It adds NO query or parsing logic of its own: the check runs the app's own createShopifyqlSessionSource (the shop-timezone lookup, the
// previous-30-complete-local-days range, buildSessionsQuery and parseSessionsResponse all live in app/models/session-source.server.js). What this
// file adds is only what the check needs around it:
//   - resolveTargetShop: which shop may be queried (the dev store the Shopify CLI is configured with, nothing else)
//   - createStoredTokenGetAdmin: an Admin-GraphQL client that uses ONE stored access token as it is. It never refreshes or exchanges a token and
//     never touches the session storage, so it cannot spend the single-use refresh token or write to the database; it refuses any other shop.
//   - checkSessions: runs the app's source through that client and reports the outcome, never a number it did not get.
import { createShopifyqlSessionSource } from "../app/models/session-source.server.js";

const DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// The app URL the Shopify library insists on (app/shopify.server.js passes process.env.SHOPIFY_APP_URL || "" to shopifyApp, which throws on an empty
// value). `shopify app dev` injects SHOPIFY_APP_URL; a plain node script gets only .env, which carries APP_PUBLIC_URL, and scripts/worker.mjs bridges
// the two the same way (SHOPIFY_APP_URL ||= the worker config's base URL, which is APP_PUBLIC_URL || SHOPIFY_APP_URL). This does the same, with the same
// rule for what is acceptable (https, or http on localhost). The library uses it only to derive its host name; no request is ever sent to it.
// Nothing is invented and no URL is written here: a missing or unusable value is refused. The returned origin is never printed, only its source.
export function resolveAppUrl(env = {}) {
  const raw = [["SHOPIFY_APP_URL", env.SHOPIFY_APP_URL], ["APP_PUBLIC_URL", env.APP_PUBLIC_URL]].find(([, value]) => typeof value === "string" && value.trim());
  if (!raw) return { ok: false, reason: "neither SHOPIFY_APP_URL nor APP_PUBLIC_URL is set, so the Shopify library cannot be configured" };
  const [source, value] = raw;
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (local && url.protocol === "http:")) return { ok: true, url: url.origin, source };
  } catch {
    /* refused below */
  }
  return { ok: false, reason: `${source} must be an https URL (or http on localhost)` };
}

// Which shop the check may query. `projectJson` is the parsed .shopify/project.json (the Shopify CLI's record of the dev store for each app,
// keyed by client id); `apiKey` is this app's client id (SHOPIFY_API_KEY). The target is the dev store configured for THIS app. A shop given on
// the command line must be exactly that one. Anything that cannot be verified is refused, and so is a production environment.
export function resolveTargetShop({ requested, apiKey, projectJson, nodeEnv } = {}) {
  if (String(nodeEnv ?? "").toLowerCase() === "production") return { ok: false, reason: "NODE_ENV is production: this check only runs against a development store" };
  if (typeof apiKey !== "string" || !apiKey) return { ok: false, reason: "SHOPIFY_API_KEY is not set, so the app's configured development store cannot be identified" };
  const entry = projectJson && typeof projectJson === "object" ? projectJson[apiKey] : null;
  const configured = typeof entry?.dev_store_url === "string" ? entry.dev_store_url.trim().toLowerCase() : "";
  if (!DOMAIN.test(configured)) return { ok: false, reason: "no development store is configured for this app in .shopify/project.json" };
  if (requested !== undefined && requested !== null) {
    const asked = String(requested).trim().toLowerCase();
    if (!DOMAIN.test(asked)) return { ok: false, reason: "--shop must be a *.myshopify.com domain" };
    if (asked !== configured) return { ok: false, reason: "--shop is not the development store configured for this app" };
  }
  return { ok: true, shop: configured };
}

// getAdmin for createShopifyqlSessionSource, built on one stored token. `fetchImpl` is injectable so tests never reach Shopify.
// A non-2xx answer is thrown the way the Shopify client throws it (with `status`), so the app's own error classification applies unchanged.
export function createStoredTokenGetAdmin({ shop, accessToken, scope, apiVersion, fetchImpl = globalThis.fetch, timeoutMs = 20000, onQuery } = {}) {
  if (!DOMAIN.test(String(shop ?? ""))) throw new TypeError("a *.myshopify.com shop is required");
  if (typeof accessToken !== "string" || !accessToken) throw new TypeError("an access token is required");
  if (typeof apiVersion !== "string" || !apiVersion) throw new TypeError("an API version is required");
  return async function getAdmin(shopDomain) {
    if (shopDomain !== shop) throw new Error("this client only serves the one development store it was built for");
    return {
      scope: String(scope ?? ""),
      admin: {
        async graphql(document, options) {
          const variables = options?.variables ?? {};
          if (typeof variables.query === "string") onQuery?.(variables.query);
          const response = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
            method: "POST",
            redirect: "error", // the token is never sent anywhere but this shop
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": accessToken },
            body: JSON.stringify({ query: document, variables }),
          });
          if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
          return response;
        },
      },
    };
  };
}

// Runs the app's session source against the one shop. Resolves { ok: true, sessions, periodStart, periodEnd, query } for a valid answer, or
// { ok: false, kind, code, retryable, query } for any failure (permission, transient or permanent). A failure never carries a count.
export async function checkSessions({ shop, accessToken, scope, apiVersion, fetchImpl, now, timeoutMs } = {}) {
  let query = null;
  const getAdmin = createStoredTokenGetAdmin({ shop, accessToken, scope, apiVersion, fetchImpl, timeoutMs, onQuery: (text) => (query = text) });
  const fetchSessions = createShopifyqlSessionSource({ getAdmin, ...(now ? { now } : {}) });
  try {
    const result = await fetchSessions({ shopDomain: shop });
    return { ok: true, sessions: result.sessions, periodStart: result.periodStart, periodEnd: result.periodEnd, query };
  } catch (error) {
    return { ok: false, kind: error?.kind ?? "unknown", code: error?.code ?? error?.name ?? "error", retryable: error?.retryable !== false, query };
  }
}
