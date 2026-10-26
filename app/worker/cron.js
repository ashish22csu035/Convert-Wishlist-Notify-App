// Scheduler for the email worker:  node app/worker/cron.js   (the `worker` service in compose.yaml)
//
// Starts the one-shot worker (scripts/worker.mjs) at every 10-minute mark (:00, :10, :20 ...). The worker keeps
// its own rules (recovery, due jobs, retry delays); this file only decides WHEN it runs.
//   - No overlap: a run that is still going when the next mark arrives makes that mark skipped.
//   - A run that hangs is stopped (SIGTERM, then SIGKILL) after MAX_RUN_MS.
//   - The worker's output goes straight to this container's logs (docker compose logs worker).
import { spawn } from "node:child_process";

const INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS) || 10 * 60 * 1000; // override is for tests only
const MAX_RUN_MS = 8 * 60 * 1000;
const KILL_AFTER_MS = 30 * 1000;
const WORKER_SCRIPT = new URL("../../scripts/worker.mjs", import.meta.url).pathname;

const log = (message) => console.log(`[cron] ${new Date().toISOString()} ${message}`);

let child = null;
let stopping = false;
let timer = null;

function runWorker() {
  if (child) {
    log("skipped: previous run still active");
    return;
  }
  log("worker run started");
  child = spawn(process.execPath, [WORKER_SCRIPT], { stdio: "inherit" });
  const term = setTimeout(() => {
    log("worker run timed out: stopping it");
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), KILL_AFTER_MS).unref();
  }, MAX_RUN_MS);
  child.on("error", (error) => log(`worker could not start: ${error.code ?? error.name}`));
  child.on("exit", (code, signal) => {
    clearTimeout(term);
    child = null;
    log(`worker run finished exit=${code ?? signal}`);
    if (stopping) process.exit(0);
  });
}

function scheduleNext() {
  const wait = INTERVAL_MS - (Date.now() % INTERVAL_MS);
  log(`next run in ${Math.round(wait / 1000)}s`);
  timer = setTimeout(() => {
    runWorker();
    scheduleNext();
  }, wait);
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  log(`${signal}: no new runs${child ? ", waiting for the current one" : ""}`);
  if (child) child.kill("SIGTERM"); // the worker finishes its current job, then exits
  else process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

log("scheduler started: worker runs every 10 minutes");
scheduleNext();
