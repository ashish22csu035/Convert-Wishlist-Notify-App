/* eslint-disable react/prop-types -- plain JavaScript project: small local helper components are not given PropTypes */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ILLUSTRATIONS } from "./setup-illustrations";
import { WishlistSettingsModal } from "./wishlist-settings-modal";
import { detectThemeSetup, setupChecklist } from "../utils/onboarding-shared";
import { themeEditorLinks } from "../utils/theme-editor";

const UNKNOWN = { embed: null, product: null };
const MIN_GAP_MS = 3000; // focus events can arrive in bursts: one Shopify request at most every few seconds

// Asks Shopify (App Bridge, in the merchant's Admin) which of the app's blocks are active on the published theme. It runs
// when the Dashboard opens and again when the merchant comes back to this tab (for example from the theme editor).
// `theme` is undefined until the first answer; any failure is { embed: null, product: null }, which is never "done".
function useThemeSetup() {
  const [theme, setTheme] = useState(undefined);
  const running = useRef(false);
  const lastStart = useRef(0);
  const alive = useRef(true);

  const check = useCallback(async (force = false) => {
    const now = Date.now();
    if (running.current || (!force && now - lastStart.current < MIN_GAP_MS)) return;
    running.current = true;
    lastStart.current = now;
    let answer = UNKNOWN;
    try {
      const app = window.shopify?.app; // App Bridge, loaded by the Admin
      if (typeof app?.extensions === "function") answer = detectThemeSetup(await app.extensions());
    } catch {
      answer = UNKNOWN;
    }
    running.current = false;
    if (!alive.current) return;
    setTheme(answer);
  }, []);

  useEffect(() => {
    alive.current = true;
    check(true);
    const onBack = () => {
      if (document.visibilityState !== "hidden") check();
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [check]);

  return { theme };
}

// "Get started with Konvert" on the Dashboard. Step 1 is complete when Wishlist Settings were saved. The two theme steps
// are complete only when Shopify reports the block as active on the published theme; opening the theme editor proves nothing,
// and when Shopify cannot tell the step stays incomplete and says so. Collapsing is a view choice only and is not saved;
// closing the checklist is saved for the shop (see the Dashboard route's action) and it can be shown again while setup is incomplete.
export function SetupChecklist({ setup }) {
  const fetcher = useFetcher();
  const [designOpen, setDesignOpen] = useState(false); // Wishlist Settings dialog, over this Dashboard
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState(undefined); // the step the merchant opened or closed; undefined until they do
  const { theme } = useThemeSetup();
  const { steps, completed, total, allDone, dismissed } = setupChecklist(setup.state, { appearanceSaved: setup.appearanceSaved, theme });
  const { embedUrl, blockUrl } = themeEditorLinks(setup.shop, setup.apiKey);
  const send = (intent) => fetcher.submit({ intent }, { method: "POST" });
  const busy = fetcher.state !== "idle";

  // One step open at a time. Until the merchant picks one, the first step that is not complete is open (none when all are).
  const expanded = picked === undefined ? (steps.find((step) => !step.completed)?.key ?? null) : picked;

  if (dismissed && allDone) return null;
  if (dismissed) {
    return (
      <section className="kv-card kv-setup kv-setup-hidden" aria-label="Setup guide">
        <span>
          Setup guide hidden · {completed} of {total} steps completed
        </span>
        <button type="button" className="kv-link" onClick={() => send("reopen")} disabled={busy}>
          Show setup guide
        </button>
      </section>
    );
  }

  const destination = {
    embed: { href: embedUrl, help: "Opens your theme editor with the Konvert app embed ready to switch on. Turn it on and click Save, then come back: this step updates by itself." },
    product: { href: blockUrl, help: "Opens your product page in the theme editor. Add the Wishlist button block where the button should appear (for example under Add to cart) and click Save, then come back: this step updates by itself." },
  };

  return (
    <section className="kv-card kv-setup" aria-labelledby="kv-setup-title">
      <div className="kv-setup-head">
        <div>
          <h3 id="kv-setup-title">Get started with Konvert Wishlist And Notify</h3>
          <p>Complete these steps to enable Wishlist and Notify Me on your storefront.</p>
        </div>
        <div className="kv-setup-controls">
          <button type="button" className="kv-setup-icon" aria-expanded={open} aria-controls="kv-setup-steps" aria-label={open ? "Collapse setup guide" : "Expand setup guide"} onClick={() => setOpen((value) => !value)}>
            <s-icon type={open ? "chevron-up" : "chevron-down"} size="small" />
          </button>
          <button type="button" className="kv-setup-icon" aria-label="Dismiss setup guide" onClick={() => send("dismiss")} disabled={busy}>
            <s-icon type="x" size="small" />
          </button>
        </div>
      </div>
      <p className="kv-setup-count" aria-live="polite">
        {completed}/{total} completed
      </p>
      {open ? (
        <ol id="kv-setup-steps" className="kv-setup-steps">
          {steps.map((step) => {
            const isOpen = expanded === step.key;
            const Art = ILLUSTRATIONS[step.key];
            return (
              <li key={step.key} className={`kv-setup-step${step.completed ? " done" : ""}${isOpen ? " open" : ""}`}>
                {/* The whole row is the disclosure button; the step's own action lives in the panel, never inside it. */}
                <button type="button" className="kv-setup-row" id={`kv-step-${step.key}`} aria-expanded={isOpen} aria-controls={`kv-step-panel-${step.key}`} onClick={() => setPicked(isOpen ? null : step.key)}>
                  <span className="kv-setup-mark" aria-hidden="true">
                    {step.completed ? (
                      <svg className="kv-setup-tick" viewBox="0 0 20 20" width="12" height="12" focusable="false">
                        <path d="M4.5 10.5 8 14l7.5-8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="kv-setup-title">
                    <strong>{step.title}</strong>
                    {step.completed ? <span className="kv-setup-status done">Completed</span> : <span className="kv-sr">Not completed</span>}
                  </span>
                  <s-icon type={isOpen ? "chevron-up" : "chevron-down"} size="small" aria-hidden="true" />
                </button>
                <div className="kv-setup-panel" id={`kv-step-panel-${step.key}`} role="region" aria-labelledby={`kv-step-${step.key}`} hidden={!isOpen}>
                  <div className="kv-setup-body">
                    <p>{step.description}</p>
                    {step.themeStep && !step.completed && !step.checking ? (
                      <p className="kv-setup-help">
                        {step.unknown ? "Shopify didn’t report this step’s status just now, so it isn’t counted as done. Use the button below; this step updates by itself when you come back. " : ""}
                        {destination[step.key].help}
                      </p>
                    ) : null}
                    <div className="kv-setup-actions">
                      {step.key === "configure" ? (
                        <s-button onClick={() => setDesignOpen(true)} aria-haspopup="dialog">
                          {step.action}
                        </s-button>
                      ) : step.completed ? (
                        <s-button disabled>{step.doneAction}</s-button>
                      ) : (
                        <s-button href={destination[step.key].href} target="_blank" disabled={step.checking || undefined}>
                          {step.action}
                        </s-button>
                      )}
                    </div>
                  </div>
                  <div className="kv-setup-art" aria-hidden="true">
                    <Art />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {open && allDone ? <p className="kv-setup-help kv-setup-finish">Setup is complete. You can dismiss this guide.</p> : null}
      <WishlistSettingsModal open={designOpen} onClosed={() => setDesignOpen(false)} />
    </section>
  );
}
