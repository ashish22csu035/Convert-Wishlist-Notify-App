// Read-only check that Shopify Analytics (ShopifyQL) answers the plan recommendation's session lookup for the DEVELOPMENT store.
//
//   node scripts/test-shopifyql-sessions.mjs                      (or: npm run test:shopifyql)
//   node scripts/test-shopifyql-sessions.mjs --shop=<domain>      only to restate the dev store; it must equal the configured one
//   node scripts/test-shopifyql-sessions.mjs --allow-remote-db    only when DATABASE_URL is not on this machine
//
// It runs the APP'S OWN lookup (createShopifyqlSessionSource in app/models/session-source.server.js), so what is verified is exactly what the
// worker sends: the shop's IANA time zone is read first (shop { ianaTimezone }), then
//   FROM sessions SHOW sessions WITH TIMEZONE '<zone>' SINCE <today-30> UNTIL <today-1>     (local dates; today is excluded)
// and the answer goes through the app's parser. This script has no query or parsing logic of its own (scripts/shopifyql-check-lib.mjs only
// supplies the client and the target check).
//
// What it does, in this order:
//   1. Refuses production (NODE_ENV) and decides whether the database host is local or remote WITHOUT connecting and without printing the URL
//      or any credential. A remote host is refused unless --allow-remote-db is given. An unreadable URL is refused.
//   2. Resolves the target shop: the development store the Shopify CLI has configured for THIS app (.shopify/project.json, keyed by
//      SHOPIFY_API_KEY). A different --shop, a missing entry or a missing key is refused before anything connects.
//      The Shopify library also needs an app URL: SHOPIFY_APP_URL if set, else APP_PUBLIC_URL (as scripts/worker.mjs does); one that is
//      missing or not https is refused. It is only used for the library's own configuration check, nothing is sent to it.
//   3. Loads that shop's ONE offline session with the session storage's read-only loadSession(id).
//   4. Refuses to go on if that session is missing, has no access token, belongs to another shop, or is expired or within 5 minutes of expiry.
//      It never refreshes or exchanges a token and never calls an app helper that could (getShopAdmin and unauthenticated.admin are NOT
//      used): a refresh token is single-use, so spending it from a copy of the data would break the live app's login for that shop.
//   5. Sends the app's two read-only requests (time zone, then the sessions query) to that shop's Admin GraphQL endpoint with the stored token.
//
// Read-only: it reads one session row and writes NOTHING (no session, PlanRecommendation or subscription row, no token). It calls no mutation.
// Needs the read_reports scope granted to the shop and Level 2 protected customer data access (shopifyqlQuery reference).
//
// A count is printed only for a valid answer. A GraphQL error, access denial, parse error or missing data is reported as exactly that, never
// as 0 sessions. No token, secret or credential is printed.
//
// Settings come from .env / the environment, by name only: DATABASE_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL.
import { register } from "node:module";

register("./resolve-hooks.mjs", import.meta.url);

if (!process.env.WORKER_SKIP_DOTENV) {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file: the environment alone is used */
  }
}

const NEAR_EXPIRY_MS = 5 * 60 * 1000; // the same margin the app's own token renewal uses
const PROJECT_FILE = new URL("../.shopify/project.json", import.meta.url);

const fail = (message) => {
  console.error(`FAILED (no session count): ${message}`);
  return 1;
};

// Safe text for an exception: its class, name, code, HTTP status and message, with anything secret-shaped removed. Library
// errors (ShopifyError and friends) often have name "Error", so the class name and message are what identify them.
// No stack, no request or response body, no headers.
const secretsFromEnv = () => [process.env.SHOPIFY_API_SECRET, process.env.DATABASE_URL].filter((value) => typeof value === "string" && value.length >= 6);
let knownSecrets = secretsFromEnv();
function scrub(text) {
  let out = String(text ?? "");
  for (const secret of knownSecrets) if (secret) out = out.split(secret).join("<hidden>");
  return out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]*/gi, (url) => `${url.split("://")[0]}://<redacted>`) // database and other URLs
    .replace(/\bshp[a-z]{2}_[A-Za-z0-9]+/g, "<token>")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 <hidden>")
    .replace(/(password|passwd|secret|token|authorization|cookie)(["'\s:=]+)[^\s,;'"]+/gi, "$1$2<hidden>")
    .slice(0, 400);
}
function describeError(error) {
  const parts = [`class ${error?.constructor?.name ?? "unknown"}`, `name ${error?.name ?? "unknown"}`];
  if (error?.code !== undefined && error?.code !== null) parts.push(`code ${scrub(error.code)}`);
  const status = error?.status ?? error?.response?.code ?? error?.statusCode;
  if (status !== undefined && status !== null) parts.push(`HTTP ${scrub(status)}`);
  const graphQL = error?.body?.errors?.graphQLErrors;
  if (Array.isArray(graphQL) && graphQL.length) {
    parts.push(`GraphQL [${graphQL.map((entry) => `${scrub(entry?.extensions?.code ?? "no code")}: ${scrub(entry?.message)}`).join(" | ")}]`);
  }
  if (error?.cause) parts.push(`cause ${error.cause?.constructor?.name ?? "unknown"}: ${scrub(error.cause?.message)}`);
  return `${parts.join(", ")}; message: ${scrub(error?.message) || "(none)"}`;
}

