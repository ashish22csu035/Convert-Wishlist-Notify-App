import prisma from "../db.server";
import { DEFAULT_SETTINGS, FEATURE_FIELDS, validateSettings } from "../utils/settings-shared";

// Merchant settings, stored in ShopSettings: the Wishlist and Notify Me switches. They are independent.
// A shop with no settings row keeps the default (both on), so existing shops behave as before until the
// merchant changes a switch. Turning a feature off only stops NEW activity (see getFeatureFlags and its
// callers); no subscription, event, email record, order or attribution is touched, so turning it back on
// restores everything. The email columns of ShopSettings are not edited here and are left as they are
// (the email builder still reads them).

export { DEFAULT_SETTINGS, validateSettings };

// Same placeholder shop row the storefront path creates before the real currency is known.
const UNKNOWN_CURRENCY = "XXX";

const pick = (row) => ({
  wishlistEnabled: row ? row.wishlistEnabled : DEFAULT_SETTINGS.wishlistEnabled,
  notifyMeEnabled: row ? row.notifyMeEnabled : DEFAULT_SETTINGS.notifyMeEnabled,
});

export async function getSettings(shopId) {
  const row = shopId ? await prisma.shopSettings.findUnique({ where: { shopId } }) : null;
  return pick(row);
}

// Read-only, by shop domain (what the storefront endpoints know). Never creates anything.
export async function getFeatureFlags(shopDomain) {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain }, select: { id: true, settings: { select: { wishlistEnabled: true, notifyMeEnabled: true } } } });
  const flags = pick(shop?.settings ?? null);
  return { wishlist: flags.wishlistEnabled, notifyMe: flags.notifyMeEnabled };
}

export async function saveSettings(shopDomain, values) {
  const shop = await prisma.shop.upsert({
    where: { domain: shopDomain },
    create: { domain: shopDomain, currencyCode: UNKNOWN_CURRENCY },
    update: {},
    select: { id: true },
  });
  const data = Object.fromEntries(FEATURE_FIELDS.map((field) => [field, Boolean(values[field])]));
  await prisma.shopSettings.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id, ...data }, update: data });
}
