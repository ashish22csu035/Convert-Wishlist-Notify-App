import prisma from "../db.server";
import { getEntitlements, resolveEntitlements } from "./entitlements.server";
import { wakeQuotaBlocked } from "./email-quota.server";
import { VERIFIED_SOURCES, getPlan } from "./plans.server";
import { ensureShopSubscription } from "./shop-lock.server";

export { ensureShopSubscription };

// Keeps ShopSubscription honest: asks an INJECTED verifier what the merchant's subscription really is, and records the answer.
// Nothing here talks to Shopify. The verifier is a function supplied by the (future) billing integration, so the whole life cycle is
// testable with fixtures:
//
//   verify({ shop: { id, domain }, subscription, signal })  ->  one of
//     { outcome: "active",   plan: "ADVANCE" | "ENTERPRISE", periodStart, periodEnd, source, shopifySubscriptionGid?, planHandle? }
//     { outcome: "trial",  plan: "ADVANCE" | "ENTERPRISE", trialEndsAt, source, ... }   a paid plan still in trial: Shopify reports no billing cycle yet
//     { outcome: "none" }                                        authoritative: there is no active subscription
//     { outcome: "inactive", status: "CANCELLED" | "FROZEN" | "EXPIRED" }   authoritative
//     { outcome: "error",    kind: "transient" | "permission" | "config", code }   (a thrown error counts as transient, or error.kind)
//
// What each answer does to the stored row:
//   active       the plan, ACTIVE, the verified period and source, verifiedAt = now; retry counters reset; the next check is due at the
//                EARLIER of 12 hours from now and the end of the period (so a renewal is picked up at the boundary, not a day later)
//   trial        the plan, ACTIVE, verifiedAt = now, and NO period (none exists yet, and none is made up): the row stays a paid plan whose
//                billing period is unknown, so its entitlements are Basic's until the first billing cycle is reported. The next check is
//                due at the EARLIER of 12 hours from now and the end of the trial
//   none         a paid row becomes CANCELLED (the plan and period metadata stay as they were); a free row is left alone
//   inactive     the given status
//   error        NOTHING about the subscription changes (not the plan, status, period, source or verifiedAt): only the failure count, a
//                safe error code and the next attempt are written. A failure is never evidence of a cancellation.
//                transient (network, rate limit, timeout, missing token, bad answer): bounded exponential backoff 1, 2, 4 ... minutes, capped at 2 hours
//                permission / config: a long wait (6 hours), recorded under a distinct code, so it is not a tight loop and is never a cancellation
// Until a paid row is verified again its entitlements are Basic's after 24 hours (resolveEntitlements), and the retries above continue.
//
// Claiming: a row is claimed by writing verificationLeaseExpiresAt with a conditional UPDATE (NULL or past = claimable), so of several
// workers exactly one wins, and a worker that died leaves a lease that simply expires. The result is written only while the row still
// holds THAT lease value, so a slow worker whose lease was taken over cannot overwrite the newer outcome.

export const REFRESH_MS = 12 * 60 * 60 * 1000;
export const INACTIVE_RECHECK_MS = 24 * 60 * 60 * 1000;
export const PERMISSION_RETRY_MS = 6 * 60 * 60 * 1000;
export const PERIOD_RECHECK_MS = 5 * 60 * 1000;
export const RETRY_BASE_MS = 60 * 1000;
export const RETRY_CAP_MS = 2 * 60 * 60 * 1000;
export const LEASE_MS = 5 * 60 * 1000;
export const VERIFY_TIMEOUT_MS = 15 * 1000;
export const ON_DEMAND_MIN_INTERVAL_MS = 60 * 1000;
// A verifier whose "none" says requireRepeat (the Partner API verifier: null means "no contract") does not cancel a paid row on the FIRST such
// answer. The first one only leaves a marker in lastVerificationError and brings the next check forward by this much; a SECOND consecutive
// answer cancels. Any other answer in between (a subscription, a trial, an error) replaces the marker, so the two must be consecutive.
// Rationale: cancelling is the one destructive transition, a paying merchant would sit on Basic until the next daily recheck, and the cost of
// asking twice is minutes. This is a confirmation, NOT a grace period: nothing here keeps an unverifiable or stale plan paid for longer.
export const CANCEL_CONFIRM_MS = 5 * 60 * 1000;
export const UNCONFIRMED_NONE = "no_contract_unconfirmed";
// How long one worker run may spend CLAIMING verifications. It is far below the cron limit (8 minutes), so billing can never use up
// the run before the emails: after it no new row is claimed. One request already started finishes (or times out) within VERIFY_TIMEOUT_MS.
export const STEP_BUDGET_MS = 60 * 1000;

const PAID = ["ADVANCE", "ENTERPRISE"];
const INACTIVE_STATUSES = ["CANCELLED", "FROZEN", "EXPIRED"];

