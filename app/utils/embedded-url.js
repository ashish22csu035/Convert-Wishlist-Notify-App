// Keeps the Shopify Admin context in the URL when the app moves between its own screens.
//
// Shopify Admin opens the app as /app/...?embedded=1&host=...&shop=... . A plain navigate("/app/other") drops that query
// string, and then any full reload of the page inside the Admin iframe (the browser, the dev server's hot reload, an error
// page's Reload button) asks the server for a page without `shop` and `host`. Shopify answers with its session-token
// bounce page, which needs those two values to finish: without them App Bridge fails ("missing required configuration
// fields: shop") and the iframe stays white. So navigations carry these parameters along. Nothing else from the current
// query (filters, pages) is carried, and the short-lived id_token is left out: the server asks for a fresh one.
const EMBEDDED_PARAMS = ["embedded", "host", "shop", "locale"];

// withEmbeddedParams("/app/settings", "?embedded=1&host=abc&days=30") -> { pathname: "/app/settings", search: "?embedded=1&host=abc" }
export function withEmbeddedParams(pathname, currentSearch = "") {
  const from = new URLSearchParams(currentSearch);
  const keep = new URLSearchParams();
  for (const name of EMBEDDED_PARAMS) {
    const value = from.get(name);
    if (value) keep.set(name, value);
  }
  const search = keep.toString();
  return { pathname, search: search ? `?${search}` : "" };
}

// Does a request for the app root come from Shopify (Admin opening the app, an install, a reload of the iframe)? Any of these
// parameters says so; a visit with none is a bare URL and keeps the login form.
const ENTRY_PARAMS = ["shop", "host", "embedded", "id_token", "hmac", "appLoadId"];
export function isAppEntryRequest(searchParams) {
  return ENTRY_PARAMS.some((name) => Boolean(searchParams.get(name)));
}
