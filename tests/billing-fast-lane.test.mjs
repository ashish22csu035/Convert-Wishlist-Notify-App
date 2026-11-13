// The plan-recommendation fast lane: app/worker/scheduler.js (wired by app/worker/cron.js), the recommendations-only mode of scripts/worker.mjs
// (runRecommendationJobs in app/worker/billing-jobs.server.js) and the install trigger's hand-over to it.
//
// Run: node --test tests/billing-fast-lane.test.mjs
// The scheduler tests use a fake `spawn` and fake timers: no process is started and nothing waits. The database tests WRITE rows, so they run only
// when DATABASE_URL names an isolated kw_*test* database with the migrations applied; otherwise they are skipped and say so. Set REDIS_URL="" too.
// Nothing here calls Shopify: every Admin client is a stub.
import "./helpers/resolve-extensionless.mjs";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { isTimezoneQuery, shopZoneAnswer } from "./helpers/shop-timezone.mjs";

const require = createRequire(import.meta.url);
const { createScheduler, FULL, RECOMMENDATIONS } = await import("../app/worker/scheduler.js");

const MIN = 60 * 1000;
const SEC = 1000;

// ======================= the scheduler =======================
// A fake child: records how it was started, can be ended by the test, and obeys kill() like a real process.
function harness(options = {}) {
  const spawned = [];
  const logs = [];
  const exits = [];
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const spawn = (execPath, args, opts) => {
    const call = calls++;
    if (options.throwOnSpawn?.(call)) throw Object.assign(new Error("spawn failed"), { code: "EAGAIN" });
    const proc = new EventEmitter();
    const neverStarts = options.noPid?.(call);
    proc.pid = neverStarts ? undefined : 1000 + spawned.length;
    proc.mode = opts.env.WORKER_MODE;
    proc.startedAt = Date.now();
    proc.signals = [];
    proc.alive = true;
    proc.end = (code = 0, signal = null) => {
      if (!proc.alive) return;
      proc.alive = false;
      active -= 1;
      proc.emit("exit", code, signal);
    };
    proc.kill = (signal) => {
      proc.signals.push(signal);
      if (signal === "SIGKILL" && !options.unkillable) proc.end(null, "SIGKILL");
      else if (signal === "SIGTERM" && options.exitOnTerm) proc.end(null, "SIGTERM");
    };
    if (neverStarts) {
      proc.alive = false; // a process that never started is not counted as running
      queueMicrotask(() => proc.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
    } else {
      active += 1;
      maxActive = Math.max(maxActive, active);
    }
    spawned.push({ proc, args, opts });
    return proc;
  };
  const scheduler = createScheduler({
    spawn,
    execPath: "node",
    script: "worker.mjs",
    intervalMs: 10 * MIN,
    fastIntervalMs: options.fastIntervalMs ?? 1 * MIN,
    maxFullRunMs: options.maxFullRunMs ?? 8 * MIN,
    maxFastRunMs: options.maxFastRunMs ?? 3 * MIN,
    killAfterMs: 30 * SEC,
    env: options.env ?? { KEEP: "yes" },
    log: (line) => logs.push(line),
    exit: (code) => exits.push(code),
  });
  return { scheduler, spawned, logs, exits, modes: () => spawned.map((s) => s.proc.mode), maxActive: () => maxActive };
}
const withClock = (fn) => async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
};
// Advances in 5-second steps: Node's mock clock moves Date.now() to the END of a tick before it runs the timers inside it, so one big tick would
// make a timer created by a callback (the scheduler re-arming itself) start from the wrong time. All times in these tests are multiples of 5 s.
const tick = async (ms) => {
  for (let left = ms; left > 0; left -= 5 * SEC) {
    mock.timers.tick(Math.min(5 * SEC, left));
    await Promise.resolve();
  }
};

