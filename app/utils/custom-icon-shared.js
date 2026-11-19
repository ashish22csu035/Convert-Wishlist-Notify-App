// Merchant "Custom icon": their own Wishlist icon as SVG. Pure: no imports.
//
// The merchant pastes an <svg>...</svg> (or only a path's `d` data). It is PARSED, never passed through: the storefront
// receives markup rebuilt from the parsed shapes, using only the elements, attributes and value characters listed below.
// So no <script>, <style>, <use>, <image>, <foreignObject>, event handler, style attribute, link or url() can get through,
// and anything that is not on the lists is refused on save with a message (never silently dropped).

export const MAX_ICON_CHARS = 3000;
const MAX_ELEMENTS = 40;

const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const ATTRIBUTES = new Set([
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "transform",
  "fill", "fill-rule", "clip-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-opacity", "opacity",
]);
// Characters a value may hold: numbers, path commands, colours (#hex, names, rgb()), transforms. No quotes, <, >, &, ;, \, : or @.
const SAFE_VALUE = /^[A-Za-z0-9\s.,#%()+-]*$/;
const UNSAFE_WORD = /url\s*\(|javascript|expression/i;
const VIEWBOX = /^\s*-?\d+(?:\.\d+)?(?:[\s,]+-?\d+(?:\.\d+)?){3}\s*$/;
const DEFAULT_VIEWBOX = "0 0 24 24";

const fail = (error) => ({ ok: false, svg: "", error });

const escapeAttr = (value) => value.replace(/"/g, "&quot;");

// `a="1" b='2'` -> { a: "1", b: "2" }, or { error }.
function readAttributes(text) {
  const attrs = {};
  const rest = text.replace(/([^\s=/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, name, double, single) => {
    attrs[name.toLowerCase()] = double ?? single ?? "";
    return " ";
  });
  if (rest.replace(/[\s/]+/g, "")) return { error: `“${rest.trim().slice(0, 40)}” could not be read as an attribute. Write attributes as name="value".` };
  return { attrs };
}

// raw -> { ok: true, svg } (svg is "" for empty input) or { ok: false, error }.
export function compileCustomIcon(raw) {
  if (raw === null || raw === undefined) return { ok: true, svg: "" };
  if (typeof raw !== "string") return fail("The custom icon must be text.");
  if (raw.length > MAX_ICON_CHARS) return fail(`The custom icon can be at most ${MAX_ICON_CHARS} characters (it is ${raw.length}).`);
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\\]/.test(raw)) return fail("The custom icon contains characters that are not allowed.");
  const text = raw.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\?xml[\s\S]*?\?>/gi, " ").trim();
  if (!text) return { ok: true, svg: "" };

  // Only a path's data: "M12 21s-7.5-4.6 ..." becomes one <path>.
  if (!text.includes("<")) {
    if (!/^[Mm][A-Za-z0-9\s.,+-]*$/.test(text)) return fail("Paste an <svg> element, or only the path data (the d=\"...\" value, which starts with M).");
    return { ok: true, svg: `<svg viewBox="${DEFAULT_VIEWBOX}" focusable="false" aria-hidden="true"><path d="${text.replace(/\s+/g, " ")}"/></svg>` };
  }

  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*?)(\/?)>/g;
  let viewBox = DEFAULT_VIEWBOX;
  let sawSvg = false;
  let depth = 0; // open <g> elements
  let svgOpen = false;
  let count = 0;
  let out = "";
  let last = 0;
  let match;
  while ((match = tag.exec(text))) {
    if (text.slice(last, match.index).trim()) return fail("Text between the shapes is not allowed. Only <svg>, <g> and shapes such as <path> are.");
    last = tag.lastIndex;
    const [, closing, nameRaw, attrText, selfClose] = match;
    const name = nameRaw.toLowerCase();

    if (name === "svg") {
      if (closing) {
        if (!svgOpen || depth) return fail("The </svg> does not match an opening tag.");
        svgOpen = false;
        continue;
      }
      if (sawSvg) return fail("Use a single <svg> element.");
      sawSvg = true;
      const parsed = readAttributes(attrText);
      if (parsed.error) return fail(parsed.error);
      if (parsed.attrs.viewbox !== undefined) {
        if (!VIEWBOX.test(parsed.attrs.viewbox)) return fail("The viewBox must be four numbers, for example viewBox=\"0 0 24 24\".");
        viewBox = parsed.attrs.viewbox.trim().replace(/[\s,]+/g, " ");
      }
      // xmlns, width, height, fill, stroke ... on the <svg> itself are ignored: the Wishlist sizes and colours the icon.
      if (!selfClose) svgOpen = true;
      continue;
    }

    if (name === "g") {
      if (closing) {
        if (depth === 0) return fail("A </g> does not match an opening <g>.");
        depth -= 1;
        out += "</g>";
        continue;
      }
      count += 1;
      const parsed = readAttributes(attrText);
      if (parsed.error) return fail(parsed.error);
      const clean = cleanAttributes(parsed.attrs, "g");
      if (clean.error) return fail(clean.error);
      out += `<g${clean.text}>`;
      if (selfClose) out += "</g>";
      else depth += 1;
      continue;
    }

    if (!SHAPES.has(name)) return fail(`<${nameRaw}> is not allowed. You can use <svg>, <g>, <path>, <circle>, <ellipse>, <rect>, <line>, <polyline> and <polygon>.`);
    if (closing) continue; // </path> after <path ...>: the shape was already written
    count += 1;
    if (count > MAX_ELEMENTS) return fail(`Use at most ${MAX_ELEMENTS} shapes.`);
    const parsed = readAttributes(attrText);
    if (parsed.error) return fail(parsed.error);
    const clean = cleanAttributes(parsed.attrs, name);
    if (clean.error) return fail(clean.error);
    if (name === "path" && !clean.text.includes(' d="')) return fail("A <path> needs a d=\"...\" attribute.");
    out += `<${name}${clean.text}/>`;
  }
  if (text.slice(last).trim()) return fail("The icon contains text that is not part of an SVG tag.");
  if (depth || svgOpen) return fail("A tag is never closed.");
  if (!out) return fail("The icon has no shapes. Add at least one <path>.");
  return { ok: true, svg: `<svg viewBox="${viewBox}" focusable="false" aria-hidden="true">${out}</svg>` };
}

