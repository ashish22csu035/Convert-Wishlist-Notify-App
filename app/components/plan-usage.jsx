/* eslint-disable react/prop-types -- plain JavaScript project: small local helper components are not given PropTypes */
import { Card, Grid, KpiCard, formatDate, formatNumber } from "./merchant-ui";

// The Pricing page body (/app/plan): the recommendation, the three plans, the merchant's usage and subscription details, and Manage plan.
// It only DISPLAYS the view built on the server (app/models/plan-usage.server.js): no billing rule, plan limit or recommendation rule lives here.
// A figure that is not known is shown as "Unavailable" or "Not available yet", never as 0 and never as a guess. Nothing on this page changes
// the merchant's plan: plan changes happen only on Shopify's own page, reached through the Manage plan route.

const date = (value) => (value ? formatDate(value) : null);

const STATUS_NOTE = {
  verified: "Confirmed with Shopify",
  free: "Free plan",
  trial: "Trial: Basic limits for now",
  inactive: "No longer active",
  pending: "Waiting for approval",
  temporary: "Could not be confirmed right now",
  unavailable: "Unavailable",
};

// The state of the subscription CHECK (separate from the plan): see verificationCheckState in plan-usage.server.js.
const CHECK_NOTE = {
  verified: "Confirmed with Shopify",
  pending: "Waiting for the first check with Shopify",
  temporary_failure: "Could not be completed just now: your plan is unchanged and we will try again",
  stale: "The last check is out of date: checking again",
  not_checked: "Not available yet",
};

function Row({ label, children }) {
  return (
    <s-table-row>
      <s-table-cell>{label}</s-table-cell>
      <s-table-cell>{children}</s-table-cell>
    </s-table-row>
  );
}

const emailLine = (plan) =>
  plan.restockEmails.period === "billing_period"
    ? `${formatNumber(plan.restockEmails.quota)} restock emails per billing period`
    : `${formatNumber(plan.restockEmails.quota)} restock emails in total while you use ${plan.label}`;

// ---------- the recommendation, above the plans ----------
function Recommendation({ view }) {
  const { recommendation, plans, plan: current } = view;
  const labelOf = (key) => plans.find((item) => item.key === key)?.label ?? key;
  return (
    <section className="kv-card kv-reco" data-testid="plan-recommendation" data-state={recommendation.state}>
      <div className="kv-card-head">
        <h3>Recommended for your store</h3>
      </div>
      <div className="kv-card-body">
        {recommendation.state === "ready" ? (
          <>
            <p className="kv-reco-lead">{`Based on your store's activity over the past 30 days, we recommend the ${labelOf(recommendation.plan)} plan.`}</p>
            {current && current.key === recommendation.plan ? <p className="kv-reco-match">You are already on the recommended plan.</p> : null}
            <p className="kv-reco-fine">{`Updated ${date(recommendation.updatedAt)}. This is only a suggestion: your plan does not change unless you choose a plan on Shopify.`}</p>
          </>
        ) : recommendation.state === "gathering" ? (
          <p className="kv-reco-lead">We&apos;re still gathering your store&apos;s analytics to recommend the best plan. You can compare all plans below.</p>
        ) : (
          <p className="kv-reco-lead">We couldn&apos;t gather your store&apos;s analytics yet, so there is no recommendation right now. You can compare all plans below.</p>
        )}
      </div>
    </section>
  );
}

// ---------- the three plans ----------
function PlanCard({ plan, current, recommended, manage }) {
  const price = !plan.paid ? "Free" : plan.price ?? (manage.available ? "Price shown on Shopify's plan page" : "Pricing not available yet");
  return (
    <section className={`kv-card kv-plan${current ? " current" : ""}${recommended ? " recommended" : ""}`} data-plan={plan.key} data-current={current ? "true" : "false"} data-recommended={recommended ? "true" : "false"}>
      <div className="kv-plan-top">
        <h3>{plan.label}</h3>
        <span className="kv-plan-badges">
          {current ? <s-badge tone="info">Current plan</s-badge> : null}
          {recommended ? <s-badge tone="success">Recommended</s-badge> : null}
        </span>
      </div>
      <div className={`kv-plan-price${plan.paid && !plan.price ? " muted" : ""}`} data-testid={`plan-price-${plan.key}`}>
        {price}
      </div>
      <ul className="kv-plan-features">
        <li>{`Up to ${formatNumber(plan.wishlistItems)} active wishlist items across your whole store`}</li>
        <li>{emailLine(plan)}</li>
        <li>{`${formatNumber(plan.analyticsHistoryDays)} days of analytics`}</li>
      </ul>
      {!current && manage.available ? (
        <s-button href="/app/manage-plan" variant={recommended ? "primary" : "secondary"} data-testid={`choose-${plan.key}`}>
          Choose on Shopify
        </s-button>
      ) : null}
    </section>
  );
}

function Plans({ view }) {
  const currentKey = view.plan?.key ?? null;
  return (
    <div className="kv-plans" data-testid="plan-cards">
      {view.plans.map((plan) => (
        <PlanCard key={plan.key} plan={plan} current={plan.key === currentKey} recommended={view.recommendation.state === "ready" && plan.key === view.recommendation.plan} manage={view.manage} />
      ))}
    </div>
  );
}

