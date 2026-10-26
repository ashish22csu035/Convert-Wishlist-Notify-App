// Stand-in for app/models/settings.server.js when a route module is bundled for the jsdom tests (no database).
// A test sets globalThis.__kwSettings = { getAppearance(shop), saveAppearance(shop, input) }; by default a shop with no
// saved appearance gets the real defaults.
import { resolveAppearance } from "../../app/utils/wishlist-appearance-shared.js";

export const getAppearance = async (shop) => (globalThis.__kwSettings?.getAppearance ? globalThis.__kwSettings.getAppearance(shop) : resolveAppearance(null));
export const saveAppearance = async (shop, input) => globalThis.__kwSettings.saveAppearance(shop, input);
