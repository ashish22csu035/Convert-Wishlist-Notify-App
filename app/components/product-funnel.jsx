/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useState } from "react";
import { formatNumber } from "../utils/format";
import { isEmptyFunnel } from "../utils/funnel";

// Connected funnel stages, narrowing left to right (top to bottom on a narrow screen).
// `stages` come from utils/funnel.js. A stage without a trustworthy source is drawn hatched and labelled
// "Unavailable" with the reason beside it; its count is never 0.
export function ProductFunnel({ stages, label = "Product funnel", feature }) {
  return (
    <ol className="kv-funnel" data-feature={feature} aria-label={label} style={{ listStyle: "none", margin: 0 }}>
      {stages.map((stage, index) => (
        <li key={stage.key} className={`kv-funnel-stage s${index + 1}${stage.available ? "" : " na"}`}>
          <span className="kv-funnel-label">{stage.label}</span>
          <span className={`kv-funnel-count${stage.available ? "" : " na"}`}>{stage.available ? stage.display ?? formatNumber(stage.count) : "Unavailable"}</span>
          <span className="kv-funnel-shape" aria-hidden="true">
            <div />
          </span>
          {stage.reason ? <span className="kv-funnel-reason">{stage.reason}</span> : null}
        </li>
      ))}
    </ol>
  );
}

// The Wishlist / Notify Me selector above the funnel. Both funnels are already loaded for the selected date
// range, so switching is local state and never reloads the page. A funnel with no activity shows an empty state
// instead of a row of zeros.
export const FUNNEL_VIEWS = [
  { key: "wishlist", label: "Wishlist" },
  { key: "notifyMe", label: "Notify Me" },
];

export function FunnelSwitch({ funnels, rangeLabel, initial = "wishlist" }) {
  const [view, setView] = useState(initial);
  const current = FUNNEL_VIEWS.find((option) => option.key === view) ?? FUNNEL_VIEWS[0];
  const funnel = funnels[current.key];
  return (
    <div>
      <div className="kv-seg standalone" role="group" aria-label="Funnel">
        {FUNNEL_VIEWS.map((option) => (
          <button key={option.key} type="button" className={`kv-seg-btn${option.key === current.key ? " on" : ""}`} aria-pressed={option.key === current.key} onClick={() => setView(option.key)}>
            {option.label}
          </button>
        ))}
      </div>
      {isEmptyFunnel(funnel.stages) ? (
        <div className="kv-empty">
          <h4>No {funnel.title} activity in this period</h4>
          <p>{rangeLabel}. The funnel fills in as customers use {funnel.title}.</p>
        </div>
      ) : (
        <ProductFunnel stages={funnel.stages} feature={funnel.feature} label={`${funnel.title} funnel, ${rangeLabel}`} />
      )}
    </div>
  );
}
