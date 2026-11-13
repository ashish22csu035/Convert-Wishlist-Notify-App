import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { recommendedPlanForSessions } from "./plans.server";

// The one-time "sessions in the previous 30 days" lookup and the advice it produces, one row per shop (PlanRecommendation).
// Rules that hold here and, for the count, in the database itself:
//   - one row per shop; asking again never creates a second one
//   - a count is stored only when it is a real non-negative whole number; a failure, a denial or missing data stores NO count (NULL),
//     never 0, and an earlier valid result is kept
//   - the recommended plan is derived from the count only; it is advice and never a subscription or an entitlement
//
// Job life cycle (statuses of the existing enum, no new column):
//   PENDING       due at nextAttemptAt
//   RUNNING       claimed by one worker; leaseExpiresAt says how long that claim holds. A worker that died leaves a RUNNING row whose
//                 lease runs out: the next claim takes it over (that takeover counts as an attempt, so a job that keeps crashing
//                 stops after MAX_ATTEMPTS)
//   SUCCEEDED     a valid count and its advice are stored
//   FAILED        the last try failed; nextAttemptAt is the bounded retry (NULL once the attempts are used up or the failure is permanent)
//   NEEDS_ACCESS  permission or approval is missing: NOT retried on a timer. Only requestRecommendationRecheck puts it back.
// Attempts are counted when a job is CLAIMED. A result or failure is written only by the worker that still holds ITS lease, so a
// stale worker (its lease expired and another worker took the job over) can never overwrite a newer outcome.

export const MAX_ATTEMPTS = 5;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const RETRY_DELAYS_MS = Object.freeze([60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]); // MAX_ATTEMPTS - 1 waits

// Delay before the next try after `attempts` tries have failed, or null when no more tries are allowed.
export function retryDelayMs(attempts) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
}

const safeCode = (code) => String(code ?? "error").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "error";

// Creates the shop's row once (PENDING, due now). Repeated calls, including simultaneous ones, return the same row.
export async function ensurePlanRecommendation(shopId, { db = prisma, now = new Date() } = {}) {
  try {
    return await db.planRecommendation.upsert({ where: { shopId }, create: { shopId, nextAttemptAt: now }, update: {} });
  } catch (error) {
    if (error?.code !== "P2002") throw error; // two first calls raced to create it: read the winner's
    return db.planRecommendation.findUniqueOrThrow({ where: { shopId } });
  }
}

// What makes a row claimable: due PENDING / FAILED, or a RUNNING row whose lease has run out (an abandoned job).
// NEEDS_ACCESS and SUCCEEDED are never claimed automatically.
const claimable = (now) => ({
  OR: [
    { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: now } },
    { status: "RUNNING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
  ],
});

// Atomically takes the next claimable job of an ACTIVE shop. Returns { row, lease } (the lease value identifies this claim) or null.
// Of several workers racing for one row exactly one matches the conditional UPDATE.
export async function claimDueRecommendation({ now = new Date(), leaseMs = DEFAULT_LEASE_MS, shopIds, db = prisma } = {}) {
  const where = { ...claimable(now), shop: { status: "ACTIVE" }, ...(shopIds ? { shopId: { in: shopIds } } : {}) };
  const candidates = await db.planRecommendation.findMany({ where, orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }], take: 10, select: { id: true, status: true, attempts: true } });
  for (const candidate of candidates) {
    const lease = new Date(now.getTime() + leaseMs);
    const base = { id: candidate.id, status: candidate.status, ...(candidate.status === "RUNNING" ? { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] } : { nextAttemptAt: { lte: now } }) };
    if (candidate.status === "RUNNING" && candidate.attempts >= MAX_ATTEMPTS) {
      // An abandoned job that already used every attempt: stop here instead of crashing forever.
      await db.planRecommendation.updateMany({ where: base, data: { status: "FAILED", errorCode: "lease_expired", nextAttemptAt: null, leaseExpiresAt: null } });
      continue;
    }
    const taken = await db.planRecommendation.updateMany({ where: base, data: { status: "RUNNING", attempts: { increment: 1 }, leaseExpiresAt: lease } });
    if (taken.count === 1) return { row: await db.planRecommendation.findUnique({ where: { id: candidate.id } }), lease };
  }
  return null;
}

const owned = (shopId, lease) => ({ shopId, status: "RUNNING", leaseExpiresAt: lease });

// A valid answer, written by the worker holding `lease`. Throws (and stores nothing) for anything that is not a real session count
// over a real period. Returns the row, or null when the lease is no longer this worker's (a stale worker changes nothing).
// A success starts a fresh retry history (attempts back to 0) and keeps nothing scheduled.
export async function recordSessionResult(shopId, { sessions, periodStart, periodEnd }, { lease, now = new Date(), db = prisma } = {}) {
  if (!(lease instanceof Date)) throw new TypeError("a result is written under a claim (lease)");
  const advice = recommendedPlanForSessions(sessions);
  const start = periodStart instanceof Date ? periodStart : new Date(periodStart);
  const end = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);
  if (!advice || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw new TypeError("not a valid session result");
  const written = await db.planRecommendation.updateMany({
    where: owned(shopId, lease),
    data: { status: "SUCCEEDED", sessions30d: sessions, periodStart: start, periodEnd: end, fetchedAt: now, recommendedPlan: advice, attempts: 0, errorCode: null, nextAttemptAt: null, leaseExpiresAt: null },
  });
  return written.count === 1 ? db.planRecommendation.findUnique({ where: { shopId } }) : null;
}

