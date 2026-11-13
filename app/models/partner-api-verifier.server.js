import { APP_PRICING_SOURCE, PLAN_KEYS, getPlan } from "./plans.server";

// Subscription verification for SHOPIFY APP PRICING, through the Partner API query activeSubscription(appId, shopId).
//
// WHAT SHOPIFY'S DOCUMENTATION ESTABLISHES (read for this phase; nothing here has been run live):
//   - With Shopify App Pricing the subscription status comes from the Partner API, NOT from the Admin API. (The Admin API's
//     currentAppInstallation.activeSubscriptions only knows Billing API charges, so it is never used here.)
//   - Authentication: the header X-Shopify-Access-Token = a Partner API client token, created in the Dev Dashboard (Organization settings >
//     Users > Security > Partner API clients). The token is scoped to the whole Partner organisation. activeSubscription needs the
//     "Manage apps" permission, a PUBLIC app, and an active contract for the shop, otherwise it returns null.
//   - The URL contains the Partner ID (the number in the Partner Dashboard URL, NOT the Dev Dashboard organisation id) and an API version,
//     and the version must be a supported one (publicApiVersions lists them). Documented error responses: 400 query too long, 401 invalid
//     access token, 404 invalid API version, 429 too many requests (four per second per client).
//   - activeSubscription fields: app { id apiKey } (id is gid://shopify/App/<n>), shop { id myshopifyDomain }, billingPeriod
//     (EVERY_30_DAYS | ANNUAL), cancelAtEndOfCycle (true = will be cancelled when the cycle ends), trialEndsAt (null when no active trial),
//     currentBillingCycle { startTime endTime } (null while the subscription is still in TRIAL), items { handle }, pendingUpdate (applied at the
//     NEXT cycle), legacySubscriptionId. The root query app(id) takes the PARTNERS form of the id (gid://partners/App/<n>) and returns id and apiKey.
//
//   - THE ENDPOINT, as the project owner confirmed it from the official Partner API documentation:
//       https://partners.shopify.com/{partner_id}/api/{version}/graphql.json      (version for example 2026-10)
//     The documentation text this module's author could read omits the URL itself, so the pattern is NOT built or assumed here: the whole URL
//     must be supplied as SHOPIFY_PARTNER_API_URL, and it is accepted only if it has exactly this shape (https, host partners.shopify.com, a
//     numeric Partner ID, a YYYY-MM or unstable version, no credentials, port, query or fragment). The verifier stays OFF without it, and the
//     token can never be sent to any other address.
//
// WHAT IT DOES NOT ESTABLISH, and what this module therefore does not assume:
//   - That the subscription of a merchant who cancelled is reported as null once the cycle has ended (cancelAtEndOfCycle is documented, the null
//     afterwards is the documented "no active subscription" answer, but it has not been observed).
//
// THE FALSE-CANCELLATION GUARD. A paid plan is cancelled locally only on an answer of null ("no contract"), and null is exactly what a WRONG app
// id would return for every shop. So a null counts as "cancelled" only when ALL of these hold, and otherwise it is an identity/configuration
// error that changes nothing:
//   1. the configuration is complete and readable (readPartnerConfig), including the app's own API key;
//   2. the request provably targets the right app: the app(id) query, asked for the configured app, returns that same id AND an apiKey equal to
//      this app's own SHOPIFY_API_KEY (identity is re-checked at least every 30 minutes, and a failed check is never cached);
//   3. the shop id used was read from the shop's own Admin session, and the response is valid;
//   4. the answer is then repeated once, at least five minutes later, before the row is cancelled (see subscription-verification.server.js:
//      requireRepeat). A non-null answer must itself carry this app's id and API key and this shop's id and domain.
// An HTTP error, a permission failure, a malformed answer, a mismatched app or shop, an unusable identity check or ambiguous data never changes
// subscription state: they only record a failure and schedule a retry. A paid plan whose verification keeps failing falls back to Basic once its
// last verification is older than 24 hours, exactly as before; that is the staleness rule, not a cancellation.
//
// Environment (names only; nothing is read from a file and no value is ever logged):
//   BILLING_MECHANISM=app_pricing        switches this verifier on (see billing-services.server.js)
//   SHOPIFY_PARTNER_API_URL              the full documented endpoint URL for a supported version (see above), e.g. .../api/2026-10/graphql.json
//   SHOPIFY_PARTNER_API_ACCESS_TOKEN     the Partner API client token (client needs "Manage apps")
//   SHOPIFY_APP_GID                      gid://shopify/App/<id>, the numeric id from the app's Partner Dashboard URL
//   SHOPIFY_API_KEY                      this app's own API key (already used by the app); the expected apiKey of the answer
//   BILLING_PLAN_HANDLES                 which plan HANDLE is which plan, e.g. advance=ADVANCE,enterprise=ENTERPRISE[,basic=BASIC]
//
// A plan is recognised ONLY by the handle of the item Shopify returns, matched against BILLING_PLAN_HANDLES. A display name, a plan name a
// browser or a merchant sends, a stored value or a recommendation is never read.
//
// Outcomes (the shapes subscription-verification.server.js consumes):
//   active   a paid plan with its CURRENT billing cycle (start and end exactly as Shopify reports them; any cycle length, monthly or annual)
//   trial    a paid plan still in trial: Shopify reports no billing cycle yet, so NO period is stored (none is invented); entitlements stay
//            Basic's until the first cycle exists, and the next check is scheduled for the end of the trial
//   none     reason "no_contract" (null, identity confirmed, to be repeated before it cancels) or "free_plan" (a subscription to the free plan)
//   error    everything else, never a cancellation and never a grant: permission, config, transient
//
// Not an input to anything here: cancelAtEndOfCycle (the subscription is still active until the cycle ends; the check at the cycle end then sees
// null) and pendingUpdate (applies at the next cycle; the CURRENT items decide today).

