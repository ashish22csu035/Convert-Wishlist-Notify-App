/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useState } from "react";
import { longDay } from "./activity-chart";

// The Dashboard's one chart: what the app brought in, day by day, in two stacked bars (Wishlist and Notify Me), with a small
// "Interest" view (saves and sign-ups) for the weeks before the first attributed order. It draws only the numbers it is given:
// the revenue bars come from the same attributed orders as the revenue card (reporting.dailyRevenue), so they always add up
// to it. Hovering, touching or arrowing through a day shows that day's exact values. Colours are the theme's tokens only.
//
//   revenue   { days, wishlist: [$], notifyMe: [$], orders: [n], total, ordersTotal, currency, mixedCurrency }
//   interest  { days, wishlist: [saves], notifyMe: [sign-ups] }
//   revenueAvailable  false when orders cannot be read yet (no permission, nothing received) or currencies are mixed

const W = 640;
const H = 236;
const PAD = { top: 14, right: 8, bottom: 28, left: 46 };
const FEATURES = [
  { key: "wishlist", label: "Wishlist", color: "var(--kv-primary)" },
  { key: "notifyMe", label: "Notify Me", color: "var(--kv-pink)" },
];

const monthDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const sum = (values) => values.reduce((a, b) => a + b, 0);
const plural = (n, one, many = `${one}s`) => `${new Intl.NumberFormat("en-US").format(n)} ${n === 1 ? one : many}`;

export const money = (value, currency, compact = false) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", ...(compact ? { notation: "compact", maximumFractionDigits: 1 } : {}) }).format(value);
  } catch {
    return `${currency ?? ""} ${value.toFixed(2)}`.trim();
  }
};

// Four round steps from 0 up to at or above the largest value. Money may use steps such as 120 or 300; counts only whole numbers.
const MONEY_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
export function niceScale(value, integer = false) {
  if (!(value > 0) || (integer && value <= 4)) return { max: 4, step: 1 };
  const raw = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const candidates = MONEY_STEPS.map((m) => Math.round(m * magnitude * 100) / 100).filter((step) => !integer || Number.isInteger(step));
  const step = candidates.find((candidate) => raw <= candidate + 1e-9) ?? magnitude * 10;
  return { max: step * 4, step };
}