// A failed lookup, written by the worker holding `lease` (null when the lease is no longer this worker's). Never writes a count and
// leaves an earlier valid count and advice untouched.
//   needsAccess  permission or approval missing: NEEDS_ACCESS, not retried on a timer
//   retryable    false = a permanent failure: FAILED with nothing scheduled
//   otherwise    FAILED with the next bounded retry (none once MAX_ATTEMPTS are used)
export async function recordSessionFailure(shopId, { code, retryable = true, needsAccess = false }, { lease, now = new Date(), db = prisma } = {}) {
  if (!(lease instanceof Date)) throw new TypeError("a failure is written under a claim (lease)");
  const current = await db.planRecommendation.findFirst({ where: owned(shopId, lease), select: { attempts: true } });
  if (!current) return null;
  const delay = needsAccess || !retryable ? null : retryDelayMs(current.attempts);
  const written = await db.planRecommendation.updateMany({
    where: owned(shopId, lease),
    data: {
      status: needsAccess ? "NEEDS_ACCESS" : "FAILED",
      errorCode: safeCode(code),
      nextAttemptAt: delay === null ? null : new Date(now.getTime() + delay),
      leaseExpiresAt: null,
    },
  });
  return written.count === 1 ? db.planRecommendation.findUnique({ where: { shopId } }) : null;
}

// An explicit "look again" (for example after the missing permission was granted): puts a NEEDS_ACCESS, exhausted FAILED or finished
// row back to PENDING with a fresh retry history. A RUNNING job is left alone. Any earlier valid count and advice are kept.
export const requestRecommendationRecheck = (shopId, { now = new Date(), db = prisma } = {}) =>
  db.planRecommendation.updateMany({
    where: { shopId, status: { in: ["NEEDS_ACCESS", "FAILED", "SUCCEEDED"] } },
    data: { status: "PENDING", attempts: 0, errorCode: null, nextAttemptAt: now, leaseExpiresAt: null },
  });

// What a screen may show: the advice only when a valid count was recorded, otherwise nothing at all (never a zero).
export function publicRecommendation(row) {
  if (!row || row.sessions30d === null || row.sessions30d === undefined || !row.recommendedPlan) return null;
  return { plan: row.recommendedPlan, sessions30d: row.sessions30d, periodStart: row.periodStart, periodEnd: row.periodEnd, fetchedAt: row.fetchedAt };
}

// ---------- scheduling: which shops get a lookup ----------

export const ENQUEUE_BATCH = 25;
const hasReportsScope = (scope) => String(scope ?? "").split(",").map((item) => item.trim()).includes("read_reports");

// The worker-side enqueue, run by the billing step before the lookups. It exists only to give a shop its ONE lookup row; the claim, lease, retry
// and result rules above are the same as for any row. It does nothing at all unless
//   - a session source is configured (SESSION_ANALYTICS_SOURCE, see billing-services.server.js): `fetchSessions` is a function, and
//   - the shop's OFFLINE session has been granted the read_reports scope (nothing is enqueued for a shop that has not, so no analytics request
//     is ever made for it; whether Shopify also approved the protected-data access is only learned from the answer: ACCESS_DENIED = NEEDS_ACCESS).
// It adds a PENDING row for each eligible ACTIVE shop that has NO row yet (UNIQUE(shopId) plus skipDuplicates: running it twice, or from two
// workers, can never make a second row; a shop with a pending, running, finished or failed row is never touched), at most `limit` per run, oldest
// installs first, so a big backlog is worked off over several runs and never takes more than a moment. It also puts a NEEDS_ACCESS row whose
// reason was a missing scope (scope_not_granted) back to PENDING once the scope has been granted, and nothing else is ever re-queued here.
// Nothing here fetches data, so nothing here can produce a count, and a missing count is never a zero.
export async function enqueuePlanRecommendations({ fetchSessions, limit = ENQUEUE_BATCH, now = new Date(), shopIds, db = prisma } = {}) {
  const summary = { created: 0, rechecked: 0 };
  if (typeof fetchSessions !== "function") return { ...summary, skipped: "no_session_source" };
  const only = shopIds?.length ? Prisma.sql`AND sh.id IN (${Prisma.join(shopIds)})` : Prisma.empty;

  const missing = await db.$queryRaw`
    SELECT sh.id AS id, s.scope AS scope
    FROM Session s
    JOIN Shop sh ON sh.domain = s.shop
    LEFT JOIN PlanRecommendation pr ON pr.shopId = sh.id
    WHERE s.isOnline = 0 AND sh.status = 'ACTIVE' AND pr.id IS NULL AND s.scope LIKE '%read_reports%' ${only}
    ORDER BY sh.installedAt ASC, sh.id ASC
    LIMIT ${limit}`;
  const eligible = [...new Set(missing.filter((row) => hasReportsScope(row.scope)).map((row) => row.id))];
  if (eligible.length) summary.created = (await db.planRecommendation.createMany({ data: eligible.map((shopId) => ({ shopId, nextAttemptAt: now })), skipDuplicates: true })).count;

  const stuck = await db.$queryRaw`
    SELECT pr.shopId AS id, s.scope AS scope
    FROM PlanRecommendation pr
    JOIN Shop sh ON sh.id = pr.shopId
    JOIN Session s ON s.shop = sh.domain
    WHERE pr.status = 'NEEDS_ACCESS' AND pr.errorCode = 'scope_not_granted' AND s.isOnline = 0 AND sh.status = 'ACTIVE' AND s.scope LIKE '%read_reports%' ${only}
    LIMIT ${limit}`;
  const granted = [...new Set(stuck.filter((row) => hasReportsScope(row.scope)).map((row) => row.id))];
  if (granted.length) {
    summary.rechecked = (
      await db.planRecommendation.updateMany({
        where: { shopId: { in: granted }, status: "NEEDS_ACCESS", errorCode: "scope_not_granted" },
        data: { status: "PENDING", attempts: 0, errorCode: null, nextAttemptAt: now, leaseExpiresAt: null },
      })
    ).count;
  }
  return summary;
}

