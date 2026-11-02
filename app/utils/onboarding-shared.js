// First-time setup checklist on the Dashboard. Pure: no React, no database.
//
// What is stored per shop (ShopSettings.onboarding, a small JSON document): only whether the merchant closed the
// checklist (`dismissed`). Setup itself is never self-reported:
//   Configure   complete when Wishlist Settings were saved (ShopSettings.wishlistAppearance exists)
//   Embed       read from Shopify in the merchant's Admin (App API, shopify.app.extensions(); see detectThemeSetup)
//   Product     the same call, for the Wishlist button block
// Opening the theme editor completes nothing. Older rows may still hold embedConfirmed / productConfirmed from the
// first version of the checklist; they are ignored and dropped the next time the document is written.

export const ONBOARDING_DEFAULT = Object.freeze({ dismissed: false });

// Intent (from the form) -> the one flag it changes and the value it sets.
const INTENTS = {
  dismiss: ["dismissed", true],
  reopen: ["dismissed", false],
};
export const ONBOARDING_INTENTS = Object.keys(INTENTS);

// Whatever the database held (object, JSON text, null, garbage) -> a complete, safe state. Never throws.
export function normalizeOnboarding(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.keys(ONBOARDING_DEFAULT).map((key) => [key, source[key] === true]));
}

// The stored state after an intent, or null when the intent is unknown (nothing should be written).
export function applyOnboardingIntent(state, intent) {
  const change = Object.hasOwn(INTENTS, intent) ? INTENTS[intent] : null;
  return change ? { ...normalizeOnboarding(state), [change[0]]: change[1] } : null;
}

// The block handles are the Liquid file names in extensions/konvert-wishlist/blocks (Shopify's own identifier for a
// block in the App API, so no extension UUID has to be guessed).
export const EMBED_HANDLE = "wishlist-embed";
export const PRODUCT_BLOCK_HANDLE = "wishlist-button";

// What shopify.app.extensions() returned -> { embed, product }, each true (confirmed on), false (confirmed not on) or
// null (cannot tell). Shopify reports the PUBLISHED theme only.
//   embed    the wishlist-embed block has status "active"; "available" / "unavailable" is false
//   product  the wishlist-button block is "active" AND has a placement in the theme (a template), not only in a section
//            group such as the header. The block's schema limits it to product templates (enabled_on), so a template
//            placement is a product template placement.
// Anything unexpected (not an array, block not listed because the extension is not deployed, odd status) is null, never true.
export function detectThemeSetup(extensions) {
  const unknown = { embed: null, product: null };
  if (!Array.isArray(extensions)) return unknown;
  const blocks = extensions
    .filter((extension) => extension && extension.type === "theme_app_extension" && Array.isArray(extension.activations))
    .flatMap((extension) => extension.activations)
    .filter((block) => block && typeof block === "object");
  const find = (handle) => blocks.find((block) => block.handle === handle);
  const known = (status) => (status === "active" ? true : status === "available" || status === "unavailable" ? false : null);
  const inTemplate = (placement) => placement && typeof placement.target === "string" && placement.target !== "" && !placement.target.startsWith("sectionGroup:") && placement.target !== "theme";

  const embed = find(EMBED_HANDLE);
  const product = find(PRODUCT_BLOCK_HANDLE);
  let productState = product ? known(product.status) : null;
  if (productState === true) {
    productState = Array.isArray(product.activations) && product.activations.some(inTemplate);
  }
  return { embed: embed ? known(embed.status) : null, product: productState };
}

export const SETUP_STEPS = [
  { key: "configure", title: "Configure your Wishlist", description: "Customize your Wishlist appearance and settings for your storefront.", action: "Configure Wishlist" },
  { key: "embed", title: "Activate the app in your theme", description: "Enable the Konvert app embed in your Shopify theme so Wishlist and Notify Me features can appear on your storefront.", action: "Activate app embed" },
  { key: "product", title: "Add the Wishlist block to the product page", description: "Add the Wishlist button block to your product template so customers can save products.", action: "Set up product page" },
];

// The checklist as shown: each step with its real status, and the count taken from those statuses.
// `theme` is detectThemeSetup's answer; `undefined` means "not asked yet" (shown as Checking…), null means "could not tell".
// Only a confirmed true counts as completed.
export function setupChecklist(state, { appearanceSaved = false, theme } = {}) {
  const stored = normalizeOnboarding(state);
  const reading = (value) => {
    if (theme === undefined) return { completed: false, status: "Checking…", unknown: false, checking: true };
    if (value === true) return { completed: true, status: "Completed", unknown: false, checking: false };
    if (value === false) return { completed: false, status: "Action required", unknown: false, checking: false };
    return { completed: false, status: "Can’t check", unknown: true, checking: false };
  };
  const per = {
    configure: { completed: Boolean(appearanceSaved), status: appearanceSaved ? "Completed" : "Action required", unknown: false, checking: false },
    embed: reading(theme?.embed),
    product: reading(theme?.product),
  };
  const steps = SETUP_STEPS.map((step) => ({ ...step, ...per[step.key], themeStep: step.key !== "configure" }));
  const completed = steps.filter((step) => step.completed).length;
  return { steps, completed, total: steps.length, allDone: completed === steps.length, dismissed: stored.dismissed };
}
