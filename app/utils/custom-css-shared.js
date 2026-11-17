// Merchant "Custom CSS" for the Wishlist (icon, product-page block, Wishlist page). Pure: no imports.
//
// POLICY (what is accepted; everything else is refused on save, never silently dropped):
//   * plain style rules `selector { property: value; }` and one level of `@media (...) { rules }`. Nothing else:
//     no @import, @font-face, @keyframes, @supports, @charset ... and no nested rules.
//   * no `url()`, `image-set()`, `expression()`, `behavior`, `-moz-binding`, `javascript:`, backslash escapes (they can hide
//     the words above), `<`, or control characters. So the CSS cannot load anything from anywhere.
//   * at most MAX_CSS_CHARS characters per field.
//   * every selector is CONFINED TO THE APP: it must start at the scope's root element (or an app-owned `.kw-` ancestor of
//     it), and a selector that does not mention the root gets the root put in front of it. Sibling combinators (`+`, `~`)
//     and :has() / :is() / :where() / :root / :host / ::slotted are refused, because they can reach outside the root.
//
// LIMITS (do not oversell): this keeps the merchant's rules on the app's own elements, which is what makes the output
// "scoped". It is NOT a sandbox. CSS the merchant writes can still make the app's own elements invisible, huge or ugly, and
// the merchant is trusted with their own storefront. The storefront also never receives the raw text: it receives the
// output of compileCustomCss(), which is rebuilt from the parsed rules only.

export const MAX_CSS_CHARS = 4000;

// scope -> where its rules may apply. `root`: the element the scope is about. An app-owned ancestor is allowed in front of
// the root only for the icon (it lives inside buttons and the header link, and its hover/saved state is on those).
export const CSS_SCOPES = {
  icon: { root: ".kw-heart", ancestors: true, label: "Wishlist icon" },
  product: { root: ".kw-block", ancestors: false, label: "product page block" },
  page: { root: ".kw-page", ancestors: false, label: "Wishlist page" },
};