export const backoffMs = (failures) => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_CAP_MS);

// When to check again after a successful active verification.
export function nextAfterActive(now, periodEnd) {
  if (periodEnd <= now) return new Date(now.getTime() + PERIOD_RECHECK_MS); // Shopify still reports an ended period: look again soon
  return new Date(Math.min(now.getTime() + REFRESH_MS, periodEnd.getTime()));
}

const safeCode = (code) => String(code ?? "error").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "error";
const validSource = (raw) => (typeof raw === "string" && VERIFIED_SOURCES.includes(raw.trim()) ? raw.trim() : null); // an answer from an unrecognised source is no verification
const asDate = (value) => (value instanceof Date ? value : new Date(value));

// Turns whatever the verifier returned (or threw) into one of the shapes above, or an error for anything unusable.
export function normalizeVerification(raw) {
  const bad = { outcome: "error", kind: "transient", code: "invalid_response" };
  if (!raw || typeof raw !== "object") return bad;
  if (raw.outcome === "none") return { outcome: "none", reason: raw.reason === "free_plan" ? "free_plan" : "no_contract", requireRepeat: raw.requireRepeat === true };
  if (raw.outcome === "trial") {
    const trialEnd = asDate(raw.trialEndsAt);
    const source = validSource(raw.source);
    if (!getPlan(raw.plan)?.paid || !source || Number.isNaN(trialEnd.getTime())) return bad;
    return {
      outcome: "trial",
      plan: raw.plan,
      trialEndsAt: trialEnd,
      cancelAtEndOfCycle: typeof raw.cancelAtEndOfCycle === "boolean" ? raw.cancelAtEndOfCycle : undefined,
      source,
      shopifySubscriptionGid: typeof raw.shopifySubscriptionGid === "string" ? raw.shopifySubscriptionGid.slice(0, 191) : undefined,
      planHandle: typeof raw.planHandle === "string" ? raw.planHandle.slice(0, 100) : undefined,
    };
  }
  if (raw.outcome === "inactive") return INACTIVE_STATUSES.includes(raw.status) ? { outcome: "inactive", status: raw.status } : bad;
  if (raw.outcome === "error") return { outcome: "error", kind: raw.kind === "permission" || raw.kind === "config" ? raw.kind : "transient", code: safeCode(raw.code) };
  if (raw.outcome === "active") {
    const start = asDate(raw.periodStart);
    const end = asDate(raw.periodEnd);
    const source = validSource(raw.source);
    if (!getPlan(raw.plan)?.paid || !source || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return bad;
    return {
      outcome: "active",
      plan: raw.plan,
      periodStart: start,
      periodEnd: end,
      cancelAtEndOfCycle: typeof raw.cancelAtEndOfCycle === "boolean" ? raw.cancelAtEndOfCycle : undefined,
      source,
      shopifySubscriptionGid: typeof raw.shopifySubscriptionGid === "string" ? raw.shopifySubscriptionGid.slice(0, 191) : undefined,
      planHandle: typeof raw.planHandle === "string" ? raw.planHandle.slice(0, 100) : undefined,
    };
  }
  return bad;
}

// Runs the verifier with a time limit; never throws.
async function callVerifier(verify, context, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: "error", kind: "transient", code: "timeout" });
    }, timeoutMs);
  });
  try {
    return normalizeVerification(await Promise.race([Promise.resolve().then(() => verify({ ...context, signal: controller.signal })), timeout]));
  } catch (error) {
    return { outcome: "error", kind: error?.kind === "permission" || error?.kind === "config" ? error.kind : "transient", code: safeCode(error?.code ?? error?.name) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- claiming ----------

const dueOrNew = (now) => [{ nextVerificationAt: { lte: now } }, { nextVerificationAt: null, plan: { in: PAID }, status: "ACTIVE" }];
const leaseFree = (now) => ({ OR: [{ verificationLeaseExpiresAt: null }, { verificationLeaseExpiresAt: { lt: now } }] });

// Atomically takes the next due row of an ACTIVE shop. Returns { row, lease, shopDomain } or null.
export async function claimDueVerification({ now = new Date(), leaseMs = LEASE_MS, shopIds, db = prisma } = {}) {
  const where = { AND: [{ OR: dueOrNew(now) }, leaseFree(now)], shop: { status: "ACTIVE" }, ...(shopIds ? { shopId: { in: shopIds } } : {}) };
  const candidates = await db.shopSubscription.findMany({ where, orderBy: [{ nextVerificationAt: "asc" }, { createdAt: "asc" }], take: 10, select: { id: true } });
  for (const { id } of candidates) {
    const lease = new Date(now.getTime() + leaseMs);
    const taken = await db.shopSubscription.updateMany({ where: { id, AND: [{ OR: dueOrNew(now) }, leaseFree(now)] }, data: { verificationLeaseExpiresAt: lease } });
    if (taken.count === 1) {
      const row = await db.shopSubscription.findUnique({ where: { id }, include: { shop: { select: { domain: true } } } });
      return { row, lease, shopDomain: row.shop.domain };
    }
  }
  return null;
}

// ---------- recording an answer ----------

// Writes one verification outcome for the row, only while it still holds `lease`. Returns { applied, outcome, ... }.
export async function applyVerification(row, lease, result, { now = new Date(), db = prisma } = {}) {
  const owner = { id: row.id, verificationLeaseExpiresAt: lease };
  const write = async (data) => (await db.shopSubscription.updateMany({ where: owner, data: { verificationLeaseExpiresAt: null, ...data } })).count === 1;

  if (result.outcome === "active") {
    const applied = await write({
      plan: result.plan,
      status: "ACTIVE",
      verificationSource: result.source,
      verifiedAt: now,
      currentPeriodStart: result.periodStart,
      currentPeriodEnd: result.periodEnd,
      trialEndsAt: null, // a billing cycle exists, so there is no running trial
      cancelAtPeriodEnd: result.cancelAtEndOfCycle ?? null, // what Shopify says; NULL when it did not say
      ...(result.shopifySubscriptionGid ? { shopifySubscriptionGid: result.shopifySubscriptionGid } : {}),
      ...(result.planHandle ? { planHandle: result.planHandle } : {}),
      verificationFailures: 0,
      lastVerificationError: null,
      nextVerificationAt: nextAfterActive(now, result.periodEnd),
    });
    // Parked mail is looked at again after EVERY successful verification whose entitlement is now usable, even when the plan and the
    // period are unchanged: a subscription that went stale fell back to Basic and parked its mail, and a plain re-verification is what
    // restores it. Waking only sets the jobs due; each one is re-evaluated when claimed, so quota that is still used up parks them again
    // (all of a shop's jobs in one step), once per verification, never in a loop. UNKNOWN deliveries are not touched.
    if (applied) {
      const effective = resolveEntitlements({ plan: result.plan, status: "ACTIVE", verificationSource: result.source, verifiedAt: now, currentPeriodStart: result.periodStart, currentPeriodEnd: result.periodEnd }, now);
      if (effective.state === "verified") await wakeQuotaBlocked(row.shopId, { now, db });
    }
    return { applied, outcome: "active" };
  }

  if (result.outcome === "trial") {
    // Verified, paid, but no billing cycle to store: both boundaries stay empty (resolveEntitlements then gives Basic's entitlements).
    const next = result.trialEndsAt > now ? new Date(Math.min(now.getTime() + REFRESH_MS, result.trialEndsAt.getTime())) : new Date(now.getTime() + PERIOD_RECHECK_MS);
    const applied = await write({
      plan: result.plan,
      status: "ACTIVE",
      verificationSource: result.source,
      verifiedAt: now,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: result.trialEndsAt,
      cancelAtPeriodEnd: result.cancelAtEndOfCycle ?? null,
      ...(result.shopifySubscriptionGid ? { shopifySubscriptionGid: result.shopifySubscriptionGid } : {}),
      ...(result.planHandle ? { planHandle: result.planHandle } : {}),
      verificationFailures: 0,
      lastVerificationError: null,
      nextVerificationAt: next,
    });
    return { applied, outcome: "trial" };
  }

  if (result.outcome === "none" && result.requireRepeat && PAID.includes(row.plan) && row.status === "ACTIVE" && row.lastVerificationError !== UNCONFIRMED_NONE) {
    // The first "no contract": nothing about the subscription changes (not its plan, status, period, source or verifiedAt).
    const applied = await write({ lastVerificationError: UNCONFIRMED_NONE, nextVerificationAt: new Date(now.getTime() + CANCEL_CONFIRM_MS) });
    return { applied, outcome: "unconfirmed" };
  }

  if (result.outcome === "none" || result.outcome === "inactive") {
    const paid = PAID.includes(row.plan);
    const status = result.outcome === "inactive" ? result.status : "CANCELLED";
    const applied = await write({
      ...(paid || result.outcome === "inactive" ? { status, trialEndsAt: null, cancelAtPeriodEnd: null } : {}), // the plan and period metadata are kept as history; a stale "cancels at the end" or "trial" note is not
      verificationSource: row.verificationSource ?? "authoritative_check",
      verifiedAt: now,
      verificationFailures: 0,
      lastVerificationError: null,
      nextVerificationAt: new Date(now.getTime() + INACTIVE_RECHECK_MS),
    });
    return { applied, outcome: paid ? "inactive" : "none" };
  }

  // An error. Nothing about the subscription changes.
  const failures = row.verificationFailures + 1;
  const wait = result.kind === "transient" ? backoffMs(failures) : PERMISSION_RETRY_MS;
  const code = result.kind === "transient" ? result.code : `${result.kind}_${result.code}`;
  const applied = await write({ verificationFailures: failures, lastVerificationError: safeCode(code), nextVerificationAt: new Date(now.getTime() + wait) });
  return { applied, outcome: "error", kind: result.kind };
}

// ---------- the worker step ----------

// Verifies every due row, bounded by `limit` and `shouldStop`. With no verifier configured it does nothing at all (it never turns
// "nothing to ask" into a cancellation, and never touches a row).
export async function runSubscriptionVerification({ verify, now = () => new Date(), leaseMs = LEASE_MS, timeoutMs = VERIFY_TIMEOUT_MS, limit = 50, budgetMs = STEP_BUDGET_MS, shouldStop = () => false, shopIds, db = prisma, log = console } = {}) {
  const summary = { claimed: 0, active: 0, trial: 0, inactive: 0, none: 0, unconfirmed: 0, failed: 0, stale: 0 };
  if (typeof verify !== "function") return { ...summary, skipped: "no_verifier" };
  const deadline = Date.now() + budgetMs;
  while (summary.claimed < limit && !shouldStop()) {
    if (Date.now() >= deadline) {
      summary.budgetExhausted = true; // what is still due is claimed by the next run
      break;
    }
    const claim = await claimDueVerification({ now: now(), leaseMs, shopIds, db });
    if (!claim) break;
    summary.claimed += 1;
    const result = await callVerifier(verify, { shop: { id: claim.row.shopId, domain: claim.shopDomain }, subscription: claim.row }, timeoutMs);
    const done = await applyVerification(claim.row, claim.lease, result, { now: now(), db });
    if (!done.applied) summary.stale += 1;
    else if (done.outcome === "error") summary.failed += 1;
    else summary[done.outcome] += 1;
  }
  if (summary.claimed) log.log(`[billing] subscription verification: ${summary.active} active, ${summary.trial} in trial, ${summary.inactive} cancelled, ${summary.unconfirmed} awaiting confirmation, ${summary.none} free, ${summary.failed} failed, ${summary.stale} superseded`);
  return summary;
}

// ---------- on demand (for the billing page) ----------

// One bounded check for one shop. It goes through the SAME claim as the worker, so it cannot run at the same time as a worker check
// for that shop, and it respects the retry schedule: a shop that is in backoff after a failure is not asked again early, and a shop
// verified within the last minute is not asked again. Returns { status, entitlements }.
//   status: "unavailable" (no verifier) | "backoff" | "confirming" | "fresh" | "in_progress" | "active" | "trial" | "inactive" | "none" | "unconfirmed" | "error" | "stale"
// A merchant who keeps refreshing the page therefore cannot cause more than one Partner API request per minute, none at all during a
// backoff or a cancellation confirmation, and never two at once.
export async function verifyShopOnDemand(shopId, { verify, now = () => new Date(), leaseMs = LEASE_MS, timeoutMs = VERIFY_TIMEOUT_MS, db = prisma } = {}) {
  const finish = async (status, extra = {}) => ({ status, ...extra, entitlements: await getEntitlements(shopId, { now: now(), db }) });
  if (typeof verify !== "function") return finish("unavailable");
  const started = now();
  const row = await ensureShopSubscription(shopId, { db });
  if (row.verificationFailures > 0 && row.nextVerificationAt && row.nextVerificationAt > started) return finish("backoff", { retryAt: row.nextVerificationAt });
  // A first "no contract" answer only left a marker; the SECOND answer that cancels must come when it was scheduled (CANCEL_CONFIRM_MS later),
  // not seconds later because a page was refreshed: two answers moments apart would be one observation, not a confirmation.
  if (row.lastVerificationError === UNCONFIRMED_NONE && row.nextVerificationAt && row.nextVerificationAt > started) return finish("confirming", { retryAt: row.nextVerificationAt });
  if (row.verifiedAt && row.verificationFailures === 0 && started.getTime() - row.verifiedAt.getTime() < ON_DEMAND_MIN_INTERVAL_MS) return finish("fresh");

  const lease = new Date(started.getTime() + leaseMs);
  const taken = await db.shopSubscription.updateMany({ where: { id: row.id, ...leaseFree(started) }, data: { verificationLeaseExpiresAt: lease } });
  if (taken.count !== 1) return finish("in_progress");
  const claimed = await db.shopSubscription.findUnique({ where: { id: row.id }, include: { shop: { select: { domain: true } } } });
  const result = await callVerifier(verify, { shop: { id: shopId, domain: claimed.shop.domain }, subscription: claimed }, timeoutMs);
  const done = await applyVerification(claimed, lease, result, { now: now(), db });
  return finish(done.applied ? done.outcome : "stale");
}
