import { runSubscriptionVerification, STEP_BUDGET_MS as VERIFY_BUDGET_MS, VERIFY_TIMEOUT_MS } from "../models/subscription-verification.server";
import { enqueuePlanRecommendations, runPlanRecommendations, STEP_BUDGET_MS as RECOMMEND_BUDGET_MS } from "../models/plan-recommendation.server";

// The billing steps of the worker run (scripts/worker.mjs, started every 10 minutes by app/worker/cron.js): subscription verification
// first, so an entitlement is as fresh as possible before restock emails are claimed, then the plan-recommendation lookups.
//
// `services` = { verify, fetchSessions }, supplied by the billing integration when it exists (see billing-services.server.js). A
// missing service makes its step do nothing; it never changes a row.
//
// Time is bounded in two layers, both far below the cron limit of 8 minutes, so billing can never use up the run before the emails:
//   budget      each step stops CLAIMING new work after budgetMs (60 s); a request already started ends within its own timeout
//   hard limit  if a step still has not returned after hardLimitMs (150 s: its budget plus a request's timeout, with slack), the worker
//               stops WAITING for it and goes on. The abandoned step can no longer change anything that matters: every write it could
//               still make is conditional on its lease, which expires, and the process exits when the run ends.
// Each step is isolated (one failing or timing out never stops the other) and the caller wraps this whole function, so billing can
// never stop the email run.
export const STEP_HARD_LIMIT_MS = 150 * 1000;

async function withHardLimit(run, hardLimitMs) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), hardLimitMs);
  });
  const work = Promise.resolve().then(run);
  work.catch(() => {}); // a step abandoned at the limit must not become an unhandled rejection later
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// Enqueue (bounded, only with a configured session source), then run the lookups. Without a source this is exactly the old step: nothing is
// enqueued and nothing is fetched. The enqueue is inside this step, so the step's budget and hard limit cover it too.
async function recommend({ fetchSessions, shouldStop, log, shopIds, budgetMs, fetchTimeoutMs }) {
  const enqueued = typeof fetchSessions === "function" && !shouldStop() ? await enqueuePlanRecommendations({ fetchSessions, shopIds }) : null;
  const result = await runPlanRecommendations({ fetchSessions, shouldStop, log, shopIds, budgetMs, ...(fetchTimeoutMs ? { fetchTimeoutMs } : {}) });
  return enqueued ? { ...result, enqueued } : result;
}

// The fast lane (WORKER_MODE=recommendations in scripts/worker.mjs): ONLY the recommendation step above, with the same enqueue, claim, lease,
// retry, budget and hard-limit rules. No verification and no other billing work. Never throws.
export async function runRecommendationJobs({ services = {}, shouldStop = () => false, log = console, shopIds, recommendBudgetMs = RECOMMEND_BUDGET_MS, fetchTimeoutMs, hardLimitMs = STEP_HARD_LIMIT_MS } = {}) {
  try {
    const result = await withHardLimit(() => recommend({ fetchSessions: services.fetchSessions, shouldStop, log, shopIds, budgetMs: recommendBudgetMs, fetchTimeoutMs }), hardLimitMs);
    if (result?.timedOut) log.error(`[billing] recommendations did not finish within ${Math.round(hardLimitMs / 1000)}s: not waiting for it any longer`);
    return result;
  } catch (error) {
    log.error(`[billing] recommendations failed: ${error?.code ?? error?.name ?? "error"}`);
    return { failed: true };
  }
}

export async function runBillingJobs({ services = {}, shouldStop = () => false, log = console, shopIds, verifyBudgetMs = VERIFY_BUDGET_MS, recommendBudgetMs = RECOMMEND_BUDGET_MS, verifyTimeoutMs = VERIFY_TIMEOUT_MS, fetchTimeoutMs, hardLimitMs = STEP_HARD_LIMIT_MS } = {}) {
  const result = {};
  for (const [name, run] of [
    ["verification", () => runSubscriptionVerification({ verify: services.verify, shouldStop, log, shopIds, budgetMs: verifyBudgetMs, timeoutMs: verifyTimeoutMs })],
    ["recommendations", () => recommend({ fetchSessions: services.fetchSessions, shouldStop, log, shopIds, budgetMs: recommendBudgetMs, fetchTimeoutMs })],
  ]) {
    try {
      result[name] = await withHardLimit(run, hardLimitMs);
      if (result[name]?.timedOut) log.error(`[billing] ${name} did not finish within ${Math.round(hardLimitMs / 1000)}s: not waiting for it any longer`);
    } catch (error) {
      log.error(`[billing] ${name} failed: ${error?.code ?? error?.name ?? "error"}`);
      result[name] = { failed: true };
    }
  }
  return result;
}
