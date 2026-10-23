// Tests for the light theme of the merchant screens (app/styles/merchant.css and the components that set colours).
//
// Run: node --test tests/dark-theme.test.mjs
//
// These read the source files: they prove that every colour comes from the theme tokens, that the tokens form
// a readable light palette (WCAG contrast is computed), and that the same metric has the same colour on every
// page. They cannot show how Shopify's own Polaris components draw inside the dark panel; that needs a look in
// Shopify Admin.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync("app/styles/merchant.css", "utf8");
const tokens = Object.fromEntries([...css.slice(0, css.indexOf("}", css.indexOf(".kv {"))).matchAll(/--(kv-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));

const channel = (hex, i) => {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("the theme tokens are defined once and form a light palette", () => {
  for (const name of ["kv-bg", "kv-surface", "kv-surface-2", "kv-border", "kv-hover", "kv-text", "kv-subdued", "kv-violet", "kv-blue", "kv-green", "kv-amber", "kv-rose", "kv-cyan", "kv-pink", "kv-on-accent"]) {
    assert.ok(tokens[name], `${name} is a token`);
  }
  assert.equal(tokens["kv-bg"].toLowerCase(), "#f7f8fa");
  assert.equal(tokens["kv-surface"].toLowerCase(), "#ffffff", "cards are white");
  assert.equal(tokens["kv-surface-2"].toLowerCase(), "#ffffff", "inputs and dropdowns are white");
  assert.equal(tokens["kv-border"].toLowerCase(), "#e5e7eb");
  assert.equal(tokens["kv-hover"].toLowerCase(), "#f3f4f6");
  assert.equal(tokens["kv-text"].toLowerCase(), "#202124");
  assert.equal(tokens["kv-subdued"].toLowerCase(), "#666d7b");
  assert.deepEqual([tokens["kv-violet"], tokens["kv-blue"], tokens["kv-green"], tokens["kv-amber"], tokens["kv-rose"]].map((c) => c.toLowerCase()), ["#7c3aed", "#2563eb", "#15803d", "#cc6a05", "#dc2626"]);
  for (const name of ["kv-bg", "kv-surface", "kv-hover"]) assert.ok(luminance(tokens[name]) > 0.9, `${name} is light`);
  assert.match(css, /color-scheme: light;/);
  assert.equal(/color-scheme:\s*dark/.test(css), false, "no dark scheme is requested anywhere");
});

test("text and accents are readable on every surface (WCAG AA, 4.5:1)", () => {
  for (const surface of ["kv-bg", "kv-surface", "kv-hover"]) {
    // accent colours are never used as text on the hover grey (the delta chips sit on white)
    for (const ink of surface === "kv-hover" ? ["kv-text", "kv-subdued"] : ["kv-text", "kv-subdued", "kv-violet", "kv-blue", "kv-green", "kv-rose", "kv-cyan", "kv-pink"]) {
      assert.ok(contrast(tokens[ink], tokens[surface]) >= 4.5, `${ink} on ${surface}: ${contrast(tokens[ink], tokens[surface]).toFixed(2)}`);
    }
    assert.ok(contrast(tokens["kv-amber"], tokens[surface]) >= 3, "amber (warnings, chart marks) meets the 3:1 needed for graphics");
  }
  for (const accent of ["kv-violet", "kv-blue", "kv-green", "kv-rose"]) {
    assert.ok(contrast(tokens["kv-on-accent"], tokens[accent]) >= 4.5, `text on a selected ${accent} control`);
  }
  // KPI cards are white; the accent tint only fills the small icon chip
  assert.match(css, /\.kv-kpi \{[^}]*background: var\(--kv-surface\);/s);
  for (const [, accent, tint] of css.matchAll(/\.kv-kpi\.(?:violet|blue|green|rose) \{ --accent: var\(--(kv-[a-z]+)\); --tint: (#[0-9a-f]{6})/g)) {
    assert.ok(contrast(tokens[accent], tint) >= 3, `icon ${accent} on its chip ${tint}`);
  }
  assert.ok(contrast(tokens["kv-border"], tokens["kv-surface"]) >= 1.2 && contrast(tokens["kv-border"], tokens["kv-surface"]) < 2, "card borders are visible but subtle");
});

test("no dark surface, dark control or light-on-dark text is left in the stylesheet: colours are tokens", () => {
  const body = css.slice(css.indexOf("/* ---------- Page header"));
  for (const hex of [...body.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map((m) => m[0].toLowerCase())) {
    const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
    assert.ok(luminance(full) > 0.5, `${hex} must be a light tint; dark colours come only from the text and accent tokens`);
  }
  for (const dark of ["#14161b", "#1b1e25", "#242831", "#2f3441", "#e9ebf0", "#a0a8b8", "#211e36", "#18243a", "#15271f"]) assert.equal(css.toLowerCase().includes(dark), false, `${dark} (dark theme) is gone`);
  assert.equal(/rgba\(0, 0, 0, 0\.[3-9]/.test(css), false, "no heavy black shadows");
  assert.equal(/dark/i.test(css.replace(/Polaris/g, "")), false, "the stylesheet no longer mentions a dark theme");
});

test("the standard controls are themed: selected, hover, disabled and keyboard focus are distinguishable", () => {
  assert.match(css, /\.kv-seg-btn\.on \{[^}]*background: var\(--accent\);[^}]*color: var\(--kv-on-accent\);/s);
  assert.match(css, /\.kv-seg-btn:focus-visible \{[^}]*outline:/s);
  assert.match(css, /\.kv-tab\[aria-current="page"\] \{[^}]*border-color: var\(--kv-blue\)/s);
  assert.match(css, /\.kv-pager span\.btn \{\s*color: var\(--kv-disabled\);/);
  assert.match(css, /\.kv-tab:hover \{\s*background: var\(--kv-hover\);/);
  assert.ok(contrast(tokens["kv-disabled"], tokens["kv-surface-2"]) >= 2.5 && contrast(tokens["kv-disabled"], tokens["kv-surface-2"]) < contrast(tokens["kv-subdued"], tokens["kv-surface-2"]), "disabled is dimmer than secondary text");
  assert.match(css, /\.kv-range-custom input\[type="date"\] \{[^}]*background: var\(--kv-surface-2\)/s);
  assert.match(css, /\.kv-info-panel \{[^}]*background: var\(--kv-surface-2\)/s);
  assert.match(css, /\.kv :focus-visible \{\s*outline-color: var\(--kv-blue\);/);
});

test("the light page panel wraps the app content only: the Shopify shell is not restyled", () => {
  assert.match(css, /\.kv \{[^}]*background: var\(--kv-bg\);[^}]*border-radius: 16px;/s);
  for (const outside of ["body", "html", ":root", "s-page", "s-app-nav", ".Polaris"]) {
    assert.equal(new RegExp(`(^|\\n)\\s*${outside.replace(".", "\\.")}[\\s{,]`).test(css), false, `${outside} is not styled globally`);
  }
});

test("one colour per meaning on every page: Wishlist violet, Notify Me blue, revenue green", () => {
  const tones = {};
  for (const file of ["app._index", "app.analytics", "app.notify-me", "app.wishlist"]) {
    for (const line of fs.readFileSync(`app/routes/${file}.jsx`, "utf8").split("\n")) {
      if (!/<(Toggle)?KpiCard/.test(line) || !/tone="/.test(line)) continue;
      const label = (/label=(?:"([^"]+)"|\{`([^`]+)`\})/.exec(line) ?? []).slice(1).find(Boolean) ?? "";
      tones[`${file}: ${label}`] = /tone="([a-z]+)"/.exec(line)[1];
    }
  }
  assert.ok(Object.keys(tones).length >= 14);
  for (const [key, tone] of Object.entries(tones)) {
    const low = key.toLowerCase();
    if (low.includes("revenue")) assert.equal(tone, "green", key);
    else if (/notify|restock|email|queued|subscri|notified/.test(low)) assert.equal(tone, "blue", key);
    else assert.equal(tone, "violet", key);
  }
  assert.equal(Object.values(tones).some((t) => t === "amber" || t === "rose"), false, "amber and rose are kept for warnings and errors");
});

test("chart and funnel colours: features keep their colour, series never share one, nothing uses a light fill", () => {
  const sw = fs.readFileSync("app/components/activity-switch.jsx", "utf8");
  const colours = (block) => [...block.matchAll(/color: "var\(--kv-([a-z]+)\)"/g)].map((m) => m[1]);
  const wishlist = colours(sw.slice(sw.indexOf("return [", sw.indexOf("Products added") - 120), sw.indexOf("];", sw.indexOf("Products added"))));
  const notify = colours(sw.slice(sw.indexOf('"Subscribed"') - 60, sw.indexOf("];", sw.indexOf('"Subscribed"'))));
  assert.deepEqual(wishlist, ["violet", "pink", "cyan"]);
  assert.deepEqual(notify, ["blue", "subdued", "cyan"]);
  assert.equal(new Set(wishlist).size, 3);
  assert.equal(new Set(notify).size, 3);
  assert.equal(fs.readFileSync("app/components/activity-chart.jsx", "utf8").includes('fill="#fff"'), false, "chart dots take the card colour");
  assert.match(css, /\.kv-funnel\[data-feature="notifyMe"\] \.kv-funnel-stage\.s1 \.kv-funnel-shape > div \{ background: var\(--kv-blue\); \}/);
  assert.match(css, /\.kv-funnel-stage\.s4 \.kv-funnel-shape > div \{[^}]*var\(--kv-green\)/);
  const funnel = fs.readFileSync("app/components/product-funnel.jsx", "utf8");
  assert.match(funnel, /data-feature={feature}/);
  assert.match(funnel, /feature={funnel\.feature}/);
});

test("no page-specific colours are hard-coded in the components or merchant routes", () => {
  for (const file of ["app/components/merchant-ui.jsx", "app/components/toggle-kpi-card.jsx", "app/components/activity-chart.jsx", "app/components/activity-switch.jsx", "app/components/product-funnel.jsx", "app/components/settings-form.jsx", "app/routes/app._index.jsx", "app/routes/app.analytics.jsx", "app/routes/app.customers.jsx", "app/routes/app.notify-me.jsx", "app/routes/app.settings.jsx", "app/routes/app.wishlist.jsx"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(source.replace(/&#\d+;/g, "")), false, `${file} has a hard-coded colour`);
  }
});