export { APP_PRICING_SOURCE }; // defined in plans.server.js beside the list of sources that may grant entitlements
export const IDENTITY_TTL_MS = 30 * 60 * 1000;

export const ACTIVE_SUBSCRIPTION_QUERY = `#graphql
  query KonvertActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      app { id apiKey }
      shop { id myshopifyDomain }
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle { startTime endTime }
      items { handle }
      pendingUpdate { billingPeriod items { handle } }
      legacySubscriptionId
    }
  }
`;

export const APP_IDENTITY_QUERY = `#graphql
  query KonvertAppIdentity($id: ID!) {
    app(id: $id) { id apiKey }
  }
`;

const SHOP_ID_QUERY = `#graphql
  query KonvertShopId { shop { id } }
`;

const SUPPORTED_PERIODS = ["EVERY_30_DAYS", "ANNUAL"];
const SHOP_GID = /^gid:\/\/shopify\/Shop\/\d+$/;
const APP_GID = /^gid:\/\/shopify\/App\/[1-9]\d*$/;
const HANDLE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CODE = (value) => String(value ?? "error").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "error";

const error = (kind, code) => ({ outcome: "error", kind, code });
const failure = (kind, code) => Object.assign(new Error(code), { kind, code });

// gid://shopify/App/123 -> gid://partners/App/123 (the form the Partner API's app(id) query documents), or null.
export const partnersAppGid = (appGid) => (APP_GID.test(String(appGid ?? "")) ? `gid://partners/App/${String(appGid).split("/").pop()}` : null);

// ---------- configuration ----------

