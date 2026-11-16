// Tests for the daily-analytics failure diagnostics (describeFailure) and the build-versus-database check (schema-drift).
//
// Run: node --test tests/analytics-diagnostics.test.mjs
// The two data tests WRITE to the database in DATABASE_URL: run them on a scratch database only.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RUN = Date.now().toString(36);
const domains = [];
let W; // analytics-daily worker
let D; // schema-drift

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = "http://localhost:1";
  process.env.SCOPES = "write_products";
  W = await import("../app/worker/analytics-daily.server.js");
  D = await import("../app/worker/schema-drift.server.js");
});

after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  (await import("../app/db.server.js")).default.$disconnect();
});

// The failure the worker container reported, as Prisma words it: a client generated before NOTIFY_ADDED_TO_CART existed reads
// a row that has it.
const enumFailure = () => {
  const error = new Error("\nInvalid `prisma.activityEvent.groupBy()` invocation:\n\n\nValue 'NOTIFY_ADDED_TO_CART' not found in enum 'ActivityType'");
  error.name = "PrismaClientUnknownRequestError";
  return error;
};

test("describeFailure: production keeps only the code; development adds the cause's message and a short stack", () => {
  assert.deepEqual(W.describeFailure(enumFailure(), false), { reason: "PrismaClientUnknownRequestError" });
  const dev = W.describeFailure(enumFailure(), true);
  assert.equal(dev.reason, "PrismaClientUnknownRequestError");
  assert.match(dev.message, /Value 'NOTIFY_ADDED_TO_CART' not found in enum 'ActivityType'/, "the actual cause, which the bare name hid");
  assert.match(dev.stack, /PrismaClientUnknownRequestError|Error/);
  assert.ok(dev.stack.split(" | ").length <= 8, "the stack is capped");
  assert.equal(W.describeFailure({ code: "P2002" }, false).reason, "P2002", "a Prisma error code wins over the name");
  assert.equal(W.analyticsVerbose.length, 0);
});

test("describeFailure never prints customer data or secrets, and is bounded", () => {
  const error = new Error(`Unique constraint failed on the fields: (email)\nDuplicate entry 'customer.name@example.com' for key 'x'\nsecret=${"A1b2".repeat(12)} shop 3fa85f64-5717-4562-b3fc-2c963f66afa6 ${"z".repeat(5000)}`);
  const out = W.describeFailure(error, true);
  const text = JSON.stringify(out);
  assert.equal(text.includes("customer.name@example.com"), false, "an email address is replaced");
  assert.match(out.message, /\[email\]/);
  assert.equal(text.includes("A1b2A1b2A1b2A1b2A1b2A1b2"), false, "a long token is replaced");
  assert.equal(text.includes("3fa85f64-5717-4562-b3fc-2c963f66afa6"), false, "a uuid is replaced");
  assert.ok(out.message.length <= 400 && out.stack.length <= 1200);
  assert.deepEqual(W.describeFailure(null, true).reason, "error", "a thrown non-error is handled");
});

test("analytics-verbose follows NODE_ENV and ANALYTICS_DEBUG", () => {
  const saved = { env: process.env.NODE_ENV, debug: process.env.ANALYTICS_DEBUG };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.ANALYTICS_DEBUG;
    assert.equal(W.analyticsVerbose(), false);
    process.env.ANALYTICS_DEBUG = "1";
    assert.equal(W.analyticsVerbose(), true, "switchable in a production container without code changes");
    delete process.env.ANALYTICS_DEBUG;
    process.env.NODE_ENV = "development";
    assert.equal(W.analyticsVerbose(), true);
  } finally {
    if (saved.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.env;
    if (saved.debug === undefined) delete process.env.ANALYTICS_DEBUG;
    else process.env.ANALYTICS_DEBUG = saved.debug;
  }
});

