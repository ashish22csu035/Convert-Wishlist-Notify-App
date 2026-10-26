import prisma from "../db.server";
import { DEFAULT_SETTINGS, FEATURE_FIELDS, validateSettings } from "../utils/settings-shared";
import { mergeAppearance, normalizeStored, publicAppearance, resolveAppearance, toSparse, validateAppearance } from "../utils/wishlist-appearance-shared";

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

// ---------------------------------------------------------------------------------------------------------
// Wishlist appearance (ShopSettings.wishlistAppearance). Independent of the switches above: saveSettings never
// writes this column and saveAppearance writes nothing else, so neither can disturb the other, the email columns
// or any other shop. Every function takes the shop DOMAIN, which only ever comes from the authenticated Admin
// session or the signed storefront request, never from a form field.
// ---------------------------------------------------------------------------------------------------------

async function readStoredAppearance(shopDomain) {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain }, select: { settings: { select: { wishlistAppearance: true } } } });
  return shop?.settings?.wishlistAppearance ?? null;
}

// The complete appearance for the Wishlist Settings screen. A shop with no row, or a damaged document, gets the defaults.
export async function getAppearance(shopDomain) {
  return resolveAppearance(normalizeStored(shopDomain ? await readStoredAppearance(shopDomain) : null));
}

// The sparse, validated document the storefront receives: display settings only. Read-only, creates nothing.
export async function getPublicAppearance(shopDomain) {
  return publicAppearance(await readStoredAppearance(shopDomain));
}

// `input` is the JSON text (or object) the screen sent, complete or partial. Keys it does not mention keep their
// saved value; keys set back to their default are dropped from the stored document.
// Returns { ok: true, errors: {}, appearance } with the complete saved appearance, or { ok: false, errors }.
export async function saveAppearance(shopDomain, input) {
  const { values, errors } = validateAppearance(input);
  if (Object.keys(errors).length) return { ok: false, errors };
  const shop = await prisma.shop.upsert({
    where: { domain: shopDomain },
    create: { domain: shopDomain, currencyCode: UNKNOWN_CURRENCY },
    update: {},
    select: { id: true, settings: { select: { wishlistAppearance: true } } },
  });
  const document = toSparse(mergeAppearance(normalizeStored(shop.settings?.wishlistAppearance), values));
  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, wishlistAppearance: document },
    update: { wishlistAppearance: document },
  });
  return { ok: true, errors: {}, appearance: resolveAppearance(document) };
}

// What GET /api/features answers: the two switches (exactly as getFeatureFlags) plus the public appearance, in one
// read. If the appearance column cannot be read, the switches are still answered, so a Wishlist the merchant
// switched off never reappears because of an appearance problem.
export async function getStorefrontFeatures(shopDomain) {
  try {
    const shop = await prisma.shop.findUnique({
      where: { domain: shopDomain },
      select: { settings: { select: { wishlistEnabled: true, notifyMeEnabled: true, wishlistAppearance: true } } },
    });
    const flags = pick(shop?.settings ?? null);
    return { wishlist: flags.wishlistEnabled, notifyMe: flags.notifyMeEnabled, appearance: publicAppearance(shop?.settings?.wishlistAppearance) };
  } catch (error) {
    console.error("[wishlist] appearance unavailable, answering the switches only", error?.code ?? error?.name ?? "error");
    return { ...(await getFeatureFlags(shopDomain)), appearance: publicAppearance(null) };
  }
}
