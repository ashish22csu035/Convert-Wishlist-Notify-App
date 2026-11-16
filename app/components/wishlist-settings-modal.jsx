/* eslint-disable react/prop-types -- plain JavaScript project: small local helper components are not given PropTypes */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { WishlistSettingsForm } from "./wishlist-settings-form";

// The Wishlist Settings form (the same component as the /app/wishlist-settings page) inside Polaris's <s-modal>, shown
// over the Dashboard, which stays mounted underneath. The dialog's own header provides the close (×) control, Escape and
// the backdrop. Data comes from /app/wishlist-settings-data; saving posts to /app/wishlist-settings' action, and when the
// server confirms, the dialog closes and the router revalidates the Dashboard (so the checklist reflects the saved state).
// A close with unsaved edits is not allowed to lose them silently: the dialog reopens with a "Discard changes?" prompt.
export function WishlistSettingsModal({ open, onClosed }) {
  const loader = useFetcher();
  const [host, setHost] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const dirty = useRef(false);
  const force = useRef(false); // set when the close was decided (saved, or edits discarded on purpose)
  const shown = useRef(false);

  const ref = useCallback((element) => setHost(element), []);

  useEffect(() => {
    if (!open || !host) return;
    force.current = false;
    dirty.current = false;
    setConfirming(false);
    loader.load("/app/wishlist-settings-data");
    host.showOverlay?.();
    shown.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open, host]);

  useEffect(() => {
    if (!host) return undefined;
    const afterHide = () => {
      if (!shown.current) return;
      if (dirty.current && !force.current) {
        host.showOverlay?.(); // × / Escape with unsaved edits: keep the dialog, ask first
        setConfirming(true);
        return;
      }
      shown.current = false;
      setConfirming(false);
      onClosed();
    };
    host.addEventListener("afterhide", afterHide);
    return () => host.removeEventListener("afterhide", afterHide);
  }, [host, onClosed]);

  const finish = () => {
    force.current = true;
    host?.hideOverlay?.();
  };
  const requestClose = () => {
    if (dirty.current) setConfirming(true);
    else finish();
  };

  const data = loader.data;
  const loading = !data;
  const modal = { host, onClose: requestClose, onSaved: () => { dirty.current = false; finish(); }, onDirtyChange: (value) => { dirty.current = value; } };

  return (
    <s-modal ref={ref} id="wishlist-settings-modal" heading="Wishlist Settings" size="large-100">
      {open && confirming ? (
        <s-banner tone="warning" heading="Discard your changes?">
          You have unsaved changes. Closing now will lose them.
          <s-button slot="secondary-actions" onClick={() => setConfirming(false)}>
            Keep editing
          </s-button>
          <s-button slot="secondary-actions" tone="critical" onClick={() => { dirty.current = false; finish(); }}>
            Discard and close
          </s-button>
        </s-banner>
      ) : null}
      {open && data?.ok ? <WishlistSettingsForm appearance={data.appearance} shop={data.shop} apiKey={data.apiKey} modal={modal} /> : null}
      {open && data && !data.ok ? (
        <s-banner tone="critical" heading="Wishlist Settings could not be loaded">
          The settings could not be read. Your storefront is not affected.
          <s-button slot="secondary-actions" onClick={() => loader.load("/app/wishlist-settings-data")}>
            Try again
          </s-button>
        </s-banner>
      ) : null}
      {open && loading ? <s-spinner accessibilityLabel="Loading Wishlist Settings" size="large" /> : null}
    </s-modal>
  );
}
