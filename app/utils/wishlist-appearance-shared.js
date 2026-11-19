// Wishlist appearance settings, shared by the server (which enforces them), the Wishlist Settings screen and its
// preview. Pure: no imports from the server.
//
// Two shapes of the same document:
//   RESOLVED  every key present, defaults filled in. What the screen edits and the preview draws.
//   SPARSE    only the keys that differ from DEFAULT_APPEARANCE, plus `version`. What is stored in
//             ShopSettings.wishlistAppearance and what the storefront receives. An untouched shop is just
//             { version: 1 }, which the storefront reads as "today's look" (nothing is overridden).
//
// Colours default to null = "not set by the app": the storefront then keeps the heart colour chosen in the
// theme editor (Wishlist embed > Heart color), and only an explicitly saved colour overrides it.
// The server is the authority: validateAppearance() runs on every save, and normalizeStored() makes anything
// read back from the database (or sent to the storefront) safe, whatever is in the column.

import { compileCustomCss } from "./custom-css-shared.js";
import { compileCustomIcon } from "./custom-icon-shared.js";

export const APPEARANCE_VERSION = 1;
// Three Custom CSS fields of up to MAX_CSS_CHARS characters each (see custom-css-shared.js) make the document larger than the
// plain settings ever were, so the cap leaves room for them.
export const MAX_APPEARANCE_BYTES = 40000;
export const HEADER_TEXT_MAX = 30;

// The heart colour of an untouched store (konvert-wishlist.css), used only to draw the preview.
export const THEME_ACCENT_FALLBACK = "#d6336c";

// The three icon shapes (24x24, stroked). They must stay identical to the paths in the theme extension's
// konvert-wishlist.js, which a test checks; the preview draws these so it matches the storefront.
export const ICON_PATHS = {
  heart: "M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5.5 6.2 5.5c1.9 0 3.4 1 4.3 2.4l1.5 2 1.5-2c.9-1.4 2.4-2.4 4.3-2.4 3.2 0 5 3.1 3.7 6.3C19.5 16.4 12 21 12 21z",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  bookmark: "M6 3h12v18l-6-4.5L6 21z",
};

// The icon markup the storefront script puts inside every .kw-heart (all three shapes; the CSS shows one). A test
// checks it is character-for-character the one in konvert-wishlist.js, so the preview draws the real thing.
export const wishlistIconSvg = () =>
  `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path class="kw-i-heart" d="${ICON_PATHS.heart}"/><path class="kw-i-star" d="${ICON_PATHS.star}"/><path class="kw-i-bookmark" d="${ICON_PATHS.bookmark}"/></svg>`;

const enumOf = (options, fallback) => ({ type: "enum", options, default: fallback });
const bool = (fallback) => ({ type: "bool", default: fallback });
const color = () => ({ type: "color", default: null });
// Custom CSS: text that must compile under the policy in custom-css-shared.js. `scope` names which part of the storefront it may touch.
const css = (scope) => ({ type: "css", scope, default: "" });
// Custom icon: SVG text that must compile under the policy in custom-icon-shared.js.
const svg = () => ({ type: "svg", default: "" });
const label = (max, fallback) => ({ type: "text", max, default: fallback });
const int = (min, max, fallback, nullable = false) => ({ type: "int", min, max, default: fallback, nullable });

// Every supported setting. Order here is the order of keys in a sparse document.
export const SPEC = {
  general: {
    iconType: enumOf(["heart", "star", "bookmark", "custom"], "heart"),
    customIcon: svg(), // the merchant's own icon, used when iconType is "custom"
    defaultColor: color(),
    hoverColor: color(),
    activeColor: color(),
    useThemeFonts: bool(true),
    customCss: css("icon"), // advanced override for the Wishlist icon only
  },
  productPage: {
    enabled: bool(true),
    // What the product page shows: the Wishlist button block (today's behaviour), a standalone icon, or both. The icon
    // needs no block: the Wishlist embed lays it over the product's main image. Its shape is the one chosen in General (iconType);
    // imagePosition is the corner of that image, and is only used when an icon is shown.
    displayMode: enumOf(["button", "icon", "both"], "button"),
    imagePosition: enumOf(["top-right", "top-left", "bottom-left", "bottom-right"], "top-right"),
    buttonType: enumOf(["icon_text", "icon"], "icon_text"),
    // Horizontal alignment inside the app block. It only shows when the width is not "full". WHERE the block sits
    // on the page (for example under Add to cart) is chosen in the theme editor, not here.
    position: enumOf(["left", "center", "right"], "left"),
    buttonStyle: enumOf(["outline", "filled"], "outline"),
    buttonRadius: int(0, 50, null, true), // null = follow the theme's button radius
    widthMode: enumOf(["full", "auto", "manual"], "full"),
    manualWidth: int(100, 800, 240),
    customCss: css("product"), // advanced override for the Wishlist button block only
  },
  collectionPage: {
    enabled: bool(true),
    iconSize: int(14, 40, 22),
    backgroundOpacity: int(0, 100, 92),
    position: enumOf(["top-right", "top-left", "bottom-left", "bottom-right"], "top-right"),
    countDisplay: enumOf(["header_badge", "none"], "header_badge"),
  },
  wishlistPage: {
    layout: enumOf(["table", "grid"], "table"),
    headerIcon: bool(true), // the header shortcut to the Wishlist page (still needs the theme embed to be on)
    headerStyle: enumOf(["icon", "text", "icon_text"], "icon"), // what that shortcut shows
    headerText: label(HEADER_TEXT_MAX, "My wishlist"), // its label when headerStyle shows text
    customCss: css("page"), // advanced override for the Wishlist page only
  },
};