test("the fast lane starts the SAME worker script in recommendations mode on its short interval; full runs say 'full'", withClock(async () => {
  const h = harness({ env: { KEEP: "yes", WORKER_MODE: "recommendations" } });
  h.scheduler.start();
  for (let minute = 1; minute <= 3; minute += 1) {
    await tick(MIN);
    h.spawned.at(-1).proc.end(0);
  }
  assert.deepEqual(h.modes(), [RECOMMENDATIONS, RECOMMENDATIONS, RECOMMENDATIONS], "one run per minute");
  assert.deepEqual(h.spawned.map((s) => s.proc.startedAt), [MIN, 2 * MIN, 3 * MIN]);
  assert.deepEqual(h.spawned.map((s) => s.args), [["worker.mjs"], ["worker.mjs"], ["worker.mjs"]], "the existing script, no new entry point");
  assert.equal(h.spawned[0].opts.env.KEEP, "yes", "the rest of the environment is passed on");
  for (let minute = 4; minute <= 10; minute += 1) {
    await tick(MIN);
    h.spawned.at(-1).proc.end(0);
  }
  const fullRuns = h.spawned.filter((s) => s.proc.mode === FULL);
  assert.deepEqual(fullRuns.map((s) => s.proc.startedAt), [10 * MIN], "the full run is on the 10-minute mark and always carries WORKER_MODE=full, even if the container's own environment said otherwise");
}));

test("children never overlap: a fast run in progress blocks further fast runs, and an active full run blocks the fast lane", withClock(async () => {
  const h = harness();
  h.scheduler.start();
  await tick(MIN);
  await tick(2 * MIN);
  assert.equal(h.spawned.length, 1, "two more ticks while the first fast run is still going start nothing");
  assert.deepEqual(h.scheduler.state(), { child: RECOMMENDATIONS, fullPending: false, stopping: false });
  h.spawned[0].proc.end(0); // 3 min
  for (let minute = 4; minute <= 9; minute += 1) {
    await tick(MIN);
    h.spawned.at(-1).proc.end(0);
  }
  await tick(MIN); // the 10-minute mark, with nothing running: the full run starts
  assert.equal(h.spawned.at(-1).proc.mode, FULL);
  const before = h.spawned.length;
  await tick(5 * MIN);
  assert.equal(h.spawned.length, before, "no recommendations-only child beside a running full worker (it does that step itself)");
  h.spawned.at(-1).proc.end(0);
  await tick(MIN);
  assert.equal(h.spawned.at(-1).proc.mode, RECOMMENDATIONS, "the fast lane resumes after the full run");
  assert.equal(h.maxActive(), 1);
}));

test("a full run that comes due during a fast run is not skipped: it starts the moment that run ends, and the 10-minute schedule is unchanged", withClock(async () => {
  const h = harness();
  h.scheduler.start();
  for (let minute = 1; minute <= 8; minute += 1) {
    await tick(MIN);
    h.spawned.at(-1).proc.end(0);
  }
  await tick(MIN); // minute 9: a fast run starts and is left running
  const fast = h.spawned.at(-1).proc;
  assert.equal(fast.mode, RECOMMENDATIONS);
  await tick(MIN + 5 * SEC); // the 10-minute mark passes while it runs
  assert.equal(h.modes().filter((mode) => mode === FULL).length, 0, "no second child while the fast run is active");
  assert.deepEqual(h.scheduler.state(), { child: RECOMMENDATIONS, fullPending: true, stopping: false }, "remembered, as one flag");
  await tick(MIN); // a further fast tick while the full run is waiting changes nothing
  assert.equal(h.spawned.length, 9, "still only the fast run (one per minute until then)");
  fast.end(0);
  const full = h.spawned.at(-1).proc;
  assert.equal(full.mode, FULL, "the full run starts immediately after the fast child exits");
  assert.equal(full.startedAt, 11 * MIN + 5 * SEC, "late, but not lost");
  assert.equal(h.scheduler.state().fullPending, false);
  full.end(0);
  assert.equal(h.modes().filter((mode) => mode === FULL).length, 1, "exactly one full run for that mark");
  // the next mark is the next wall-clock mark: the delayed run did not shift it
  for (let step = 0; step < 20; step += 1) {
    await tick(MIN);
    if (Date.now() >= 20 * MIN) break;
    h.spawned.at(-1).proc.end(0);
  }
  const fullStarts = h.spawned.filter((s) => s.proc.mode === FULL).map((s) => s.proc.startedAt);
  assert.deepEqual(fullStarts, [11 * MIN + 5 * SEC, 20 * MIN]);
}));

test("a full run due while a full run is still going is skipped as before, and nothing is queued behind it", withClock(async () => {
  const h = harness({ maxFullRunMs: 60 * MIN, fastIntervalMs: 1000 * MIN });
  h.scheduler.start();
  await tick(10 * MIN);
  const full = h.spawned.find((s) => s.proc.mode === FULL)?.proc;
  assert.ok(full, "the first mark started a full run");
  await tick(10 * MIN); // the second mark: still running
  assert.ok(h.logs.some((line) => /skipped: previous run still active/.test(line)));
  assert.equal(h.scheduler.state().fullPending, false, "a skipped full run is not remembered: its work is the one already running");
  full.end(0);
  assert.equal(h.spawned.at(-1).proc, full, "nothing starts when it ends");
}));

