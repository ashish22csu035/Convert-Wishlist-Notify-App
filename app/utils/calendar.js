// Pure helpers for the single-month range calendar (components/range-calendar.jsx). Days are "YYYY-MM-DD" strings in
// UTC, the same days the reports use (utils/period.js), so a string comparison is a date comparison.

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dayDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const isoOf = (date) => date.toISOString().slice(0, 10);
export const todayIso = (now = new Date()) => isoOf(now);

// "2026-10-06" -> "Oct 6, 2026"; a range -> "Oct 6, 2026 – Oct 23, 2026"; nothing picked -> "Select a start date".
export const formatDay = (iso) => DAY.format(dayDate(iso));
export const longDay = (iso) => WEEKDAY.format(dayDate(iso));
export function formatSelection({ start, end }) {
  if (!start) return "Select a start date";
  if (!end) return `${formatDay(start)} – select an end date`;
  return `${formatDay(start)} – ${formatDay(end)}`;
}

export const monthLabel = (month) => MONTH.format(dayDate(`${month}-01`)); // month = "2026-10"
export const monthOf = (iso) => iso.slice(0, 7);
export function shiftMonth(month, by) {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, m - 1 + by, 1));
  return isoOf(date).slice(0, 7);
}

// The weeks of a month, Sunday first, always six rows so the calendar does not change height. Days of the neighbouring
// months are included (muted) so every week is complete.
export function monthGrid(month) {
  const first = dayDate(`${month}-01`);
  const gridStart = new Date(first.getTime() - first.getUTCDay() * 86400000);
  return Array.from({ length: 42 }, (_, i) => {
    const iso = isoOf(new Date(gridStart.getTime() + i * 86400000));
    return { iso, inMonth: monthOf(iso) === month };
  });
}

// One click on a day. No start yet, or a finished range: this day starts a new range. A start without an end: a later
// (or the same) day ends it; an EARLIER day restarts the selection from that day, so the range is always in order.
export function pickDay(selection, iso) {
  if (!selection.start || selection.end) return { start: iso, end: null };
  if (iso < selection.start) return { start: iso, end: null };
  return { start: selection.start, end: iso };
}

export const rangeState = ({ start, end }, iso) => ({
  edge: iso === start || iso === end,
  inside: Boolean(start && end && iso > start && iso < end),
});
