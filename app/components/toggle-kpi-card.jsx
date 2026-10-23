/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useState } from "react";
import { formatNumber } from "../utils/format";

// Same tooltip as the other cards (kept in this file so it can be tested without the router).
function Hint({ label, text }) {
  if (!text) return null;
  const id = `hint-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <>
      <button type="button" className="kv-hint" aria-label={`About ${label}: ${text}`} title={text}>
        <s-icon type="info" size="small" interestFor={id} />
      </button>
      <s-tooltip id={id}>{text}</s-tooltip>
    </>
  );
}

// A metric tile with a compact two-option segmented control in its header. Every option's figure is
// already loaded, so switching is local state: it changes only this card and never reloads the page.
// `options`: [{ key, label, value, caption, display?, details? }]; value null = unavailable (never shown as 0).
// `display` (a ready-made string such as a money amount) replaces the formatted number as the headline,
// `details` are extra lines under the title, `footnote` is a line shown for every option.
//
// The control is made of plain <button>s (not a Polaris button group) so it is always rendered, keyboard
// operable and announced as a pressed/not-pressed pair; it is styled in app/styles/merchant.css.
export function ToggleKpiCard({ label, icon, tone = "violet", options, initial, footnote, hint }) {
  const [active, setActive] = useState(initial ?? options[0].key);
  const current = options.find((option) => option.key === active) ?? options[0];
  const unavailable = current.value === null || current.value === undefined;
  return (
    <div className={`kv-kpi has-seg ${unavailable ? "muted" : tone}`}>
      <div className="kv-kpi-top">
        <span className="kv-kpi-icon">
          <s-icon type={icon} />
        </span>
        <div className="kv-seg" role="group" aria-label={`${label} view`}>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`kv-seg-btn${option.key === current.key ? " on" : ""}`}
              aria-pressed={option.key === current.key}
              onClick={() => setActive(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`kv-kpi-value${unavailable ? " na" : ""}`}>{unavailable ? "Unavailable" : (current.display ?? formatNumber(current.value))}</div>
      <div className="kv-kpi-label">
        {label}
        <Hint label={label} text={current.hint ?? hint} />
      </div>
      {unavailable ? null : (current.details ?? []).map((line) => (
        <div key={line} className="kv-kpi-note">
          {line}
        </div>
      ))}
      {unavailable || current.caption ? <div className="kv-kpi-note">{unavailable ? (current.unavailableNote ?? "This figure could not be loaded.") : current.caption}</div> : null}
      {footnote ? <div className="kv-kpi-note">{footnote}</div> : null}
    </div>
  );
}