test("a child that cannot start, throws on spawn, exits non-zero, or errors never wedges the scheduler", withClock(async () => {
  const h = harness({ noPid: (i) => i === 0, throwOnSpawn: (i) => i === 1 });
  h.scheduler.start();
  await tick(MIN); // 1st: error without a pid, "exit" never comes
  await tick(0);
  assert.equal(h.scheduler.state().child, null, "released although no exit event will ever arrive");
  await tick(MIN); // 2nd: spawn() throws
  assert.equal(h.scheduler.state().child, null);
  await tick(MIN); // 3rd works and fails with exit 1
  h.spawned.at(-1).proc.end(1);
  assert.equal(h.scheduler.state().child, null);
  assert.ok(h.logs.some((line) => /recommendation run finished exit=1/.test(line)), "a failure is reported");
  await tick(MIN);
  assert.equal(h.spawned.at(-1).proc.alive, true, "the next minute still starts a run");
  // an error event from a child that DID start does not release it early; its exit does
  const started = h.spawned.at(-1).proc;
  started.emit("error", Object.assign(new Error("kill failed"), { code: "EPERM" }));
  assert.equal(h.scheduler.state().child, RECOMMENDATIONS);
  started.end(null, "SIGKILL");
  assert.equal(h.scheduler.state().child, null);
  assert.equal(h.maxActive(), 1);
}));

test("a hung child is stopped (SIGTERM, then SIGKILL), the state is released, and the next run starts", withClock(async () => {
  const h = harness();
  h.scheduler.start();
  await tick(MIN);
  const hung = h.spawned[0].proc;
  await tick(3 * MIN);
  assert.deepEqual(hung.signals, ["SIGTERM"], "stopped after the fast-run limit");
  assert.equal(h.scheduler.state().child, RECOMMENDATIONS, "until it has really gone");
  await tick(30 * SEC);
  assert.deepEqual(hung.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(h.scheduler.state().child, null, "released by its exit");
  assert.ok(h.logs.some((line) => /timed out/.test(line)));
  await tick(MIN);
  assert.equal(h.spawned.length >= 2 && h.spawned.at(-1).proc.alive, true, "recommendation processing continues");
}));

test("even a child that survives SIGKILL cannot block the scheduler forever", withClock(async () => {
  const h = harness({ unkillable: true });
  h.scheduler.start();
  await tick(MIN);
  await tick(3 * MIN + 30 * SEC + 30 * SEC);
  assert.equal(h.scheduler.state().child, null);
  assert.ok(h.logs.some((line) => /abandoned/.test(line)));
  assert.equal(h.spawned[0].proc.signals.at(-1), "SIGKILL");
}));

test("timers never build a backlog: an hour of ticks with children of every kind keeps at most one child and one timer per lane", withClock(async () => {
  const h = harness();
  h.scheduler.start();
  let n = 0;
  for (let second = 0; second < 3600; second += 15) {
    await tick(15 * SEC);
    const last = h.spawned.at(-1)?.proc;
    n += 1;
    if (last?.alive && n % 3 === 0) last.end(n % 2); // ends some, leaves others hanging until their time limit
  }
  assert.equal(h.maxActive(), 1, "never two children at once");
  assert.ok(h.spawned.length < 3600 / 60 + 10, "no more starts than there are fast ticks and marks");
}));

test("stop: SIGTERM goes to the current child, nothing new starts (a waiting full run is dropped), and the process exits when the child has", withClock(async () => {
  const h = harness();
  h.scheduler.start();
  await tick(9 * MIN);
  h.spawned.at(-1).proc.end(0);
  await tick(MIN);
  await tick(MIN); // 10-min mark: a fast run (started at minute 10 fast tick or earlier) is active
  h.scheduler.stop("SIGTERM");
  const live = h.spawned.at(-1).proc;
  assert.ok(live.signals.includes("SIGTERM"), "the child is asked to finish");
  assert.deepEqual(h.exits, [], "not before the child ends");
  const count = h.spawned.length;
  await tick(30 * MIN);
  assert.equal(h.spawned.length, count, "no new runs after stop");
  live.end(0);
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.spawned.length, count, "and a waiting full run was dropped, not started during shutdown");

  const idle = harness();
  idle.scheduler.start();
  idle.scheduler.stop("SIGINT");
  assert.deepEqual(idle.exits, [0], "idle: exits at once");
  await tick(60 * MIN);
  assert.equal(idle.spawned.length, 0);
}));

