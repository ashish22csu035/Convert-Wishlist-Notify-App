/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useState } from "react";
import { formatNumber } from "../utils/format";
import { isEmptyFunnel } from "../utils/funnel";

// Connected funnel stages, left to right (top to bottom on a narrow screen), in the order `stages` gives them (4 for
// Wishlist, 5 for Notify Me). `stages` come from utils/funnel.js. A stage without a trustworthy source is drawn hatched
// and labelled "Unavailable" with the reason beside it; its count is never 0. A stage that ignores the selected dates is
// tagged "All time". The revenue stage carries its order count under the amount.
// Geometry: the band narrows from full height to FUNNEL_END_PCT in equal steps, one per stage. Stage i is the trapezoid
// between edge i and edge i+1, so every stage joins the next exactly and the first is the largest. It depends only on the
// stage's position, never on the data (a figure is never stretched to look proportional).
const FUNNEL_END_PCT = 40;
export const funnelEdges = (count) => Array.from({ length: count + 1 }, (_, i) => Math.round((100 - (i * (100 - FUNNEL_END_PCT)) / count) * 10) / 10);

export function ProductFunnel({ stages, label = "Product funnel", feature }) {
  const edges = funnelEdges(stages.length);
  return (
    <ol className="kv-funnel" data-feature={feature} data-stages={stages.length} aria-label={label} style={{ listStyle: "none", margin: 0 }}>
      {stages.map((stage, index) => (
        <li key={stage.key} className={`kv-funnel-stage s${index + 1}${stage.available ? "" : " na"}`}>
          <span className="kv-funnel-head">
            <span className="kv-funnel-label">{stage.label}</span>
          </span>
          {stage.scope === "all-time" ? <span className="kv-funnel-scope">All time</span> : null}
          <span className={`kv-funnel-count${stage.available ? "" : " na"}`}>{stage.available ? stage.display ?? formatNumber(stage.count) : "Unavailable"}</span>
          {typeof stage.orders === "number" ? <span className="kv-funnel-sub">{`${formatNumber(stage.orders)} ${stage.orders === 1 ? "order" : "orders"}`}</span> : null}
          <span className="kv-funnel-shape" aria-hidden="true" style={{ "--hl": edges[index], "--hr": edges[index + 1] }}>
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
      {funnel.partial ? (
        <p className="kv-funnel-foot" data-testid="funnel-partial">
          Some days are not summarised yet, so these figures may be lower than the real totals.
        </p>
      ) : null}
    </div>
  );
}