// A bar with only its top corners rounded.
function barPath(x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

function Bars({ days, a, b, format, axisFormat, integer, extra, summary }) {
  const [hover, setHover] = useState(null);
  const totals = days.map((_, i) => a.values[i] + b.values[i]);
  const { max, step } = niceScale(Math.max(...totals), integer);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / days.length;
  const barW = Math.max(2, Math.min(slot * 0.56, 26));
  const cx = (i) => PAD.left + slot * (i + 0.5);
  const y = (v) => PAD.top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const shown = hover !== null && hover < days.length ? hover : null;
  const move = (delta) => setHover((current) => (current === null ? (delta > 0 ? 0 : days.length - 1) : Math.min(days.length - 1, Math.max(0, current + delta))));
  const onKeyDown = (event) => {
    if (event.key === "ArrowRight") move(1);
    else if (event.key === "ArrowLeft") move(-1);
    else if (event.key === "Home") setHover(0);
    else if (event.key === "End") setHover(days.length - 1);
    else if (event.key === "Escape") setHover(null);
    else return;
    event.preventDefault();
  };
  const flip = shown !== null && cx(shown) > PAD.left + plotW / 2;

  return (
    <div className="kv-chart-scroll">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- a chart region read with the arrow keys; the tooltip is announced as a status */}
      <div className="kv-chart-wrap" role="group" tabIndex={0} aria-label={`${summary} Use the left and right arrow keys to read each day.`} onKeyDown={onKeyDown} onFocus={() => setHover((current) => current ?? days.length - 1)} onBlur={() => setHover(null)} onMouseLeave={() => setHover(null)}>
        <svg className="kv-chart kv-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(step * i)} y2={y(step * i)} />
              <text x={PAD.left - 8} y={y(step * i) + 3} textAnchor="end">
                {axisFormat(step * i)}
              </text>
            </g>
          ))}
          {days.map((day, i) =>
            i % labelEvery === 0 ? (
              <text key={day} x={cx(i)} y={H - 9} textAnchor="middle">
                {monthDay(day)}
              </text>
            ) : null,
          )}
          {shown !== null ? <rect className="kv-bars-band" x={PAD.left + slot * shown} y={PAD.top} width={slot} height={plotH} rx="6" /> : null}
          {days.map((day, i) => {
            const hA = (a.values[i] / max) * plotH;
            const hB = (b.values[i] / max) * plotH;
            const x = cx(i) - barW / 2;
            const dim = shown !== null && shown !== i;
            return (
              <g key={day} className={dim ? "kv-bars-bar dim" : "kv-bars-bar"}>
                {hA > 0 ? <path d={barPath(x, y(a.values[i]), barW, hA, hB > 0 ? 0 : 3)} fill={a.color} /> : null}
                {hB > 0 ? <path d={barPath(x, y(a.values[i] + b.values[i]), barW, hB, 3)} fill={b.color} /> : null}
              </g>
            );
          })}
          {days.map((day, i) => (
            <rect key={day} className="hit" data-day={day} x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onMouseMove={() => setHover(i)} onTouchStart={() => setHover(i)} />
          ))}
        </svg>
        {shown !== null ? (
          <div className={`kv-tooltip${flip ? " left" : ""}`} role="status" data-testid="chart-tooltip" style={{ left: `${(cx(shown) / W) * 100}%` }}>
            <div className="kv-tooltip-date">{longDay(days[shown])}</div>
            <ul>
              {[a, b].map((s) => (
                <li key={s.key} style={{ "--dot": s.color }}>
                  <span className="kv-tooltip-name">{s.label}</span>
                  <strong>{format(s.values[shown])}</strong>
                </li>
              ))}
              {extra ? (
                <li style={{ "--dot": "transparent" }}>
                  <span className="kv-tooltip-name">{extra.label}</span>
                  <strong>{extra.values[shown]}</strong>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DashboardChart({ revenue, interest, revenueAvailable = true, rangeLabel }) {
  const canShowRevenue = Boolean(revenueAvailable) && !revenue.mixedCurrency;
  const [view, setView] = useState(canShowRevenue && revenue.total > 0 ? "revenue" : "interest");
  const current = canShowRevenue ? view : "interest";
  const isRevenue = current === "revenue";
  const data = isRevenue ? revenue : interest;
  const names = isRevenue ? { wishlist: "Wishlist", notifyMe: "Notify Me" } : { wishlist: "Wishlist saves", notifyMe: "Notify Me requests" };
  const [first, second] = FEATURES.map((feature) => ({ ...feature, label: names[feature.key], values: data[feature.key] }));
  const format = isRevenue ? (v) => money(v, revenue.currency) : (v) => new Intl.NumberFormat("en-US").format(v);
  const axisFormat = isRevenue ? (v) => money(v, revenue.currency, true).replace(/\.0(?=[A-Za-z]|$)/, "") : (v) => String(Math.round(v));
  const headline = isRevenue ? money(revenue.total, revenue.currency) : new Intl.NumberFormat("en-US").format(sum(interest.wishlist) + sum(interest.notifyMe));
  const detail = isRevenue
    ? `${plural(revenue.ordersTotal, "order")} · ${rangeLabel}`
    : `${plural(sum(interest.wishlist), "Wishlist save")} · ${plural(sum(interest.notifyMe), "Notify Me request")} · ${rangeLabel}`;
  const summary = isRevenue
    ? `Revenue from Wishlist and Notify Me, ${rangeLabel}: ${headline} from ${plural(revenue.ordersTotal, "order")}.`
    : `Wishlist saves and Notify Me requests, ${rangeLabel}: ${plural(sum(interest.wishlist), "save")} and ${plural(sum(interest.notifyMe), "request")}.`;

  return (
    <div className="kv-dchart">
      <div className="kv-dchart-head">
        <div>
          <div className="kv-dchart-title">{isRevenue ? "Revenue from Wishlist and Notify Me" : "Customer interest"}</div>
          <div className="kv-dchart-total" data-testid="chart-total">{headline}</div>
          <div className="kv-dchart-sub">{detail}</div>
        </div>
        {canShowRevenue ? (
          <div className="kv-seg standalone" role="group" aria-label="Chart view">
            {[["revenue", "Revenue"], ["interest", "Interest"]].map(([key, label]) => (
              <button key={key} type="button" className={`kv-seg-btn${key === current ? " on" : ""}`} aria-pressed={key === current} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="kv-legend" style={{ marginBottom: 8 }}>
        {[first, second].map((s) => (
          <span key={s.key} style={{ "--dot": s.color }}>
            {s.label}
          </span>
        ))}
      </div>
      <Bars days={data.days} a={first} b={second} format={format} axisFormat={axisFormat} integer={!isRevenue} summary={summary} extra={isRevenue ? { label: "Orders", values: revenue.orders } : null} />
    </div>
  );
}