test("cron.js: the 10-minute cadence and the worker script are unchanged, the fast lane uses the same script, and no service or image is added", () => {
  const cron = fs.readFileSync("app/worker/cron.js", "utf8");
  assert.match(cron, /CRON_INTERVAL_MS\) \|\| 10 \* 60 \* 1000/);
  assert.match(cron, /scripts\/worker\.mjs/);
  assert.match(cron, /createScheduler/);
  const compose = fs.readFileSync("compose.yaml", "utf8");
  assert.deepEqual([...compose.matchAll(/^  ([a-z]+):\s*$/gm)].map((m) => m[1]), ["web", "worker", "redis", "migrate"], "no new Compose service");
  assert.match(compose, /command: \["node", "app\/worker\/cron\.js"\]/);
  assert.equal((fs.readFileSync("Dockerfile", "utf8").match(/^FROM /gm) ?? []).length, 4, "the Dockerfile still builds one image");
});

// ======================= the worker modes =======================
const env = (extra = {}) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, WORKER_SKIP_DOTENV: "1", ...extra });
const run = (extra) => spawnSync(process.execPath, ["scripts/worker.mjs"], { env: env(extra), encoding: "utf8", timeout: 30000 });

test("an unknown WORKER_MODE refuses to start instead of silently running the full worker", () => {
  const result = run({ WORKER_MODE: "bogus" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WORKER_MODE must be "full" or "recommendations"/);
  assert.doesNotMatch(result.stdout, /\[worker\] started/);
});

test("recommendations mode keeps the same configuration guard and never reaches the email path", () => {
  for (const extra of [{ WORKER_MODE: "recommendations" }, { WORKER_MODE: "full" }, {}]) {
    const result = run(extra);
    assert.equal(result.status, 1, JSON.stringify(extra));
    assert.match(result.stderr, /not started/);
    assert.doesNotMatch(result.stdout, /one-shot|queue drained|analytics daily/);
  }
});

test("the worker script: the recommendations branch comes before everything the full run does and ends the process; the full run is untouched", () => {
  const source = fs.readFileSync("scripts/worker.mjs", "utf8");
  const branch = source.indexOf('if (mode === "recommendations")');
  assert.ok(branch > 0);
  const tail = source.slice(branch, source.indexOf("const { createTransport }"));
  assert.match(tail, /runRecommendationJobs/);
  assert.match(tail, /process\.exit\(code\)/);
  assert.doesNotMatch(tail, /createTransport|createWorker|runAnalyticsDaily|runBillingJobs|runSubscriptionVerification|recoverInventoryEvents|queueSnapshot|drain\(/, "none of the full run's work is in the fast lane");
  assert.match(tail, /BILLING_MECHANISM: ""/, "no verifier can even be built");
  // the full run, as it was
  assert.match(source, /await runBillingJobs\(\{ services: getBillingServices\(\), shouldStop: \(\) => signal !== null \}\)/);
  assert.ok(source.indexOf("runBillingJobs({") < source.indexOf("await worker.drain()"));
  assert.ok(source.indexOf("await worker.drain()") < source.indexOf("runAnalyticsDaily({"));
  const jobs = fs.readFileSync("app/worker/billing-jobs.server.js", "utf8");
  const fastLane = jobs.slice(jobs.indexOf("export async function runRecommendationJobs"), jobs.indexOf("export async function runBillingJobs"));
  assert.doesNotMatch(fastLane, /runSubscriptionVerification|services\.verify/);
});

// ======================= database: install trigger -> fast lane -> result =======================
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""));
} catch {
  dbName = "";
}
const skip = /^kw_.*test/i.test(dbName) ? false : `DATABASE_URL does not name an isolated kw_*test* database (got "${dbName || "none"}"): database tests skipped`;
const dbTest = (name, fn) => test(name, { skip }, fn);
const { PrismaClient } = require("@prisma/client");
const prisma = skip ? null : new PrismaClient();
const { onShopAuthenticated } = await import("../app/models/install-recommendation.server.js");
const { createShopifyqlSessionSource } = await import("../app/models/session-source.server.js");
const { runRecommendationJobs, runBillingJobs } = await import("../app/worker/billing-jobs.server.js");
const R = await import("../app/models/plan-recommendation.server.js");

