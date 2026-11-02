/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WEEKDAYS, formatSelection, longDay, monthGrid, monthLabel, monthOf, pickDay, rangeState, shiftMonth, todayIso } from "../utils/calendar";
import { customPeriod } from "../utils/period";

const GAP = 6; // between the selector and the calendar
const MARGIN = 8; // kept free at the viewport edge

// Where the calendar goes: straight below its selector, right edges aligned (the selector sits at the right of the page
// header), pulled back inside the viewport; above the selector when there is no room below and more room above.
export function popoverPosition(anchor, size, viewport) {
  const width = Math.min(size.width, viewport.width - 2 * MARGIN);
  const left = Math.max(MARGIN, Math.min(anchor.right - width, viewport.width - width - MARGIN));
  const below = anchor.bottom + GAP;
  const fitsBelow = below + size.height <= viewport.height - MARGIN;
  const above = anchor.top - GAP - size.height;
  const top = fitsBelow || above < MARGIN ? Math.max(MARGIN, Math.min(below, viewport.height - size.height - MARGIN)) : above;
  return { left, top };
}

// A single-month calendar for choosing a custom date range (UTC days, both included), shown as a floating popover under
// the selector it belongs to. It is portalled to <body> and fixed-positioned, so it takes no room in the page and no
// parent's overflow can clip it. The choice is a draft until Apply: Cancel, Escape and a click outside throw it away.
// Apply is checked with the same rules the server uses (customPeriod) and hands back the cleaned { from, to }.
export function RangeCalendar({ anchorRef, initial, notice = null, onApply, onCancel }) {
  const today = todayIso();
  const [selection, setSelection] = useState({ start: initial?.from ?? null, end: initial?.to ?? null });
  const [month, setMonth] = useState(monthOf(initial?.to ?? initial?.from ?? today));
  const [error, setError] = useState(notice);
  const [mounted, setMounted] = useState(false); // the server has no document to portal into
  const [position, setPosition] = useState(null);
  const root = useRef(null);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!mounted) return undefined;
    const place = () => {
      const node = root.current;
      const anchor = anchorRef?.current;
      if (!node || !anchor) return;
      const box = anchor.getBoundingClientRect();
      const size = { width: node.offsetWidth || 320, height: node.offsetHeight || 0 };
      setPosition(popoverPosition(box, size, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true); // any scrolling ancestor, so it stays attached to the selector
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [mounted, anchorRef, month, error]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onCancel();
    };
    const onPointer = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      if (path.includes(root.current) || (anchorRef?.current && path.includes(anchorRef.current))) return; // inside, or on the selector itself
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [onCancel, anchorRef]);

  useEffect(() => {
    if (mounted) root.current?.focus({ preventScroll: true });
  }, [mounted]);

  if (!mounted) return null;

  const complete = Boolean(selection.start && selection.end);
  const apply = () => {
    const result = customPeriod(selection.start, selection.end);
    if (result.error) {
      setError(result.error);
      return;
    }
    onApply({ from: result.period.from, to: result.period.to });
  };
  const pick = (iso) => {
    setError(null);
    setSelection((current) => pickDay(current, iso));
  };

  return createPortal(
    <div className="kv kv-pop-root">
      <div
        className="kv-cal"
        role="dialog"
        aria-label="Custom date range"
        tabIndex={-1}
        ref={root}
        style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: "hidden" }}
      >
        <p className="kv-cal-summary" aria-live="polite" data-testid="cal-summary">
          {formatSelection(selection)}
        </p>
        <div className="kv-cal-head">
          <button type="button" className="kv-cal-nav" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            ‹
          </button>
          <strong aria-live="polite" data-testid="cal-month">
            {monthLabel(month)}
          </strong>
          <button type="button" className="kv-cal-nav" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            ›
          </button>
        </div>
        <div className="kv-cal-grid" role="grid" aria-label={monthLabel(month)}>
          {WEEKDAYS.map((name) => (
            <span key={name} className="kv-cal-weekday" aria-hidden="true">
              {name}
            </span>
          ))}
          {monthGrid(month).map(({ iso, inMonth }) => {
            const { edge, inside } = rangeState(selection, iso);
            const disabled = iso > today || iso < "2000-01-01";
            const classes = ["kv-cal-day", !inMonth ? "muted" : "", edge ? "edge" : "", inside ? "inside" : "", iso === today ? "today" : ""].filter(Boolean).join(" ");
            return (
              <button key={iso} type="button" className={classes} data-day={iso} aria-label={longDay(iso)} aria-pressed={edge || inside} disabled={disabled} onClick={() => pick(iso)}>
                {Number(iso.slice(8))}
              </button>
            );
          })}
        </div>
        {error ? (
          <p className="kv-range-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="kv-cal-actions">
          <button type="button" className="kv-cal-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="kv-range-apply" disabled={!complete} onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
