/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { Component, useEffect, useMemo, useRef, useState } from "react";
import storefrontCss from "virtual:konvert-storefront-css"; // the theme extension's stylesheet, see vite.config.js (a path import would 404 behind Shopify CLI's proxy)
import { toSparse } from "../utils/wishlist-appearance-shared";
import { PREVIEW_APP_ID, PREVIEW_HEIGHT, PREVIEW_VIEWPORTS, previewMarkup, previewShell, storefrontHooks } from "../utils/wishlist-preview-document";

// The live preview of the Wishlist Settings being edited. It draws a sample storefront page for the active tab in an
// <iframe> that uses the REAL storefront stylesheet and class names, with the settings applied the way the storefront
// script applies them (data-kw-* attributes and --kw-* variables on <html>). It is built from the form's own state, so
// it follows every change at once; it saves nothing, runs no script, sends no request, and never touches a customer's
// Wishlist, an event or a cart. The sample products are invented. A real theme has its own fonts, spacing and image
// shapes, so it can only ever be approximate: check the real storefront after saving.

export const PREVIEW_NOTE = "Approximate preview — your Shopify theme may differ";

const SHELL = previewShell(storefrontCss);
const VIEWPORT_KEYS = Object.keys(PREVIEW_VIEWPORTS);
const TAB_TITLES = { general: "Collection grid", productPage: "Product page", collectionPage: "Collection page", wishlistPage: "Wishlist page" };

// Puts the page for `tab` and the settings into the frame's document. Safe to run again and again: the document
// is only written once, then the <html> attributes, variables and page are updated in place (scroll position is kept
// while the merchant edits).
function syncFrame(frame, tab, hooks) {
  const doc = frame?.contentDocument;
  if (!doc || !doc.documentElement) return;
  if (!doc.getElementById(PREVIEW_APP_ID)) {
    doc.open();
    doc.write(SHELL);
    doc.close();
  }
  const root = doc.documentElement;
  for (const attribute of [...root.attributes]) if (attribute.name.startsWith("data-kw-")) root.removeAttribute(attribute.name);
  root.removeAttribute("style");
  for (const [name, value] of Object.entries(hooks.attributes)) root.setAttribute(name, value);
  for (const [name, value] of Object.entries(hooks.variables)) root.style.setProperty(name, value);
  const app = doc.getElementById(PREVIEW_APP_ID);
  if (app && app.getAttribute("data-tab") !== tab) {
    app.innerHTML = previewMarkup(tab);
    app.setAttribute("data-tab", tab);
  }
}

// What the saved settings switch off or cannot do, said next to the preview because the preview itself then shows nothing.
function notesFor(values) {
  const notes = [];
  if (!values.productPage.enabled) notes.push("The Wishlist button is hidden on product pages.");
  if (!values.collectionPage.enabled) notes.push("Hearts are hidden on product cards.");
  if (!values.wishlistPage.headerIcon) notes.push("The header Wishlist icon is hidden.");
  return notes;
}

// A failure while drawing the preview must never take the settings form down with it (an exception thrown from an effect
// would replace the whole screen with the error page). It is logged, the preview says it could not be drawn, and the next
// change of tab or setting tries again.
const PREVIEW_FAILED = "The preview could not be drawn. Your settings and the controls are not affected: you can keep editing and save.";

export function AppearancePreview({ tab, values, viewport = "desktop", onViewport }) {
  const frame = useRef(null);
  const [failed, setFailed] = useState(false);
  const stage = useRef(null);
  const [stageWidth, setStageWidth] = useState(0);
  const hooks = useMemo(() => storefrontHooks(toSparse(values)), [values]);
  const hooksKey = JSON.stringify(hooks);
  const view = PREVIEW_VIEWPORTS[viewport] ?? PREVIEW_VIEWPORTS.desktop;

  // Every change of settings or tab is applied to the frame at once. The frame's own load event applies it again for
  // browsers that replace a new frame's blank document after it is attached.
  const draw = () => {
    try {
      syncFrame(frame.current, tab, hooks);
      setFailed((was) => (was ? false : was));
    } catch (error) {
      console.error("[wishlist-settings] the preview could not be drawn", error?.name, String(error?.message ?? "").slice(0, 200));
      setFailed(true);
    }
  };
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hooksKey stands for hooks
  }, [tab, hooksKey]);

  // The sample page is laid out at a real storefront width and scaled down to fit, so its breakpoints (the Wishlist
  // table, the product page columns) are the real ones. Without a measurable stage (tests) it is shown at full size.
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const measure = () => setStageWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = stageWidth > 0 ? Math.min(1, stageWidth / view.width) : 1;
  const notes = notesFor(values);

  return (
    <aside className="kv-card kv-preview-card" aria-label="Preview">
      <div className="kv-card-head">
        <h3>Preview</h3>
        <div className="kv-seg" role="group" aria-label="Preview size">
          {VIEWPORT_KEYS.map((key) => (
            <button key={key} type="button" className={`kv-seg-btn${key === viewport ? " on" : ""}`} aria-pressed={key === viewport} onClick={() => onViewport?.(key)}>
              {PREVIEW_VIEWPORTS[key].label}
            </button>
          ))}
        </div>
      </div>
      <div className="kv-card-body kv-pv">
        <p className="kv-pv-label">{PREVIEW_NOTE}</p>
        {failed ? (
          <p className="kv-pv-notes" role="alert">
            {PREVIEW_FAILED}
          </p>
        ) : null}
        <div className="kv-pv-stage" ref={stage} style={{ height: PREVIEW_HEIGHT, ...(failed ? { display: "none" } : {}) }}>
          <div className={`kv-pv-device kv-pv-device--${viewport}`} style={{ width: Math.round(view.width * scale), height: PREVIEW_HEIGHT }}>
            <iframe
              ref={frame}
              className="kv-pv-frame"
              title={`Storefront preview: ${TAB_TITLES[tab] ?? TAB_TITLES.general}`}
              sandbox="allow-same-origin"
              onLoad={draw}
              style={{ width: view.width, height: Math.round(PREVIEW_HEIGHT / scale), transform: `scale(${scale})` }}
            />
          </div>
        </div>
        {notes.length ? (
          <ul className="kv-pv-notes" role="status">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {tab === "productPage" ? <p className="kv-pv-label">Sample layout only. On your store the button appears where you place the Wishlist button block in the theme editor.</p> : null}
      </div>
    </aside>
  );
}

// Contains an error thrown while RENDERING the preview, so the form beside it stays on screen.
export class PreviewBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("[wishlist-settings] the preview failed to render", error?.name, String(error?.message ?? "").slice(0, 200));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <aside className="kv-card kv-preview-card" aria-label="Preview">
        <div className="kv-card-head">
          <h3>Preview</h3>
        </div>
        <div className="kv-card-body kv-pv">
          <p className="kv-pv-notes" role="alert">
            {PREVIEW_FAILED}
          </p>
          <s-button onClick={() => this.setState({ failed: false })}>Try again</s-button>
        </div>
      </aside>
    );
  }
}