const quiet = { log() {}, error() {}, warn() {} };
const RUN = Date.now().toString(36);
const domains = [];
let seq = 0;
after(async () => {
  if (prisma) {
    await prisma.session.deleteMany({ where: { shop: { in: domains } } });
    await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
    await prisma.$disconnect();
  }
});
const newDomain = (tag) => {
  const domain = `kw-fl-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return domain;
};
const storeSession = (shop, scope) => prisma.session.create({ data: { id: `off_${shop}`, shop, state: "test", isOnline: false, scope, accessToken: "dummy-not-a-real-token" } });
const rowFor = (domain) => prisma.planRecommendation.findFirst({ where: { shop: { domain } } });
const table = (rows) => ({ data: { shopifyqlQuery: { tableData: { columns: [{ name: "sessions" }], rows }, parseErrors: [] } } });
const adminStub = (answer, scope = "read_reports") => {
  const getAdmin = async () => ({
    scope,
    admin: {
      graphql: async (query) => {
        if (isTimezoneQuery(query)) return { json: async () => shopZoneAnswer("UTC") };
        getAdmin.calls += 1;
        return { json: async () => answer };
      },
    },
  });
  getAdmin.calls = 0;
  return getAdmin;
};
// What the web process does at install, and what the fast lane then does, for one shop.
async function install(tag, { scope = "read_reports", sessions = "24500" } = {}) {
  const domain = newDomain(tag);
  const getAdmin = adminStub(table([{ sessions }]));
  const services = { fetchSessions: createShopifyqlSessionSource({ getAdmin }) };
  if (scope !== null) await storeSession(domain, scope);
  const shop = await prisma.shop.create({ data: { domain, currencyCode: "XXX" } });
  const authenticate = () => onShopAuthenticated({ shop: domain, isOnline: false }, { services, log: quiet });
  const fastLane = () => runRecommendationJobs({ services, shopIds: [shop.id], log: quiet });
  return { domain, shop, getAdmin, services, authenticate, fastLane };
}

dbTest("a freshly installed shop's job is picked up by the fast lane, with no full worker run: result, period and advice are stored", async () => {
  const s = await install("pickup");
  await s.authenticate();
  const queued = await rowFor(s.domain);
  assert.deepEqual([queued.status, queued.sessions30d, queued.recommendedPlan], ["PENDING", null, null], "the hook only queued it");
  assert.equal(s.getAdmin.calls, 0, "and made no analytics request");
  const result = await s.fastLane();
  assert.deepEqual([result.claimed, result.succeeded], [1, 1]);
  const done = await rowFor(s.domain);
  assert.deepEqual([done.status, done.sessions30d, done.recommendedPlan, done.attempts], ["SUCCEEDED", 24500, "ADVANCE", 0]);
  assert.ok(done.periodStart < done.periodEnd && done.fetchedAt);
  assert.equal(s.getAdmin.calls, 1);
});

dbTest("the threshold: 100,000 is Advance, 100,001 is Enterprise, through the fast lane", async () => {
  for (const [sessions, plan] of [["100000", "ADVANCE"], ["100001", "ENTERPRISE"]]) {
    const s = await install(`edge-${sessions}`, { sessions });
    await s.authenticate();
    await s.fastLane();
    assert.deepEqual([(await rowFor(s.domain)).sessions30d, (await rowFor(s.domain)).recommendedPlan], [Number(sessions), plan]);
  }
});

dbTest("duplicate installation events and repeated or simultaneous fast-lane runs make one job and one analytics request", async () => {
  const s = await install("dup");
  await Promise.all([s.authenticate(), s.authenticate(), s.authenticate()]);
  assert.equal(await prisma.planRecommendation.count({ where: { shop: { domain: s.domain } } }), 1);
  const runs = await Promise.all([s.fastLane(), s.fastLane(), s.fastLane()]);
  assert.equal(runs.reduce((sum, run) => sum + run.claimed, 0), 1, "only one of the simultaneous runs claimed it");
  assert.equal(s.getAdmin.calls, 1);
  await s.fastLane();
  assert.equal(s.getAdmin.calls, 1, "a later run finds nothing due");
});

dbTest("authenticating again (re-install, token refresh) does not reset or re-run a completed recommendation", async () => {
  const s = await install("reauth", { sessions: "150000" });
  await s.authenticate();
  await s.fastLane();
  const first = await rowFor(s.domain);
  assert.equal(first.recommendedPlan, "ENTERPRISE");
  await s.authenticate();
  await s.authenticate();
  await s.fastLane();
  const again = await rowFor(s.domain);
  assert.deepEqual([again.status, again.sessions30d, again.recommendedPlan, again.fetchedAt.getTime(), again.updatedAt.getTime()], [first.status, first.sessions30d, first.recommendedPlan, first.fetchedAt.getTime(), first.updatedAt.getTime()]);
  assert.equal(s.getAdmin.calls, 1, "no second analytics request");
});

dbTest("without the read_reports permission, without a session source, or with no session at all: no job, no request, no recommendation", async () => {
  const noScope = await install("noscope", { scope: "read_products" });
  await noScope.authenticate();
  assert.equal(await rowFor(noScope.domain), null);
  const none = await install("nosession", { scope: null });
  await none.authenticate();
  assert.equal(await rowFor(none.domain), null);
  const off = await install("nosource");
  assert.deepEqual(await onShopAuthenticated({ shop: off.domain, isOnline: false }, { services: { fetchSessions: null }, log: quiet }), { enqueued: false });
  assert.equal(await rowFor(off.domain), null);
  const idle = await runRecommendationJobs({ services: { fetchSessions: null }, shopIds: [noScope.shop.id, none.shop.id, off.shop.id], log: quiet });
  assert.equal(idle.skipped, "no_session_source");
  assert.equal(noScope.getAdmin.calls + none.getAdmin.calls + off.getAdmin.calls, 0);
});

dbTest("unavailable, invalid or empty analytics never become a count or a recommendation, and follow the existing retry schedule", async () => {
  for (const [tag, answer] of [["empty", table([])], ["junk", table([{ sessions: "n/a" }])], ["nodata", { data: { shopifyqlQuery: { tableData: null, parseErrors: [] } } }]]) {
    const domain = newDomain(`bad-${tag}`);
    await storeSession(domain, "read_reports");
    const shop = await prisma.shop.create({ data: { domain, currencyCode: "XXX" } });
    const services = { fetchSessions: createShopifyqlSessionSource({ getAdmin: adminStub(answer) }) };
    await onShopAuthenticated({ shop: domain, isOnline: false }, { services, log: quiet });
    await runRecommendationJobs({ services, shopIds: [shop.id], log: quiet });
    const row = await rowFor(domain);
    assert.deepEqual([row.sessions30d, row.recommendedPlan, R.publicRecommendation(row)], [null, null, null], tag);
    assert.equal(row.status, "FAILED", tag);
    const before = row.attempts;
    await runRecommendationJobs({ services, shopIds: [shop.id], log: quiet });
    assert.equal((await rowFor(domain)).attempts, before, `${tag}: the retry delay is respected: an immediate second fast-lane run does not claim it again`);
  }
});

dbTest("lease rules hold in the fast lane: a live claim is left alone, an abandoned one is taken over once, and the fast lane runs no verification", async () => {
  const s = await install("lease");
  await s.authenticate();
  const row = await rowFor(s.domain);
  const future = new Date(Date.now() + 10 * MIN);
  await prisma.planRecommendation.update({ where: { id: row.id }, data: { status: "RUNNING", attempts: 1, leaseExpiresAt: future } });
  assert.equal((await s.fastLane()).claimed, 0, "another worker holds it");
  assert.equal(s.getAdmin.calls, 0);
  await prisma.planRecommendation.update({ where: { id: row.id }, data: { leaseExpiresAt: new Date(Date.now() - MIN) } });
  const verify = mock.fn(async () => ({ outcome: "none" }));
  const result = await runRecommendationJobs({ services: { ...s.services, verify }, shopIds: [s.shop.id], log: quiet });
  assert.deepEqual([result.claimed, result.succeeded], [1, 1], "the abandoned job is recovered");
  assert.equal(verify.mock.callCount(), 0, "subscription verification is never part of the fast lane");
  assert.equal((await rowFor(s.domain)).attempts, 0, "a success starts a fresh history");
  // the full run still verifies and still processes recommendations
  const full = await runBillingJobs({ services: { ...s.services, verify }, shopIds: [s.shop.id], log: quiet });
  assert.ok("verification" in full && "recommendations" in full, "the normal run keeps both billing steps");
});

after(() => mock.timers.reset());
