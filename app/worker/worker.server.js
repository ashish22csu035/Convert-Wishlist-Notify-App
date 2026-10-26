import { DEFAULT_LEASE_MS, claimNext, processJob, recoverExpiredLeases } from "../models/email-delivery.server";

// The email worker. It only looks at the database for queued EmailDelivery rows; it never asks
// Shopify about inventory (that is the webhook's job).
//
// Two ways to run it, both built on the same pass:
//   drain()          one-shot (what `npm run worker` uses): claim and send every job that is due now,
//                    including jobs that become due while draining, then resolve. Jobs scheduled for
//                    later (a retry after a transient error) are NOT waited for: they stay PENDING for
//                    a later run.
//   start() / stop() the original timed loop, kept for the tests and for anyone who wants it.
//
// Safety does not depend on running one worker: every claim is a single conditional UPDATE, so two
// workers (or two drains) can never take the same job, and a job is never sent twice.
//
// options: { intervalMs, batchSize, leaseMs, shopIds, ctx }  (ctx is passed to processJob;
// shopIds limits the worker to those shops: used by the tests, absent in normal use)
export function createWorker({ intervalMs = 15000, batchSize = 10, leaseMs = DEFAULT_LEASE_MS, shopIds, ctx, recover, log = console } = {}) {
  let timer = null;
  let stopping = false;
  let running = null;
  let draining = null;
  let outcomes = {};

  async function pass() {
    // Optional: replay inventory events that did not finish, so their restock jobs exist before sending.
    if (recover) {
      try {
        const done = await recover();
        if (done?.found) log.log(`[worker] inventory events recovered: ${done.processed} processed, ${done.ignored ?? 0} ignored, ${done.skipped ?? 0} skipped, ${done.failed} still failing`);
      } catch (error) {
        log.error(`[worker] inventory recovery failed: ${error?.code ?? error?.name ?? "error"}`);
      }
    }
    const recovered = await recoverExpiredLeases({ shopIds });
    if (recovered) log.log(`[worker] recovered ${recovered} stuck job(s)`);
    let handled = 0;
    while (!stopping && handled < batchSize) {
      const job = await claimNext({ leaseMs, shopIds });
      if (!job) break;
      try {
        const result = await processJob(job, { ...ctx, leaseMs });
        outcomes[result] = (outcomes[result] ?? 0) + 1;
        log.log(`[worker] job ${job.id} -> ${result}`);
      } catch (error) {
        // The row stays SENDING; its lease expiry decides whether it is retried or marked UNKNOWN.
        outcomes.CRASHED = (outcomes.CRASHED ?? 0) + 1;
        log.error(`[worker] job ${job.id} crashed: ${error?.code ?? error?.name ?? "error"}`);
      }
      handled += 1;
    }
    return handled;
  }

  // Runs one pass now (or joins the one already running). Resolves to the number of jobs handled.
  function tick() {
    if (!running) {
      running = pass().finally(() => {
        running = null;
      });
    }
    return running;
  }

  // One-shot: passes until a pass finds nothing due, or stop() is called. Resolves to
  // { handled, outcomes, interrupted } where outcomes counts the resulting statuses (SENT, SKIPPED,
  // PENDING for a scheduled retry, FAILED, UNKNOWN, CRASHED). Each claim re-reads the clock, so a job
  // whose nextAttemptAt is in the future is never claimed here and never waited for.
  function drain() {
    if (!draining) {
      outcomes = {};
      draining = (async () => {
        let handled = 0;
        while (!stopping) {
          const count = await tick();
          handled += count;
          if (count === 0) break;
        }
        return { handled, outcomes: { ...outcomes }, interrupted: stopping };
      })().finally(() => {
        draining = null;
      });
    }
    return draining;
  }

  function schedule(delay) {
    if (stopping) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await tick();
      } catch (error) {
        log.error(`[worker] pass failed: ${error?.code ?? error?.name ?? "error"}`);
      }
      schedule(intervalMs);
    }, delay);
  }

  return {
    start() {
      stopping = false;
      schedule(0);
    },
    // Lets the job being worked on finish, claims nothing new, and resolves once the loop or drain is idle.
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (running) await running.catch(() => {});
      if (draining) await draining.catch(() => {});
    },
    tick,
    drain,
  };
}
