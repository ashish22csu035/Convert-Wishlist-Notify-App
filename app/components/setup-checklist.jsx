/* eslint-disable react/prop-types -- plain JavaScript project: small local helper components are not given PropTypes */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";
import { withEmbeddedParams } from "../utils/embedded-url";
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
  const navigate = useNavigate();
  const { search } = useLocation();
  const [open, setOpen] = useState(true);
  const { theme } = useThemeSetup();
  const { steps, completed, total, allDone, dismissed } = setupChecklist(setup.state, { appearanceSaved: setup.appearanceSaved, theme });
  const { embedUrl, blockUrl } = themeEditorLinks(setup.shop, setup.apiKey);
  const send = (intent) => fetcher.submit({ intent }, { method: "POST" });
  const busy = fetcher.state !== "idle";

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
      <div className="kv-setup-progress">
        <span className="kv-setup-count">
          {completed} of {total} steps completed
        </span>
        <div className="kv-setup-bar" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}>
          <span style={{ width: `${(completed / total) * 100}%` }} />
        </div>
      </div>
      {open ? (
        <ol id="kv-setup-steps" className="kv-setup-steps">
          {steps.map((step) => (
            <li key={step.key} className={`kv-setup-step${step.completed ? " done" : ""}`}>
              <span className="kv-setup-mark" aria-hidden="true">
                {step.completed ? <s-icon type="check" size="small" /> : null}
              </span>
              <div className="kv-setup-body">
                <div className="kv-setup-title">
                  <strong>{step.title}</strong>
                  <span className={`kv-setup-status${step.completed ? " done" : ""}`}>{step.status}</span>
                </div>
                <p>{step.description}</p>
                {step.themeStep && !step.completed && !step.checking ? (
                  <p className="kv-setup-help">
                    {step.unknown ? "Shopify didn’t report this step’s status just now, so it isn’t counted as done. Use the button below; this step updates by itself when you come back. " : ""}
                    {destination[step.key].help}
                  </p>
                ) : null}
              </div>
              <div className="kv-setup-actions">
                {step.key === "configure" ? (
                  <s-button href="/app/wishlist-settings" onClick={() => navigate(withEmbeddedParams("/app/wishlist-settings", search))}>
                    {step.action}
                  </s-button>
                ) : (
                  <s-button href={destination[step.key].href} target="_blank">
                    {step.action}
                  </s-button>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {open && allDone ? <p className="kv-setup-help kv-setup-finish">Setup is complete. You can dismiss this guide.</p> : null}
    </section>
  );
}
