/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */

// A small dependency-free line/area chart drawn as SVG. It only draws the numbers it is given:
// one value per day per series, from real counts. Nothing is smoothed, extrapolated or invented.

const W = 640;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 36 };

// 1, 2, 5 x 10^n at or above the largest value, so the axis ticks are round numbers.
export function niceMax(value) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) if (value <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
}

const monthDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// days: ["2026-10-01", ...]; series: [{ key, label, color, values: [number, ...] }]
export function ActivityChart({ days, series, label }) {
  const total = series.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0);
  if (days.length === 0 || total === 0) {
    return (
      <div className="kv-empty kv-chart-empty">
        <h4>No activity in this period</h4>
        <p>The chart fills in as customers use the app.</p>
      </div>
    );
  }
  const max = niceMax(Math.max(...series.flatMap((s) => s.values)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const summary = `${label}. ${series.map((s) => `${s.label}: ${s.values.reduce((a, b) => a + b, 0)} in total`).join("; ")}.`;

  return (
    <div>
      <div className="kv-legend" style={{ marginBottom: 8 }}>
        {series.map((s) => (
          <span key={s.key} style={{ "--dot": s.color }}>
            {s.label}
          </span>
        ))}
      </div>
      <div className="kv-chart-scroll">
      <svg className="kv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text x={PAD.left - 6} y={y(tick) + 3} textAnchor="end">
              {Number.isInteger(tick) ? tick : tick.toFixed(1)}
            </text>
          </g>
        ))}
        {days.map((day, i) =>
          i % labelEvery === 0 ? (
            <text key={day} x={x(i)} y={H - 8} textAnchor="middle">
              {monthDay(day)}
            </text>
          ) : null,
        )}
        {series.map((s) => {
          const line = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          const area = `${line} L${x(days.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
          return (
            <g key={s.key}>
              {days.length > 1 ? <path d={area} fill={s.color} opacity="0.1" /> : null}
              {days.length > 1 ? <path d={line} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null}
              {days.length <= 45
                ? s.values.map((v, i) => (
                    <circle key={days[i]} cx={x(i)} cy={y(v)} r={days.length === 1 ? 4 : 2.5} fill="var(--kv-surface)" stroke={s.color} strokeWidth="1.5">
                      <title>{`${monthDay(days[i])}: ${v} ${s.label.toLowerCase()}`}</title>
                    </circle>
                  ))
                : null}
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}
