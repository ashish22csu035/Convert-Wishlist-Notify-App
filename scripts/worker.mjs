// Email worker entry point:  npm run worker
//
// One-shot: sends every restock email that is due now (queued by processRestock), including jobs that
// become due while it works, then exits. It does not wait for future restocks and does not poll. Run it
// again whenever you want queued mail sent; a job that failed transiently is scheduled for a later retry
// and is picked up by a later run once it is due.
//
// It does not talk to Shopify about inventory and does not run the web server (see README). Nothing is
// touched unless the whole configuration is valid, so a missing setting changes no jobs.
import { register } from "node:module";

register("./resolve-hooks.mjs", import.meta.url);

// Settings may live in .env (process.env wins over the file). Tests can switch this off.
if (!process.env.WORKER_SKIP_DOTENV) {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file: the environment alone is used */
  }
}

const { ConfigError, readWorkerConfig } = await import("../app/models/mail-config.server.js");

let config;
try {
  config = readWorkerConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error("[worker] not started: fix these settings (variable names only, no values are shown):");
  for (const problem of error.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// The Shopify client reads these when it is first imported.
process.env.SHOPIFY_APP_URL ||= config.baseUrl;

const { createTransport } = await import("nodemailer");
const { createWorker } = await import("../app/worker/worker.server.js");
const { queueSnapshot } = await import("../app/models/email-delivery.server.js");
const { getShopAdmin } = await import("../app/models/shopify-lookup.server.js");
const { recoverInventoryEvents } = await import("../app/models/inventory-webhook.server.js");
const { default: prisma } = await import("../app/db.server.js");

const transport = createTransport(config.smtp);
const worker = createWorker({
  recover: () => recoverInventoryEvents(),
  ctx: { transport, config: { mailFrom: config.mailFrom, baseUrl: config.baseUrl }, getAdmin: getShopAdmin },
});

// SIGINT / SIGTERM: finish the job being sent, claim nothing new, clean up, exit. Whatever is still
// queued stays queued for the next run.
let signal = null;
function onSignal(name) {
  if (signal) return;
  signal = name;
  console.log(`[worker] ${name}: finishing the current job, then stopping (remaining jobs stay queued)`);
  const force = setTimeout(() => {
    console.error("[worker] did not stop in time; exiting");
    process.exit(1);
  }, 45000);
  force.unref();
  worker.stop();
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

console.log("[worker] started (one-shot): sending queued emails that are due, then exiting");
let exitCode = 0;
try {
  const { handled, outcomes } = await worker.drain();
  const detail = Object.entries(outcomes).map(([status, count]) => `${status}: ${count}`).join(", ");
  console.log(`[worker] ${signal ? "stopped early" : "queue drained"}: ${handled} job(s) handled${detail ? ` (${detail})` : ""}`);
  if (outcomes.CRASHED) exitCode = 1;

  const left = await queueSnapshot();
  if (left.scheduled) {
    console.log(
      `[worker] ${left.scheduled} job(s) are scheduled for a retry (next due ${left.nextAttemptAt.toISOString()}). ` +
        "Run the worker again after that time to send them.",
    );
  }
  if (left.unknown) {
    console.log(`[worker] ${left.unknown} job(s) have an UNKNOWN result and are never resent automatically: check them by hand.`);
  }
} catch (error) {
  console.error(`[worker] failed: ${error?.code ?? error?.name ?? "error"}`);
  exitCode = 1;
} finally {
  transport.close();
  await prisma.$disconnect().catch(() => {});
}
process.exit(signal ? (exitCode || (signal === "SIGINT" ? 130 : 143)) : exitCode);
