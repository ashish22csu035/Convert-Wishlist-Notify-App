/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useEffect, useState } from "react";
import { useBlocker, useFetcher, useLocation, useNavigate } from "react-router";
import { withEmbeddedParams } from "../utils/embedded-url";
import { OPTION_LABELS, SPEC, isAppearanceDirty, sectionDefaults, validateAppearance } from "../utils/wishlist-appearance-shared";
import { Page } from "./merchant-ui";
import { WcField, WcSelect, WcSwitch, flags } from "./wc-fields";
import { AppearancePreview, PreviewBoundary } from "./wishlist-appearance-preview";

// Wishlist Settings: how the Wishlist looks and behaves on the storefront, in four tabs that share ONE state object, so
// switching tabs never loses an edit. Save sends the whole appearance in one request; the server validates it again
// (utils/wishlist-appearance-shared.js) and only a confirmed write is reported as saved. Discard goes back to the last
// server-confirmed copy. This screen never reads or writes the Wishlist / Notify Me switches.

const TABS = [
  { key: "general", label: "General" },
  { key: "productPage", label: "Product page" },
  { key: "collectionPage", label: "Collection page" },
  { key: "wishlistPage", label: "Wishlist page" },
];

const PAGE_PATH = "/apps/konvert-notify/my-wishlist";

// "" -> null (nullable) / "" (not nullable, so the server rule reports it); digits -> number; anything else is kept as
// typed so the error message can point at it.
const toNumber = (text, nullable) => {
  const clean = String(text).trim();
  if (clean === "") return nullable ? null : "";
  return /^\d{1,6}$/.test(clean) ? Number(clean) : clean;
};

function ColorControl({ label, value, onValue, error, details }) {
  return (
    <div className="kv-color">
      <WcField as="s-color-field" label={label} value={value ?? ""} onValue={(text) => onValue(text.trim() === "" ? null : text)} error={error || undefined} details={details} />
      {value ? (
        <s-button variant="tertiary" onClick={() => onValue(null)}>
          Use default
        </s-button>
      ) : null}
    </div>
  );
}

function NumberControl({ label, value, onValue, error, details, min, max, placeholder, nullable }) {
  return (
    <WcField
      as="s-number-field"
      label={label}
      value={value === null || value === undefined ? "" : String(value)}
      onValue={(text) => onValue(toNumber(text, nullable))}
      min={min}
      max={max}
      placeholder={placeholder}
      error={error || undefined}
      details={details}
    />
  );
}

// Things the app cannot do from here: the theme editor decides whether the app embed is on and where the product
// button block sits.
function ThemeEditorNotice({ shop, apiKey }) {
  const editor = `https://${shop}/admin/themes/current/editor`;
  const key = encodeURIComponent(apiKey || "");
  const embedUrl = key ? `${editor}?context=apps&activateAppId=${key}/wishlist-embed` : `${editor}?context=apps`;
  const blockUrl = key ? `${editor}?template=product&addAppBlockId=${key}/wishlist-button&target=mainSection` : `${editor}?template=product`;
  return (
    <s-banner tone="info" heading="Some things are set in your theme editor">
      These settings change how the Wishlist looks. They cannot turn on something your theme does not have yet: the Wishlist embed (header icon, hearts on product cards) must be on, and the Wishlist button block must be added to your product page. Where
      you place that block in the theme editor is where the button appears, for example under Add to cart.
      <s-link slot="secondary-actions" href={embedUrl} target="_blank">
        Open the app embed in the theme editor
      </s-link>
      <s-link slot="secondary-actions" href={blockUrl} target="_blank">
        Add the button to the product page
      </s-link>
    </s-banner>
  );
}

