/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useEffect, useState } from "react";
import { useBlocker, useFetcher, useLocation, useNavigate } from "react-router";
import { withEmbeddedParams } from "../utils/embedded-url";
import { FEATURE_FIELDS, isDirty } from "../utils/settings-shared";
import { Page } from "./merchant-ui";
import { WcSwitch, flags } from "./wc-fields";

// The Settings screen: one independent switch per storefront feature, saved with an explicit Save button.
// The server is the authority (the route action validates again with utils/settings-shared.js) and only a
// confirmed write is reported as saved.

const FEATURES = [
  {
    key: "wishlistEnabled",
    title: "Wishlist",
    label: "Enable Wishlist",
    details: "Customers can save products and see their Wishlist page.",
    offTitle: "Wishlist is off",
    offText: "The Wishlist buttons, header icon and collection hearts are hidden, and new saves are refused. Saved items and history are kept, and come back when you turn Wishlist on again.",
  },
  {
    key: "notifyMeEnabled",
    title: "Notify Me",
    label: "Enable Notify Me",
    details: "Customers can ask to be emailed when a sold-out item is back in stock.",
    offTitle: "Notify Me is off",
    offText: "The Notify Me button is hidden and new subscriptions are refused. Existing subscriptions and history are kept. Restock emails that are queued while this is off are skipped permanently and are not sent later, even after you turn it back on.",
  },
];

export function SettingsForm({ settings }) {
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { search } = useLocation(); // the Admin context (embedded, host, shop) travels with the navigation
  const [values, setValues] = useState(settings);
  const [saved, setSaved] = useState(settings); // what the server last confirmed

  const saving = fetcher.state !== "idle";
  const dirty = isDirty(values, saved);

  useEffect(() => {
    if (fetcher.data?.ok) setSaved(fetcher.data.values);
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

  const save = () => {
    if (saving) return; // no duplicate submissions
    const data = new FormData();
    for (const field of FEATURE_FIELDS) data.set(field, values[field] ? "true" : "false");
    fetcher.submit(data, { method: "POST" });
  };
  const justSaved = fetcher.data?.ok && !dirty;

  return (
    <Page
      title="Settings"
      subtitle="Choose which features customers see on your storefront."
      actions={
        <>
          {dirty ? <span className="kv-id">Unsaved changes</span> : null}
          <s-button variant="primary" onClick={save} {...flags({ disabled: !dirty || saving, loading: saving })}>
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
        <s-banner tone="success" heading="Settings saved">
          Your storefront follows these settings within a minute.
        </s-banner>
      ) : null}
      {fetcher.data && !fetcher.data.ok ? (
        <s-banner tone="critical" heading="Settings were not saved">
          {fetcher.data.failed ? "Something went wrong while saving. Your changes are still on this page; try Save again." : "The settings were not valid. Reload the page and try again."}
        </s-banner>
      ) : null}

      <div className="kv-form">
        {FEATURES.map((feature) => (
          <section key={feature.key} className="kv-card kv-form-card">
            <h3>{feature.title}</h3>
            <WcSwitch
              label={feature.label}
              details={feature.details}
              checked={values[feature.key]}
              onChecked={(on) => setValues((current) => ({ ...current, [feature.key]: on }))}
            />
            {!values[feature.key] ? (
              <s-banner tone="warning" heading={feature.offTitle}>
                {feature.offText}
              </s-banner>
            ) : null}
            {feature.key === "wishlistEnabled" ? (
              <div className="kv-form-link">
                {/* href: inside Shopify Admin, App Bridge handles a click on an element with an href (the same mechanism as the app menu
                    links) and moves the app there itself. onClick is the fallback when App Bridge is not running. */}
                <s-button href="/app/wishlist-settings" onClick={() => navigate(withEmbeddedParams("/app/wishlist-settings", search))}>
                  Wishlist Settings
                </s-button>
                <p>Choose the icon, colors, button style and layout of the Wishlist on your storefront.</p>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </Page>
  );
}
