// Scheduler for the email worker:  node app/worker/cron.js   (the `worker` service in compose.yaml)
//
// Starts the one-shot worker (scripts/worker.mjs) at every 10-minute mark (:00, :10, :20 ...). The worker keeps
// its own rules (recovery, due jobs, retry delays); this file only decides WHEN it runs.
//   - No overlap: a run that is still going when the next mark arrives makes that mark skipped.
//   - A run that hangs is stopped (SIGTERM, then SIGKILL) after MAX_RUN_MS.
//   - The worker's output goes straight to this container's logs (docker compose logs worker).
// Plus a fast lane: about every minute the SAME script is started in WORKER_MODE=recommendations, which only works the plan-recommendation
// queue, so a freshly installed shop gets its recommendation promptly. The rules that keep the two lanes from overlapping, and from ever
// losing a 10-minute run, are in scheduler.js.
import { spawn } from "node:child_process";
import process from "node:process";
import { createScheduler, DEFAULT_FAST_INTERVAL_MS } from "./scheduler.js";

const INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS) || 10 * 60 * 1000; // override is for tests only
const FAST_INTERVAL_MS = Number(process.env.CRON_FAST_INTERVAL_MS) || DEFAULT_FAST_INTERVAL_MS; // override is for tests only
const MAX_RUN_MS = 8 * 60 * 1000;
const KILL_AFTER_MS = 30 * 1000;
const WORKER_SCRIPT = new URL("../../scripts/worker.mjs", import.meta.url).pathname;

const log = (message) => console.log(`[cron] ${new Date().toISOString()} ${message}`);

const scheduler = createScheduler({
  spawn,
  execPath: process.execPath,
  script: WORKER_SCRIPT,
  intervalMs: INTERVAL_MS,
  fastIntervalMs: FAST_INTERVAL_MS,
  maxFullRunMs: MAX_RUN_MS,
  killAfterMs: KILL_AFTER_MS,
  env: process.env,
  log,
  exit: (code) => process.exit(code),
});

process.on("SIGTERM", () => scheduler.stop("SIGTERM"));
process.on("SIGINT", () => scheduler.stop("SIGINT"));

scheduler.start();