// "advance=ADVANCE,enterprise=ENTERPRISE,basic=BASIC" -> { handles: Map(handle -> plan key), problems: [reason] }. Never throws, never echoes input.
export function parsePlanHandles(text) {
  const handles = new Map();
  const problems = [];
  for (const entry of String(text ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const [handle, plan, ...rest] = entry.split(/[=:]/).map((part) => part.trim());
    if (rest.length || !HANDLE.test(handle ?? "") || !PLAN_KEYS.includes(plan)) problems.push("unreadable_entry");
    else if (handles.has(handle)) problems.push("duplicate_handle");
    else handles.set(handle, plan);
  }
  const planKeys = [...handles.values()];
  if (new Set(planKeys).size !== planKeys.length) problems.push("plan_mapped_twice");
  for (const required of PLAN_KEYS.filter((key) => getPlan(key)?.paid)) if (!planKeys.includes(required)) problems.push(`missing_${required.toLowerCase()}`);
  return { handles, problems };
}

const ENDPOINT_PATH = /^\/\d+\/api\/(\d{4}-\d{2}|unstable)\/graphql\.json$/;

// Exactly the documented shape; see the header. Nothing is built from parts.
export function validEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "partners.shopify.com" && !url.username && !url.password && !url.port && !url.search && !url.hash && ENDPOINT_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

// { ready, missing: [names], invalid: [names], config } . Only NAMES are returned, never a value.
export function readPartnerConfig(env = process.env) {
  const text = (name) => String(env?.[name] ?? "").trim();
  const missing = [];
  const invalid = [];
  const need = (name, ok) => {
    if (!text(name)) missing.push(name);
    else if (!ok(text(name))) invalid.push(name);
  };
  need("SHOPIFY_PARTNER_API_URL", validEndpoint);
  need("SHOPIFY_PARTNER_API_ACCESS_TOKEN", () => true);
  need("SHOPIFY_APP_GID", (value) => APP_GID.test(value));
  need("SHOPIFY_API_KEY", () => true);
  need("BILLING_PLAN_HANDLES", (value) => parsePlanHandles(value).problems.length === 0);
  const ready = missing.length === 0 && invalid.length === 0;
  return {
    ready,
    missing,
    invalid,
    config: ready
      ? { url: text("SHOPIFY_PARTNER_API_URL"), token: text("SHOPIFY_PARTNER_API_ACCESS_TOKEN"), appGid: text("SHOPIFY_APP_GID"), apiKey: text("SHOPIFY_API_KEY"), handles: parsePlanHandles(text("BILLING_PLAN_HANDLES")).handles }
      : null,
  };
}

// ---------- the answer ----------

const asDate = (value) => (typeof value === "string" || value instanceof Date ? new Date(value) : new Date(NaN));
const domainOf = (value) => String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// Pure. `data` is the `data` object of the GraphQL response. Returns an outcome and never throws. A null answer is returned as
// { outcome: "none", reason: "no_contract", requireRepeat: true }: it is NOT yet a cancellation, the verifier must first confirm the identity.
export function interpretActiveSubscription(data, { appGid, apiKey, shopGid, shopDomain, handles, now = new Date() }) {
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "activeSubscription")) return error("transient", "invalid_response");
  const sub = data.activeSubscription;
  if (sub === null) return { outcome: "none", reason: "no_contract", requireRepeat: true }; // documented: null = no active subscription for the app
  if (typeof sub !== "object" || Array.isArray(sub)) return error("transient", "invalid_response");

  // The answer must be about THIS app (by id AND by API key) and THIS shop, whatever was asked.
  if (sub.app?.id !== appGid || !apiKey || sub.app?.apiKey !== apiKey) return error("config", "app_mismatch");
  if (sub.shop?.id !== shopGid || domainOf(sub.shop?.myshopifyDomain) !== domainOf(shopDomain)) return error("config", "shop_mismatch");

  if (typeof sub.cancelAtEndOfCycle !== "boolean" || !Array.isArray(sub.items)) return error("transient", "invalid_response");
  if (sub.pendingUpdate !== null && sub.pendingUpdate !== undefined && (typeof sub.pendingUpdate !== "object" || !Array.isArray(sub.pendingUpdate.items))) return error("transient", "invalid_response");
  if (!SUPPORTED_PERIODS.includes(sub.billingPeriod)) return error("config", "unsupported_billing_period");

  // Which plan: only a handle from BILLING_PLAN_HANDLES counts, and exactly one plan may be named.
  const plans = new Set();
  let handle = null;
  for (const item of sub.items) {
    if (!item || typeof item.handle !== "string") return error("transient", "invalid_response");
    const plan = handles.get(item.handle);
    if (plan) {
      plans.add(plan);
      handle = item.handle;
    }
  }
  if (plans.size === 0) return error("config", "unknown_plan"); // a plan this app does not know: not a cancellation, not a grant
  if (plans.size > 1) return error("config", "ambiguous_plan");
  const plan = [...plans][0];
  if (!getPlan(plan)?.paid) return { outcome: "none", reason: "free_plan" }; // a real subscription to the free plan: nothing paid

  const common = { plan, source: APP_PRICING_SOURCE, planHandle: handle, cancelAtEndOfCycle: sub.cancelAtEndOfCycle, shopifySubscriptionGid: typeof sub.legacySubscriptionId === "string" ? sub.legacySubscriptionId : undefined };
  const cycle = sub.currentBillingCycle;
  if (cycle === null || cycle === undefined) {
    // Documented: no billing cycle while the subscription is still in trial. No period is made up.
    const trialEnd = asDate(sub.trialEndsAt);
    if (sub.trialEndsAt && !Number.isNaN(trialEnd.getTime()) && trialEnd > now) return { outcome: "trial", ...common, trialEndsAt: trialEnd };
    return error("transient", "billing_cycle_unavailable"); // no cycle and no running trial: inconsistent, look again later
  }
  if (typeof cycle !== "object") return error("transient", "invalid_response");
  const start = asDate(cycle.startTime);
  const end = asDate(cycle.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return error("transient", "invalid_response");
  if (end <= now) return error("transient", "period_not_current"); // Shopify has not moved on to the next cycle yet: look again shortly
  return { outcome: "active", ...common, periodStart: start, periodEnd: end };
}

// Pure. `data` is the `data` object of the app(id) response. true only when it is the configured app AND this app's own API key.
export function identityMatches(data, { appGid, apiKey }) {
  const expected = partnersAppGid(appGid);
  return Boolean(expected && apiKey && data?.app && data.app.id === expected && data.app.apiKey === apiKey);
}

// ---------- the Partner API client (injectable fetch) ----------

function classifyHttp(status) {
  if (status === 401 || status === 403) return failure("permission", `http_${status}`);
  if (status === 404) return failure("config", "endpoint_not_found"); // documented: an invalid API version; also a wrong URL. Not a statement about the shop
  if (status === 400) return failure("config", "bad_request");
  if (status === 429) return failure("transient", "throttled");
  return failure("transient", `http_${status}`);
}

