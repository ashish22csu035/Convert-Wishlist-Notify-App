// Stand-in for app/shopify.server.js when a route module is bundled for the jsdom tests: `authenticate.admin` answers
// with whatever the test put in globalThis.__kwAuth (a function that returns a session or throws a response),
// defaulting to an authenticated demo shop.
export const authenticate = {
  admin: async (request) => (globalThis.__kwAuth ? globalThis.__kwAuth(request) : { session: { shop: "demo-store.myshopify.com" } }),
};
