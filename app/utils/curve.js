// Pure geometry for the Dashboard chart (no React): see components/activity-chart.jsx.

// A smooth curve through the points [[x, y], ...] (x ascending): a monotone cubic Hermite spline (Fritsch-Carlson, the same
// "monotone X" curve d3 draws). The curve passes through every point, and between two points it is monotone, so it can
// never overshoot a data value (no dip below zero after a spike). Returns the "M... C..." path data, "" for no points.
export function monotonePath(points) {
  const n = points.length;
  if (n === 0) return "";
  const fmt = (v) => Number(v.toFixed(1));
  if (n === 1) return `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push((points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    // A turning point (or a flat step) gets a flat tangent, which is what keeps peaks and zeros exact.
    tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (2 * slope[i - 1] * slope[i]) / (slope[i - 1] + slope[i]));
  }
  tangent.push(slope[n - 2]);
  // Fritsch-Carlson limit on each tangent so the curve stays within its two neighbouring values.
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      tangent[i] = (3 * a * slope[i]) / h;
      tangent[i + 1] = (3 * b * slope[i]) / h;
    }
  }
  let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const w = dx[i] / 3;
    d += ` C${fmt(x0 + w)},${fmt(y0 + tangent[i] * w)} ${fmt(x1 - w)},${fmt(y1 - tangent[i + 1] * w)} ${fmt(x1)},${fmt(y1)}`;
  }
  return d;
}