function classifyGraphQlErrors(errors) {
  const text = errors.map((entry) => `${entry?.extensions?.code ?? ""} ${entry?.message ?? ""}`).join(" ");
  if (/THROTTLED|RATE_LIMIT|too many requests/i.test(text)) return failure("transient", "throttled");
  if (/ACCESS_DENIED|FORBIDDEN|UNAUTHORI[SZ]ED|invalid access token|permission|not authori[sz]ed|access denied/i.test(text)) return failure("permission", "access_denied");
  return failure("transient", "graphql_error");
}

// Resolves the `data` of the response or throws a coded failure; the token is only ever in the request header.
// eslint-disable-next-line no-undef
export function createPartnerApiClient({ url, token, fetchImpl = fetch } = {}) {
  if (!validEndpoint(url) || !token || typeof fetchImpl !== "function") throw new TypeError("an https Shopify endpoint URL, a token and a fetch are required");
  async function request(query, variables, signal) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        redirect: "error", // the token is never sent anywhere else
        signal,
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
      });
    } catch (thrown) {
      throw failure("transient", SAFE_CODE(thrown?.code ?? thrown?.name ?? "request_failed"));
    }
    if (!response.ok) throw classifyHttp(response.status);
    const json = await response.json().catch(() => null);
    if (!json || typeof json !== "object") throw failure("transient", "invalid_response");
    if (Array.isArray(json.errors) && json.errors.length) throw classifyGraphQlErrors(json.errors);
    return json.data;
  }
  return {
    activeSubscription: ({ appId, shopId, signal }) => request(ACTIVE_SUBSCRIPTION_QUERY, { appId, shopId }, signal),
    app: ({ appId, signal }) => request(APP_IDENTITY_QUERY, { id: appId }, signal),
  };
}

// ---------- the verifier ----------

// `getAdmin(shopDomain)` resolves { admin } (see getShopAdmin) or rejects; `client` is a Partner API client; `apiKey` is THIS app's own API key.
// All injected, so tests never touch the network. Returns the function the verification worker calls.
export function createPartnerApiVerifier({ client, appGid, apiKey, handles, getAdmin, now = () => new Date() } = {}) {
  if (!client || typeof client.activeSubscription !== "function" || typeof client.app !== "function" || !APP_GID.test(String(appGid ?? "")) || !apiKey || !(handles instanceof Map) || typeof getAdmin !== "function") {
    throw new TypeError("client, appGid, apiKey, handles and getAdmin are required");
  }
  let identityConfirmedAt = null; // only a SUCCESS is remembered

  // Is the configured app id really this app? Returns null (confirmed) or an error outcome; never throws.
  async function confirmIdentity(signal) {
    if (identityConfirmedAt !== null && now().getTime() - identityConfirmedAt < IDENTITY_TTL_MS) return null;
    let data;
    try {
      data = await client.app({ appId: partnersAppGid(appGid), signal });
    } catch (thrown) {
      return error(thrown?.kind === "permission" || thrown?.kind === "config" ? thrown.kind : "transient", `identity_${SAFE_CODE(thrown?.code ?? thrown?.name)}`);
    }
    if (!data || typeof data !== "object") return error("transient", "identity_invalid_response");
    if (!data.app) return error("config", "app_identity_not_found");
    if (!identityMatches(data, { appGid, apiKey })) return error("config", "app_identity_mismatch");
    identityConfirmedAt = now().getTime();
    return null;
  }

  return async function verify({ shop, signal }) {
    let shopGid;
    try {
      const { admin } = await getAdmin(shop.domain);
      const response = await admin.graphql(SHOP_ID_QUERY);
      shopGid = (await response.json())?.data?.shop?.id;
    } catch {
      return error("transient", "admin_session_unavailable"); // no session, no shop id: never evidence about the subscription
    }
    if (!SHOP_GID.test(String(shopGid ?? ""))) return error("transient", "shop_id_unavailable");
    let data;
    try {
      data = await client.activeSubscription({ appId: appGid, shopId: shopGid, signal });
    } catch (thrown) {
      return error(thrown?.kind === "permission" || thrown?.kind === "config" ? thrown.kind : "transient", SAFE_CODE(thrown?.code ?? thrown?.name));
    }
    const result = interpretActiveSubscription(data, { appGid, apiKey, shopGid, shopDomain: shop.domain, handles, now: now() });
    if (result.outcome === "none" && result.reason === "no_contract") {
      // "No contract" is only believable if the request is known to have been about the right app.
      const identity = await confirmIdentity(signal);
      if (identity) return identity;
    }
    return result;
  };
}