// "local", "remote" or null (unreadable). Looks at the host only; nothing from the URL is ever printed.
function databaseHostKind(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ? "local" : "remote";
  } catch {
    return null;
  }
}

let prisma = null;

async function main() {
  // --- 1. environment and database host, before anything connects
  if (String(process.env.NODE_ENV ?? "").toLowerCase() === "production") return fail("NODE_ENV is production: this check only runs against a development store. Nothing was connected.");
  const kind = databaseHostKind(process.env.DATABASE_URL ?? "");
  if (kind === null) return fail("DATABASE_URL is missing or not a valid URL. Nothing was connected.");
  console.log(`database host: ${kind}`);
  if (kind === "remote" && !process.argv.includes("--allow-remote-db")) {
    return fail("DATABASE_URL points at a REMOTE database host. Nothing was connected. Re-run with --allow-remote-db only if you mean to read that database.");
  }

  // --- 2. the one shop allowed: the CLI's configured development store for this app
  const { readFileSync } = await import("node:fs");
  const { resolveTargetShop, resolveAppUrl, checkSessions } = await import("./shopifyql-check-lib.mjs");
  let projectJson = null;
  try {
    projectJson = JSON.parse(readFileSync(PROJECT_FILE, "utf8"));
  } catch {
    projectJson = null; // refused below: the dev store cannot be verified
  }
  const requested = process.argv.find((arg) => arg.startsWith("--shop="))?.slice("--shop=".length);
  const target = resolveTargetShop({ requested, apiKey: process.env.SHOPIFY_API_KEY, projectJson, nodeEnv: process.env.NODE_ENV });
  if (!target.ok) return fail(`${target.reason}. Nothing was connected.`);
  const SHOP = target.shop;
  console.log(`shop: ${SHOP} (the configured development store)`);

  // The Shopify library refuses to start without an app URL. A plain node script gets only .env (APP_PUBLIC_URL); the same bridge as
  // scripts/worker.mjs. The URL is only used for the library's own configuration check: no request goes to it.
  const appUrl = resolveAppUrl(process.env);
  if (!appUrl.ok) return fail(`${appUrl.reason}. Nothing was connected.`);
  process.env.SHOPIFY_APP_URL = appUrl.url;
  console.log(`app URL for the library configuration: taken from ${appUrl.source} (not contacted)`);

  // --- 3. the one session, read-only. The storage only reads here (findUnique, and a count when it starts).
  const { sessionStorage, apiVersion } = await import("../app/shopify.server.js");
  prisma = (await import("../app/db.server.js")).default;
  console.log(`Admin API version: ${apiVersion}`);

  let session;
  try {
    session = await sessionStorage.loadSession(`offline_${SHOP}`); // the library's offline id format: "offline_<shop domain>"
  } catch (error) {
    return fail(`the session could not be read (${describeError(error)}). Is DATABASE_URL the database you meant, and is it reachable?`);
  }

  // --- 4. refuse anything that would need a refresh
  if (!session) return fail("no stored offline session for this shop in this database (nothing was refreshed or written).");
  if (session.shop !== SHOP || session.isOnline) return fail("the stored session is not this shop's offline session.");
  if (typeof session.accessToken !== "string" || !session.accessToken) return fail("the stored session has no access token.");
  if (session.isExpired(NEAR_EXPIRY_MS)) {
    return fail(
      `the stored access token is expired or within 5 minutes of expiry (expires ${session.expires ? session.expires.toISOString() : "n/a"}). ` +
        "This script never refreshes a token (that would spend the single-use refresh token and write to the database). Let the app renew it (open the app in the development store), then run again.",
    );
  }
  knownSecrets = [...secretsFromEnv(), session.accessToken, session.refreshToken].filter((value) => typeof value === "string" && value.length >= 6);
  console.log(`stored session: valid until ${session.expires ? session.expires.toISOString() : "no expiry recorded"}`);
  const granted = String(session.scope ?? "").split(",").map((item) => item.trim());
  console.log(`read_reports in the stored session scope: ${granted.includes("read_reports") ? "yes" : "NO (the scope has not been granted to this shop yet)"}`);

  // --- 5. the app's own lookup, with the stored token as it is
  const { recommendedPlanForSessions } = await import("../app/models/plans.server.js");
  const result = await checkSessions({ shop: SHOP, accessToken: session.accessToken, scope: session.scope, apiVersion });
  if (result.query) console.log(`query sent: ${result.query}`);
  if (!result.ok) {
    const meaning =
      result.kind === "permission"
        ? "access is missing (this is NOT 0 sessions)"
        : result.retryable
          ? "unavailable data or a temporary failure (the app would retry; this is NOT 0 sessions)"
          : "a permanent failure (the app would not retry; this is NOT 0 sessions)";
    return fail(`${scrub(result.code)} [${result.kind}]: ${meaning}`);
  }
  const days = (result.periodEnd - result.periodStart) / (24 * 60 * 60 * 1000);
  console.log(`period: ${result.periodStart.toISOString()} to ${result.periodEnd.toISOString()} (end exclusive, ${days.toFixed(2)} days)`);
  console.log(`OK: ${result.sessions} sessions in the previous 30 complete local days. The app would recommend ${recommendedPlanForSessions(result.sessions)}.`);
  console.log(`measured at: ${new Date().toISOString()} (UTC)`);
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  code = fail(`unexpected error (${describeError(error)})`);
} finally {
  if (prisma) await prisma.$disconnect().catch(() => {});
}
process.exit(code);
