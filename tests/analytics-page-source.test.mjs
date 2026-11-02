// Source-level checks of the Analytics page (no database): the neutral refresh notice replaces the "being prepared" banner,
// and the percentage-change badges are gone from the KPI cards.
// Run: node --test tests/analytics-page-source.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { formatUpdatedAt } from "../app/utils/format.js";

const source = fs.readFileSync("app/routes/app.analytics.jsx", "utf8");

test("the preparation banner is replaced by one neutral notice that matches the worker schedule", () => {
  for (const gone of ["still being prepared", "Daily summaries are ready for", "availableDays", "expectedDays", "preparing", "Waiting for daily summaries"]) assert.equal(source.includes(gone), false, gone);
  assert.equal((source.match(/Analytics refresh approximately every 10 minutes\./g) ?? []).length, 1);
  assert.match(fs.readFileSync("app/worker/cron.js", "utf8"), /10 \* 60 \* 1000/, "the scheduler really starts the worker every 10 minutes");
});

test("no KPI card on the Analytics page gets a percentage-change badge", () => {
  assert.equal(/delta=|deltaOf/.test(source), false);
  assert.equal(/<KpiCard[^>]*\bprevious\b/.test(source), false);
  assert.ok((source.match(/<KpiCard /g) ?? []).length >= 6, "the metric cards themselves are still there");
});

test("a session card with no usable data says so instead of showing a number", () => {
  assert.match(source, /sessionActivity\.wishlist\.current === null \? "No session data for this range yet"/);
  assert.match(source, /sessionActivity\.notifyMe\.current === null \? "No session data for this range yet"/);
});


test("Last updated sits inside the existing notice, under the 10-minute message, and says Not available yet without a time", () => {
  assert.match(source, /<s-banner tone="info">\s*Analytics refresh approximately every 10 minutes\.\s*<p className="kv-refresh-meta" data-testid="analytics-updated">\s*Last updated: \{formatUpdatedAt\(a\.lastUpdated\) \?\? "Not available yet"\}/);
  assert.equal(/new Date\(\)|Date\.now\(\)/.test(source), false, "the page never shows its own clock as the update time");
  assert.match(fs.readFileSync("app/styles/merchant.css", "utf8"), /\.kv-refresh-meta \{[^}]*color: var\(--kv-subdued\)/);
});

test("formatUpdatedAt: readable, always UTC like the rest of the app, the same on server and browser", () => {
  assert.equal(formatUpdatedAt("2026-11-02T11:40:00.000Z"), "November 2, 2026 at 11:40 AM UTC");
  assert.equal(formatUpdatedAt("2026-11-02T00:05:00.000Z"), "November 2, 2026 at 12:05 AM UTC");
  assert.equal(formatUpdatedAt("2026-11-02T13:07:00.000Z"), "November 2, 2026 at 1:07 PM UTC");
  assert.equal(formatUpdatedAt("2026-11-02T23:30:00+05:30"), "November 2, 2026 at 6:00 PM UTC", "an offset time is shown in UTC");
  assert.equal(formatUpdatedAt("2026-12-31T23:59:00.000Z"), "December 31, 2026 at 11:59 PM UTC", "no day rolls over to another zone");
  for (const missing of [null, undefined, "", "not a date"]) assert.equal(formatUpdatedAt(missing), null, String(missing));
});
