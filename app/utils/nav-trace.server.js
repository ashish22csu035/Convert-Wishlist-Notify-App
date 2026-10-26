import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isbot } from "isbot";

// TEMPORARY diagnostics (remove once the blank page after "Wishlist Settings" is explained): one JSON line per /app or
// /auth request in %TEMP%\kw-nav-trace.log, so a failing click in Shopify Admin can be matched with what the server saw.
// It records only the route path, parameter NAMES, whether an Authorization header and a session-token parameter were
// present (yes/no, never their values), whether the User-Agent looks like a bot (Shopify answers bots with 410), the
// response status and, for a redirect, the destination PATH. No query value, token, cookie or customer data is written.

export function describeAppRequest(request, response) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\.data$/, "");
  if (!(path === "/app" || path.startsWith("/app/") || path.startsWith("/auth"))) return null;
  const location = response.headers.get("location");
  let redirectPath = null;
  if (location) {
    try {
      redirectPath = new URL(location, url).pathname;
    } catch {
      redirectPath = "(unreadable)";
    }
  }
  return {
    at: new Date().toISOString(),
    kind: url.pathname.endsWith(".data") ? "data" : "document",
    method: request.method,
    path,
    hasAuthorizationHeader: Boolean(request.headers.get("authorization")),
    hasIdTokenParam: url.searchParams.has("id_token"),
    paramNames: [...new Set(url.searchParams.keys())].sort(),
    botLikeUserAgent: isbot(request.headers.get("user-agent") ?? ""),
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").split(";")[0] || null,
    redirectPath,
  };
}

export function traceAppRequest(request, response) {
  try {
    const entry = describeAppRequest(request, response);
    if (entry) appendFileSync(join(tmpdir(), "kw-nav-trace.log"), `${JSON.stringify(entry)}\n`);
  } catch {
    /* diagnostics only */
  }
}
