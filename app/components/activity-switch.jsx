/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useState } from "react";
import { ActivityChart } from "./activity-chart";

// The Dashboard's activity chart with a two-option switch: Wishlist activity or Notify Me activity. Both
// charts use the series the dashboard report already holds (daily counts of real events, UTC days), so
// switching is local state and never reloads the page. Each view has its own legend and empty state.
// `series` is the report's { days, values }; `rangeLabel` names the period ("Last 30 days", "Oct 1 – Oct 15, 2026 (UTC)").
export const ACTIVITY_VIEWS = [
  { key: "wishlist", label: "Wishlist activity" },
  { key: "notify", label: "Notify Me activity" },
];

export function chartSeries(view, values) {
  if (view === "notify") {
    return [
      { key: "subscribed", label: "Subscribed", color: "var(--kv-blue)", values: values.NOTIFY_SUBSCRIBED },
      { key: "unsubscribed", label: "Unsubscribed", color: "var(--kv-subdued)", values: values.NOTIFY_UNSUBSCRIBED },
      { key: "sent", label: "Restock emails sent", color: "var(--kv-cyan)", values: values.RESTOCK_EMAIL_SENT },
    ];
  }
  return [
    { key: "added", label: "Products added", color: "var(--kv-violet)", values: values.WISHLIST_ADDED },
    { key: "users", label: "Unique users", color: "var(--kv-pink)", values: values.wishlistUsers },
    { key: "clicks", label: "Product clicks", color: "var(--kv-cyan)", values: values.WISHLIST_PRODUCT_CLICKED },
  ];
}

export function ActivitySwitch({ series, rangeLabel, initial = "wishlist" }) {
  const [view, setView] = useState(initial);
  const current = ACTIVITY_VIEWS.find((option) => option.key === view) ?? ACTIVITY_VIEWS[0];
  return (
    <div>
      <div className="kv-seg standalone" role="group" aria-label="Activity chart">
        {ACTIVITY_VIEWS.map((option) => (
          <button key={option.key} type="button" className={`kv-seg-btn${option.key === current.key ? " on" : ""}`} aria-pressed={option.key === current.key} onClick={() => setView(option.key)}>
            {option.label}
          </button>
        ))}
      </div>
      <ActivityChart label={`${current.label}, ${rangeLabel}`} days={series.days} series={chartSeries(current.key, series.values)} />
      <p className="kv-note" style={{ padding: "8px 0 0" }}>
        Daily counts, UTC days. {current.key === "wishlist" ? "“Unique users” counts different customers per day. " : ""}Days before the app started tracking this store are not shown.
      </p>
    </div>
  );
}
