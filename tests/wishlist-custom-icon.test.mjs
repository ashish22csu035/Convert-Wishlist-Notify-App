import test from "node:test";
import assert from "node:assert/strict";
import { compileCustomIcon, CUSTOM_ICON_EXAMPLE } from "../app/utils/custom-icon-shared.js";
import { publicAppearance, publicCustomIcon, validateAppearance } from "../app/utils/wishlist-appearance-shared.js";

test("the shipped example compiles", () => {
  const r = compileCustomIcon(CUSTOM_ICON_EXAMPLE);
  assert.equal(r.ok, true);
  assert.match(r.svg, /^<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><g transform="translate\(1.5 5\) scale\(0.82\)"><path d="M12 21s.*<path d="M19 2.5v5M16.5 5h5"\/>/);
});

test("bare path data is wrapped, empty is fine", () => {
  assert.equal(compileCustomIcon("M6 3h12v18l-6-4.5L6 21z").svg, '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>');
  assert.deepEqual(compileCustomIcon("  "), { ok: true, svg: "" });
});

test("hostile markup is refused, never passed through", () => {
  for (const bad of [
    '<svg><script>alert(1)</script></svg>',
    '<svg><path d="M0 0" onload="x()"/></svg>',
    '<svg><path d="M0 0" style="fill:red"/></svg>',
    '<svg><path d="M0 0" fill="url(#a)"/></svg>',
    '<svg><use href="#a"/></svg>',
    '<svg><image href="x.png"/></svg>',
    '<svg><foreignObject/></svg>',
    '<svg><path d="M0 0"/></svg><svg></svg>',
    '<svg><path d="M0 0"></svg',
    "<svg><path/></svg>",
    "<svg></svg>",
    "M0 0 <b>",
  ]) assert.equal(compileCustomIcon(bad).ok, false, bad);
  assert.equal(compileCustomIcon("M0 0".padEnd(3001, "0")).ok, false);
});

test("only custom + valid SVG reaches the storefront, and never inside appearance", () => {
  const saved = { version: 1, general: { iconType: "custom", customIcon: "M6 3h12v18z" } };
  assert.match(publicCustomIcon(saved), /<path d="M6 3h12v18z"\/>/);
  assert.equal(publicCustomIcon({ version: 1, general: { iconType: "star", customIcon: "M6 3h12v18z" } }), "");
  assert.equal(publicCustomIcon({ version: 1, general: { iconType: "custom" } }), "");
  assert.deepEqual(publicAppearance(saved), { version: 1, general: { iconType: "custom" } });
});

test("validateAppearance reports a bad icon", () => {
  const { errors } = validateAppearance({ general: { customIcon: "<svg><script/></svg>" } });
  assert.ok(errors["general.customIcon"]);
  assert.deepEqual(validateAppearance({ general: { iconType: "custom" } }).errors, {});
});

import { readFileSync } from "node:fs";
import { storefrontHooks } from "../app/utils/wishlist-preview-document.js";
import { publicCustomCss, resolveAppearance, toSparse } from "../app/utils/wishlist-appearance-shared.js";
import { CSS_EXAMPLES } from "../app/utils/custom-css-shared.js";

const COLORS = { defaultColor: "#2c813c", hoverColor: "#675b5b", activeColor: "#042508" };
const css = readFileSync(new URL("../extensions/konvert-wishlist/assets/konvert-wishlist.css", import.meta.url), "utf8");

test("heart, star and bookmark: the three colours reach the preview AND the storefront through the same hooks and CSS", () => {
  for (const iconType of ["heart", "star", "bookmark"]) {
    const appearance = resolveAppearance({ general: { iconType, ...COLORS } });
    const { attributes, variables } = storefrontHooks(appearance);
    assert.equal(variables["--kw-general-default-color"], COLORS.defaultColor, iconType);
    assert.equal(variables["--kw-general-hover-color"], COLORS.hoverColor, iconType);
    assert.equal(variables["--kw-general-active-color"], COLORS.activeColor, iconType);
    if (iconType !== "heart") assert.equal(attributes["data-kw-general-icon-type"], iconType);
    // storefront receives the same colours
    const pub = publicAppearance(toSparse(appearance)).general;
    assert.equal(pub.defaultColor, COLORS.defaultColor);
    assert.equal(pub.hoverColor, COLORS.hoverColor);
    assert.equal(pub.activeColor, COLORS.activeColor);
  }
  // the CSS both the preview and the storefront load turns those variables into colours
  assert.match(css, /\.kw-heart \{[^}]*color: var\(--kw-general-default-color/);
  assert.match(css, /\.kw-btn:hover > \.kw-heart,[^{]*\{[^}]*var\(--kw-general-hover-color/);
  assert.match(css, /\[aria-pressed='true'\] > \.kw-heart,[^{]*\{[^}]*var\(--kw-general-active-color/);
  for (const t of ["star", "bookmark"]) assert.match(css, new RegExp(`data-kw-general-icon-type='${t}'\] \.kw-i-${t}`));
});

test("Custom icon: saved colours are ignored, and icon CSS saved earlier is never delivered", () => {
  const custom = resolveAppearance({ general: { iconType: "custom", customIcon: "M6 3h12v18z", customCss: CSS_EXAMPLES.icon, ...COLORS } });
  const { variables } = storefrontHooks(custom);
  assert.equal(variables["--kw-general-default-color"], undefined);
  assert.equal(publicAppearance(toSparse(custom)).general.defaultColor, undefined);
  assert.equal(publicCustomCss(toSparse(custom)).icon, undefined);
  const heart = resolveAppearance({ general: { iconType: "heart", customCss: CSS_EXAMPLES.icon, ...COLORS } });
  assert.equal(publicCustomCss(toSparse(heart)).icon, undefined);
  assert.equal(compileCustomIcon(CUSTOM_ICON_EXAMPLE).ok, true);
});

test("the settings form: colours only for the built-in icons; only the SVG box for Custom; no icon CSS box", () => {
  const src = readFileSync(new URL("../app/components/wishlist-settings-form.jsx", import.meta.url), "utf8");
  const general = src.slice(src.indexOf("general: ("), src.indexOf("productPage: ("));
  const [customBranch, builtIn] = general.split(") : (");
  assert.match(customBranch, /CustomIconControl/);
  assert.doesNotMatch(general, /CssControl/);
  assert.doesNotMatch(customBranch, /ColorControl/);
  assert.match(builtIn, /Default icon color/);
  assert.match(builtIn, /Hover color/);
  assert.match(builtIn, /Saved color/);
  assert.doesNotMatch(builtIn, /CssControl/);
});

test("preview: the custom icon is applied AFTER the header link is rebuilt (the rebuilt link carries the default heart)", () => {
  const src = readFileSync(new URL("../app/components/wishlist-appearance-preview.jsx", import.meta.url), "utf8");
  assert.ok(src.indexOf("link.replaceWith(next)") < src.indexOf('querySelectorAll(".kw-heart")'));
});