function Comparison({ plans }) {
  return (
    <Card title="Compare plans">
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Feature</s-table-header>
          {plans.map((plan) => (
            <s-table-header key={plan.key}>{plan.label}</s-table-header>
          ))}
        </s-table-header-row>
        <s-table-body>
          <s-table-row>
            <s-table-cell>Active wishlist items (whole store)</s-table-cell>
            {plans.map((plan) => (
              <s-table-cell key={plan.key}>{formatNumber(plan.wishlistItems)}</s-table-cell>
            ))}
          </s-table-row>
          <s-table-row>
            <s-table-cell>Restock emails</s-table-cell>
            {plans.map((plan) => (
              <s-table-cell key={plan.key}>{plan.restockEmails.period === "billing_period" ? `${formatNumber(plan.restockEmails.quota)} per billing period` : `${formatNumber(plan.restockEmails.quota)} in total`}</s-table-cell>
            ))}
          </s-table-row>
          <s-table-row>
            <s-table-cell>Analytics history</s-table-cell>
            {plans.map((plan) => (
              <s-table-cell key={plan.key}>{`${formatNumber(plan.analyticsHistoryDays)} days`}</s-table-cell>
            ))}
          </s-table-row>
        </s-table-body>
      </s-table>
    </Card>
  );
}

export function PlanUsage({ view }) {
  const { status, plan, email, wishlist, trial, cancellation, verification, warning, manage, period } = view;
  const emailNote = !email
    ? undefined
    : email.scope === "billing_period"
      ? email.resetsAt
        ? `Resets ${date(email.resetsAt)}`
        : "Reset date not available until your billing period is confirmed"
      : "Basic's allowance does not reset on a schedule";
  return (
    <>
      {warning ? (
        <s-banner tone={warning.tone} heading={warning.title} data-testid="plan-warning">
          {warning.message}
        </s-banner>
      ) : null}

      {!manage.available ? (
        <s-banner tone="info" heading="Plan changes are not configured yet" data-testid="manage-plan-unconfigured">
          {plan && plan.verifiedPaid
            ? "Choosing or changing a plan from this page is not set up yet. Your current plan is unchanged."
            : "Paid plans can't be purchased from this page yet. Your store stays on the free Basic plan until plan selection is set up. Nothing is charged."}
        </s-banner>
      ) : null}

      <Recommendation view={view} />
      <Plans view={view} />

      <Grid>
        <KpiCard label="Current plan" display={plan ? plan.label : "Unavailable"} value={plan ? 1 : null} icon="check-circle" tone="violet" note={STATUS_NOTE[status]} hint="The plan Shopify has confirmed for your store. If it cannot be confirmed, Basic limits apply for now." />
        <KpiCard
          label="Restock emails"
          value={email ? email.used : null}
          display={email ? `${formatNumber(email.used)} of ${formatNumber(email.quota)}` : undefined}
          icon="email"
          tone="violet"
          note={emailNote}
          hint="Restock emails sent, or being sent, under your current plan. Emails sent under another plan are counted against that plan."
        />
        <KpiCard
          label="Wishlist items"
          value={wishlist ? wishlist.used : null}
          display={wishlist ? `${formatNumber(wishlist.used)} of ${formatNumber(wishlist.limit)}` : undefined}
          icon="heart"
          tone="violet"
          note={wishlist ? (wishlist.overLimit ? "Over this plan's limit: existing items are kept" : "Active items across all your customers") : undefined}
          hint="All active wishlist items of every customer in your store, together."
        />
      </Grid>
      {!view.limitsEnforced && plan ? <p className="kv-note">Plan limits are shown for information and are not being enforced yet.</p> : null}

      <Comparison plans={view.plans} />

      <Card title="Subscription">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Detail</s-table-header>
            <s-table-header>Value</s-table-header>
          </s-table-header-row>
          <s-table-body>
            <Row label="Plan status">{STATUS_NOTE[status]}</Row>
            {view.lastConfirmedPlan ? <Row label="Last confirmed plan">{view.lastConfirmedPlan}</Row> : null}
            {trial ? <Row label="Trial">{`${trial.planLabel} trial ends ${date(trial.endsAt)}`}</Row> : null}
            {cancellation ? <Row label="Cancellation">{`Will cancel at the end of the billing period, ${date(cancellation.effectiveAt)}`}</Row> : null}
            {period ? <Row label="Billing period">{`${date(period.start)} to ${date(period.end)}`}</Row> : null}
            {verification.check ? <Row label="Subscription check">{CHECK_NOTE[verification.check]}</Row> : null}
            <Row label="Last confirmed with Shopify">{date(verification.lastVerifiedAt) ?? "Not confirmed yet"}</Row>
            {verification.checkingAgainAt ? <Row label="Checking again">{`Around ${date(verification.checkingAgainAt)}`}</Row> : null}
          </s-table-body>
        </s-table>
      </Card>

      <Card title="Manage your plan">
        {manage.available ? (
          <>
            <p className="kv-note">Shopify hosts the plan selection and approval page. You will leave this app to choose or change a plan.</p>
            <s-button href="/app/manage-plan" variant="primary" data-testid="manage-plan">
              Manage plan
            </s-button>
          </>
        ) : (
          <p className="kv-note" data-testid="manage-plan-unavailable">
            Plan changes are not configured yet. You can compare the plans above, but they cannot be purchased from this page until plan selection is set up.
          </p>
        )}
      </Card>
    </>
  );
}
