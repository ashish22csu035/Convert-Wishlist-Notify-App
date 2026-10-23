/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { Children, useEffect, useRef, useState } from "react";
import { Link, isRouteErrorResponse, useNavigate, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { PAGE_SIZE, RANGE_DAYS } from "../utils/dashboard-constants";
import { formatNumber } from "../utils/format";
import { customPeriod, describePeriod } from "../utils/period";
import { WcField, WcSelect } from "./wc-fields";
import "../styles/merchant.css";

export { ToggleKpiCard } from "./toggle-kpi-card";

// Shared building blocks for the six merchant screens. Layout, cards and charts are styled in
// app/styles/merchant.css; controls (selects, buttons, badges, tables, banners) are Polaris web components.

export { ATTRIBUTION_FOOTNOTE, STATUS_HELP, WISHLIST_ITEM_MODES, attributionView, deltaOf, deliveryReason, formatDate, formatMoney, formatNumber, timeAgo, wishlistItemsView } from "../utils/format";

// ---------- Query-string driven controls ----------

// Builds a URL that keeps the current query string (Shopify's embedded params included) and changes
// only what is asked. A null/empty value removes the parameter.
export function useUrl() {
  const [params] = useSearchParams();
  return (updates) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined || value === "") next.delete(key);
      else next.set(key, String(value));
    }
    return `?${next.toString()}`;
  };
}

// A select that writes its choice into the URL (and so into the loader). Uses native events, see wc-fields.jsx.
export function ParamSelect({ label, param, value, options, reset = ["page"] }) {
  const navigate = useNavigate();
  const url = useUrl();
  return (
    <WcSelect
      label={label}
      labelAccessibilityVisibility="exclusive"
      value={value}
      options={options}
      onValue={(chosen) => {
        if (chosen === String(value)) return; // a repeat of the current choice does nothing
        navigate(url({ [param]: chosen, ...Object.fromEntries(reset.map((key) => [key, null])) }));
      }}
    />
  );
}

export const RANGE_OPTIONS = RANGE_DAYS.map((days) => [days, `Last ${days} days`]);

