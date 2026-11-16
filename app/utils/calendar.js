// Small date helpers for the date-range picker (components/merchant-ui.jsx DateRange). Days are "YYYY-MM-DD" strings in UTC,
// the same days the reports use (utils/period.js), so a string comparison is a date comparison.

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const dayDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const isoOf = (date) => date.toISOString().slice(0, 10);
export const todayIso = (now = new Date()) => isoOf(now);

// "2026-10-06" -> "Oct 6, 2026"; a range -> "Oct 6, 2026 – Oct 23, 2026"; nothing picked -> "Select a start date".
export const formatDay = (iso) => DAY.format(dayDate(iso));
export function formatSelection({ start, end }) {
  if (!start) return "Select a start date";
  if (!end) return `${formatDay(start)} – select an end date`;
  return `${formatDay(start)} – ${formatDay(end)}`;
}

export const monthOf = (iso) => iso.slice(0, 7); // "2026-10"