function cleanAttributes(attrs, element) {
  let text = "";
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "xmlns" || name === "class" || name === "id") continue; // harmless but meaningless here: dropped, not an error
    if (!ATTRIBUTES.has(name)) return { error: `The attribute “${name}” on <${element}> is not allowed.` };
    if (!SAFE_VALUE.test(value) || UNSAFE_WORD.test(value)) return { error: `The value of ${name} uses something that is not allowed (url(), quotes, & and similar).` };
    text += ` ${name}="${escapeAttr(value.trim().replace(/\s+/g, " "))}"`;
  }
  return { text };
}

// What "Use this example" puts in the box, and the example shown under it: a heart with two sparkles, built from a path, a group
// with a transform and two sparkle shapes. No fill or stroke colour is set, so the icon follows the Wishlist's own colours and
// fills in when the item is saved.
export const CUSTOM_ICON_EXAMPLE = `<svg viewBox="0 0 24 24">
  <!-- the heart, shrunk and moved down to leave room for the sparkles -->
  <g transform="translate(1.5 5) scale(0.82)">
    <path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5.5 6.2 5.5c1.9 0 3.4 1 4.3 2.4l1.5 2 1.5-2c.9-1.4 2.4-2.4 4.3-2.4 3.2 0 5 3.1 3.7 6.3C19.5 16.4 12 21 12 21z"/>
  </g>
  <!-- a big and a small sparkle -->
  <path d="M19 2.5v5M16.5 5h5"/>
  <path d="M5 2.5v3M3.5 4h3"/>
</svg>`;
