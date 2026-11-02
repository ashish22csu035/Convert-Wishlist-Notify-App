// Notify Me settings, shared by the server (which enforces them and sends the emails), the Notify Me Settings screen
// and its previews. Pure: no imports from the server.
//
// One document, stored in ShopSettings.notifyMeSettings, in two sections:
//   button  the storefront Notify Me button (text, style, colours). Sent to the storefront; nothing else is.
//   email   the back-in-stock email (subject, heading, body, button label). Used only by the email sender.
// The stored form is SPARSE ({ version, button?, email? }). Button keys equal to their default are dropped. Email keys the
// merchant saved are kept even when they equal the default ("sticky"), so a saved default is not replaced by an older
// value from the legacy columns (ShopSettings.emailSubject / emailBody / buttonLabel), which are only a fallback for
// shops that customised before this screen existed.
//
// The email text can use three variables, all filled from data the restock flow really has. There is no customer name
// variable: the app stores only the subscriber's email address, never a name.

import { normalizeColor, parseField } from "./wishlist-appearance-shared.js";

export const NOTIFY_VERSION = 1;
export const MAX_NOTIFY_BYTES = 8192;

export const NOTIFY_VARIABLES = [
  { token: "product", label: "Product name", sample: "Linen shirt (Medium)" },
  { token: "product_url", label: "Product link", sample: "https://your-store.myshopify.com/products/linen-shirt?variant=1" },
  { token: "shop_name", label: "Store name", sample: "Your store" },
];
const KNOWN = new Set(NOTIFY_VARIABLES.map((variable) => variable.token));

const text = (min, max, fallback, { variables = false, sticky = false } = {}) => ({ type: "text", min, max, default: fallback, variables, sticky });
const enumOf = (options, fallback) => ({ type: "enum", options, default: fallback });
const color = () => ({ type: "color", default: null });

export const SPEC = {
  button: {
    text: text(1, 40, "Notify Me"),
    style: enumOf(["theme", "filled", "outline"], "theme"), // theme = keep the theme's own button look
    bgColor: color(),
    textColor: color(),
  },
  email: {
    subject: text(1, 150, "{{product}} is back in stock", { variables: true, sticky: true }),
    heading: text(0, 100, "", { variables: true, sticky: true }), // empty = no heading, as the email was before this setting
    body: text(1, 1000, "Good news! {{product}} is back in stock.", { variables: true, sticky: true }),
    ctaLabel: text(1, 40, "View product", { sticky: true }),
  },
};
export const SECTIONS = Object.keys(SPEC);

