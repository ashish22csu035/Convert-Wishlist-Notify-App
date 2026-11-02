/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useEffect, useState } from "react";
import { useBlocker, useFetcher, useLocation, useNavigate } from "react-router";
import { withEmbeddedParams } from "../utils/embedded-url";
import { NOTIFY_VARIABLES, OPTION_LABELS, SPEC, isNotifyDirty, sectionDefaults, validateNotify } from "../utils/notify-settings-shared";
import { Page } from "./merchant-ui";
import { NativeSaveBar } from "./native-save-bar";
import { ButtonPreview, EmailPreview, ViewportToggle } from "./notify-preview";
import { WcField, WcSelect } from "./wc-fields";

// Notify Me Settings: the storefront button and the back-in-stock email, in two tabs that share ONE state object (switching
// tabs never loses an edit). Save sends everything in one request; the server validates again
// (utils/notify-settings-shared.js) and only a confirmed write is reported as saved. Saving sends no email.

const TABS = [
  { key: "button", label: "Button" },
  { key: "email", label: "Email" },
];

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

function TextControl({ label, value, onValue, error, details, multiline, max }) {
  return <WcField as={multiline ? "s-text-area" : "s-text-field"} label={label} value={value} onValue={onValue} error={error || undefined} details={details} maxLength={max} {...(multiline ? { rows: 4 } : {})} />;
}

export function NotifySettingsForm({ settings }) {
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { search } = useLocation(); // the Admin context (embedded, host, shop) travels with the navigation
  const [tab, setTab] = useState("button");
  const [values, setValues] = useState(settings);
  const [saved, setSaved] = useState(settings); // what the server last confirmed
  const [notice, setNotice] = useState(null);
  // View choices only: never saved, and kept while the merchant switches tabs.
  const [viewport, setViewport] = useState("desktop");
  const [pageType, setPageType] = useState("product");
  const [subscribed, setSubscribed] = useState(false); // the preview button's local state; no request is ever made

  const saving = fetcher.state !== "idle";
  const { errors } = validateNotify(values);
  const invalid = Object.keys(errors).length > 0;
  const dirty = invalid || isNotifyDirty(values, saved);

  useEffect(() => {
    if (!fetcher.data) return;
    setNotice(fetcher.data);
    if (fetcher.data.ok) setSaved(fetcher.data.settings);
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
    data.set("settings", JSON.stringify(values));
    fetcher.submit(data, { method: "POST" });
  };
  const discard = () => {
    setValues(saved);
    setNotice(null);
  };
  const reset = () => setValues((current) => ({ ...current, [tab]: sectionDefaults(tab) }));
  const justSaved = notice?.ok && !dirty;

  const backToSettings = (event) => {
    event?.preventDefault?.();
    navigate(withEmbeddedParams("/app/settings", search));
  };

  const b = values.button;
  const e = values.email;
  const variableHelp = `Variables you can use: ${NOTIFY_VARIABLES.map((variable) => `{{${variable.token}}} (${variable.label.toLowerCase()})`).join(", ")}.`;

  const panels = {
    button: (
      <>
        <TextControl label="Button text" value={b.text} onValue={set("button", "text")} error={err("button", "text")} max={SPEC.button.text.max} details="Shown instead of Add to cart when a variant is sold out. It replaces the text for every language." />
        <WcSelect label="Button style" value={b.style} options={OPTION_LABELS.style} onValue={set("button", "style")} />
        <ColorControl label="Background color" value={b.bgColor} onValue={set("button", "bgColor")} error={err("button", "bgColor")} details={b.bgColor ? undefined : "Not set: your theme’s button color is used."} />
        <ColorControl label="Text color" value={b.textColor} onValue={set("button", "textColor")} error={err("button", "textColor")} details={b.textColor ? undefined : "Not set: your theme’s button text color is used."} />
      </>
    ),
    email: (
      <>
        <TextControl label="Email subject" value={e.subject} onValue={set("email", "subject")} error={err("email", "subject")} max={SPEC.email.subject.max} details={variableHelp} />
        <TextControl label="Email heading" value={e.heading} onValue={set("email", "heading")} error={err("email", "heading")} max={SPEC.email.heading.max} details="Optional. Leave empty for no heading." />
        <TextControl label="Email body" value={e.body} onValue={set("email", "body")} error={err("email", "body")} multiline max={SPEC.email.body.max} details="Plain text. Customer and merchant text is always shown as text, never as HTML." />
        <TextControl label="Button label" value={e.ctaLabel} onValue={set("email", "ctaLabel")} error={err("email", "ctaLabel")} max={SPEC.email.ctaLabel.max} details="The button in the email that opens the product." />
      </>
    ),
  };

  const current = TABS.find((item) => item.key === tab);

  return (
    <Page
      title="Notify Me Settings"
      back={{ href: "/app/settings", label: "Settings", onNavigate: backToSettings }}
      subtitle="Choose how the Notify Me button looks and what the back-in-stock email says."
      actions={
        <>
          <s-button href="/app/settings" onClick={backToSettings}>
            Back to Settings
          </s-button>
        </>
      }
    >
      <NativeSaveBar id="notify-settings-save-bar" open={dirty} saving={saving} canSave={!invalid} onSave={save} onDiscard={discard} />
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
        <s-banner tone="success" heading="Notify Me settings saved">
          Your storefront follows the button settings within a minute. The next back-in-stock emails use the email settings. Saving sends no email.
        </s-banner>
      ) : null}
      {notice && !notice.ok ? (
        <s-banner tone="critical" heading="Notify Me settings were not saved">
          {notice.failed ? "Something went wrong while saving. Your changes are still on this page; try Save again." : "Some values were not valid. Check the highlighted fields and try again."}
        </s-banner>
      ) : null}

      <div className="kv-tabs" role="tablist" aria-label="Notify Me settings sections">
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
        <section className="kv-card kv-preview-card" aria-label="Preview">
          <div className="kv-card-head">
            <h3>Preview</h3>
            <ViewportToggle viewport={viewport} onViewport={setViewport} />
          </div>
          {tab === "button" ? <ButtonPreview button={b} viewport={viewport} pageType={pageType} onPageType={setPageType} subscribed={subscribed} onSubscribed={setSubscribed} /> : <EmailPreview email={e} viewport={viewport} />}
        </section>
      </div>
    </Page>
  );
}