// ---------- the runner (the data source is injected; nothing here knows how sessions are fetched) ----------

const FETCH_TIMEOUT_MS = 30 * 1000;
// How long one worker run may spend CLAIMING lookups (see STEP_BUDGET_MS in subscription-verification.server.js).
export const STEP_BUDGET_MS = 60 * 1000;

// Calls the source with a REAL time limit. The abort signal is only a request to stop: a source that ignores it would be awaited forever,
// so the wait itself is raced against a timer, and the timeout is a failure with code "timeout" (never an answer, never a zero). A call
// that finishes later is simply ignored: nothing writes its result, and a late rejection is swallowed so it cannot crash the process.
async function boundedFetch(fetchSessions, context, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("timeout"), { code: "timeout" }));
    }, timeoutMs);
  });
  const call = Promise.resolve().then(() => fetchSessions({ ...context, signal: controller.signal }));
  call.catch(() => {});
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// `fetchSessions({ shopId, shopDomain, signal })` must resolve { sessions, periodStart, periodEnd } or reject. A rejection with
// error.kind "permission" means access is missing; anything else is a transient failure unless error.retryable === false. Whatever it
// returns is validated by recordSessionResult: a missing, null or non-numeric count is a failure, never a zero.
export async function runPlanRecommendations({ fetchSessions, now = () => new Date(), leaseMs = DEFAULT_LEASE_MS, limit = 25, budgetMs = STEP_BUDGET_MS, fetchTimeoutMs = FETCH_TIMEOUT_MS, shouldStop = () => false, shopIds, db = prisma, log = console } = {}) {
  const summary = { claimed: 0, succeeded: 0, failed: 0, needsAccess: 0, stale: 0 };
  if (typeof fetchSessions !== "function") return { ...summary, skipped: "no_session_source" };
  const deadline = Date.now() + budgetMs;
  while (summary.claimed < limit && !shouldStop()) {
    if (Date.now() >= deadline) {
      summary.budgetExhausted = true; // what is still due is claimed by the next run
      break;
    }
    const claim = await claimDueRecommendation({ now: now(), leaseMs, shopIds, db });
    if (!claim) break;
    summary.claimed += 1;
    const { row, lease } = claim;
    const shop = await db.shop.findUnique({ where: { id: row.shopId }, select: { domain: true } });
    let answer = null;
    let failure = null;
    try {
      answer = await boundedFetch(fetchSessions, { shopId: row.shopId, shopDomain: shop?.domain ?? null }, fetchTimeoutMs);
    } catch (error) {
      failure = error?.kind === "permission"
        ? { code: error.code ?? "access_denied", needsAccess: true }
        : { code: error?.code ?? error?.name ?? "error", retryable: error?.retryable !== false };
    }
    let applied = null;
    if (!failure) {
      try {
        applied = await recordSessionResult(row.shopId, { sessions: answer?.sessions, periodStart: answer?.periodStart, periodEnd: answer?.periodEnd }, { lease, now: now(), db });
        if (applied) summary.succeeded += 1;
        else summary.stale += 1;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        failure = { code: "invalid_data" }; // unusable data is a failure, never a zero
      }
    }
    if (failure) {
      const written = await recordSessionFailure(row.shopId, failure, { lease, now: now(), db });
      if (!written) summary.stale += 1;
      else if (failure.needsAccess) summary.needsAccess += 1;
      else summary.failed += 1;
    }
  }
  if (summary.claimed) log.log(`[billing] plan recommendations: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.needsAccess} need access, ${summary.stale} superseded`);
  return summary;
}
