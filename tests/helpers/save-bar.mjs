// A stand-in for App Bridge's <ui-save-bar> in the jsdom tests. The real element is defined by Shopify's App Bridge script
// inside the Admin; here show() / hide() only record whether the bar is "showing", which is all the screens drive.
// The buttons inside it are the screen's own React buttons: the one with variant="primary" is Save, the other Discard.
export function installSaveBar(win) {
  if (win.customElements.get("ui-save-bar")) return;
  win.customElements.define(
    "ui-save-bar",
    class extends win.HTMLElement {
      show() {
        this.setAttribute("data-showing", "true");
        return Promise.resolve();
      }
      hide() {
        this.removeAttribute("data-showing");
        return Promise.resolve();
      }
    },
  );
}

export const saveBars = (doc = document) => [...doc.querySelectorAll("ui-save-bar")];
export const barShowing = (doc = document) => saveBars(doc).some((bar) => bar.hasAttribute("data-showing"));
export const barSave = (doc = document) => saveBars(doc)[0]?.querySelector('button[variant="primary"]') ?? null;
export const barDiscard = (doc = document) => saveBars(doc)[0]?.querySelector("button:not([variant])") ?? null;
// "The merchant can press it": the bar is on screen and the button is not disabled.
export const canSave = (doc = document) => barShowing(doc) && !barSave(doc).hasAttribute("disabled");
export const canDiscard = (doc = document) => barShowing(doc) && !barDiscard(doc).hasAttribute("disabled");
