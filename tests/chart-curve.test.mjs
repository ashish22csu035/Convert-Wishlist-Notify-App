// The Dashboard chart's smooth lines (app/utils/curve.js monotonePath): a monotone cubic through every real point.
//
// Run: node --test tests/chart-curve.test.mjs
import "./helpers/resolve-extensionless.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { monotonePath } from "../app/utils/curve.js";

// Parses "M x,y C a,b c,d x,y ..." into segments, and samples each cubic Bezier.
function parse(d) {
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  const start = [nums[0], nums[1]];
  const segments = [];
  let prev = start;
  for (let i = 2; i < nums.length; i += 6) {
    const seg = { p0: prev, c1: [nums[i], nums[i + 1]], c2: [nums[i + 2], nums[i + 3]], p1: [nums[i + 4], nums[i + 5]] };
    segments.push(seg);
    prev = seg.p1;
  }
  return { start, segments };
}
const bezierY = (s, t) => (1 - t) ** 3 * s.p0[1] + 3 * (1 - t) ** 2 * t * s.c1[1] + 3 * (1 - t) * t ** 2 * s.c2[1] + t ** 3 * s.p1[1];

const pts = (ys, step = 20) => ys.map((y, i) => [i * step, y]);

test("the curve passes through every real point, in order, and nothing else is added", () => {
  const points = pts([100, 60, 100, 100, 10, 90, 100]);
  const { start, segments } = parse(monotonePath(points));
  assert.deepEqual(start, points[0]);
  assert.equal(segments.length, points.length - 1);
  segments.forEach((s, i) => assert.deepEqual(s.p1, points[i + 1], `ends on point ${i + 1}`));
});

test("it never overshoots: between two days the line stays between their two values (a zero day stays on zero, a spike keeps its height)", () => {
  // y grows downward on screen; 100 = the zero baseline, 10 = the spike
  const points = pts([100, 100, 100, 10, 100, 100, 100]);
  const { segments } = parse(monotonePath(points));
  segments.forEach((s) => {
    const lo = Math.min(s.p0[1], s.p1[1]);
    const hi = Math.max(s.p0[1], s.p1[1]);
    for (let t = 0; t <= 1; t += 0.05) {
      const y = bezierY(s, t);
      assert.ok(y >= lo - 0.2 && y <= hi + 0.2, `y=${y} outside [${lo}, ${hi}]`);
    }
  });
});

test("flat runs stay perfectly flat, and a smooth ramp is curved rather than angular", () => {
  const flat = parse(monotonePath(pts([50, 50, 50, 50]))).segments;
  flat.forEach((s) => assert.equal(new Set([s.p0[1], s.c1[1], s.c2[1], s.p1[1]]).size, 1));
  const ramp = parse(monotonePath(pts([100, 80, 50, 40, 10]))).segments;
  assert.ok(ramp.some((s) => s.c1[1] !== s.p0[1] + (s.p1[1] - s.p0[1]) / 3), "not a straight line in disguise");
});

test("edge cases: no points, one point, two points", () => {
  assert.equal(monotonePath([]), "");
  assert.equal(monotonePath([[5, 7]]), "M5,7");
  const two = parse(monotonePath([[0, 10], [20, 30]]));
  assert.deepEqual(two.segments[0].p1, [20, 30]);
});

test("the chart draws one curve per series with real values, a single neutral fill under the first series only, and no hard-coded sample data", () => {
  const chart = fs.readFileSync("app/components/activity-chart.jsx", "utf8");
  assert.match(chart, /monotonePath\(s\.values\.map\(\(v, i\) => \[x\(i\), y\(v\)\]\)\)/, "the curve is built from the series' own values");
  assert.match(chart, /index === 0 \? <path d=\{area\}/, "the area is under the first series only");
  assert.equal((chart.match(/stopColor: "var\(--kv-primary\)"/g) ?? []).length, 2, "the wash fades the theme's black to nothing");
  const switchSource = fs.readFileSync("app/components/activity-switch.jsx", "utf8");
  assert.equal(/blue|violet(?!\))|purple/i.test(switchSource.replace(/--kv-(blue|violet)/g, "")), false);
  assert.match(switchSource, /Unique users", color: "var\(--kv-cyan\)"[\s\S]*Product clicks", color: "var\(--kv-pink\)"/, "second series medium grey, third lighter grey");
});
