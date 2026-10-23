import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toGid, toShopDomain } from "./shopify-ids.server";

// TEMPORARY diagnostics (remove once the storefront request is verified):
// one JSON line per proxy request in %TEMP%\kw-proxy-trace.log. Holds only the
// route path, parameter NAMES, outcome and status: no values, signature,
// cookies or customer data.
export function traceProxy(event) {
  try {
    appendFileSync(
      join(tmpdir(), "kw-proxy-trace.log"),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
  } catch {
    /* diagnostics only */
  }
}

// Same tolerance as @shopify/shopify-api's HMAC validation.
const TIMESTAMP_TOLERANCE_SEC = 90;

function badRequest(reason, url) {
  // Only a reason code and the parameter NAMES are logged: never the signature,
  // secret, values or customer id.
  const names = [...new Set(url.searchParams.keys())].sort().join(",");
  console.warn("[wishlist] app proxy request rejected:", reason, "params:", names);
  traceProxy({ stage: "rejected", reason, path: url.pathname, params: names });
  return new Response(undefined, { status: 400, statusText: "Bad Request" });
}

// Verifies Shopify's App Proxy signature: HMAC-SHA256 (hex, keyed with the app
// secret) over the sorted `key=value` query parameters, without the signature.
// Repeated parameters are joined with commas, as in Shopify's documentation.
function hasValidSignature(url) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const signature = url.searchParams.get("signature");
  if (!secret) console.error("[wishlist] SHOPIFY_API_SECRET is not set");
  if (!secret || !signature) return false;

  const grouped = new Map();
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "signature") continue;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  const message = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .join("");

  const expected = crypto.createHmac("sha256", secret).update(message).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Verifies a storefront request that arrived through the Shopify App Proxy.
//
// The signature is checked here instead of with authenticate.public.appProxy:
// that helper also loads the shop's offline Admin session and may refresh its
// access token over the network, and any failure there surfaced as a 500 on
// every storefront request. The wishlist never calls the Admin API, so it does
// not need that session.
//
// Only the signed `shop` and `logged_in_customer_id` query parameters are used.
// Request bodies and any other parameters are never used for identity.
export async function authenticateStorefront(request) {
  const url = new URL(request.url);
  traceProxy({
    stage: "received",
    method: request.method,
    path: url.pathname,
    params: [...new Set(url.searchParams.keys())].sort().join(","),
  });

  if (!hasValidSignature(url)) throw badRequest("invalid_signature", url);
  const age = Math.abs(Date.now() / 1000 - Number(url.searchParams.get("timestamp")));
  if (!(age <= TIMESTAMP_TOLERANCE_SEC)) throw badRequest("stale_timestamp", url);

  const shopDomain = toShopDomain(url.searchParams.get("shop"));
  if (!shopDomain) throw badRequest("invalid_shop", url);

  // Empty string when the visitor is not logged in.
  const customerGid = toGid(
    "Customer",
    url.searchParams.get("logged_in_customer_id"),
  );

  traceProxy({ stage: "verified", path: url.pathname, loggedIn: Boolean(customerGid) });
  return { shopDomain, customerGid };
}

// Liquid response that Shopify renders inside the store's theme layout.
export function liquidResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/liquid");
  return new Response(body, { ...init, headers });
}

// Short id returned to the browser (X-KW-Request-Id header) and written to the
// server log, so a failing Network request can be matched to its log line. The
// header also shows that this version of the code answered.
export function newRequestId() {
  return crypto.randomUUID().slice(0, 8);
}

export function noStoreJson(body, status = 200, requestId) {
  const headers = { "Cache-Control": "no-store" };
  if (requestId) headers["X-KW-Request-Id"] = requestId;
  // `error` is the short machine code of a failed answer (e.g. "variant_available"), never a message or data.
  const error = typeof body?.error === "string" ? body.error : undefined;
  traceProxy({ stage: "responded", status, requestId: requestId ?? null, ...(error ? { error } : {}) });
  return Response.json(body, { status, headers });
}

// Error details that are safe to log: class, Prisma/Node code and a message with
// URLs, Shopify GIDs and long numbers (customer/product ids) removed.
export function safeErrorSummary(error) {
  const message = String(error?.message ?? "")
    .split("\n")
    .slice(-3)
    .join(" ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\d{5,}/g, "[n]")
    .slice(0, 300);
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? error?.errorCode ?? null,
    message,
  };
}

export function logFailure(scope, requestId, error, shopDomain) {
  console.error(
    `[wishlist] ${scope} failed`,
    JSON.stringify({ requestId, shop: shopDomain ?? null, ...safeErrorSummary(error) }),
  );
}