export const SECTIONS = Object.keys(SPEC);

// Labels for the screen. Values are the ones in SPEC.
export const OPTION_LABELS = {
  iconType: [["heart", "Heart"], ["star", "Star"], ["bookmark", "Bookmark"], ["custom", "Custom"]],
  displayMode: [["button", "Button only"], ["icon", "Icon only"], ["both", "Both icon and button"]],
  buttonType: [["icon_text", "Icon with text"], ["icon", "Icon only"]],
  productPosition: [["left", "Left"], ["center", "Center"], ["right", "Right"]],
  buttonStyle: [["outline", "Outline"], ["filled", "Filled"]],
  widthMode: [["full", "Full width of the block"], ["auto", "Automatic (fits the content)"], ["manual", "Fixed width"]],
  collectionPosition: [["top-right", "Top right"], ["top-left", "Top left"], ["bottom-left", "Bottom left"], ["bottom-right", "Bottom right"]],
  countDisplay: [["header_badge", "Count badge on the header icon"], ["none", "No count"]],
  layout: [["table", "Table"], ["grid", "Grid"]],
  headerStyle: [["icon", "Icon"], ["text", "Text"], ["icon_text", "Icon and text"]],
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// "#ABC" and "#aabbcc" both become "#aabbcc"; null for anything else. Names, rgb(), url() and the like are
// refused on purpose, so a colour can never carry anything but a colour into the storefront's CSS.
export function normalizeColor(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!HEX.test(text)) return null;
  const digits = text.slice(1).toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits}`;
}

// One value against its rule. Returns { ok: true, value } (value normalized) or { ok: false, error }.
export function parseField(spec, raw) {
  switch (spec.type) {
    case "enum":
      return typeof raw === "string" && spec.options.includes(raw) ? { ok: true, value: raw } : { ok: false, error: "Choose one of the listed options." };
    case "bool":
      return raw === true || raw === false ? { ok: true, value: raw } : { ok: false, error: "Choose on or off." };
    case "color": {
      if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { ok: true, value: null };
      const value = normalizeColor(raw);
      return value ? { ok: true, value } : { ok: false, error: "Use a hex color such as #d6336c." };
    }
    case "int": {
      if ((raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) && spec.nullable) return { ok: true, value: null };
      const number = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
      if (Number.isInteger(number) && number >= spec.min && number <= spec.max) return { ok: true, value: number };
      return { ok: false, error: `Enter a whole number from ${spec.min} to ${spec.max}.` };
    }
    case "css": {
      if (raw === null || raw === undefined) return { ok: true, value: "" };
      const compiled = compileCustomCss(raw, spec.scope);
      return compiled.ok ? { ok: true, value: raw.trim() } : { ok: false, error: compiled.error };
    }
    case "svg": {
      if (raw === null || raw === undefined) return { ok: true, value: "" };
      const compiled = compileCustomIcon(raw);
      return compiled.ok ? { ok: true, value: raw.trim() } : { ok: false, error: compiled.error };
    }
    case "text": {
      if (typeof raw !== "string") return { ok: false, error: "Enter some text." };
      const value = raw.trim().replace(/\s+/g, " ");
      if (!value) return { ok: true, value: spec.default };
      if (value.length > spec.max) return { ok: false, error: `Use at most ${spec.max} characters.` };
      // eslint-disable-next-line no-control-regex -- control characters are refused on purpose
      if (/[<>&"\u0000-\u001f]/.test(value)) return { ok: false, error: "Use plain text without < > & or quotes." };
      return { ok: true, value };
    }
    default:
      return { ok: false, error: "Unsupported setting." };
  }
}

const eachField = (visit) => {
  for (const section of SECTIONS) for (const key of Object.keys(SPEC[section])) visit(section, key, SPEC[section][key]);
};

// The complete default appearance (every key). Frozen: copy before editing.
export const DEFAULT_APPEARANCE = (() => {
  const out = {};
  for (const section of SECTIONS) out[section] = {};
  eachField((section, key, spec) => {
    out[section][key] = spec.default;
  });
  for (const section of SECTIONS) Object.freeze(out[section]);
  return Object.freeze(out);
})();

// Defaults of one section, as a fresh object (the per-tab "Reset to defaults").
export const sectionDefaults = (section) => ({ ...DEFAULT_APPEARANCE[section] });

// Anything -> a complete appearance. A missing, wrong or hostile value falls back to its default.
export function resolveAppearance(input) {
  const source = isPlainObject(input) ? input : {};
  const out = {};
  for (const section of SECTIONS) out[section] = {};
  eachField((section, key, spec) => {
    const part = isPlainObject(source[section]) ? source[section] : {};
    const parsed = has(part, key) ? parseField(spec, part[key]) : { ok: false };
    out[section][key] = parsed.ok ? parsed.value : spec.default;
  });
  return out;
}

// Anything -> the sparse document: only keys that are valid AND differ from the default, plus the version.
export function toSparse(input) {
  const source = isPlainObject(input) ? input : {};
  const out = { version: APPEARANCE_VERSION };
  eachField((section, key, spec) => {
    const part = isPlainObject(source[section]) ? source[section] : null;
    if (!part || !has(part, key)) return;
    const parsed = parseField(spec, part[key]);
    if (!parsed.ok || parsed.value === spec.default) return;
    (out[section] ||= {})[key] = parsed.value;
  });
  return out;
}

// What the database held (a parsed object, a JSON string, null, or garbage) -> a safe sparse document. Never throws.
export function normalizeStored(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return toSparse(value);
}

// The storefront gets exactly the sparse, validated document. Nothing else from the row is ever added to it.
// Custom CSS never travels inside this document: it is delivered separately, already compiled (publicCustomCss), so the
// storefront script has no raw merchant text to interpret. Header text is display text and stays.
// With the "Custom" icon the colours are set by the merchant's own CSS, so the three colour pickers (hidden on the screen) must not
// apply any value saved from an earlier heart/star/bookmark. Shared with the preview so both agree.
export function dropColorsWhenCustom(general) {
  if (general?.iconType !== "custom") return general;
  delete general.defaultColor;
  delete general.hoverColor;
  delete general.activeColor;
  return general;
}

export function publicAppearance(raw) {
  const sparse = normalizeStored(raw);
  for (const section of SECTIONS) {
    if (!sparse[section]) continue;
    delete sparse[section].customCss;
    delete sparse[section].customIcon; // delivered separately, compiled (publicCustomIcon)
    if (section === "general") dropColorsWhenCustom(sparse.general);
    if (!Object.keys(sparse[section]).length) delete sparse[section];
  }
  return sparse;
}

// The compiled icon markup for the storefront, or "" when the merchant has not chosen "Custom" or the SVG is empty/invalid
// (the storefront then keeps the heart). Rebuilt from the parsed shapes on every call.
export function publicCustomIcon(raw) {
  const general = normalizeStored(raw).general;
  if (general?.iconType !== "custom") return "";
  const compiled = compileCustomIcon(general.customIcon);
  return compiled.ok ? compiled.svg : "";
}

// The compiled, confined CSS per scope: { icon, product, page }, only non-empty ones. Rebuilt from the parsed rules on every call.
export function publicCustomCss(raw) {
  const sparse = normalizeStored(raw);
  const out = {};
  for (const [scope, section] of [["icon", "general"], ["product", "productPage"], ["page", "wishlistPage"]]) {
    if (scope === "icon") continue; // no screen edits the icon CSS any more: anything saved earlier is not delivered
    const compiled = compileCustomCss(sparse[section]?.customCss, scope);
    if (compiled.ok && compiled.css) out[scope] = compiled.css;
  }
  return out;
}

// Strict check of what a browser sent. `input` is a JSON string or an object, complete or partial.
// Returns { values, errors }: `values` holds only the recognised keys that were valid (normalized, defaults
// included); `errors` maps "section.key" to a message. Unknown sections and keys are ignored. An oversized or
// malformed document is refused as a whole under the key "appearance".
export function validateAppearance(input) {
  const errors = {};
  const values = {};
  let source = input;
  if (typeof source === "string") {
    if (new TextEncoder().encode(source).length > MAX_APPEARANCE_BYTES) return { values, errors: { appearance: "The settings are too large." } };
    try {
      source = JSON.parse(source);
    } catch {
      return { values, errors: { appearance: "The settings could not be read." } };
    }
  }
  if (!isPlainObject(source)) return { values, errors: { appearance: "The settings could not be read." } };

  for (const section of SECTIONS) {
    if (!has(source, section)) continue;
    const part = source[section];
    if (!isPlainObject(part)) {
      errors[section] = "The settings could not be read.";
      continue;
    }
    for (const key of Object.keys(SPEC[section])) {
      if (!has(part, key)) continue;
      const parsed = parseField(SPEC[section][key], part[key]);
      if (parsed.ok) (values[section] ||= {})[key] = parsed.value;
      else errors[`${section}.${key}`] = parsed.error;
    }
  }
  return { values, errors };
}

// Layers `patch` over `base` key by key: keys the patch does not mention keep their saved value.
export function mergeAppearance(base, patch) {
  const out = {};
  for (const section of SECTIONS) {
    out[section] = { ...(isPlainObject(base?.[section]) ? base[section] : {}), ...(isPlainObject(patch?.[section]) ? patch[section] : {}) };
  }
  return out;
}

// True when the two appearances would be stored differently. Comparing the sparse forms ignores defaults that
// are spelled out in one and left out of the other.
export function isAppearanceDirty(current, saved) {
  return JSON.stringify(toSparse(current)) !== JSON.stringify(toSparse(saved));
}
