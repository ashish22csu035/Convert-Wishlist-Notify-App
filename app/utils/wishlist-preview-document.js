// The sample storefront shown by the Wishlist Settings preview. Pure: strings in, strings out.
//
// The preview is a small document in an <iframe>. It loads the REAL konvert-wishlist.css and uses the storefront's own
// class names (kw-btn--card, kw-btn--product, kw-header-icon, kw-table, ...) and the same data-kw-* attributes and
// --kw-* variables that konvert-wishlist.js puts on <html>, so every setting is drawn by the same CSS rules as on a
// real store and the preview cannot drift from it. Only the surrounding "theme" (header, product grid, product page
// layout) is preview-only: it uses pv-* classes. Nothing here is fetched: products are invented, no script runs and
// no link goes anywhere.
import { THEME_ACCENT_FALLBACK, toSparse, wishlistIconSvg } from "./wishlist-appearance-shared.js";

export const PREVIEW_VIEWPORTS = {
  desktop: { label: "Desktop", width: 960 }, // wider than the storefront's 860px table breakpoint, so the table layout shows
  mobile: { label: "Mobile", width: 390 },
};
export const PREVIEW_HEIGHT = 600;
export const PREVIEW_APP_ID = "kw-preview-app";

// What konvert-wishlist.js does with the appearance document, as a function: words and on/off become
// data-kw-<section>-<key> attributes, numbers and colours --kw-<section>-<key> variables (numbers also leave the
// attribute so the CSS can tell "set" from "unset"). A test runs the real script and compares.
export function storefrontHooks(appearance) {
  const sparse = toSparse(appearance);
  const attributes = {};
  const variables = {};
  for (const [section, part] of Object.entries(sparse)) {
    if (section === "version") continue;
    for (const [key, value] of Object.entries(part)) {
      const name = `kw-${section}-${key}`.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      if (typeof value === "number") {
        variables[`--${name}`] = String(value);
        attributes[`data-${name}`] = String(value);
      } else if (typeof value === "string" && value.startsWith("#")) {
        variables[`--${name}`] = value;
      } else {
        attributes[`data-${name}`] = String(value);
      }
    }
  }
  return { attributes, variables };
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- sample catalogue (invented; the preview never reads a shop) --------------------------------------------------
const PRODUCTS = [
  { title: "Classic cotton tee", price: "$28.00", tone: 1, variant: "Large / White" },
  { title: "Canvas market tote", price: "$34.00", tone: 2, variant: "" },
  { title: "Stoneware mug", price: "$18.00", tone: 3, variant: "" },
  { title: "Merino wool beanie", price: "$22.00", tone: 4, variant: "One size" },
  { title: "Insulated trail bottle", price: "$26.00", tone: 5, variant: "" },
  { title: "Relaxed linen shirt", price: "$64.00", tone: 6, variant: "Medium / Sand" },
  { title: "Everyday crossbody bag", price: "$48.00", tone: 2, variant: "" },
  { title: "Soft knit scarf", price: "$32.00", tone: 4, variant: "" },
];
const ICON = wishlistIconSvg();
const heart = `<span class="kw-heart" aria-hidden="true">${ICON}</span>`;

function header() {
  return `<header class="pv-header">
  <span class="pv-menu" aria-hidden="true"><i></i><i></i><i></i></span>
  <span class="pv-logo">Sample Store</span>
  <nav class="pv-nav" aria-label="Sample navigation"><span>Home</span><span>Shop</span><span>Collections</span><span>Sale</span><span>Contact</span></nav>
  <span class="pv-icons">
    <a class="kw-header-icon" href="#" tabindex="-1" aria-label="My Wishlist">${heart}<span class="kw-header-icon__count">3</span></a>
    <span class="pv-cart" aria-label="Cart"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12l-1 13H7L6 7z"/><path d="M9 7a3 3 0 016 0"/></svg></span>
  </span>
</header>`;
}

const image = (tone, extra = "") => `<div class="pv-img pv-tone-${tone}${extra}"></div>`;

// A product card as the storefront script builds it: the heart is a kw-btn--card button inside the card's image.
function card(product, { state = "default", tag = "" } = {}) {
  const saved = state === "saved";
  return `<li class="pv-card kw-card-host">
  <div class="pv-media">${image(product.tone)}<button type="button" class="kw-btn kw-btn--card${state === "hover" ? " kw-force-hover" : ""}" data-kw-button aria-pressed="${saved}" aria-label="${saved ? "Saved to wishlist" : "Add to wishlist"}: ${escapeHtml(product.title)}" tabindex="-1">${heart}</button></div>
  <h3 class="pv-title">${escapeHtml(product.title)}</h3>
  <p class="pv-price">${escapeHtml(product.price)}</p>${tag ? `\n  <span class="pv-tag">${escapeHtml(tag)}</span>` : ""}
</li>`;
}

function generalPage() {
  const states = [["default", "Default"], ["hover", "Hover"], ["saved", "Saved"]];
  const cards = PRODUCTS.map((product, index) => card(product, { state: states[index]?.[0] ?? "default", tag: states[index]?.[1] ?? "" })).join("\n");
  return `${header()}
<main class="pv-main">
  <h1 class="pv-h1">Summer collection</h1>
  <p class="pv-sub">Light layers and everyday essentials.</p>
  <ul class="pv-grid">
${cards}
  </ul>
</main>`;
}

function productPage() {
  const thumbs = [1, 2, 3, 4].map((n) => `<div class="pv-thumb">${image(n === 1 ? 1 : n)}</div>`).join("");
  return `${header()}
<main class="pv-main">
  <p class="pv-crumbs">Home / Shop / Classic cotton tee</p>
  <div class="pv-product">
    <div class="pv-gallery">${image(1, " pv-img--square")}<div class="pv-thumbs">${thumbs}</div></div>
    <div class="pv-details">
      <p class="pv-vendor">Sample Store</p>
      <h1 class="pv-ptitle">Classic cotton tee</h1>
      <p class="pv-pprice">$28.00</p>
      <p class="pv-desc">A soft, mid-weight cotton tee with a relaxed fit. Pre-washed, so it keeps its shape.</p>
      <p class="pv-label">Size</p>
      <div class="pv-sizes"><span>S</span><span class="on">M</span><span>L</span><span>XL</span></div>
      <p class="pv-label">Quantity</p>
      <div class="pv-qty"><span>−</span><span>1</span><span>+</span></div>
      <button type="button" class="pv-add" tabindex="-1">Add to cart</button>
      <div class="kw-block"><button type="button" class="kw-btn kw-btn--product" data-kw-button aria-pressed="false" tabindex="-1">${heart}<span class="kw-btn__label" data-kw-label>Add to wishlist</span></button></div>
      <p class="pv-meta">Free shipping over $60 · Free returns</p>
    </div>
  </div>
</main>`;
}

function collectionPage() {
  const cards = PRODUCTS.slice(0, 6).map((product) => card(product)).join("\n");
  return `${header()}
<main class="pv-main">
  <h1 class="pv-h1">All products</h1>
  <div class="pv-toolbar"><span>Filter</span><span>Sort: Featured</span><span class="pv-count">6 products</span></div>
  <ul class="pv-grid">
${cards}
  </ul>
</main>`;
}

// The Wishlist page: the same table the page script builds (columns, cell classes, controls), so the layout rules in
// konvert-wishlist.css (table, grid, phone cards) apply untouched. Availability states are illustrative.
function wishlistRow(product, { stock }) {
  const out = stock === "out";
  const unit = product.price;
  return `<tr class="kw-row">
  <td class="kw-td kw-td--select"><input class="kw-check" type="checkbox" aria-label="Select: ${escapeHtml(product.title)}" tabindex="-1"></td>
  <td class="kw-td kw-td--remove"><button type="button" class="kw-row__remove" aria-label="Remove from wishlist: ${escapeHtml(product.title)}" title="Remove from wishlist" tabindex="-1">×</button></td>
  <td class="kw-td kw-td--image"><a class="kw-thumb" href="#" tabindex="-1" aria-label="${escapeHtml(product.title)}">${image(product.tone)}</a></td>
  <td class="kw-td kw-td--name"><a class="kw-row__title" href="#" tabindex="-1">${escapeHtml(product.title)}</a><span class="kw-row__variant">${escapeHtml(product.variant)}</span></td>
  <td class="kw-td kw-td--price"><span class="kw-price">${escapeHtml(unit)}</span>${out ? '<div class="kw-line" hidden></div>' : `<div class="kw-line">Subtotal: ${escapeHtml(unit)}</div>`}</td>
  <td class="kw-td kw-td--stock"><span class="kw-stock kw-stock--${out ? "out" : "in"}">${out ? "Out of stock" : "In stock"}</span></td>
  <td class="kw-td kw-td--qty"><div class="kw-qty"><button type="button" class="kw-qty__btn" tabindex="-1"${out ? " disabled" : ""}>−</button><input class="kw-qty__input" type="number" value="1" tabindex="-1"${out ? " disabled" : ""}><button type="button" class="kw-qty__btn" tabindex="-1"${out ? " disabled" : ""}>+</button></div></td>
  <td class="kw-td kw-td--action"><div class="kw-action">${out ? '<button type="button" class="kw-btn-cart kw-btn-cart--notify" tabindex="-1">Notify Me</button>' : '<button type="button" class="kw-btn-cart" tabindex="-1">Add to cart</button>'}</div></td>
</tr>`;
}

function wishlistPage() {
  const rows = [
    wishlistRow(PRODUCTS[0], { stock: "in" }),
    wishlistRow(PRODUCTS[5], { stock: "out" }),
    wishlistRow(PRODUCTS[3], { stock: "in" }),
    wishlistRow(PRODUCTS[1], { stock: "in" }),
  ].join("\n");
  const columns = ["Remove", "Product image", "Product name", "Price", "Stock status", "Quantity", "Action"];
  return `${header()}
<div class="kw-page">
  <header class="kw-page__header">
    <h1 class="kw-page__title">Wishlisted products <span class="kw-page__count">(4 Items)</span></h1>
    <button type="button" class="kw-page__select" tabindex="-1">Select</button>
  </header>
  <div class="kw-page__body">
    <div class="kw-table-wrap">
      <table class="kw-table">
        <thead><tr><th class="kw-th kw-th--select" scope="col"><input class="kw-check" type="checkbox" aria-label="Select all products" tabindex="-1"></th>${columns.map((name, i) => `<th class="kw-th kw-th--${["remove", "image", "name", "price", "stock", "qty", "action"][i]}" scope="col">${name}</th>`).join("")}</tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </div>
</div>`;
}

const PAGES = { general: generalPage, productPage, collectionPage, wishlistPage };

// The markup for one tab. It does not depend on the settings: they act through the attributes and variables on <html>.
export function previewMarkup(tab) {
  const build = PAGES[tab] ?? PAGES.general;
  return `<div class="pv-page" data-preview="${PAGES[tab] ? tab : "general"}">${build()}</div>`;
}

// The sample "theme": a neutral serif store, so the "use my theme's fonts" switch visibly changes the text. Preview only.
export const SAMPLE_THEME_CSS = `
:root { --kw-accent: ${THEME_ACCENT_FALLBACK}; --buttons-radius: 4px; }
* { box-sizing: border-box; }
html, body { margin: 0; }
html { font-size: 62.5%; } /* Dawn-style themes: 1rem = 10px. konvert-wishlist.css sizes the Wishlist page in rem on that basis. */
body { font-family: Georgia, 'Times New Roman', serif; font-size: 15px; line-height: 1.5; color: #1c1c1c; background: #fff; }
a { color: inherit; text-decoration: none; }
h1, h2, h3, p, ul { margin: 0; padding: 0; }
ul { list-style: none; }
.pv-header { display: flex; align-items: center; gap: 24px; padding: 10px 28px; border-bottom: 1px solid #e6e6e6; background: #fff; }
.pv-logo { font-size: 20px; letter-spacing: .04em; font-weight: 700; }
.pv-nav { display: flex; gap: 22px; margin-left: 12px; font-size: 14px; }
.pv-icons { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.pv-cart { display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; }
.pv-menu { display: none; width: 22px; flex-direction: column; gap: 4px; }
.pv-menu i { display: block; height: 2px; background: #1c1c1c; }
.pv-main { padding: 28px 28px 40px; }
.pv-h1 { font-size: 30px; line-height: 1.2; font-weight: 400; }
.pv-sub { margin: 4px 0 22px; color: #666; }
.pv-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 26px 20px; }
.pv-card { position: relative; min-width: 0; }
.pv-media { position: relative; }
.pv-img { position: relative; width: 100%; aspect-ratio: 4 / 5; overflow: hidden; background: #ececec; }
.pv-img::after { content: ""; position: absolute; left: 24%; right: 24%; top: 26%; bottom: 22%; background: rgba(255, 255, 255, .5); border-radius: 14px; }
.pv-img--square { aspect-ratio: 1 / 1; }
.pv-tone-1 { background: linear-gradient(160deg, #dfe8f5, #b9cbe6); }
.pv-tone-2 { background: linear-gradient(160deg, #f3e3cf, #e3c7a3); }
.pv-tone-3 { background: linear-gradient(160deg, #e5efe2, #bfd6b9); }
.pv-tone-4 { background: linear-gradient(160deg, #f2dfe3, #e3bcc6); }
.pv-tone-5 { background: linear-gradient(160deg, #e7e3f2, #c9c1e3); }
.pv-tone-6 { background: linear-gradient(160deg, #f4ecd6, #e6d6a5); }
.pv-title { margin-top: 10px; font-size: 15px; font-weight: 400; line-height: 1.3; }
.pv-price { margin-top: 2px; color: #555; font-size: 14px; }
.pv-tag { display: inline-block; margin-top: 6px; padding: 1px 8px; font: 600 11px/18px system-ui, sans-serif; color: #444; background: #f1f1f1; border-radius: 9px; }
.pv-toolbar { display: flex; gap: 18px; margin: 10px 0 18px; padding: 10px 0; border-top: 1px solid #e6e6e6; border-bottom: 1px solid #e6e6e6; font-size: 14px; }
.pv-count { margin-left: auto; color: #666; }
.pv-crumbs { margin-bottom: 18px; font-size: 13px; color: #777; }
.pv-product { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 44px; align-items: start; }
.pv-thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 10px; }
.pv-thumb .pv-img::after { display: none; }
.pv-vendor { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #777; }
.pv-ptitle { margin: 4px 0 6px; font-size: 30px; line-height: 1.2; font-weight: 400; }
.pv-pprice { font-size: 20px; }
.pv-desc { margin: 12px 0 16px; color: #444; }
.pv-label { margin: 12px 0 6px; font-size: 13px; color: #555; }
.pv-sizes { display: flex; gap: 8px; }
.pv-sizes span { min-width: 44px; padding: 8px 12px; text-align: center; border: 1px solid #cfcfcf; border-radius: 22px; font-size: 14px; }
.pv-sizes .on { color: #fff; background: #1c1c1c; border-color: #1c1c1c; }
.pv-qty { display: inline-flex; border: 1px solid #cfcfcf; }
.pv-qty span { min-width: 40px; padding: 8px 0; text-align: center; }
.pv-add { display: block; width: 100%; margin-top: 18px; padding: 14px 16px; font: inherit; font-weight: 600; color: #fff; background: #1c1c1c; border: 1px solid #1c1c1c; border-radius: 4px; }
.pv-meta { margin-top: 14px; font-size: 13px; color: #666; }
.kw-force-hover > .kw-heart { color: var(--kw-general-hover-color, var(--kw-general-default-color, var(--kw-accent, ${THEME_ACCENT_FALLBACK}))); }
.kw-thumb .pv-img { height: 100%; aspect-ratio: auto; }
@media (max-width: 600px) {
  .pv-header { gap: 12px; padding: 6px 14px; }
  .pv-nav { display: none; }
  .pv-menu { display: flex; }
  .pv-logo { font-size: 17px; }
  .pv-main { padding: 18px 14px 28px; }
  .pv-h1 { font-size: 24px; }
  .pv-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 12px; }
  .pv-product { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .pv-ptitle { font-size: 24px; }
  .pv-toolbar { gap: 12px; font-size: 13px; }
}
`;

// The whole document the iframe starts from; the settings and the page markup are put in afterwards.
export const previewShell = (storefrontCss) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${storefrontCss}</style><style>${SAMPLE_THEME_CSS}</style></head><body><div id="${PREVIEW_APP_ID}"></div></body></html>`;
