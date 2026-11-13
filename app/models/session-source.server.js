// The source of the "sessions in the previous 30 days" figure behind the plan recommendation: Shopify Analytics through ShopifyQL
// (the Admin GraphQL API field shopifyqlQuery). It is the only authoritative source of STORE sessions: the app's own BrowsingSession rows
// only cover visitors who used Wishlist or Notify Me, so they are never a substitute.
//
// What Shopify's documentation says it needs (nothing here has been run against a live store):
//   - the read_reports access scope, granted and approved on the shop (the scope is declared in the local TOML files only; it has not been
//     released, so no shop has it yet)
//   - Level 2 access to protected customer data for the app (a Partner/Dev Dashboard approval this repository cannot show)
//   - Admin API version 2025-10 or later (the app uses 2026-07)
// Until both are in place Shopify refuses the request (ACCESS_DENIED) and the answer is "needs access", never a number. This adapter is
// also switched off unless SESSION_ANALYTICS_SOURCE=shopifyql is set (see billing-services.server.js).
//
// The requested range is explicit and recorded: the 30 COMPLETE calendar days before today IN THE STORE'S OWN TIME ZONE (the shop's IANA zone,
// read from the Admin API field shop.ianaTimezone). If the store's local date is D, the range is D-30 .. D-1, both ends inclusive as ShopifyQL
// defines SINCE/UNTIL, and today (D) is excluded. The query states the zone itself (`WITH TIMEZONE '<zone>'`) so ShopifyQL resolves the dates
// in the same zone this code computed them in; no zone is ever assumed or defaulted. It is stored as [periodStart, periodEnd): the two exact
// instants at which the store's local day D-30 and local day D begin (UTC instants, as every other date column here). Because they are
// local midnights, the span is 30 days only on the wall clock: across a daylight-saving change it is 30 days +/- 1 hour.
// Not established by Shopify's documentation (see the report): whether a date-only UNTIL covers that whole day, and whether the `sessions`
// metric includes bot sessions by default. The query has no bot filter and counts whatever `sessions` counts; that is not changed here.
//
// What is never turned into a number: a refusal, a parse error, a missing column, no rows, more than one row, a value that is not a whole
// number, a timeout, a missing Admin session, a missing or unusable time zone. Each one is a failure with a code. In particular "no rows" is
// NOT zero sessions: it is unavailable data (a real zero would arrive as a row).

export const SESSION_WINDOW_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;

// A valid IANA zone name or null. The charset check also guarantees the name can be placed inside the quoted ShopifyQL clause unchanged.
export function validTimeZone(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

const formatters = new Map();
function localKey(instantMs, timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hourCycle: "h23" });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  return Number(parts.year) * 10000 + Number(parts.month) * 100 + Number(parts.day); // YYYYMMDD in the zone
}

const keyOf = (utcMs) => {
  const date = new Date(utcMs);
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
};
const isoOfKey = (key) => `${String(Math.floor(key / 10000)).padStart(4, "0")}-${String(Math.floor(key / 100) % 100).padStart(2, "0")}-${String(key % 100).padStart(2, "0")}`;

// The first instant at which the zone's local date is `key` (or later: a zone whose clocks skip midnight starts that day at the first valid time).
// Hour steps from well before the day find the first hour inside it; a minute search inside that hour finds the exact instant (offsets are whole
// minutes). Scanning from the start, not bisecting, stays correct where a clock change at midnight makes a local date occur twice.
function startOfLocalDay(key, timeZone) {
  const anchor = Date.UTC(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, key % 100);
  let hour = anchor - 40 * HOUR_MS;
  while (localKey(hour, timeZone) < key) hour += HOUR_MS;
  let low = hour - HOUR_MS;
  let high = hour; // localKey(low) < key <= localKey(high)
  const minute = 60 * 1000;
  while (high - low > minute) {
    const mid = low + Math.max(1, Math.floor((high - low) / (2 * minute))) * minute;
    if (localKey(mid, timeZone) >= key) high = mid;
    else low = mid;
  }
  return new Date(high);
}

// The requested range for `now` in `timeZone`: { start, end, timeZone, firstDay, lastDay }; start/end are the instants described above
// (end EXCLUSIVE), firstDay/lastDay the inclusive local dates sent to ShopifyQL.
export function sessionRange(now = new Date(), timeZone) {
  const zone = validTimeZone(timeZone);
  if (!zone) throw new TypeError("a valid IANA time zone is required");
  const todayKey = localKey(now.getTime(), zone);
  const today = Date.UTC(Math.floor(todayKey / 10000), (Math.floor(todayKey / 100) % 100) - 1, todayKey % 100);
  const DAY = 24 * HOUR_MS;
  const firstKey = keyOf(today - SESSION_WINDOW_DAYS * DAY); // calendar arithmetic on dates: month, year and leap-day boundaries come for free
  const lastKey = keyOf(today - DAY);
  return { start: startOfLocalDay(firstKey, zone), end: startOfLocalDay(todayKey, zone), timeZone: zone, firstDay: isoOfKey(firstKey), lastDay: isoOfKey(lastKey) };
}

export const buildSessionsQuery = (range) => `FROM sessions SHOW sessions WITH TIMEZONE '${range.timeZone}' SINCE ${range.firstDay} UNTIL ${range.lastDay}`;

