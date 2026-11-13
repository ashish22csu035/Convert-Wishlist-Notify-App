// Stand-in for app/shopify.server.js when a route that uses `authenticate.admin(request)` and its `redirect` helper is bundled for a test.
// `authenticate.admin` answers with whatever globalThis.__kwAuth returns (an object such as { session: { shop } }) or throws (for example a
// Response, as the real library does for an unauthenticated request); with no __kwAuth it is an authenticated demo shop. The `redirect` it
// returns only RECORDS what it was asked to do in globalThis.__kwRedirects ({ url, init }) and answers with a plain 302 carrying that address.
// It is a recorder, not the library: the real helper's embedded behaviour (App Bridge response, top-level navigation) is NOT reproduced here.
export const authenticate = {
  admin: async (request) => {
    const base = globalThis.__kwAuth ? await globalThis.__kwAuth(request) : { session: { shop: "demo-store.myshopify.com" } };
    const redirect = (url, init) => {
      (globalThis.__kwRedirects ??= []).push({ url, init });
      return new Response(null, { status: 302, headers: { Location: url } });
    };
    return { redirect, ...base };
  },
};