export const OPTION_LABELS = {
  style: [["theme", "Match my theme"], ["filled", "Filled"], ["outline", "Outline"]],
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// eslint-disable-next-line no-control-regex
const cleanText = (value) => String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

// Every {{ name }} in a template that is not one of the supported variables.
export function unknownVariables(template) {
  const found = [];
  for (const match of String(template).matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    if (!KNOWN.has(match[1].toLowerCase()) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

function parseNotifyField(spec, raw) {
  if (spec.type === "text") {
    if (typeof raw !== "string") return { ok: false, error: "Enter some text." };
    const value = cleanText(raw);
    if (value.length < spec.min) return { ok: false, error: spec.min === 1 ? "This cannot be empty." : `Use at least ${spec.min} characters.` };
    if (value.length > spec.max) return { ok: false, error: `Use at most ${spec.max} characters.` };
    if (spec.variables) {
      const unknown = unknownVariables(value);
      if (unknown.length) return { ok: false, error: `Unknown variable ${unknown.map((name) => `{{${name}}}`).join(", ")}. You can use ${NOTIFY_VARIABLES.map((variable) => `{{${variable.token}}}`).join(", ")}.` };
    } else if (value.includes("{{")) {
      return { ok: false, error: "Variables are not available in this field." };
    }
    return { ok: true, value };
  }
  return parseField(spec, raw);
}

const eachField = (visit) => {
  for (const section of SECTIONS) for (const key of Object.keys(SPEC[section])) visit(section, key, SPEC[section][key]);
};

export const DEFAULT_NOTIFY = (() => {
  const out = {};
  for (const section of SECTIONS) out[section] = {};
  eachField((section, key, spec) => {
    out[section][key] = spec.default;
  });
  for (const section of SECTIONS) Object.freeze(out[section]);
  return Object.freeze(out);
})();

export const sectionDefaults = (section) => ({ ...DEFAULT_NOTIFY[section] });

// Anything -> a complete settings object. A missing, wrong or hostile value falls back to its default.
export function resolveNotify(input) {
  const source = isPlainObject(input) ? input : {};
  const out = {};
  for (const section of SECTIONS) out[section] = {};
  eachField((section, key, spec) => {
    const part = isPlainObject(source[section]) ? source[section] : {};
    const parsed = has(part, key) ? parseNotifyField(spec, part[key]) : { ok: false };
    out[section][key] = parsed.ok ? parsed.value : spec.default;
  });
  return out;
}

// Anything -> the sparse document to store.
export function toSparseNotify(input) {
  const source = isPlainObject(input) ? input : {};
  const out = { version: NOTIFY_VERSION };
  eachField((section, key, spec) => {
    const part = isPlainObject(source[section]) ? source[section] : null;
    if (!part || !has(part, key)) return;
    const parsed = parseNotifyField(spec, part[key]);
    if (!parsed.ok || (parsed.value === spec.default && !spec.sticky)) return;
    (out[section] ||= {})[key] = parsed.value;
  });
  return out;
}

export function normalizeNotifyStored(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return toSparseNotify(value);
}

// What the settings screen shows and the email sender uses: the stored document, with the legacy columns filling any
// email key the document does not have, then the defaults.
export function effectiveNotify(rawDocument, legacy = null) {
  const stored = normalizeNotifyStored(rawDocument);
  const email = { ...(stored.email ?? {}) };
  const fromLegacy = { subject: legacy?.emailSubject, body: legacy?.emailBody, ctaLabel: legacy?.buttonLabel };
  for (const [key, value] of Object.entries(fromLegacy)) {
    if (!has(email, key) && typeof value === "string" && value.trim() !== "") email[key] = value;
  }
  return resolveNotify({ ...stored, email });
}

// The storefront gets the button section only: valid, display-only values. Never the email text.
export function publicNotifyButton(raw) {
  return normalizeNotifyStored(raw).button ?? {};
}

// Strict check of what a browser sent (JSON text or object, complete or partial). Returns { values, errors } like
// validateAppearance: `values` holds the valid recognised keys, `errors` maps "section.key" to a message.
export function validateNotify(input) {
  const errors = {};
  const values = {};
  let source = input;
  if (typeof source === "string") {
    if (new TextEncoder().encode(source).length > MAX_NOTIFY_BYTES) return { values, errors: { settings: "The settings are too large." } };
    try {
      source = JSON.parse(source);
    } catch {
      return { values, errors: { settings: "The settings could not be read." } };
    }
  }
  if (!isPlainObject(source)) return { values, errors: { settings: "The settings could not be read." } };
  for (const section of SECTIONS) {
    if (!has(source, section)) continue;
    const part = source[section];
    if (!isPlainObject(part)) {
      errors[section] = "The settings could not be read.";
      continue;
    }
    for (const key of Object.keys(SPEC[section])) {
      if (!has(part, key)) continue;
      const parsed = parseNotifyField(SPEC[section][key], part[key]);
      if (parsed.ok) (values[section] ||= {})[key] = parsed.value;
      else errors[`${section}.${key}`] = parsed.error;
    }
  }
  return { values, errors };
}

export function mergeNotify(base, patch) {
  const out = {};
  for (const section of SECTIONS) {
    out[section] = { ...(isPlainObject(base?.[section]) ? base[section] : {}), ...(isPlainObject(patch?.[section]) ? patch[section] : {}) };
  }
  return out;
}

// True when the two would behave differently (compares the complete forms).
export const isNotifyDirty = (current, saved) => JSON.stringify(resolveNotify(current)) !== JSON.stringify(resolveNotify(saved));

// ---------------------------------------------------------------------------------------------------------------
// The email. The real sender and the preview both call renderNotifyEmail, so they cannot drift apart.
// ---------------------------------------------------------------------------------------------------------------

// Replaces the supported variables with their values. Anything else stays as typed. The values are plain text here;
// they are HTML-escaped only where the HTML is built.
export function fillTemplate(template, values) {
  return String(template).replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (whole, name) => {
    const key = name.toLowerCase();
    return KNOWN.has(key) && typeof values?.[key] === "string" ? values[key] : whole;
  });
}

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const RESTOCK_FOOTER = "You are receiving this email because you asked to be notified when this item was back in stock.";

// `email` is effectiveNotify(...).email; `values` is { product, product_url, shop_name } (plain text);
// `unsubscribeLink` is the https link built by the server. Returns the subject and the text and HTML bodies.
export function renderNotifyEmail(email, values, unsubscribeLink, fallbackSubject) {
  const fill = (template, max) => cleanText(fillTemplate(template, values)).slice(0, max);
  const subject = fill(email.subject, 150) || fallbackSubject;
  const heading = fill(email.heading, 100);
  const intro = fill(email.body, 1000);
  const button = fill(email.ctaLabel, 40) || "View product";
  const link = values.product_url;

  const text = `${heading ? `${heading}\n\n` : ""}${intro}\n\n${button}: ${link}\n\n${RESTOCK_FOOTER}\nUnsubscribe: ${unsubscribeLink}\n`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;max-width:560px">` +
    (heading ? `<h2 style="font-size:22px;line-height:1.3;margin:0 0 12px">${escapeHtml(heading)}</h2>` : "") +
    `<p>${escapeHtml(intro)}</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#000;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(button)}</a></p>` +
    `<p style="font-size:13px;color:#666">${escapeHtml(RESTOCK_FOOTER)}<br><a href="${escapeHtml(unsubscribeLink)}" style="color:#666">Unsubscribe</a></p></div>`;
  return { subject, heading, intro, button, text, html };
}

// The same email with sample data, for the preview on the settings screen.
export function sampleNotifyEmail(email) {
  const values = Object.fromEntries(NOTIFY_VARIABLES.map((variable) => [variable.token, variable.sample]));
  return renderNotifyEmail(email, values, "https://your-store.myshopify.com/unsubscribe", "Your item is back in stock");
}

// How the storefront shows the button for these settings, as inline style for the preview. The storefront stylesheet
// (konvert-wishlist.css) implements the same three looks; a test keeps them in step.
// The storefront's own success wording (locales/en.default.json "notify_subscribed", used by konvert-wishlist-extras.js).
export const NOTIFY_SUBSCRIBED_LABEL = "You're on the list!";

// Where the storefront really offers Notify Me. Product page: the theme's Add to cart button is relabelled while the
// selected variant is sold out (startNotifyProduct). Wishlist page: a sold-out saved variant gets the button.
export const NOTIFY_PAGE_TYPES = [
  { key: "product", label: "Product page" },
  { key: "wishlist", label: "Wishlist page" },
];

// The email for the preview frame with every link made inert, so a click can go nowhere (the frame is also sandboxed and
// has no script). The sample URLs never reach the document; the button keeps its look.
export function inertEmailHtml(html) {
  return String(html).replace(/<a href="[^"]*" style="/g, '<a role="button" aria-disabled="true" style="cursor:pointer;');
}

export function notifyButtonStyle(button) {
  const bg = normalizeColor(button?.bgColor);
  const fg = normalizeColor(button?.textColor);
  if (button?.style === "filled") return { background: bg ?? "#111111", border: `1px solid ${bg ?? "#111111"}`, color: fg ?? "#ffffff" };
  if (button?.style === "outline") return { background: "transparent", border: `1px solid ${bg ?? "currentColor"}`, color: fg ?? bg ?? "inherit" };
  return { ...(bg ? { background: bg } : { background: "#e8e8e8" }), border: "1px solid transparent", color: fg ?? "#1a1a1a" };
}
