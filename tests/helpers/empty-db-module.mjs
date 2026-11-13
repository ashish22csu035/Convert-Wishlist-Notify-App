// Stand-in for app/db.server.js in route tests that only need a billing model for its pure helpers: it has no connection and no methods,
// so any attempt to use the database fails loudly instead of reaching a real one.
export default new Proxy(
  {},
  {
    get: (_target, name) => {
      throw new Error(`the database is not available in this test (${String(name)})`);
    },
  },
);
