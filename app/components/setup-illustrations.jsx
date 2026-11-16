/* eslint-disable react/prop-types -- plain JavaScript project: small local helper components are not given PropTypes */
// Small local illustrations for the Dashboard setup guide: plain inline SVG, no images to load, no dependencies. They are
// decoration only (aria-hidden, not focusable) and draw with the app's own colour tokens, so they follow the light theme.
// One per step: the Wishlist design (browser + product card + heart), the theme embed (code window + tick) and the product
// page block (product card + Wishlist button).

const FRAME = { fill: "var(--kv-surface)", stroke: "var(--kv-border)", strokeWidth: 1.5 };
const SOFT = "var(--kv-surface-2, #f1f1f1)";
const INK = "#303030";
const HEART = "M7 12.5C3 9 0 6.6 0 3.8 0 1.7 1.6 0 3.6 0 5 0 6.3.8 7 2 7.7.8 9 0 10.4 0 12.4 0 14 1.7 14 3.8 14 6.6 11 9 7 12.5Z";

function Art({ children }) {
  return (
    <svg className="kv-setup-svg" viewBox="0 0 160 112" width="160" height="112" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const Dots = () => (
  <g fill="var(--kv-border)">
    <circle cx="14" cy="13" r="2" />
    <circle cx="21" cy="13" r="2" />
    <circle cx="28" cy="13" r="2" />
  </g>
);

export function DesignIllustration() {
  return (
    <Art>
      <rect x="6" y="6" width="148" height="100" rx="8" {...FRAME} />
      <path d="M6 22h148" stroke="var(--kv-border)" strokeWidth="1.5" />
      <Dots />
      <rect x="18" y="32" width="58" height="62" rx="6" fill={SOFT} />
      <rect x="24" y="38" width="46" height="30" rx="4" fill="var(--kv-border)" />
      <rect x="24" y="74" width="34" height="5" rx="2.5" fill="var(--kv-border)" />
      <rect x="24" y="83" width="22" height="5" rx="2.5" fill={INK} />
      <circle cx="62" cy="50" r="9" fill="var(--kv-surface)" stroke="var(--kv-border)" />
      <path d={HEART} transform="translate(55 45)" fill="var(--kv-pink, #d6336c)" />
      <rect x="88" y="34" width="54" height="6" rx="3" fill="var(--kv-border)" />
      <rect x="88" y="46" width="42" height="6" rx="3" fill="var(--kv-border)" />
      <rect x="88" y="62" width="54" height="22" rx="6" fill={SOFT} />
      <circle cx="100" cy="73" r="5" fill="var(--kv-pink, #d6336c)" />
      <circle cx="116" cy="73" r="5" fill="var(--kv-violet, #7c5cff)" />
      <circle cx="132" cy="73" r="5" fill={INK} />
    </Art>
  );
}

export function EmbedIllustration() {
  return (
    <Art>
      <rect x="6" y="6" width="148" height="100" rx="8" {...FRAME} />
      <path d="M6 22h148" stroke="var(--kv-border)" strokeWidth="1.5" />
      <Dots />
      <rect x="18" y="34" width="70" height="6" rx="3" fill="var(--kv-border)" />
      <rect x="18" y="46" width="52" height="6" rx="3" fill={SOFT} />
      <rect x="26" y="58" width="60" height="6" rx="3" fill="var(--kv-border)" />
      <rect x="18" y="70" width="40" height="6" rx="3" fill={SOFT} />
      <rect x="18" y="82" width="66" height="6" rx="3" fill="var(--kv-border)" />
      <circle cx="120" cy="66" r="22" fill={INK} />
      <path d="M109 66.5 117 74.5 132 58" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </Art>
  );
}

export function ProductIllustration() {
  return (
    <Art>
      <rect x="6" y="6" width="148" height="100" rx="8" {...FRAME} />
      <rect x="18" y="18" width="52" height="76" rx="6" fill={SOFT} />
      <rect x="24" y="24" width="40" height="46" rx="4" fill="var(--kv-border)" />
      <path d="M24 70 38 52l9 10 6-6 11 14Z" fill="var(--kv-surface)" opacity="0.7" />
      <rect x="24" y="76" width="28" height="5" rx="2.5" fill="var(--kv-border)" />
      <rect x="24" y="85" width="18" height="5" rx="2.5" fill={INK} />
      <rect x="82" y="20" width="58" height="7" rx="3.5" fill="var(--kv-border)" />
      <rect x="82" y="33" width="30" height="6" rx="3" fill={INK} />
      <rect x="82" y="48" width="58" height="18" rx="9" fill="var(--kv-surface)" stroke={INK} strokeWidth="1.5" />
      <path d={HEART} transform="translate(88 52.5) scale(0.8)" fill="var(--kv-pink, #d6336c)" />
      <rect x="104" y="55" width="30" height="5" rx="2.5" fill={INK} />
      <rect x="82" y="72" width="58" height="18" rx="9" fill={INK} />
      <rect x="95" y="79" width="32" height="5" rx="2.5" fill="#fff" />
    </Art>
  );
}

export const ILLUSTRATIONS = { configure: DesignIllustration, embed: EmbedIllustration, product: ProductIllustration };
