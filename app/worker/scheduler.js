// The scheduling rules of app/worker/cron.js, kept apart from the process wiring so they can be tested with a fake `spawn` and fake timers.
//
// Two kinds of child process, both the SAME script (scripts/worker.mjs), told apart only by WORKER_MODE:
//   full             every `intervalMs` on the wall-clock mark (:00, :10, ...): verification, plan recommendations, restock emails, analytics.
//   recommendations  every `fastIntervalMs`: ONLY the plan-recommendation step, so a shop that just installed gets its recommendation within
//                    about a minute instead of waiting for the next full run.
//
// Rules (all of them hold on every exit path of a child):
//   - At most ONE child exists at any moment. `child` is explicit state, set when a child is launched and cleared exactly once when it ends
//     (exit, spawn error, timeout, kill); a timer firing never assumes the previous child has finished.
//   - A full run that comes due while a full run is active is skipped (as before: its work is already being done).
//   - A full run that comes due while a recommendations run is active is NOT skipped: it is remembered (`fullPending`, a boolean, so
//     it can never become a backlog) and starts the moment that child ends.
//   - A recommendations run never starts while a full run is active (the full run does the recommendation step itself), nor while a full
//     run is waiting to start.
//   - The full schedule is computed from the wall clock only, so a fast run never moves or resets it.
//   - Both timers re-arm themselves after they fire (one pending timer each, never an interval that can stack up).
//   - A child that fails (non-zero exit, error, timeout) changes nothing for the scheduler: the next tick launches the next run. Recommendation
//     jobs that failed are retried by their own rules (attempt limits, retry delays, lease expiry) in the database, not here.
export const MODE_ENV = "WORKER_MODE";
export const FULL = "full";
export const RECOMMENDATIONS = "recommendations";

export const DEFAULT_FAST_INTERVAL_MS = 60 * 1000;
export const MAX_FULL_RUN_MS = 8 * 60 * 1000;
export const MAX_FAST_RUN_MS = 3 * 60 * 1000; // the step's own hard limit is 150 s (billing-jobs.server.js)
export const KILL_AFTER_MS = 30 * 1000;

export function createScheduler({
  spawn,
  execPath,
  script,
  intervalMs,
  fastIntervalMs = DEFAULT_FAST_INTERVAL_MS,
  maxFullRunMs = MAX_FULL_RUN_MS,
  maxFastRunMs = MAX_FAST_RUN_MS,
  killAfterMs = KILL_AFTER_MS,
  env = {},
  log = () => {},
  exit = () => {},
}) {
  let child = null; // { kind, proc } while a worker process is running or being stopped, otherwise null
  let fullPending = false;
  let stopping = false;
  let fullTimer = null;
  let fastTimer = null;

  function launch(kind) {
    const label = kind === FULL ? "worker run" : "recommendation run";
    let proc;
    try {
      proc = spawn(execPath, [script], { stdio: "inherit", env: { ...env, [MODE_ENV]: kind } });
    } catch (error) {
      log(`${label} could not start: ${error?.code ?? error?.name ?? "error"}`);
      return;
    }
    child = { kind, proc };
    // Only full runs announce themselves: a recommendation run happens every minute and says nothing unless it has something to report.
    if (kind === FULL) log("worker run started");

    let settled = false;
    let termTimer = null;
    let killTimer = null;
    let giveUpTimer = null;
    const settle = (how) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      child = null;
      if (kind === FULL || how !== "exit=0") log(`${label} finished ${how}`);
      if (stopping) {
        exit(0);
        return;
      }
      if (fullPending) {
        fullPending = false;
        launch(FULL); // the full run that came due meanwhile starts now, not at the next mark
      }
    };
    const kill = (signal) => {
      try {
        proc.kill(signal);
      } catch {
        /* already gone: its exit event decides */
      }
    };

    termTimer = setTimeout(() => {
      log(`${label} timed out: stopping it`);
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        // SIGKILL cannot be ignored; this only guards against an exit event that never arrives, so the scheduler cannot stay blocked forever.
        giveUpTimer = setTimeout(() => settle("abandoned (no exit after SIGKILL)"), killAfterMs);
        giveUpTimer.unref?.();
      }, killAfterMs);
      killTimer.unref?.();
    }, kind === FULL ? maxFullRunMs : maxFastRunMs);

    proc.on("error", (error) => {
      log(`${label} error: ${error?.code ?? error?.name ?? "error"}`);
      // A spawn that never happened has no pid and will never emit "exit". A process that did start still ends through "exit".
      if (proc.pid === undefined) settle("without starting");
    });
    proc.on("exit", (code, signal) => settle(`exit=${code ?? signal}`));
  }

  function fullDue() {
    if (stopping) return;
    if (!child) launch(FULL);
    else if (child.kind === FULL) log("skipped: previous run still active");
    else {
      fullPending = true;
      log("worker run is due while a recommendation run is active: it starts as soon as that run ends");
    }
  }

  function fastDue() {
    if (stopping || child || fullPending) return; // never beside another child, never in front of a full run that is waiting
    launch(RECOMMENDATIONS);
  }

  function armFull() {
    const wait = intervalMs - (Date.now() % intervalMs);
    log(`next run in ${Math.round(wait / 1000)}s`);
    fullTimer = setTimeout(() => {
      fullTimer = null;
      try {
        fullDue();
      } finally {
        if (!stopping) armFull();
      }
    }, wait);
  }

  function armFast() {
    fastTimer = setTimeout(() => {
      fastTimer = null;
      try {
        fastDue();
      } finally {
        if (!stopping) armFast();
      }
    }, fastIntervalMs);
  }

  return {
    start() {
      log(`scheduler started: worker runs every ${Math.round(intervalMs / 60000)} minutes, plan recommendations are checked every ${Math.round(fastIntervalMs / 1000)}s`);
      armFull();
      armFast();
    },
    stop(signal) {
      if (stopping) return;
      stopping = true;
      fullPending = false;
      clearTimeout(fullTimer);
      clearTimeout(fastTimer);
      log(`${signal}: no new runs${child ? ", waiting for the current one" : ""}`);
      if (child) {
        try {
          child.proc.kill("SIGTERM"); // the worker finishes its current job, then exits; its exit ends the scheduler
        } catch {
          /* already gone: its exit event decides */
        }
      } else exit(0);
    },
    // Test and shutdown helpers: what the scheduler believes right now.
    state: () => ({ child: child?.kind ?? null, fullPending, stopping }),
  };
}
