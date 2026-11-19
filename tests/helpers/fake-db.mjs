// An in-memory stand-in for app/db.server.js (the Prisma client), for tests that must not touch a database. It implements only
// what app/models/settings.server.js calls: shop.upsert / shop.findUnique(OrThrow) by domain and shopSettings.findUnique / upsert by shopId.
// `select` is ignored (full rows come back), which is a superset of what any caller asks for.
const shops = new Map(); // domain -> { id, domain, currencyCode, status, installedAt }
const settings = new Map(); // shopId -> { shopId, ...columns }
let next = 1;

const withSettings = (shop) => (shop ? { ...shop, settings: settings.get(shop.id) ?? null } : null);

const prisma = {
  __reset() {
    shops.clear();
    settings.clear();
    next = 1;
  },
  shop: {
    async upsert({ where, create }) {
      let shop = shops.get(where.domain);
      if (!shop) {
        shop = { id: `shop-${next++}`, status: "ACTIVE", installedAt: new Date(), ...create };
        shops.set(shop.domain, shop);
      }
      return withSettings(shop);
    },
    async findUnique({ where }) {
      return withSettings(shops.get(where.domain));
    },
    async findUniqueOrThrow({ where }) {
      const shop = shops.get(where.domain);
      if (!shop) throw new Error("not found");
      return withSettings(shop);
    },
  },
  shopSettings: {
    async findUnique({ where }) {
      return settings.get(where.shopId) ?? null;
    },
    async upsert({ where, create, update }) {
      const row = settings.get(where.shopId);
      const value = row ? { ...row, ...update } : { shopId: where.shopId, wishlistEnabled: true, notifyMeEnabled: true, ...create };
      settings.set(where.shopId, value);
      return value;
    },
  },
};
export default prisma;