export function WishlistSettingsForm({ appearance, shop, apiKey }) {
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { search } = useLocation(); // the Admin context (embedded, host, shop) travels with the navigation
  const [tab, setTab] = useState("general");
  const [values, setValues] = useState(appearance);
  const [saved, setSaved] = useState(appearance); // what the server last confirmed
  const [notice, setNotice] = useState(null); // the server's last answer, until the merchant edits or discards
  const [copied, setCopied] = useState(false);
  // Which sample screen size the preview shows, per tab. A view choice only: it is not part of the settings and is never saved.
  const [viewports, setViewports] = useState({ general: "desktop", productPage: "desktop", collectionPage: "mobile", wishlistPage: "desktop" });

  const saving = fetcher.state !== "idle";
  const { errors } = validateAppearance(values);
  const invalid = Object.keys(errors).length > 0;
  const dirty = invalid || isAppearanceDirty(values, saved);

  useEffect(() => {
    if (!fetcher.data) return;
    setNotice(fetcher.data);
    if (fetcher.data.ok) setSaved(fetcher.data.appearance);
  }, [fetcher.data]);

  // Leaving with unsaved changes: ask first, inside the app and when the tab is closed.
  const blocker = useBlocker(dirty && !saving);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = (section, key) => (value) => setValues((current) => ({ ...current, [section]: { ...current[section], [key]: value } }));
  const err = (section, key) => errors[`${section}.${key}`];

  const save = () => {
    if (saving || invalid) return; // no duplicate or invalid submissions
    const data = new FormData();
    data.set("appearance", JSON.stringify(values));
    fetcher.submit(data, { method: "POST" });
  };
  const discard = () => {
    setValues(saved);
    setNotice(null);
  };
  const reset = () => setValues((current) => ({ ...current, [tab]: sectionDefaults(tab) }));
  const justSaved = notice?.ok && !dirty;

  const pageUrl = `https://${shop}${PAGE_PATH}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // the field above stays selectable
    }
  };

  const g = values.general;
  const p = values.productPage;
  const c = values.collectionPage;
  const w = values.wishlistPage;

  const panels = {
    general: (
      <>
        <WcSelect label="Icon" value={g.iconType} options={OPTION_LABELS.iconType} onValue={set("general", "iconType")} />
        <ColorControl
          label="Default icon color"
          value={g.defaultColor}
          onValue={set("general", "defaultColor")}
          error={err("general", "defaultColor")}
          details={g.defaultColor ? undefined : "Not set: your theme editor’s “Heart color” is used (#d6336c unless you changed it)."}
        />
        <ColorControl label="Hover color" value={g.hoverColor} onValue={set("general", "hoverColor")} error={err("general", "hoverColor")} details={g.hoverColor ? undefined : "Not set: the default color."} />
        <ColorControl label="Saved color" value={g.activeColor} onValue={set("general", "activeColor")} error={err("general", "activeColor")} details={g.activeColor ? undefined : "Not set: the default color. This is the color of an item that is already in the Wishlist."} />
        <WcSwitch
          label="Use my theme’s fonts"
          details="On: the Wishlist uses your theme’s fonts. Off: it uses a plain system font."
          checked={g.useThemeFonts}
          onChecked={set("general", "useThemeFonts")}
        />
      </>
    ),
    productPage: (
      <>
        <WcSwitch
          label="Show the Wishlist button on product pages"
          details="This can hide the button but cannot add it: the Wishlist button block must be on your product page in the theme editor."
          checked={p.enabled}
          onChecked={set("productPage", "enabled")}
        />
        <WcSelect label="Button content" value={p.buttonType} options={OPTION_LABELS.buttonType} onValue={set("productPage", "buttonType")} />
        <WcSelect label="Button style" value={p.buttonStyle} options={OPTION_LABELS.buttonStyle} onValue={set("productPage", "buttonStyle")} />
        <NumberControl
          label="Corner radius (px)"
          value={p.buttonRadius}
          onValue={set("productPage", "buttonRadius")}
          error={err("productPage", "buttonRadius")}
          min={SPEC.productPage.buttonRadius.min}
          max={SPEC.productPage.buttonRadius.max}
          placeholder="Theme default"
          nullable
          details="Empty: the button follows your theme’s button radius."
        />
        <WcSelect label="Width" value={p.widthMode} options={OPTION_LABELS.widthMode} onValue={set("productPage", "widthMode")} />
        {p.widthMode === "manual" ? (
          <NumberControl
            label="Fixed width (px)"
            value={p.manualWidth}
            onValue={set("productPage", "manualWidth")}
            error={err("productPage", "manualWidth")}
            min={SPEC.productPage.manualWidth.min}
            max={SPEC.productPage.manualWidth.max}
          />
        ) : null}
        <WcSelect
          label="Alignment in its block"
          value={p.position}
          options={OPTION_LABELS.productPosition}
          onValue={set("productPage", "position")}
          details="Only visible when the width is not full. Where the block sits on the page (for example under Add to cart) is set by where you place it in the theme editor."
        />
      </>
    ),
    collectionPage: (
      <>
        <WcSwitch
          label="Show hearts on product cards"
          details="This can hide them but cannot add them: the Wishlist embed must be on in the theme editor with “Show hearts on product cards” ticked."
          checked={c.enabled}
          onChecked={set("collectionPage", "enabled")}
        />
        <NumberControl
          label="Icon size (px)"
          value={c.iconSize}
          onValue={set("collectionPage", "iconSize")}
          error={err("collectionPage", "iconSize")}
          min={SPEC.collectionPage.iconSize.min}
          max={SPEC.collectionPage.iconSize.max}
          details="The button around the icon is never smaller than 44px, so it stays easy to tap."
        />
        <NumberControl
          label="Background opacity (%)"
          value={c.backgroundOpacity}
          onValue={set("collectionPage", "backgroundOpacity")}
          error={err("collectionPage", "backgroundOpacity")}
          min={SPEC.collectionPage.backgroundOpacity.min}
          max={SPEC.collectionPage.backgroundOpacity.max}
        />
        <WcSelect label="Position on the product image" value={c.position} options={OPTION_LABELS.collectionPosition} onValue={set("collectionPage", "position")} />
        <WcSelect label="Wishlist count" value={c.countDisplay} options={OPTION_LABELS.countDisplay} onValue={set("collectionPage", "countDisplay")} />
      </>
    ),
    wishlistPage: (
      <>
        <WcSelect label="Layout" value={w.layout} options={OPTION_LABELS.layout} onValue={set("wishlistPage", "layout")} />
        <WcSwitch
          label="Show the Wishlist icon in the header"
          details="A shortcut to the Wishlist page. It needs the Wishlist embed to be on with “Show wishlist icon in the header” ticked in the theme editor."
          checked={w.headerIcon}
          onChecked={set("wishlistPage", "headerIcon")}
        />
        <div className="kv-url">
          <WcField as="s-text-field" label="Wishlist page address" value={pageUrl} {...flags({ readOnly: true })} details="Add this address to your store menu or a button. Customers need to be logged in to see their Wishlist." />
          <s-button onClick={copy}>{copied ? "Copied" : "Copy"}</s-button>
        </div>
      </>
    ),
  };

  // One destination for the header arrow and the "Back to Settings" button: a direct route (never history), embedded context kept.
  // If there are unsaved changes the existing blocker asks first.
  const backToSettings = (event) => {
    event?.preventDefault?.();
    navigate(withEmbeddedParams("/app/settings", search));
  };

  const current = TABS.find((item) => item.key === tab);

  return (
    <Page
      title="Wishlist Settings"
      back={{ href: "/app/settings", label: "Settings", onNavigate: backToSettings }}
      subtitle="Choose how the Wishlist looks and behaves on your storefront."
      actions={
        <>
          {dirty ? <span className="kv-id">Unsaved changes</span> : null}
          <s-button href="/app/settings" onClick={backToSettings}>
            Back to Settings
          </s-button>
          <s-button onClick={discard} {...flags({ disabled: !dirty || saving })}>
            Discard
          </s-button>
          <s-button variant="primary" onClick={save} {...flags({ disabled: !dirty || saving || invalid, loading: saving })}>
            {saving ? "Saving…" : "Save"}
          </s-button>
        </>
      }
    >
      {blocker.state === "blocked" ? (
        <s-banner tone="warning" heading="You have unsaved changes">
          Leaving this page will discard them.
          <s-button slot="secondary-actions" onClick={() => blocker.reset()}>
            Stay on this page
          </s-button>
          <s-button slot="secondary-actions" tone="critical" onClick={() => blocker.proceed()}>
            Leave without saving
          </s-button>
        </s-banner>
      ) : null}
      {justSaved ? (
        <s-banner tone="success" heading="Appearance saved">
          Your storefront follows these settings within a minute.
        </s-banner>
      ) : null}
      {notice && !notice.ok ? (
        <s-banner tone="critical" heading="Appearance was not saved">
          {notice.failed ? "Something went wrong while saving. Your changes are still on this page; try Save again." : "Some values were not valid. Check the highlighted fields and try again."}
        </s-banner>
      ) : null}

      <ThemeEditorNotice shop={shop} apiKey={apiKey} />

      <div className="kv-tabs" role="tablist" aria-label="Wishlist settings sections">
        {TABS.map((item) => (
          <button key={item.key} type="button" role="tab" id={`kv-tab-${item.key}`} className="kv-tab" aria-selected={tab === item.key} aria-current={tab === item.key ? "page" : undefined} aria-controls="kv-tabpanel" onClick={() => setTab(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      <div className="kv-wset">
        <section className="kv-card kv-form-card" role="tabpanel" id="kv-tabpanel" aria-labelledby={`kv-tab-${tab}`}>
          <div className="kv-card-head">
            <h3>{current.label}</h3>
            <s-button variant="tertiary" onClick={reset}>
              Reset to defaults
            </s-button>
          </div>
          <div className="kv-fields">{panels[tab]}</div>
        </section>
        <PreviewBoundary>
          <AppearancePreview tab={tab} values={values} viewport={viewports[tab]} onViewport={(next) => setViewports((current) => ({ ...current, [tab]: next }))} />
        </PreviewBoundary>
      </div>
    </Page>
  );
}