export const SHOP_TIMEZONE_GRAPHQL = `#graphql
  query KonvertShopTimezone {
    shop {
      ianaTimezone
    }
  }
`;

export const SHOPIFYQL_GRAPHQL = `#graphql
  query KonvertShopifyqlSessions($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData { columns { name dataType displayName } rows }
      parseErrors
    }
  }
`;

// kind: "permission" (access missing: not retried on a timer), "transient" (retried with backoff), retryable false = permanent.
const failure = (kind, code, retryable = true) => Object.assign(new Error(code), { kind, code, retryable });

// A non-negative whole number from a ShopifyQL cell, or null. Never turns a missing or odd value into 0.
function toCount(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+(\.0+)?$/.test(text.trim())) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// Pure. `json` is the whole GraphQL response body. Returns the session count or throws a coded failure.
export function parseSessionsResponse(json) {
  if (!json || typeof json !== "object") throw failure("transient", "invalid_response");
  if (Array.isArray(json.errors) && json.errors.length) {
    const codes = json.errors.map((entry) => entry?.extensions?.code);
    if (codes.includes("ACCESS_DENIED")) throw failure("permission", "access_denied");
    throw failure("transient", codes.includes("THROTTLED") ? "throttled" : "graphql_error");
  }
  const result = json.data?.shopifyqlQuery;
  if (!result) throw failure("transient", "no_data");
  if (Array.isArray(result.parseErrors) && result.parseErrors.length) throw failure("transient", "parse_error", false);
  const table = result.tableData;
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw failure("transient", "no_data");
  if (!table.columns.some((column) => column?.name === "sessions")) throw failure("transient", "missing_column", false);
  if (table.rows.length === 0) throw failure("transient", "no_rows"); // unavailable, NOT zero
  if (table.rows.length !== 1) throw failure("transient", "unexpected_rows", false);
  const sessions = toCount(table.rows[0]?.sessions);
  if (sessions === null) throw failure("transient", "invalid_value", false);
  return sessions;
}

// Pure. `json` is the whole response of SHOP_TIMEZONE_GRAPHQL. Returns the shop's IANA zone or throws a coded failure. A missing zone is
// unavailable data (retried with backoff); a zone that is not a real IANA name is a permanent failure. Neither ever becomes UTC.
export function parseTimezoneResponse(json) {
  if (!json || typeof json !== "object") throw failure("transient", "invalid_response");
  if (Array.isArray(json.errors) && json.errors.length) {
    const codes = json.errors.map((entry) => entry?.extensions?.code);
    if (codes.includes("ACCESS_DENIED")) throw failure("permission", "access_denied");
    throw failure("transient", codes.includes("THROTTLED") ? "throttled" : "graphql_error");
  }
  const zone = json.data?.shop?.ianaTimezone;
  if (zone === undefined || zone === null || zone === "") throw failure("transient", "timezone_unavailable");
  const valid = validTimeZone(zone);
  if (!valid) throw failure("transient", "invalid_timezone", false);
  return valid;
}

function classify(thrown) {
  const codes = (thrown?.body?.errors?.graphQLErrors ?? []).map((entry) => entry?.extensions?.code).filter(Boolean);
  const status = thrown?.response?.code ?? thrown?.status ?? null;
  if (codes.includes("ACCESS_DENIED")) return failure("permission", "access_denied");
  if (status === 401 || status === 403) return failure("permission", `http_${status}`);
  if (status === 429 || codes.includes("THROTTLED")) return failure("transient", "throttled");
  if (status >= 500) return failure("transient", `http_${status}`);
  return failure("transient", String(thrown?.code ?? thrown?.name ?? "request_failed").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40));
}

// `getAdmin(shopDomain)` resolves { admin, scope } (see getShopAdmin) or rejects. Injected, so tests never touch Shopify. The returned
// function is what runPlanRecommendations calls: it resolves { sessions, periodStart, periodEnd } or rejects with a coded failure.
export function createShopifyqlSessionSource({ getAdmin, now = () => new Date() } = {}) {
  if (typeof getAdmin !== "function") throw new TypeError("getAdmin is required");
  return async function fetchSessions({ shopDomain }) {
    let session;
    try {
      session = await getAdmin(shopDomain);
    } catch {
      throw failure("transient", "admin_session_unavailable");
    }
    const granted = String(session?.scope ?? "").split(",").map((item) => item.trim());
    if (!granted.includes("read_reports")) throw failure("permission", "scope_not_granted"); // not asked of Shopify at all
    const ask = async (document, variables) => {
      try {
        const response = await session.admin.graphql(document, variables ? { variables } : undefined);
        return await response.json();
      } catch (thrown) {
        throw classify(thrown);
      }
    };
    const timeZone = parseTimezoneResponse(await ask(SHOP_TIMEZONE_GRAPHQL)); // the store's own zone, from the same Admin client; never assumed
    const range = sessionRange(now(), timeZone);
    const json = await ask(SHOPIFYQL_GRAPHQL, { query: buildSessionsQuery(range) });
    return { sessions: parseSessionsResponse(json), periodStart: range.start, periodEnd: range.end };
  };
}