const FORBIDDEN_VALUE = /url\s*\(|image-set\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|@|[{}<\\]|behavior|binding/i;
const FORBIDDEN_SELECTOR = /:has\s*\(|:is\s*\(|:where\s*\(|:root|:host|::slotted|[{};<\\@]/i;
const PROPERTY = /^-{0,2}[a-z][a-z0-9-]*$/i;
const MEDIA_QUERY = /^[a-z0-9\s():,.\-/]+$/i;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const fail = (error) => ({ ok: false, css: "", error });

// Splits on `separator` outside (), [] and quotes.
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// "a .b > c:hover" -> compounds ["a", ".b", "c:hover"], or null when a sibling combinator is used.
function compoundsOf(selector) {
  const compounds = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const ch of selector) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "(" || ch === "[") {
      depth += 1;
      current += ch;
    } else if (ch === ")" || ch === "]") {
      depth -= 1;
      current += ch;
    } else if (depth === 0 && (ch === "+" || ch === "~")) {
      return null;
    } else if (depth === 0 && (ch === ">" || /\s/.test(ch))) {
      if (current) compounds.push(current);
      current = "";
    } else current += ch;
  }
  if (quote || depth !== 0) return null;
  if (current) compounds.push(current);
  return compounds;
}

const startsWithClass = (compound, className) => compound === className || (compound.startsWith(className) && !/[\w-]/.test(compound[className.length]));

// One selector -> the confined selector, or { error }.
function confineSelector(raw, scope) {
  const selector = raw.trim().replace(/\s+/g, " ");
  if (!selector) return { error: "A selector is empty." };
  if (FORBIDDEN_SELECTOR.test(selector)) return { error: `The selector “${selector.slice(0, 60)}” uses something that is not allowed (for example :has(), :is(), :root or a backslash).` };
  const compounds = compoundsOf(selector);
  if (!compounds || !compounds.length) return { error: `The selector “${selector.slice(0, 60)}” cannot be read, or uses a sibling combinator (+ or ~), which is not allowed.` };
  const rootAt = compounds.findIndex((compound) => startsWithClass(compound, scope.root));
  if (rootAt === -1) return { selector: `${scope.root} ${selector}` };
  // Anything in front of the root must be an app-owned class (and only where the scope allows ancestors).
  const before = compounds.slice(0, rootAt);
  if (before.length && !(scope.ancestors && before.every((compound) => /^\.kw-[\w-]/.test(compound)))) {
    return { error: `The selector “${selector.slice(0, 60)}” must start with ${scope.root}${scope.ancestors ? " (or one of this app’s own .kw- classes before it)" : ""}.` };
  }
  return { selector };
}

function compileDeclarations(body) {
  const out = [];
  for (const piece of splitTopLevel(body, ";")) {
    const text = piece.trim();
    if (!text) continue;
    const colon = text.indexOf(":");
    if (colon < 1) return { error: `“${text.slice(0, 40)}” is not a property: value pair.` };
    const property = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim().replace(/\s+/g, " ");
    if (!PROPERTY.test(property)) return { error: `“${property.slice(0, 40)}” is not a valid property name.` };
    if (!value) return { error: `The property ${property} has no value.` };
    if (FORBIDDEN_VALUE.test(value) || FORBIDDEN_VALUE.test(property)) return { error: `The value of ${property} uses something that is not allowed (url(), @, backslashes, braces and similar).` };
    const quotes = (value.match(/["']/g) || []).length;
    if (quotes % 2 !== 0) return { error: `The value of ${property} has an unclosed quote.` };
    out.push(`${property}:${value}`);
  }
  return { css: out.join(";") };
}

function compileRule(selectorText, body, scope) {
  const selectors = [];
  for (const part of splitTopLevel(selectorText, ",")) {
    const confined = confineSelector(part, scope);
    if (confined.error) return confined;
    selectors.push(confined.selector);
  }
  const declarations = compileDeclarations(body);
  if (declarations.error) return declarations;
  return { css: declarations.css ? `${selectors.join(",")}{${declarations.css}}` : "" };
}

// Reads `{ ... }` blocks one after another from `text`. Returns [{ prelude, body }] or { error }.
function readBlocks(text) {
  const blocks = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) {
      if (text.slice(i).trim()) return { error: "There is text after the last rule that is not inside { }." };
      break;
    }
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    if (depth !== 0) return { error: "A { is never closed." };
    blocks.push({ prelude: text.slice(i, open).trim(), body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return blocks;
}

// `raw` is what the merchant typed. Returns { ok: true, css } (css is "" for empty input) or { ok: false, error }.
export function compileCustomCss(raw, scopeName) {
  const scope = CSS_SCOPES[scopeName];
  if (!scope) return fail("Unknown CSS scope.");
  if (raw === null || raw === undefined) return { ok: true, css: "" };
  if (typeof raw !== "string") return fail("Custom CSS must be text.");
  if (raw.length > MAX_CSS_CHARS) return fail(`Custom CSS can be at most ${MAX_CSS_CHARS} characters (it is ${raw.length}).`);
  if (CONTROL.test(raw)) return fail("Custom CSS contains characters that are not allowed.");
  if (/[<\\]/.test(raw)) return fail("Custom CSS cannot contain “<” or backslashes.");
  if (raw.includes("/*") && !raw.includes("*/", raw.indexOf("/*") + 2)) return fail("A comment is never closed.");
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!text) return { ok: true, css: "" };

  const blocks = readBlocks(text);
  if (blocks.error) return fail(blocks.error);
  const out = [];
  for (const { prelude, body } of blocks) {
    if (!prelude) return fail("A rule has no selector.");
    if (prelude.startsWith("@")) {
      const media = /^@media\s+(.+)$/i.exec(prelude);
      if (!media || !MEDIA_QUERY.test(media[1])) return fail(`“${prelude.slice(0, 40)}” is not allowed. Only @media rules with a simple condition can be used.`);
      const inner = readBlocks(body);
      if (inner.error) return fail(inner.error);
      const rules = [];
      for (const rule of inner) {
        if (!rule.prelude || rule.prelude.startsWith("@") || /[{}]/.test(rule.body)) return fail("Inside @media only plain style rules are allowed.");
        const compiled = compileRule(rule.prelude, rule.body, scope);
        if (compiled.error) return fail(compiled.error);
        if (compiled.css) rules.push(compiled.css);
      }
      if (rules.length) out.push(`@media ${media[1].trim().replace(/\s+/g, " ")}{${rules.join("")}}`);
    } else {
      if (/[{}]/.test(body)) return fail("Rules cannot be nested.");
      const compiled = compileRule(prelude, body, scope);
      if (compiled.error) return fail(compiled.error);
      if (compiled.css) out.push(compiled.css);
    }
  }
  return { ok: true, css: out.join("\n") };
}

// What the "Reset to default" action puts back, and the example shown under each editor.
export const CSS_EXAMPLES = {
  icon: `.kw-heart svg {\n  stroke-width: 2.2;\n}\n.kw-btn:hover .kw-heart {\n  transform: scale(1.1);\n}\n.kw-btn[aria-pressed="true"] .kw-heart svg {\n  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25));\n}`,
  product: `.kw-btn {\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n}\n.kw-btn:hover {\n  opacity: 0.9;\n}\n.kw-btn:focus-visible {\n  outline: 2px solid currentColor;\n}\n.kw-btn[aria-pressed="true"] {\n  font-weight: 700;\n}\n.kw-btn:disabled {\n  opacity: 0.5;\n}`,
  page: `.kw-page__title {\n  font-size: 28px;\n}\n.kw-table img {\n  border-radius: 8px;\n}\n@media (max-width: 600px) {\n  .kw-page__title {\n    font-size: 22px;\n  }\n}`,
};