// The date-range control: the presets plus "Custom range" (two UTC days, both included). A preset applies at
// once. A custom range is checked here with the same rules the server uses (utils/period.js) and only applied
// when valid; the server checks it again, so a hand-edited URL cannot get past it. The chosen range is always
// written in words under the control, so the page says which days it is showing.
export function DateRange({ period }) {
  const navigate = useNavigate();
  const url = useUrl();
  const custom = period.kind === "custom";
  const [open, setOpen] = useState(custom || Boolean(period.error));
  const [from, setFrom] = useState(period.from ?? period.requested?.from ?? "");
  const [to, setTo] = useState(period.to ?? period.requested?.to ?? "");
  const [error, setError] = useState(period.error ?? null);

  const choose = (chosen) => {
    if (chosen === "custom") {
      setOpen(true);
      return;
    }
    setOpen(false);
    setError(null);
    if (!custom && chosen === String(period.days)) return; // a repeat of the current choice does nothing
    navigate(url({ days: chosen, range: null, from: null, to: null, page: null }));
  };
  const apply = () => {
    const result = customPeriod(from, to);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    navigate(url({ range: "custom", from: result.period.from, to: result.period.to, days: null, page: null }));
  };

  return (
    <>
      <div className="kv-range">
        <WcSelect label="Date range" labelAccessibilityVisibility="exclusive" value={custom ? "custom" : open ? "custom" : period.days} options={[...RANGE_OPTIONS, ["custom", "Custom range"]]} onValue={choose} />
      </div>
      {open ? (
        <form
          className="kv-range-custom"
          aria-label="Custom date range"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <label>
            <span>Start date (UTC)</span>
            <input type="date" name="from" value={from} onChange={(event) => setFrom(event.target.value)} aria-invalid={error ? "true" : undefined} />
          </label>
          <label>
            <span>End date (UTC)</span>
            <input type="date" name="to" value={to} onChange={(event) => setTo(event.target.value)} aria-invalid={error ? "true" : undefined} />
          </label>
          <button type="submit" className="kv-range-apply">
            Apply
          </button>
          {error ? (
            <p className="kv-range-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      {custom ? <p className="kv-range-note">Showing {describePeriod(period).label}</p> : null}
    </>
  );
}

export function Tabs({ tabs, active }) {
  const url = useUrl();
  return (
    <nav className="kv-tabs" aria-label="Sections">
      {tabs.map(([key, label]) => (
        <Link key={key} className="kv-tab" to={url({ tab: key, page: null })} aria-current={key === active ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function SearchBox({ value, placeholder }) {
  const navigate = useNavigate();
  const url = useUrl();
  const [text, setText] = useState(value ?? "");
  const submit = () => navigate(url({ q: text.trim(), page: null }));
  return (
    <>
      {/* Enter inside the field bubbles up out of its shadow DOM to this wrapper. The wrapper is not itself
          interactive: the field inside it is, and already supports keyboard, touch and tabbing. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="grow"
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      >
        <WcField as="s-search-field" label={placeholder} labelAccessibilityVisibility="exclusive" placeholder={placeholder} value={text} onValue={setText} />
      </div>
      <s-button onClick={submit}>Search</s-button>
      {value ? (
        <s-button
          variant="tertiary"
          onClick={() => {
            setText("");
            navigate(url({ q: null, page: null }));
          }}
        >
          Clear
        </s-button>
      ) : null}
    </>
  );
}

export function Pager({ page, total, noun }) {
  const url = useUrl();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  return (
    <div className="kv-pager">
      {page > 1 ? <Link to={url({ page: page - 1 })}>Previous</Link> : <span className="btn">Previous</span>}
      {page < pages ? <Link to={url({ page: page + 1 })}>Next</Link> : <span className="btn">Next</span>}
      <span>
        Showing {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)} {noun}
      </span>
    </div>
  );
}

// ---------- Layout ----------

export function Page({ title, subtitle, days, period, actions, children }) {
  const range = period ?? (days ? { kind: "preset", days } : null);
  return (
    <s-page heading={title} inlineSize="large">
      <div className="kv">
        <div className="kv-head">
          <p>{subtitle}</p>
          <div className="kv-head-actions">
            {actions}
            {range ? <DateRange period={range} /> : null}
          </div>
        </div>
        {children}
      </div>
    </s-page>
  );
}

export function Card({ title, action, flush, children }) {
  return (
    <section className="kv-card">
      {title ? (
        <div className="kv-card-head">
          <h3>{title}</h3>
          {action ? (
            <Link className="kv-link" to={action.to}>
              {action.label}
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className={`kv-card-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

// A row of metric cards. The card count picks the layout (kv-kpis nN in merchant.css), so any number of cards
// forms an aligned grid of equal columns with no gap beside the last card.
export function Grid({ children, two }) {
  const count = Children.toArray(children).filter(Boolean).length;
  return <div className={two ? "kv-grid two" : `kv-grid kv-kpis n${count}`}>{children}</div>;
}

export function Split({ children }) {
  return <div className="kv-split">{children}</div>;
}

// A metric tile. `value === null` means the figure is not available: it is labelled as such, never shown as 0.
export function KpiCard({ label, value, display, icon, tone = "violet", delta = null, days, note, hint }) {
  const unavailable = value === null || value === undefined;
  const headline = display ?? (unavailable ? "Unavailable" : formatNumber(value));
  const direction = delta === null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return (
    <div className={`kv-kpi ${unavailable ? "muted" : tone}`}>
      <div className="kv-kpi-top">
        <span className="kv-kpi-icon">
          <s-icon type={icon} />
        </span>
        {direction ? <span className={`kv-delta ${direction}`}>{direction === "up" ? "↑" : direction === "down" ? "↓" : "→"} {Math.abs(delta)}%</span> : null}
      </div>
      <div className={`kv-kpi-value${unavailable ? " na" : ""}`}>{headline}</div>
      <div className="kv-kpi-label">
        {label}
        <Hint label={label} text={hint} />
      </div>
      {direction && days ? <div className="kv-kpi-note">vs previous {days} days</div> : note ? <div className="kv-kpi-note">{note}</div> : null}
    </div>
  );
}

// A small info icon with a tooltip that explains what a figure means. The icon is the keyboard target.
export function Hint({ label, text }) {
  if (!text) return null;
  const id = `hint-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <>
      <button type="button" className="kv-hint" aria-label={`About ${label}: ${text}`} title={text}>
        <s-icon type="info" size="small" interestFor={id} />
      </button>
      <s-tooltip id={id}>{text}</s-tooltip>
    </>
  );
}

// An (i) button that opens a small panel of explanation. Keyboard operable (Enter/Space), announced with
// aria-expanded, closed with Escape, a click outside or the button again. `children` is the content.
export function InfoPopover({ label, children }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event) => {
      if (root.current && !root.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);
  const id = `info-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <span className="kv-info" ref={root}>
      <button type="button" className="kv-hint" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((on) => !on)}>
        <s-icon type="info" size="small" />
      </button>
      {open ? (
        <div className="kv-info-panel" id={id} role="note">
          {children}
        </div>
      ) : null}
    </span>
  );
}

export function EmptyState({ heading, children }) {
  return (
    <div className="kv-empty">
      <h4>{heading}</h4>
      <p>{children}</p>
    </div>
  );
}

export function NoShopState() {
  return (
    <Card>
      <EmptyState heading="No activity yet">Nothing has been recorded for this store. Data appears here once customers use Wishlist or Notify Me on the storefront.</EmptyState>
    </Card>
  );
}

export function ProductCell({ title, subtitle, imageUrl, href, fallback }) {
  const name = title || fallback;
  return (
    <div className="kv-product">
      <span className="kv-thumb">{imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <s-icon type="image" />}</span>
      <span className="kv-product-text">
        {href ? (
          <s-link href={href}>
            <span className="kv-product-title">{name}</span>
          </s-link>
        ) : (
          <span className="kv-product-title">{name}</span>
        )}
        {subtitle ? <span className="kv-product-sub">{subtitle}</span> : null}
      </span>
    </div>
  );
}

// ---------- Status and activity ----------

const STATUS = {
  ACTIVE: ["info", "Active"],
  FULFILLED: ["success", "Notified"],
  UNSUBSCRIBED: ["neutral", "Unsubscribed"],
  PENDING: ["info", "Queued"],
  SENDING: ["info", "Sending"],
  SENT: ["success", "Sent"],
  FAILED: ["critical", "Failed"],
  UNKNOWN: ["warning", "Unknown"],
  SKIPPED: ["neutral", "Skipped"],
};
export const statusLabel = (status) => STATUS[status]?.[1] ?? status;

export function StatusBadge({ status }) {
  const [tone, label] = STATUS[status] ?? ["neutral", status];
  return <s-badge tone={tone}>{label}</s-badge>;
}

export const EVENT = {
  WISHLIST_ADDED: { label: "Added to Wishlist", verb: "added", suffix: "to their Wishlist", icon: "heart", tone: "" },
  WISHLIST_REMOVED: { label: "Removed from Wishlist", verb: "removed", suffix: "from their Wishlist", icon: "heart", tone: "neutral" },
  WISHLIST_PRODUCT_CLICKED: { label: "Opened from Wishlist", verb: "opened", suffix: "from their Wishlist", icon: "product", tone: "blue" },
  NOTIFY_SUBSCRIBED: { label: "Subscribed to Notify Me", verb: "asked to be notified about", suffix: "", icon: "notification", tone: "blue" },
  NOTIFY_UNSUBSCRIBED: { label: "Unsubscribed from Notify Me", verb: "stopped notifications for", suffix: "", icon: "notification", tone: "neutral" },
  RESTOCK_EMAIL_SENT: { label: "Restock email sent", verb: "Restock email sent for", suffix: "", icon: "email", tone: "green" },
};

export function Feed({ items }) {
  return (
    <ul className="kv-feed">
      {items.map((item) => (
        <li key={item.id}>
          <span className={`kv-feed-icon ${item.tone}`}>
            <s-icon type={item.icon} />
          </span>
          <div className="kv-feed-text">
            <div>{item.text}</div>
            <div className="kv-feed-time">
              {item.label ? `${item.label} · ` : ""}
              {item.time}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// Route-level error boundary: auth redirects and Shopify headers still go through the app boundary.
export function MerchantErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && [401, 302, 303, 410].includes(error.status)) return boundary.error(error);
  return (
    <s-page heading="Something went wrong">
      <s-banner tone="critical" heading="This page could not be loaded">
        Try reloading the page. If the problem continues, check that the app server and database are running.
      </s-banner>
      <p>
        <s-button onClick={() => window.location.reload()}>Reload page</s-button>
      </p>
    </s-page>
  );
}
