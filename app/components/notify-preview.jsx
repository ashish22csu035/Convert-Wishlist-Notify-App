/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useEffect, useRef, useState } from "react";
import { NOTIFY_PAGE_TYPES, NOTIFY_SUBSCRIBED_LABEL, inertEmailHtml, notifyButtonStyle, sampleNotifyEmail } from "../utils/notify-settings-shared";
import { previewImagePosition, previewImageUrl } from "../utils/preview-products";
import { PREVIEW_HEIGHT, PREVIEW_VIEWPORTS } from "../utils/wishlist-preview-document";

// The preview of the Notify Me Settings being edited, in the same frame as the Wishlist Settings preview (Desktop/Mobile
// toggle, scaled stage). Everything here is local React state: the Notify Me button never calls /apps/konvert-notify or
// any other endpoint, creates no subscription and needs no email address. Products are invented sample data.

export const PREVIEW_NOTE = "Approximate preview — your Shopify theme may differ. Sample products are preview data.";
const VIEWPORT_KEYS = Object.keys(PREVIEW_VIEWPORTS);

export function ViewportToggle({ viewport, onViewport }) {
  return (
    <div className="kv-seg" role="group" aria-label="Preview size">
      {VIEWPORT_KEYS.map((key) => (
        <button key={key} type="button" className={`kv-seg-btn${key === viewport ? " on" : ""}`} aria-pressed={key === viewport} onClick={() => onViewport(key)}>
          {PREVIEW_VIEWPORTS[key].label}
        </button>
      ))}
    </div>
  );
}

// The sample button. `subscribed` is the preview's own state; a click only reports it upward.
function NotifyButton({ button, subscribed, onClick, className = "" }) {
  return (
    <button
      type="button"
      className={`kv-np-notify ${className}`}
      style={notifyButtonStyle(button)}
      disabled={subscribed}
      aria-label={subscribed ? undefined : `Preview of the button: ${button.text}`}
      data-preview-notify={subscribed ? "done" : "ready"}
      onClick={onClick}
    >
      {subscribed ? NOTIFY_SUBSCRIBED_LABEL : button.text}
    </button>
  );
}

function Header() {
  return (
    <div className="kv-np-header">
      <strong>Sample store</strong>
      <span>Shop · Cart</span>
    </div>
  );
}

function ProductPage({ button, subscribed, onNotify }) {
  return (
    <div className="kv-np-page">
      <Header />
      <div className="kv-np-product-body">
        <div className="kv-np-img kv-np-img--lg">
          <img src={previewImageUrl("shirt")} alt="" decoding="async" draggable="false" style={{ objectPosition: previewImagePosition("shirt") }} />
        </div>
        <div>
          <h4 className="kv-np-title">Relaxed linen shirt</h4>
          <p className="kv-np-price">$64.00</p>
          <p className="kv-np-label">Size</p>
          <div className="kv-np-sizes">
            <span className="kv-np-size kv-np-size--out on">S</span>
            <span className="kv-np-size">M</span>
            <span className="kv-np-size">L</span>
          </div>
          <p className="kv-np-hint">Size S is sold out in this sample.</p>
          <NotifyButton button={button} subscribed={subscribed} onClick={onNotify} />
        </div>
      </div>
    </div>
  );
}

const WISHLIST_ROWS = [
  { title: "Classic cotton tee", variant: "Large / White", price: "$28.00", out: false, photo: "tee" },
  { title: "Canvas market tote", variant: "Natural", price: "$34.00", out: true, photo: "tote" },
];

function WishlistPage({ button, subscribed, onNotify }) {
  return (
    <div className="kv-np-page">
      <Header />
      <h4 className="kv-np-title kv-np-pad">My Wishlist</h4>
      <ul className="kv-np-rows">
        {WISHLIST_ROWS.map((row) => (
          <li key={row.title} className="kv-np-row">
            <div className="kv-np-img kv-np-img--sm">
              <img src={previewImageUrl(row.photo)} alt="" decoding="async" draggable="false" style={{ objectPosition: previewImagePosition(row.photo) }} />
            </div>
            <div className="kv-np-row-info">
              <p className="kv-np-card-title">{row.title}</p>
              <p className="kv-np-hint">
                {row.variant} · {row.price}
              </p>
            </div>
            {row.out ? <NotifyButton button={button} subscribed={subscribed} onClick={onNotify} className="kv-np-notify--row" /> : <span className="kv-np-cart">Add to cart</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PAGE_NOTES = {
  product: "On your store this is your theme’s own Add to cart button, relabelled while the selected variant is sold out.",
  wishlist: "On the Wishlist page, a sold-out saved variant shows this button in place of Add to cart.",
};

// Lays the sample page out at a real storefront width and scales it down to fit, like the Wishlist preview.
function Stage({ viewport, children }) {
  const stage = useRef(null);
  const [width, setWidth] = useState(0);
  const view = PREVIEW_VIEWPORTS[viewport] ?? PREVIEW_VIEWPORTS.desktop;
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = width > 0 ? Math.min(1, width / view.width) : 1;
  return (
    <div className="kv-pv-stage" ref={stage} style={{ height: PREVIEW_HEIGHT }}>
      <div className={`kv-pv-device kv-pv-device--${viewport}`} style={{ width: Math.round(view.width * scale), height: PREVIEW_HEIGHT }}>
        <div className="kv-np-canvas" data-viewport={viewport} style={{ width: view.width, height: Math.round(PREVIEW_HEIGHT / scale), transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ButtonPreview({ button, viewport, pageType, onPageType, subscribed, onSubscribed }) {
  const page = NOTIFY_PAGE_TYPES.find((item) => item.key === pageType) ?? NOTIFY_PAGE_TYPES[0];
  const props = { button, subscribed, onNotify: () => onSubscribed(true) };
  return (
    <div className="kv-preview-body kv-pv">
      <div className="kv-seg" role="group" aria-label="Preview page">
        {NOTIFY_PAGE_TYPES.map((item) => (
          <button key={item.key} type="button" className={`kv-seg-btn${item.key === page.key ? " on" : ""}`} aria-pressed={item.key === page.key} onClick={() => onPageType(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <p className="kv-pv-label">{PREVIEW_NOTE}</p>
      <Stage viewport={viewport}>{page.key === "product" ? <ProductPage {...props} /> : page.key === "wishlist" ? <WishlistPage {...props} /> : null}</Stage>
      <p className="kv-pv-label" role="status" data-testid="page-note">
        {PAGE_NOTES[page.key]}
      </p>
      <p className="kv-pv-label">
        Click the button to see the “{NOTIFY_SUBSCRIBED_LABEL}” state. Nothing is sent or saved.{" "}
        <s-button variant="tertiary" onClick={() => onSubscribed(false)} {...(subscribed ? {} : { disabled: true })}>
          Reset preview
        </s-button>
      </p>
    </div>
  );
}

// The email is drawn from the same function that builds the real one, with sample data, inside a sandboxed frame. Its links
// are inert: the call-to-action looks like a button and a click goes nowhere.
export function EmailPreview({ email, viewport }) {
  const sample = sampleNotifyEmail(email);
  return (
    <div className="kv-preview-body">
      <p className="kv-note">
        <strong>Subject:</strong> {sample.subject}
      </p>
      <div className={`kv-np-email kv-np-email--${viewport}`}>
        <iframe className="kv-email-frame" title="Preview of the back-in-stock email" sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:16px;background:#fff">${inertEmailHtml(sample.html)}</body>`} />
      </div>
      <p className="kv-note">Shown with sample data. Real emails use the customer’s product and your store name. The button does nothing here.</p>
    </div>
  );
}