test("a failing day is logged with its cause in development and without it in production; the other days are still written", async () => {
  const domain = `kw-diag-${RUN}.myshopify.com`;
  domains.push(domain);
  const shop = await prisma.shop.create({ data: { domain, currencyCode: "USD", installedAt: new Date("2026-10-20T00:00:00Z") } });
  const NOW = new Date("2026-10-22T10:00:00.000Z");
  const real = (await import("../app/models/analytics-daily.server.js")).calculateAnalyticsDay;
  const run = async (verbose) => {
    const lines = [];
    const saved = process.env.NODE_ENV;
    const savedDebug = process.env.ANALYTICS_DEBUG;
    process.env.NODE_ENV = verbose ? "development" : "production";
    delete process.env.ANALYTICS_DEBUG;
    try {
      const summary = await W.runAnalyticsDaily({
        now: () => NOW,
        shopIds: [shop.id],
        log: { log() {}, error: (line) => lines.push(line) },
        invalidate: async () => {},
        calculate: async (shopId, day) => {
          if (day === "2026-10-22") throw enumFailure(); // only the day holding the newer data fails
          return real(shopId, day);
        },
      });
      return { summary, lines };
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
      if (savedDebug !== undefined) process.env.ANALYTICS_DEBUG = savedDebug;
    }
  };
  const dev = await run(true);
  assert.ok(dev.summary.failed >= 1 && dev.summary.written >= 1, "one day failed, the others were written");
  const devLine = dev.lines.find((line) => line.includes("day failed"));
  assert.match(devLine, /"day":"2026-10-22"/);
  assert.match(devLine, /Value 'NOTIFY_ADDED_TO_CART' not found in enum 'ActivityType'/);
  assert.match(devLine, /"stack":/);
  const prod = await run(false);
  const prodLine = prod.lines.find((line) => line.includes("day failed"));
  assert.match(prodLine, /"reason":"PrismaClientUnknownRequestError"/);
  assert.equal(/NOTIFY_ADDED_TO_CART|"stack"|"message"/.test(prodLine), false, "production logs the code only, as before");
});

// ---------------------------------------------------------------------------------------------------------------------
const migrationsDir = (...names) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kw-mig-"));
  for (const name of names) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, "migration_lock.toml"), "provider = \"mysql\"");
  return dir;
};
const stubDb = (...applied) => ({ $queryRaw: async () => applied.map((migration_name) => ({ migration_name })) });

test("schema drift: an image older than the database is named, with the exact migrations and the fix", async () => {
  const dir = migrationsDir("20261116120000_funnel_summaries");
  const drift = await D.checkSchemaDrift(stubDb("20261116120000_funnel_summaries", "20261116180000_notify_cart_tracking"), dir);
  assert.deepEqual(drift, { unknownToBuild: ["20261116180000_notify_cart_tracking"], pendingInDb: [] });
  const [line] = D.driftMessages(drift);
  assert.match(line, /20261116180000_notify_cart_tracking/);
  assert.match(line, /this build is older than the database/);
  assert.match(line, /stale image, or the database was migrated from another branch/);
  assert.match(line, /Rebuild and restart the web and worker images/);
});

test("schema drift: a build ahead of the database says to migrate; matching builds and databases print nothing", async () => {
  const ahead = await D.checkSchemaDrift(stubDb("20261116120000_funnel_summaries"), migrationsDir("20261116120000_funnel_summaries", "20261116180000_notify_cart_tracking"));
  assert.deepEqual(ahead, { unknownToBuild: [], pendingInDb: ["20261116180000_notify_cart_tracking"] });
  assert.match(D.driftMessages(ahead)[0], /prisma migrate deploy/);
  const same = await D.checkSchemaDrift(stubDb("20261116120000_funnel_summaries"), migrationsDir("20261116120000_funnel_summaries"));
  assert.deepEqual(D.driftMessages(same), []);
  assert.equal(fs.readFileSync("scripts/worker.mjs", "utf8").includes("checkSchemaDrift(prisma)"), true, "the worker runs the check at the start of every run");
});

test("schema drift against the real migrations folder and database: this checkout and its (scratch) database agree", async () => {
  const drift = await D.checkSchemaDrift(prisma);
  assert.deepEqual(drift, { unknownToBuild: [], pendingInDb: [] });
});
