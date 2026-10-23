// Date ranges for the merchant screens. Pure (no server or React imports), so the server and the browser
// agree and tests can run it directly.
//
// A period is whole UTC days, as everywhere else in the reports:
//   preset  "last N days" = today plus the N-1 days before it, up to now          (until = null)
//   custom  from..to, both days INCLUDED, in UTC                                    (until = the start of the day after `to`)
// Reports filter `occurredAt >= since` and, for a custom range, `< until`. A custom range never reaches
// past today: an end date in the future is cut back to today (nothing exists after now), and a start date in
// the future is refused.

import { DEFAULT_DAYS, RANGE_DAYS } from "./dashboard-constants.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_CUSTOM_DAYS = 366;
const EARLIEST = "2000-01-01";

export const startOfUtcDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const isoDay = (date) => date.toISOString().slice(0, 10);

// "2026-10-05" -> Date at 00:00 UTC, or null for anything that is not a real calendar day.
export function parseIsoDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || isoDay(date) !== value ? null : date;
}

export function presetPeriod(days = DEFAULT_DAYS, now = new Date()) {
  const n = RANGE_DAYS.includes(days) ? days : DEFAULT_DAYS;
  return { kind: "preset", days: n, since: new Date(startOfUtcDay(now).getTime() - (n - 1) * DAY_MS), until: null, from: null, to: null };
}

// Builds a custom period or explains why it cannot be one: { period } or { error }.
export function customPeriod(from, to, now = new Date()) {
  const start = parseIsoDay(from);
  const end = parseIsoDay(to);
  if (!start || !end) return { error: "Enter both dates as valid calendar days." };
  if (isoDay(start) < EARLIEST) return { error: "The start date is too far in the past." };
  const today = startOfUtcDay(now);
  if (start.getTime() > today.getTime()) return { error: "The start date cannot be in the future." };
  if (end.getTime() < start.getTime()) return { error: "The end date cannot be before the start date." };
  const last = end.getTime() > today.getTime() ? today : end; // nothing exists after today
  const days = Math.round((last.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days > MAX_CUSTOM_DAYS) return { error: `Choose a range of at most ${MAX_CUSTOM_DAYS} days.` };
  return { period: { kind: "custom", days, since: start, until: new Date(last.getTime() + DAY_MS), from: isoDay(start), to: isoDay(last) } };
}

// From URL search params (`range=custom&from=..&to=..` or `days=30`). A bad custom range falls back to the
// default preset and carries `error` so the screen can say why.
export function parsePeriod(params, now = new Date()) {
  const get = (name) => (typeof params?.get === "function" ? params.get(name) : params?.[name]);
  if (get("range") === "custom") {
    const result = customPeriod(get("from"), get("to"), now);
    if (result.period) return result.period;
    return { ...presetPeriod(DEFAULT_DAYS, now), error: result.error, requested: { from: get("from") ?? "", to: get("to") ?? "" } };
  }
  const days = Number(get("days"));
  return presetPeriod(RANGE_DAYS.includes(days) ? days : DEFAULT_DAYS, now);
}

// Accepts what the reports are called with: a number of days (a preset) or a period from the functions above.
export function resolvePeriod(input, now = new Date()) {
  if (input && typeof input === "object" && input.since instanceof Date) return input;
  return presetPeriod(typeof input === "number" ? input : DEFAULT_DAYS, now);
}

// The period straight before this one, of the same length (for "vs previous" comparisons).
export function previousOf(period) {
  const length = period.days * DAY_MS;
  return { since: new Date(period.since.getTime() - length), until: period.since };
}

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const FULL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// Wording for the screens. `label` names the period, `within` finishes a sentence ("... in the last 30 days").
export function describePeriod(period) {
  if (period.kind === "custom") {
    const start = new Date(`${period.from}T00:00:00Z`);
    const end = new Date(`${period.to}T00:00:00Z`);
    const label = period.from === period.to ? FULL.format(start) : `${start.getUTCFullYear() === end.getUTCFullYear() ? SHORT.format(start) : FULL.format(start)} – ${FULL.format(end)}`;
    return { label: `${label} (UTC)`, within: `from ${label} (UTC)`, previous: `the ${period.days} days before` };
  }
  return { label: `Last ${period.days} days`, within: `in the last ${period.days} days`, previous: `previous ${period.days} days` };
}

// The plain data a screen needs: no Dates, so it serialises the same on the server and in the browser.
// `error` is set when a custom range in the URL was refused and the default preset is shown instead.
export function periodView(period) {
  return { kind: period.kind, days: period.days, from: period.from ?? null, to: period.to ?? null, error: period.error ?? null, requested: period.requested ?? null };
}
