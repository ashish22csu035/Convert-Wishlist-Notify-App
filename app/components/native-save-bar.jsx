/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { SaveBar } from "@shopify/app-bridge-react";

// Shopify's own contextual Save / Discard bar (App Bridge's <ui-save-bar>, through @shopify/app-bridge-react's SaveBar),
// not a look-alike. The settings screens give it ONE id each, and it is shown exactly while there is something to save:
//
//   open     the screen's `dirty` (an edit not yet confirmed by the server). It becomes false only when the saved copy has
//            caught up with the form, so a failed save keeps the bar - and the merchant's edits - on screen.
//   saving   a request is in flight: Save shows its spinner and both buttons are disabled, so a second request cannot start.
//   canSave  false while the form has values the server would refuse (the fields show their errors); Discard still works.
//
// The first <button> with variant="primary" is Shopify's Save, the other is Discard. While the bar is showing, App Bridge
// also asks the merchant before they leave the page through the Admin's own navigation.
export function NativeSaveBar({ id, open, saving, canSave = true, onSave, onDiscard }) {
  return (
    <SaveBar id={id} open={open}>
      <button
        type="button"
        variant="primary"
        onClick={onSave}
        {...(!canSave || saving ? { disabled: true } : {})}
        {...(saving ? { loading: "" } : {})}
      >
        Save
      </button>
      <button type="button" onClick={onDiscard} {...(saving ? { disabled: true } : {})}>
        Discard
      </button>
    </SaveBar>
  );
}
