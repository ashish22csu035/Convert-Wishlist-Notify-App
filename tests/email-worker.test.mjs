// Tests for the restock email worker: claiming, sending, retries, ambiguity, eligibility, config,
// shutdown and the unsubscribe link.
//
// Run from the project root after `npm run build`:
//   node --test tests/email-worker.test.mjs
//
// NOTHING here sends mail or logs in to an SMTP server: the transport is a fake that records what it
// is given, and Shopify is a fake Admin client. So these tests prove the worker's logic and its
// database behaviour (real MySQL, real row locking); they do not prove that Gmail accepts the mail.
// Every worker call is scoped to uniquely named fixture shops, so queued jobs of real shops (for example
// the dev store's pending job) can never be claimed. A snapshot at the start and end proves they were not touched.
import "./helpers/resolve-extensionless.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphqlQueryError, HttpInternalError, HttpRequestError, HttpResponseError, HttpThrottlingError } from "@shopify/shopify-api";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const PORT = 3195;
const BASE = `http://localhost:${PORT}`;
const RUN = Date.now().toString(36);
const domains = [];
let seq = 9500000000;
let m; // modules, loaded after the environment is set
let appPrisma;
let server;
let realJobsBefore;

const CONFIG = { mailFrom: "sender@example.invalid", baseUrl: "https://app.example.invalid" };

async function makeShop(tag, data = {}) {
  const domain = `kw-ew-${tag}-${(seq += 1)}-${RUN}.myshopify.com`;
  domains.push(domain);
  return prisma.shop.create({ data: { domain, currencyCode: "XXX", ...data } });
}

// A queued email: shop, variant in stock at `cycle`, an ACTIVE subscription made at baseline 0, a PENDING job.
async function makeJob(shop, { cycle = 1, email = "customer@example.invalid", subStatus = "ACTIVE", baseline = 0, inStock = true, availabilityCycle, due = -1000, variantGid, subscription } = {}) {
  const n = (seq += 1);
  variantGid ??= `gid://shopify/ProductVariant/${n}`;
  const exists = await prisma.variantAvailability.findUnique({ where: { shopId_variantGid: { shopId: shop.id, variantGid } } });
  if (!exists) {
    await prisma.variantAvailability.create({
      data: { shopId: shop.id, variantGid, productGid: "gid://shopify/Product/7500000001", inventoryItemGid: `gid://shopify/InventoryItem/${n}`, isInStock: inStock, restockCycle: availabilityCycle ?? cycle },
    });
  }
  let sub = subscription;
  if (!sub) {
    const actor = await prisma.actor.create({ data: { shopId: shop.id, customerGid: `gid://shopify/Customer/${(seq += 1)}` } });
    sub = await prisma.notifySubscription.create({
      data: { shopId: shop.id, actorId: actor.id, productGid: "gid://shopify/Product/7500000001", variantGid, email, status: subStatus, baselineCycle: baseline, consentedAt: new Date(), consentSource: "test" },
    });
  }
  const job = await prisma.emailDelivery.create({
    data: { shopId: shop.id, subscriptionId: sub.id, restockCycle: cycle, variantGid, status: "PENDING", nextAttemptAt: new Date(Date.now() + due) },
  });
  return { job, sub, variantGid };
}

// Every queued email of every shop that is not a test fixture (read-only). Fixture shops of ALL test files
// start with "kw-" (kw-ew-, kw-rs-, kw-wh-, kw-dash-): other files run at the same time and create theirs.
async function realJobs() {
  const shops = await prisma.shop.findMany({ where: { NOT: { domain: { startsWith: "kw-" } } }, select: { id: true } });
  return JSON.stringify(await prisma.emailDelivery.findMany({ where: { shopId: { in: shops.map((x) => x.id) } }, orderBy: { id: "asc" } }));
}
const jobRow = (id) => prisma.emailDelivery.findUnique({ where: { id } });
const subRow = (id) => prisma.notifySubscription.findUnique({ where: { id } });

// ---- fakes ---------------------------------------------------------------------------------------
function fakeTransport({ delay = 0, fail } = {}) {
  const t = { calls: [], active: 0, maxActive: 0 };
  t.sendMail = async (mail) => {
    t.calls.push(mail);
    t.active += 1;
    t.maxActive = Math.max(t.maxActive, t.active);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const failure = typeof fail === "function" ? fail(t.calls.length) : fail;
      if (failure) throw Object.assign(new Error("smtp failure"), failure);
      return { accepted: [mail.to], rejected: [], messageId: mail.messageId };
    } finally {
      t.active -= 1;
    }
  };
  return t;
}
const PRODUCT = { id: null, title: "Large", product: { title: "Test Board", handle: "test-board", onlineStoreUrl: "https://shop.example.invalid/products/test-board", status: "ACTIVE" } };
function fakeAdmin(answer = (id) => ({ ...PRODUCT, id })) {
  return async () => ({
    scope: "",
    admin: {
      async graphql(query, { variables }) {
        const node = await answer(variables.id);
        return { json: async () => ({ data: { node } }) };
      },
    },
  });
}
const ctxWith = (transport, over = {}) => ({ transport, config: CONFIG, getAdmin: fakeAdmin(), ...over });
const run = (shop, job, ctx, now) => m.processJob(job, { ...ctx, ...(now ? { now: () => now } : {}) });
async function claimAndRun(shop, ctx) {
  const job = await m.claimNext({ shopIds: [shop.id] });
  assert.ok(job, "a job was claimed");
  return { job, result: await m.processJob(job, ctx) };
}
const tokenFrom = (mail) => new URL(/Unsubscribe: (\S+)/.exec(mail.text)[1]).searchParams.get("t");

before(async () => {
  process.env.SHOPIFY_API_KEY = "dummy-key";
  process.env.SHOPIFY_API_SECRET = "dummy-secret-for-tests-only";
  process.env.SHOPIFY_APP_URL = BASE;
  process.env.SCOPES = "write_products";
  m = {
    ...(await import("../app/models/email-delivery.server.js")),
    ...(await import("../app/models/unsubscribe.server.js")),
    ...(await import("../app/models/mail-config.server.js")),
    ...(await import("../app/models/restock-email.server.js")),
    ...(await import("../app/worker/worker.server.js")),
  };
  appPrisma = (await import("../app/db.server.js")).default;
  realJobsBefore = await realJobs();

  server = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (c) => (output += c));
  server.stderr.on("data", (c) => (output += c));
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

after(async () => {
  const realJobsAfter = await realJobs();
  await prisma.shop.deleteMany({ where: { domain: { in: domains } } });
  const left = await prisma.shop.count({ where: { domain: { in: domains } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
  server?.kill();
  assert.equal(left, 0, "test shops were removed");
  assert.equal(realJobsAfter, realJobsBefore, "queued jobs of real shops were not touched");
});

// ======================= claiming =======================
test("claiming takes a due PENDING job: SENDING, one attempt, a lease; not-due, finished and other shops' jobs are left alone", async () => {
  const shop = await makeShop("claim");
  const other = await makeShop("claim-other");
  const { job: due } = await makeJob(shop);
  const { job: later } = await makeJob(shop, { due: 60 * 60 * 1000 });
  const { job: sent } = await makeJob(shop);
  await prisma.emailDelivery.update({ where: { id: sent.id }, data: { status: "SENT" } });
  const { job: foreign } = await makeJob(other);

  const claimed = await m.claimNext({ shopIds: [shop.id], leaseMs: 60000 });
  assert.equal(claimed.id, due.id);
  assert.equal(claimed.status, "SENDING");
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.leaseExpiresAt > new Date());
  assert.equal(await m.claimNext({ shopIds: [shop.id] }), null, "nothing else is due in this shop");
  assert.equal((await jobRow(later.id)).status, "PENDING");
  assert.equal((await jobRow(foreign.id)).status, "PENDING");
});

test("CONCURRENT claims (real MySQL): each job is claimed by exactly one caller", async () => {
  const shop = await makeShop("race");
  const one = await makeJob(shop);
  const results = await Promise.all(Array.from({ length: 12 }, () => m.claimNext({ shopIds: [shop.id] })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).id, one.job.id);
  assert.equal((await jobRow(one.job.id)).attempts, 1);

  const shop2 = await makeShop("race2");
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await makeJob(shop2)).job.id);
  const many = (await Promise.all(Array.from({ length: 14 }, () => m.claimNext({ shopIds: [shop2.id] })))).filter(Boolean);
  assert.equal(many.length, 5);
  // ids are UUID strings: a plain sort puts both lists in the same order
  assert.deepEqual(many.map((j) => j.id).sort(), ids.sort(), "five different jobs, none twice");
});

test("two workers racing over the same job send it once", async () => {
  const shop = await makeShop("tworkers");
  await makeJob(shop);
  const transport = fakeTransport({ delay: 30 });
  const a = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
  const b = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
  const [x, y] = await Promise.all([a.tick(), b.tick()]);
  assert.equal(x + y, 1);
  assert.equal(transport.calls.length, 1);
});

// ======================= sending =======================
test("a successful send: one email with the right content, the job SENT, the subscription FULFILLED, one event, and never again", async () => {
  const shop = await makeShop("ok", { name: "Snow Shop" });
  const { job, sub, variantGid } = await makeJob(shop, { email: "buyer@example.invalid" });
  const transport = fakeTransport();
  const { result } = await claimAndRun(shop, ctxWith(transport));
  assert.equal(result, "SENT");

  assert.equal(transport.calls.length, 1);
  const mail = transport.calls[0];
  assert.equal(mail.to, "buyer@example.invalid");
  assert.equal(mail.subject, "Test Board (Large) is back in stock");
  const variantId = variantGid.split("/").pop();
  assert.match(mail.text, /back in stock/);
  assert.ok(mail.text.includes(`https://shop.example.invalid/products/test-board?variant=${variantId}`), "link to the exact variant");
  assert.ok(mail.html.includes(`variant=${variantId}`));
  assert.deepEqual(mail.from, { name: "Snow Shop", address: "sender@example.invalid" });
  assert.match(mail.headers["List-Unsubscribe"], /^<https:\/\/app\.example\.invalid\/notify\/unsubscribe\?t=[A-Za-z0-9_-]{43}>$/);
  assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const row = await jobRow(job.id);
  assert.equal(row.status, "SENT");
  assert.ok(row.sentAt);
  assert.equal(row.outboundMessageId, mail.messageId);
  assert.equal(row.linkTokenHash, crypto.createHash("sha256").update(tokenFrom(mail)).digest("hex"), "only the hash of the link token is stored");
  assert.notEqual(row.linkTokenHash, tokenFrom(mail));
  assert.equal(row.leaseExpiresAt, null);
  assert.equal((await subRow(sub.id)).status, "FULFILLED");
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id, type: "RESTOCK_EMAIL_SENT", feature: "NOTIFY_ME", variantGid } }), 1);

  // another pass, and a brand-new worker (a restart): nothing more is sent
  const again = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
  assert.equal(await again.tick(), 0);
  assert.equal(transport.calls.length, 1);
});

test("a second queued job for an already-notified subscription is skipped, so one customer gets one email", async () => {
  const shop = await makeShop("twojobs");
  const first = await makeJob(shop, { cycle: 1, availabilityCycle: 2 });
  await makeJob(shop, { cycle: 2, availabilityCycle: 2, variantGid: first.variantGid, subscription: first.sub });
  const transport = fakeTransport();
  const worker = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
  assert.equal(await worker.tick(), 2);
  assert.equal(transport.calls.length, 1);
  const rows = await prisma.emailDelivery.findMany({ where: { subscriptionId: first.sub.id }, orderBy: { restockCycle: "asc" } });
  assert.deepEqual(rows.map((r) => [r.restockCycle, r.status, r.errorCode]), [[1, "SENT", null], [2, "SKIPPED", "subscription_not_active"]]);
});

// ======================= failures =======================
test("a retryable failure goes back to PENDING with growing backoff, and is FAILED after the last attempt; nothing is marked sent", async () => {
  const shop = await makeShop("retry");
  const { job, sub } = await makeJob(shop);
  const transport = fakeTransport({ fail: { code: "ECONNECTION", command: "CONN" } });
  let clock = new Date();
  const seen = [];
  for (let attempt = 1; attempt <= m.MAX_ATTEMPTS; attempt += 1) {
    const claimed = await m.claimNext({ shopIds: [shop.id], now: clock });
    assert.ok(claimed, `attempt ${attempt} is due`);
    assert.equal(claimed.attempts, attempt);
    const result = await m.processJob(claimed, { ...ctxWith(transport), now: () => clock });
    const row = await jobRow(job.id);
    seen.push([result, row.status, row.nextAttemptAt && row.nextAttemptAt.getTime() - clock.getTime()]);
    assert.equal(row.outboundMessageId, null, "an attempt that sent nothing leaves no message id");
    assert.equal(row.linkTokenHash, null, "and no valid unsubscribe token");
    if (row.status === "PENDING") {
      assert.equal(await m.claimNext({ shopIds: [shop.id], now: clock }), null, "not due again before its backoff has passed");
      clock = new Date(row.nextAttemptAt.getTime() + 1);
    }
  }
  assert.deepEqual(seen.map((s) => s[1]), ["PENDING", "PENDING", "PENDING", "PENDING", "FAILED"]);
  assert.deepEqual(seen.slice(0, 4).map((s) => s[2]), [60000, 240000, 960000, 3840000], "1, 4, 16, 64 minutes");
  assert.equal(transport.calls.length, m.MAX_ATTEMPTS);
  assert.equal((await subRow(sub.id)).status, "ACTIVE", "the customer is still waiting, not wrongly marked as notified");
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id, type: "RESTOCK_EMAIL_SENT" } }), 0);
});

test("a server that declines for now (4xx) is retried; one that refuses the message (5xx) is a permanent failure", async () => {
  const shop = await makeShop("codes");
  const temp = await makeJob(shop);
  assert.equal((await claimAndRun(shop, ctxWith(fakeTransport({ fail: { responseCode: 421, command: "DATA" } })))).result, "PENDING");
  assert.equal((await jobRow(temp.job.id)).status, "PENDING");

  const perm = await makeJob(shop);
  await prisma.emailDelivery.update({ where: { id: temp.job.id }, data: { nextAttemptAt: new Date(Date.now() + 3600000) } });
  const { result } = await claimAndRun(shop, ctxWith(fakeTransport({ fail: { responseCode: 550, command: "RCPT TO" } })));
  assert.equal(result, "FAILED");
  const row = await jobRow(perm.job.id);
  assert.deepEqual([row.status, row.attempts], ["FAILED", 1]);
  assert.match(row.errorCode, /^smtp_/);
});

test("AMBIGUOUS outcome (connection lost while sending): marked UNKNOWN, never sent again, subscription not marked notified", async () => {
  for (const failure of [{ code: "ETIMEDOUT", command: "DATA" }, { code: "ESOCKET" }, { code: "ECONNRESET", command: "API" }, {}]) {
    const shop = await makeShop("ambiguous");
    const { job, sub } = await makeJob(shop);
    const transport = fakeTransport({ fail: failure });
    const { result } = await claimAndRun(shop, ctxWith(transport));
    assert.equal(result, "UNKNOWN", JSON.stringify(failure));
    const row = await jobRow(job.id);
    assert.deepEqual([row.status, row.errorCode], ["UNKNOWN", "send_outcome_unknown"]);
    assert.ok(row.outboundMessageId, "the message id is kept so the mail can be traced");
    assert.equal((await subRow(sub.id)).status, "ACTIVE");

    const worker = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
    for (let i = 0; i < 3; i += 1) assert.equal(await worker.tick(), 0);
    await m.recoverExpiredLeases({ shopIds: [shop.id], now: new Date(Date.now() + 24 * 3600000) });
    assert.equal(await worker.tick(), 0);
    assert.equal(transport.calls.length, 1, "no automatic resend, whatever time passes");
    assert.equal((await jobRow(job.id)).status, "UNKNOWN");
  }
});

test("SMTP accepting nothing is a failure, not a success", async () => {
  const shop = await makeShop("rejected");
  const { job, sub } = await makeJob(shop);
  const transport = { calls: [], sendMail: async (mail) => (transport.calls.push(mail), { accepted: [], rejected: [mail.to] }) };
  assert.equal((await claimAndRun(shop, ctxWith(transport))).result, "FAILED");
  assert.equal((await jobRow(job.id)).errorCode, "smtp_not_accepted");
  assert.equal((await subRow(sub.id)).status, "ACTIVE");
});

test("if the send succeeded but recording it fails, the job is never resent: it becomes UNKNOWN once its lease expires", async () => {
  const shop = await makeShop("unrecorded");
  const { job, sub } = await makeJob(shop);
  const transport = fakeTransport();
  const original = appPrisma.$transaction;
  appPrisma.$transaction = async () => {
    throw new Error("database went away");
  };
  let result;
  try {
    result = (await claimAndRun(shop, ctxWith(transport))).result;
  } finally {
    appPrisma.$transaction = original;
  }
  assert.equal(result, "SENT_UNRECORDED");
  assert.equal(transport.calls.length, 1);
  assert.equal((await jobRow(job.id)).status, "SENDING");

  await m.recoverExpiredLeases({ shopIds: [shop.id], now: new Date(Date.now() + 3600000) });
  assert.equal((await jobRow(job.id)).status, "UNKNOWN");
  const worker = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
  assert.equal(await worker.tick(), 0);
  assert.equal(transport.calls.length, 1);
  assert.equal((await subRow(sub.id)).status, "ACTIVE");
});

test("stuck claims: before the SMTP call it is safe to retry, after it the outcome is unknown", async () => {
  const shop = await makeShop("lease");
  const past = new Date(Date.now() - 1000);
  const mk = async (data) => {
    const { job } = await makeJob(shop);
    await prisma.emailDelivery.update({ where: { id: job.id }, data: { status: "SENDING", leaseExpiresAt: past, ...data } });
    return job.id;
  };
  const beforeSend = await mk({ attempts: 1 });
  const afterSend = await mk({ attempts: 1, outboundMessageId: `<lease-${RUN}@x.invalid>` });
  const exhausted = await mk({ attempts: m.MAX_ATTEMPTS });
  const live = await mk({ attempts: 1, leaseExpiresAt: new Date(Date.now() + 600000) });

  assert.equal(await m.recoverExpiredLeases({ shopIds: [shop.id] }), 3);
  assert.equal((await jobRow(beforeSend)).status, "PENDING");
  assert.deepEqual([(await jobRow(afterSend)).status, (await jobRow(afterSend)).errorCode], ["UNKNOWN", "lease_expired"]);
  assert.equal((await jobRow(exhausted)).status, "FAILED");
  assert.equal((await jobRow(live)).status, "SENDING", "a lease that has not expired is respected");
});

// ======================= eligibility =======================
test("jobs that are no longer eligible are SKIPPED and nothing is sent", async () => {
  const cases = [
    ["subscription_not_active", { subStatus: "UNSUBSCRIBED" }],
    ["subscription_not_active", { subStatus: "FULFILLED" }],
    ["already_covered", { baseline: 1 }],
    ["out_of_stock_again", { inStock: false }],
    ["out_of_stock_again", { cycle: 3, availabilityCycle: 2 }],
  ];
  for (const [reason, options] of cases) {
    const shop = await makeShop("inelig");
    const { job } = await makeJob(shop, options);
    const transport = fakeTransport();
    const { result } = await claimAndRun(shop, ctxWith(transport));
    assert.equal(result, "SKIPPED", reason);
    const row = await jobRow(job.id);
    assert.deepEqual([row.status, row.errorCode], ["SKIPPED", reason]);
    assert.equal(transport.calls.length, 0);
  }
  const off = await makeShop("off");
  await prisma.shopSettings.create({ data: { shopId: off.id, notifyMeEnabled: false } });
  const { job } = await makeJob(off);
  const t = fakeTransport();
  assert.equal((await claimAndRun(off, ctxWith(t))).result, "SKIPPED");
  assert.equal((await jobRow(job.id)).errorCode, "notify_disabled");
  assert.equal(t.calls.length, 0);

  const gone = await makeShop("inactive");
  const inactive = await makeJob(gone);
  await prisma.shop.update({ where: { id: gone.id }, data: { status: "UNINSTALLED" } });
  assert.equal((await claimAndRun(gone, ctxWith(t))).result, "SKIPPED");
  assert.equal((await jobRow(inactive.job.id)).errorCode, "shop_inactive");
});

test("an unsubscribe between queueing and sending stops the email", async () => {
  const shop = await makeShop("unsub-before");
  const { job, sub } = await makeJob(shop);
  await prisma.notifySubscription.update({ where: { id: sub.id }, data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() } });
  const transport = fakeTransport();
  assert.equal((await claimAndRun(shop, ctxWith(transport))).result, "SKIPPED");
  assert.equal(transport.calls.length, 0);
  assert.equal((await jobRow(job.id)).errorCode, "subscription_not_active");
});

test("without a usable recipient or product information nothing is sent and nothing is invented", async () => {
  for (const email of ["", "not-an-email", "a@b", "spaces in@x.com"]) {
    const shop = await makeShop("norecipient");
    const { job } = await makeJob(shop, { email });
    const transport = fakeTransport();
    assert.equal((await claimAndRun(shop, ctxWith(transport))).result, "SKIPPED", JSON.stringify(email));
    assert.equal((await jobRow(job.id)).errorCode, "no_recipient");
    assert.equal(transport.calls.length, 0);
  }
  const products = [
    ["deleted variant", () => null],
    ["draft product", (id) => ({ ...PRODUCT, id, product: { ...PRODUCT.product, status: "DRAFT" } })],
    ["archived product", (id) => ({ ...PRODUCT, id, product: { ...PRODUCT.product, status: "ARCHIVED" } })],
    ["no title", (id) => ({ ...PRODUCT, id, product: { ...PRODUCT.product, title: "  " } })],
    ["no link at all", (id) => ({ ...PRODUCT, id, product: { ...PRODUCT.product, onlineStoreUrl: null, handle: "" } })],
    ["insecure link", (id) => ({ ...PRODUCT, id, product: { ...PRODUCT.product, onlineStoreUrl: "http://shop.example.invalid/products/x" } })],
    ["another variant's answer", () => ({ ...PRODUCT, id: "gid://shopify/ProductVariant/1" })],
  ];
  for (const [name, answer] of products) {
    const shop = await makeShop("noproduct");
    const { job } = await makeJob(shop);
    const transport = fakeTransport();
    assert.equal((await claimAndRun(shop, ctxWith(transport, { getAdmin: fakeAdmin(answer) }))).result, "SKIPPED", name);
    assert.equal((await jobRow(job.id)).errorCode, "product_unavailable", name);
    assert.equal(transport.calls.length, 0, name);
  }
});

test("when Shopify cannot be reached the job is retried later, not skipped and not sent", async () => {
  const shop = await makeShop("adminfail");
  const { job } = await makeJob(shop);
  const transport = fakeTransport();
  const down = async () => { throw new Error("network down"); };
  const { result } = await claimAndRun(shop, ctxWith(transport, { getAdmin: down }));
  assert.equal(result, "PENDING");
  const row = await jobRow(job.id);
  assert.deepEqual([row.status, row.attempts, row.errorCode], ["PENDING", 1, "product_lookup_failed"]);
  assert.ok(row.nextAttemptAt > new Date());
  assert.equal(transport.calls.length, 0);
});

// ======================= email content =======================
test("the email is built safely: no header injection, HTML escaped, settings applied, link https only", () => {
  const shop = { domain: "s.myshopify.com", name: "S" };
  const base = { shop, settings: null, variantGid: "gid://shopify/ProductVariant/42", recipient: "a@b.com", mailFrom: "x@y.com", unsubscribeLink: "https://app.example.invalid/notify/unsubscribe?t=abc", messageId: "<id@x>" };
  const evil = m.buildRestockEmail({ ...base, product: { productTitle: "Board\r\nBcc: attacker@evil.com <script>alert(1)</script>", handle: "board", onlineStoreUrl: null, variantTitle: "" } });
  assert.equal(/[\r\n]/.test(evil.subject), false, "no line breaks in the subject");
  assert.equal(evil.html.includes("<script>"), false);
  assert.ok(evil.html.includes("&lt;script&gt;"));
  assert.equal(evil.to, "a@b.com");
  assert.ok(evil.text.includes("https://s.myshopify.com/products/board?variant=42"), "link built from the shop domain and handle");

  const custom = m.buildRestockEmail({ ...base, settings: { emailSubject: "Back: {{product}}", emailBody: "It is here: {{product}}", buttonLabel: "Buy", senderName: "Snow Co", replyToEmail: "help@snow.com" }, product: { productTitle: "Board", handle: "board", variantTitle: "Default Title" } });
  assert.deepEqual([custom.subject, custom.from, custom.replyTo], ["Back: Board", { name: "Snow Co", address: "x@y.com" }, "help@snow.com"]);
  assert.ok(custom.text.includes("It is here: Board") && custom.text.includes("Buy:"));

  assert.equal(m.buildRestockEmail({ ...base, product: { productTitle: "T", handle: "h", onlineStoreUrl: "javascript:alert(1)" } }), null);
  assert.equal(m.buildRestockEmail({ ...base, variantGid: "gid://shopify/ProductVariant/abc", product: { productTitle: "T", handle: "h" } }), null);
  assert.equal(m.buildRestockEmail({ ...base, recipient: "", product: { productTitle: "T", handle: "h" } }), null);
});

// ======================= configuration =======================
test("configuration: missing or invalid settings are reported by NAME only, never by value", () => {
  assert.throws(() => m.readWorkerConfig({}), (e) => e instanceof m.ConfigError && ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "APP_PUBLIC_URL"].every((n) => e.problems.join(" ").includes(n)));
  const secret = "hunter2-very-secret";
  try {
    m.readWorkerConfig({ SMTP_HOST: "h", SMTP_PORT: "nope", SMTP_USER: "u@x.com", SMTP_PASS: secret, MAIL_FROM: "not an address", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", SHOPIFY_APP_URL: "http://insecure.example.com" });
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof m.ConfigError);
    assert.equal(error.message.includes(secret) || JSON.stringify(error.problems).includes(secret), false, "the password never appears");
    assert.ok(error.problems.some((p) => p.includes("SMTP_PORT")) && error.problems.some((p) => p.includes("MAIL_FROM")) && error.problems.some((p) => p.includes("https")));
  }
  const ok = m.readWorkerConfig({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465", SMTP_USER: "u@gmail.com", SMTP_PASS: "p", MAIL_FROM: "Shop <shop@gmail.com>", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", APP_PUBLIC_URL: "https://app.example.com/ignored/path", WORKER_INTERVAL_MS: "5000" });
  assert.deepEqual([ok.smtp.host, ok.smtp.port, ok.smtp.secure, ok.mailFrom, ok.baseUrl, ok.intervalMs], ["smtp.gmail.com", 465, true, "shop@gmail.com", "https://app.example.com", 5000]);
  assert.equal(m.readWorkerConfig({ SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p", MAIL_FROM: "a@b.com", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", SHOPIFY_APP_URL: "http://localhost:3000" }).smtp.secure, false);
  assert.throws(() => m.readWorkerConfig({ SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p", MAIL_FROM: "a@b.com", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", SHOPIFY_APP_URL: "https://a.b", WORKER_INTERVAL_MS: "10" }), m.ConfigError);
});

test("the worker refuses to start without SMTP settings, says which are missing, and changes no job", async () => {
  const shop = await makeShop("startup");
  const { job } = await makeJob(shop);
  const result = spawnSync(process.execPath, ["scripts/worker.mjs"], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, WORKER_SKIP_DOTENV: "1" },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not started/);
  assert.match(result.stderr, /SMTP_HOST is missing/);
  assert.match(result.stderr, /SMTP_PASS is missing/);
  assert.equal((await jobRow(job.id)).status, "PENDING", "no pending job was touched");
  assert.equal((await jobRow(job.id)).attempts, 0);
});

// ======================= the loop =======================
test("shutdown: the job in progress finishes, nothing new is claimed, and the loop stays stopped", async () => {
  const shop = await makeShop("shutdown");
  const first = await makeJob(shop);
  const second = await makeJob(shop);
  const transport = fakeTransport({ delay: 250 });
  const worker = m.createWorker({ intervalMs: 20, shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
  worker.start();
  while (transport.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
  await worker.stop(); // returns only after the email being sent is finished
  const statuses = [(await jobRow(first.job.id)).status, (await jobRow(second.job.id)).status].sort();
  assert.deepEqual(statuses, ["PENDING", "SENT"], "one finished, the other was not started");
  assert.equal(transport.calls.length, 1);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(transport.calls.length, 1, "no further work after stop");
  assert.equal((await jobRow(second.job.id)).attempts + (await jobRow(first.job.id)).attempts, 1);
});

test("passes never overlap, even with a tiny interval and slow sends", async () => {
  const shop = await makeShop("overlap");
  for (let i = 0; i < 4; i += 1) await makeJob(shop);
  const transport = fakeTransport({ delay: 60 });
  const worker = m.createWorker({ intervalMs: 5, shopIds: [shop.id], ctx: ctxWith(transport), log: { log() {}, error() {} } });
  worker.start();
  const deadline = Date.now() + 10000;
  while ((await prisma.emailDelivery.count({ where: { shopId: shop.id, status: "SENT" } })) < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  await worker.stop();
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.maxActive, 1, "only one send at a time from one worker");
});

// ======================= one-shot drain =======================
const quiet = { log() {}, error() {} };

test("drain sends every due job, then resolves; a job due later is left PENDING and untouched, and a second drain finds nothing", async () => {
  const shop = await makeShop("drain");
  const due = [await makeJob(shop), await makeJob(shop), await makeJob(shop)];
  const later = await makeJob(shop, { due: 60 * 60 * 1000 });
  const transport = fakeTransport();
  const worker = m.createWorker({ batchSize: 2, shopIds: [shop.id], ctx: ctxWith(transport), log: quiet }); // several passes are needed

  const summary = await worker.drain();
  assert.deepEqual([summary.handled, summary.outcomes, summary.interrupted], [3, { SENT: 3 }, false]);
  assert.equal(transport.calls.length, 3);
  for (const { job, sub } of due) {
    assert.equal((await jobRow(job.id)).status, "SENT");
    assert.equal((await subRow(sub.id)).status, "FULFILLED");
  }
  const waiting = await jobRow(later.job.id);
  assert.deepEqual([waiting.status, waiting.attempts], ["PENDING", 0], "scheduled for later: not claimed, not attempted");

  assert.deepEqual((await worker.drain()).handled, 0, "nothing is due, so it exits straight away");
  assert.equal(transport.calls.length, 3, "and nothing is sent twice");
  const left = await m.queueSnapshot({ shopIds: [shop.id] });
  assert.deepEqual([left.scheduled, left.unknown], [1, 0]);
  assert.equal(left.nextAttemptAt.getTime(), waiting.nextAttemptAt.getTime());
});

test("drain also sends a job that becomes due while it is draining", async () => {
  const shop = await makeShop("drain-live");
  await makeJob(shop);
  let added;
  const transport = fakeTransport();
  const send = transport.sendMail;
  transport.sendMail = async (mail) => {
    if (!added) added = await makeJob(shop); // queued while the first email is being sent
    return send(mail);
  };
  const summary = await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: quiet }).drain();
  assert.equal(summary.handled, 2);
  assert.equal((await jobRow(added.job.id)).status, "SENT");
});

test("a transient failure is scheduled for a later run: drain makes one attempt, does not loop, and reports it", async () => {
  const shop = await makeShop("drain-retry");
  const { job, sub } = await makeJob(shop);
  const transport = fakeTransport({ fail: { responseCode: 421 } });
  const started = Date.now();
  const summary = await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: quiet }).drain();
  assert.deepEqual([summary.handled, summary.outcomes], [1, { PENDING: 1 }]);
  assert.equal(transport.calls.length, 1, "not retried within the same run");
  const row = await jobRow(job.id);
  assert.deepEqual([row.status, row.attempts], ["PENDING", 1]);
  assert.ok(row.nextAttemptAt.getTime() >= started + 55000, "the retry is a minute or more away");
  assert.equal((await subRow(sub.id)).status, "ACTIVE");
  assert.equal((await m.queueSnapshot({ shopIds: [shop.id] })).scheduled, 1);
  // A later run before it is due still leaves it alone.
  assert.equal((await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: quiet }).drain()).handled, 0);
  assert.equal(transport.calls.length, 1);
});

test("drain never revives FAILED, UNKNOWN, SKIPPED or SENT jobs", async () => {
  const shop = await makeShop("drain-final");
  const rows = [];
  for (const status of ["FAILED", "UNKNOWN", "SKIPPED", "SENT"]) {
    const made = await makeJob(shop);
    await prisma.emailDelivery.update({ where: { id: made.job.id }, data: { status, attempts: 2, errorCode: status === "SENT" ? null : "x" } });
    rows.push([made.job.id, status]);
  }
  const transport = fakeTransport();
  const summary = await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: quiet }).drain();
  assert.equal(summary.handled, 0);
  assert.equal(transport.calls.length, 0);
  for (const [id, status] of rows) assert.deepEqual([(await jobRow(id)).status, (await jobRow(id)).attempts], [status, 2]);
  assert.equal((await m.queueSnapshot({ shopIds: [shop.id] })).unknown, 1, "UNKNOWN jobs are reported for a person to check");
});

test("an ambiguous send during drain ends UNKNOWN and is not retried in the same run", async () => {
  const shop = await makeShop("drain-unknown");
  const { job, sub } = await makeJob(shop);
  const transport = fakeTransport({ fail: { code: "ESOCKET", command: "DATA" } });
  const summary = await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: quiet }).drain();
  assert.deepEqual(summary.outcomes, { UNKNOWN: 1 });
  assert.equal(transport.calls.length, 1);
  assert.equal((await jobRow(job.id)).status, "UNKNOWN");
  assert.equal((await subRow(sub.id)).status, "ACTIVE");
});

test("two drains running at once send each job exactly once", async () => {
  const shop = await makeShop("drain-race");
  const jobs = [];
  for (let i = 0; i < 6; i += 1) jobs.push(await makeJob(shop));
  const transport = fakeTransport({ delay: 15 });
  const a = m.createWorker({ batchSize: 2, shopIds: [shop.id], ctx: ctxWith(transport), log: quiet });
  const b = m.createWorker({ batchSize: 2, shopIds: [shop.id], ctx: ctxWith(transport), log: quiet });
  const [one, two] = await Promise.all([a.drain(), b.drain()]);
  assert.equal(one.handled + two.handled, 6);
  assert.equal(transport.calls.length, 6);
  assert.equal(new Set(transport.calls.map((mail) => mail.messageId)).size, 6);
  for (const { job } of jobs) assert.deepEqual([(await jobRow(job.id)).status, (await jobRow(job.id)).attempts], ["SENT", 1]);
});

test("stop() during a drain (what SIGINT/SIGTERM do): the current job finishes, nothing new is claimed, the rest stays PENDING", async () => {
  const shop = await makeShop("drain-stop");
  const jobs = [await makeJob(shop), await makeJob(shop), await makeJob(shop)];
  const transport = fakeTransport({ delay: 200 });
  const worker = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: quiet });
  const draining = worker.drain();
  while (transport.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
  await worker.stop();
  const summary = await draining;
  assert.deepEqual([summary.handled, summary.interrupted, transport.calls.length], [1, true, 1]);
  const statuses = [];
  for (const { job } of jobs) statuses.push((await jobRow(job.id)).status);
  assert.deepEqual(statuses.sort(), ["PENDING", "PENDING", "SENT"]);
});

// ======================= unsubscribe =======================
test("unsubscribe tokens: random, not guessable, only their hash is stored, and they identify nothing", async () => {
  const a = m.newToken();
  const b = m.newToken();
  assert.notEqual(a, b);
  assert.match(a, m.TOKEN_PATTERN);
  assert.equal(m.hashToken(a).length, 64);
  assert.equal(await m.isKnownToken(a), false, "a well-formed but unknown token is not valid");
  for (const bad of ["", "short", "x".repeat(44), "../../etc/passwd", null, undefined, 123, "a".repeat(43) + "!"]) assert.equal(await m.isKnownToken(bad), false);
  assert.equal(await m.unsubscribeByToken("nope"), "unknown");
});

async function sentJobWithToken(tag, { subStatus = "ACTIVE" } = {}) {
  const shop = await makeShop(tag);
  const { job, sub } = await makeJob(shop);
  const token = m.newToken();
  await prisma.emailDelivery.update({ where: { id: job.id }, data: { status: "SENT", sentAt: new Date(), linkTokenHash: m.hashToken(token) } });
  if (subStatus !== "ACTIVE") await prisma.notifySubscription.update({ where: { id: sub.id }, data: { status: subStatus } });
  return { shop, job, sub, token };
}

test("unsubscribing: ACTIVE -> UNSUBSCRIBED once with one event; repeating it is harmless", async () => {
  const { shop, sub, token } = await sentJobWithToken("unsub");
  assert.equal(await m.unsubscribeByToken(token), "unsubscribed");
  const row = await subRow(sub.id);
  assert.equal(row.status, "UNSUBSCRIBED");
  assert.ok(row.unsubscribedAt);
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id, type: "NOTIFY_UNSUBSCRIBED", feature: "NOTIFY_ME" } }), 1);
  assert.equal(await m.unsubscribeByToken(token), "already");
  assert.equal(await prisma.activityEvent.count({ where: { shopId: shop.id, type: "NOTIFY_UNSUBSCRIBED" } }), 1);

  const done = await sentJobWithToken("unsub-done", { subStatus: "FULFILLED" });
  assert.equal(await m.unsubscribeByToken(done.token), "already", "already notified: nothing more would be sent anyway");
  assert.equal((await subRow(done.sub.id)).status, "FULFILLED");
});

test("the unsubscribe page: GET only asks, POST does it, bad tokens get a neutral 404, nothing personal is shown", async () => {
  const { sub, token } = await sentJobWithToken("unsub-http");
  const url = `${BASE}/notify/unsubscribe?t=${token}`;

  const get = await fetch(url);
  const page = await get.text();
  assert.equal(get.status, 200);
  assert.match(page, /<form method="post"/);
  assert.equal((await subRow(sub.id)).status, "ACTIVE", "opening the link (a scanner, a preview) changes nothing");
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(get.headers.get("x-frame-options"), "DENY");
  assert.equal(page.includes("@") || page.includes("customer"), false);

  for (const bad of ["", "abc", "a".repeat(43), "x".repeat(60)]) {
    assert.equal((await fetch(`${BASE}/notify/unsubscribe?t=${bad}`)).status, 404, `GET ${bad}`);
    assert.equal((await fetch(`${BASE}/notify/unsubscribe?t=${bad}`, { method: "POST" })).status, 404, `POST ${bad}`);
  }
  assert.equal((await fetch(`${BASE}/notify/unsubscribe`, { method: "POST" })).status, 404);
  assert.equal((await subRow(sub.id)).status, "ACTIVE");

  // what a mail client sends for the one-click header
  const oneClick = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(oneClick.status, 200);
  assert.match(await oneClick.text(), /unsubscribed/i);
  assert.equal((await subRow(sub.id)).status, "UNSUBSCRIBED");
  assert.equal((await fetch(url, { method: "POST" })).status, 200, "repeating is fine");
  assert.equal(await prisma.activityEvent.count({ where: { shopId: sub.shopId, type: "NOTIFY_UNSUBSCRIBED" } }), 1);
});

test("the link in a real queued email works end to end: send, then unsubscribe through the page", async () => {
  const shop = await makeShop("e2e");
  const { sub } = await makeJob(shop);
  const transport = fakeTransport();
  assert.equal((await claimAndRun(shop, ctxWith(transport))).result, "SENT");
  const link = /Unsubscribe: (\S+)/.exec(transport.calls[0].text)[1].replace(CONFIG.baseUrl, BASE);
  assert.equal((await subRow(sub.id)).status, "FULFILLED");
  assert.equal((await fetch(link, { method: "POST" })).status, 200, "the token that was emailed is the one that is stored");
  const original = new URL(link).searchParams.get("t");
  const changed = (original[0] === "A" ? "B" : "A") + original.slice(1); // always differs from the real token
  assert.equal((await fetch(`${BASE}/notify/unsubscribe?t=${changed}`, { method: "POST" })).status, 404, "a changed token is not valid");
});

// ======================= product lookups are shared within one drain =======================
// A restock queues one job per subscriber; they all need the same product details. The worker keeps the answers of
// one drain in a cache keyed by shop AND variant, so a variant costs one Shopify lookup per drain, not one per email.
const titled = (title) => ({ ...PRODUCT, product: { ...PRODUCT.product, title } });
// getAdmin that counts every product lookup as [shop domain, variant id]. `answer(domain, id, n)` returns the node
// (n is the 1-based number of this lookup); it may throw to simulate a failing Shopify.
function countingAdmin(answer) {
  const lookups = [];
  const getAdmin = async (domain) => ({
    scope: "",
    admin: {
      async graphql(query, { variables }) {
        lookups.push([domain, variables.id]);
        const node = await answer(domain, variables.id, lookups.length);
        return { json: async () => ({ data: { node } }) };
      },
    },
  });
  return { lookups, getAdmin };
}
const mailText = (mail) => `${mail.subject}\n${mail.text}`;

test("product cache: several jobs for one shop and variant make ONE lookup in a drain, and every email is complete", async () => {
  const shop = await makeShop("pc-same");
  const first = await makeJob(shop);
  const jobs = [first, await makeJob(shop, { variantGid: first.variantGid }), await makeJob(shop, { variantGid: first.variantGid }), await makeJob(shop, { variantGid: first.variantGid })];
  const admin = countingAdmin((domain, id) => ({ ...titled("Shared Board"), id }));
  const transport = fakeTransport();
  const summary = await m.createWorker({ batchSize: 2, shopIds: [shop.id], ctx: ctxWith(transport, { getAdmin: admin.getAdmin }), log: quiet }).drain(); // several passes: one cache for all
  assert.deepEqual([summary.handled, summary.outcomes], [4, { SENT: 4 }]);
  assert.equal(admin.lookups.length, 1, "one Shopify lookup for four emails");
  assert.equal(transport.calls.length, 4);
  assert.ok(transport.calls.every((mail) => mailText(mail).includes("Shared Board")), "each email still has the product details");
  for (const { job, sub } of jobs) assert.deepEqual([(await jobRow(job.id)).status, (await subRow(sub.id)).status], ["SENT", "FULFILLED"]);
});

test("product cache: different variants of one shop never share an answer", async () => {
  const shop = await makeShop("pc-variants");
  const a = await makeJob(shop);
  const b = await makeJob(shop);
  await makeJob(shop, { variantGid: a.variantGid });
  await makeJob(shop, { variantGid: b.variantGid });
  const admin = countingAdmin((domain, id) => ({ ...titled(`Board ${id.split("/").pop()}`), id }));
  const transport = fakeTransport();
  const summary = await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport, { getAdmin: admin.getAdmin }), log: quiet }).drain();
  assert.deepEqual(summary.outcomes, { SENT: 4 });
  assert.equal(admin.lookups.length, 2, "one lookup per variant");
  for (const mail of transport.calls) {
    const title = [a, b].map((x) => `Board ${x.variantGid.split("/").pop()}`).filter((t) => mailText(mail).includes(t));
    assert.equal(title.length, 1, "an email names exactly its own variant's product");
  }
});

test("product cache: different shops never share an answer, even for the same variant id", async () => {
  const one = await makeShop("pc-shop-a");
  const two = await makeShop("pc-shop-b");
  const variantGid = `gid://shopify/ProductVariant/${(seq += 1)}`;
  await makeJob(one, { variantGid });
  await makeJob(one, { variantGid });
  await makeJob(two, { variantGid });
  await makeJob(two, { variantGid });
  const admin = countingAdmin((domain, id) => ({ ...titled(domain === one.domain ? "Shop One Board" : "Shop Two Board"), id }));
  const transport = fakeTransport();
  const summary = await m.createWorker({ shopIds: [one.id, two.id], ctx: ctxWith(transport, { getAdmin: admin.getAdmin }), log: quiet }).drain();
  assert.deepEqual(summary.outcomes, { SENT: 4 });
  assert.deepEqual(admin.lookups.map(([domain]) => domain).sort(), [one.domain, two.domain].sort(), "each shop was asked once, through its own admin");
  const texts = transport.calls.map(mailText);
  assert.equal(texts.filter((t) => t.includes("Shop One Board")).length, 2);
  assert.equal(texts.filter((t) => t.includes("Shop Two Board")).length, 2);
});

test("product cache: a failed lookup is not kept; the next job for the same variant asks Shopify again", async () => {
  const shop = await makeShop("pc-fail");
  const first = await makeJob(shop);
  const second = await makeJob(shop, { variantGid: first.variantGid });
  const admin = countingAdmin((domain, id, n) => {
    if (n === 1) throw new Error("shopify down");
    return { ...titled("Recovered Board"), id };
  });
  const transport = fakeTransport();
  const summary = await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport, { getAdmin: admin.getAdmin }), log: quiet }).drain();
  assert.equal(admin.lookups.length, 2, "the failure was not cached");
  assert.deepEqual(summary.outcomes, { PENDING: 1, SENT: 1 }, "the first job is scheduled for a retry as before, the second is sent");
  const rows = await Promise.all([first.job.id, second.job.id].map(jobRow));
  assert.deepEqual(rows.map((r) => r.status).sort(), ["PENDING", "SENT"]);
  assert.equal(rows.find((r) => r.status === "PENDING").errorCode, "shop_unavailable");
  assert.ok(mailText(transport.calls[0]).includes("Recovered Board"));
});

test("product cache: nothing is carried from one drain to the next", async () => {
  const shop = await makeShop("pc-drains");
  const admin = countingAdmin((domain, id) => ({ ...titled("Board"), id }));
  const worker = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(fakeTransport(), { getAdmin: admin.getAdmin }), log: quiet });
  const first = await makeJob(shop);
  await worker.drain();
  await makeJob(shop, { variantGid: first.variantGid });
  await worker.drain();
  assert.equal(admin.lookups.length, 2, "the second run read the product afresh");
});

test("product cache: concurrent requests for one key share one in-flight lookup; a rejection is forgotten", async () => {
  const cache = m.createProductCache();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const load = async () => { calls += 1; await gate; return { title: "x" }; };
  const both = Promise.all([cache.get("s", "v", load), cache.get("s", "v", load)]);
  release();
  const [a, b] = await both;
  assert.deepEqual([calls, a === b], [1, true]);
  assert.equal(await cache.get("s", "v", load), a, "and the finished answer is reused");

  let attempts = 0;
  const flaky = async () => { attempts += 1; if (attempts === 1) throw new Error("boom"); return { title: "ok" }; };
  await assert.rejects(cache.get("s", "other", flaky), /boom/);
  assert.deepEqual(await cache.get("s", "other", flaky), { title: "ok" });
  assert.equal(attempts, 2);
  assert.equal(await cache.get("t", "v", async () => "other shop"), "other shop", "the shop is part of the key");
});

// ======================= Shopify throttling in the email worker =======================
// A throttled product lookup is the same bounded retry as any transient failure (one attempt used, normal backoff),
// but never earlier than the wait Shopify asked for, and the worker stops claiming more jobs for the run so a
// throttle cannot spend the attempts of every queued email at once. Nothing is sent and nothing is marked notified.
const http429 = (retryAfter) => new HttpThrottlingError({ message: "Shopify is throttling requests", code: 429, statusText: "Too Many Requests", body: {}, headers: {}, retryAfter });
const gqlThrottled = () => new GraphqlQueryError({ message: "Throttled", response: { status: 200 }, headers: {}, body: { errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } } });
const httpFailure = (code) => new HttpResponseError({ message: `status ${code}`, code, statusText: "x", body: {}, headers: {} });
const failingAdmin = (error) => fakeAdmin(() => { throw error; });
const MINUTE = 60 * 1000;

test("throttled lookup: THROTTLED, one attempt used, retry no earlier than Retry-After, nothing sent or marked notified", async () => {
  const shop = await makeShop("thr-retry-after");
  const { job, sub } = await makeJob(shop);
  const transport = fakeTransport();
  const before = Date.now();
  const { result } = await claimAndRun(shop, ctxWith(transport, { getAdmin: failingAdmin(http429(120)) }));
  assert.equal(result, "THROTTLED");
  const row = await jobRow(job.id);
  assert.deepEqual([row.status, row.attempts, row.errorCode, row.outboundMessageId, row.leaseExpiresAt], ["PENDING", 1, "shopify_throttled", null, null]);
  const wait = row.nextAttemptAt.getTime() - before;
  assert.ok(wait >= 120 * 1000 - 1000 && wait < 125 * 1000, `waits for Retry-After (120 s), not the 60 s backoff: ${wait} ms`);
  assert.equal(transport.calls.length, 0);
  assert.equal((await subRow(sub.id)).status, "ACTIVE");
});

test("throttled lookup: without Retry-After (GraphQL THROTTLED) the normal backoff applies, and a short Retry-After never shortens it", async () => {
  const shop = await makeShop("thr-backoff");
  const first = await makeJob(shop);
  const before = Date.now();
  assert.equal((await claimAndRun(shop, ctxWith(fakeTransport(), { getAdmin: failingAdmin(gqlThrottled()) }))).result, "THROTTLED");
  const a = (await jobRow(first.job.id)).nextAttemptAt.getTime() - before;
  assert.ok(a >= MINUTE - 1000 && a < MINUTE + 5000, `attempt 1: the 1-minute backoff (${a} ms)`);

  const third = await makeJob(shop);
  await prisma.emailDelivery.update({ where: { id: third.job.id }, data: { attempts: 2 } }); // the claim makes it attempt 3: backoff 16 minutes
  const start = Date.now();
  assert.equal((await claimAndRun(shop, ctxWith(fakeTransport(), { getAdmin: failingAdmin(http429(5)) }))).result, "THROTTLED");
  const b = (await jobRow(third.job.id)).nextAttemptAt.getTime() - start;
  assert.ok(b >= 16 * MINUTE - 1000, `attempt 3: Retry-After of 5 s does not undercut the 16-minute backoff (${b} ms)`);
});

test("throttling stays bounded: after the last attempt the job is FAILED, never retried for ever", async () => {
  const shop = await makeShop("thr-last");
  const { job, sub } = await makeJob(shop);
  await prisma.emailDelivery.update({ where: { id: job.id }, data: { attempts: m.MAX_ATTEMPTS - 1 } });
  const { result } = await claimAndRun(shop, ctxWith(fakeTransport(), { getAdmin: failingAdmin(http429(1)) }));
  assert.equal(result, "FAILED");
  const row = await jobRow(job.id);
  assert.deepEqual([row.status, row.attempts, row.errorCode], ["FAILED", m.MAX_ATTEMPTS, "shopify_throttled"]);
  assert.equal((await subRow(sub.id)).status, "ACTIVE");
});

test("auth, server and network failures are not throttling: PENDING with the normal backoff, as before", async () => {
  const failures = [httpFailure(401), httpFailure(403), new HttpInternalError({ message: "boom", code: 500, statusText: "x", body: {}, headers: {} }), new HttpRequestError("socket hang up")];
  for (const error of failures) {
    const shop = await makeShop("thr-other");
    const { job } = await makeJob(shop);
    const before = Date.now();
    const { result } = await claimAndRun(shop, ctxWith(fakeTransport(), { getAdmin: failingAdmin(error) }));
    assert.equal(result, "PENDING", error.constructor.name);
    const row = await jobRow(job.id);
    assert.deepEqual([row.status, row.attempts, row.errorCode], ["PENDING", 1, "shop_unavailable"], error.constructor.name);
    const wait = row.nextAttemptAt.getTime() - before;
    assert.ok(wait >= MINUTE - 1000 && wait < MINUTE + 5000, `${error.constructor.name}: ${wait} ms`);
  }
});

test("drain: a throttle stops the run at once; the other due jobs are not claimed, keep all their attempts, and are sent by the next run", async () => {
  const shop = await makeShop("thr-drain");
  const jobs = [await makeJob(shop), await makeJob(shop), await makeJob(shop)];
  const transport = fakeTransport();
  let lookups = 0;
  const throttled = async () => ({ scope: "", admin: { async graphql() { lookups += 1; throw http429(2); } } });
  const worker = m.createWorker({ batchSize: 1, shopIds: [shop.id], ctx: ctxWith(transport, { getAdmin: throttled }), log: quiet }); // several passes would be needed otherwise
  const summary = await worker.drain();
  assert.deepEqual([summary.handled, summary.outcomes], [1, { THROTTLED: 1 }]);
  assert.equal(lookups, 1, "Shopify was asked once, not once per queued job");
  assert.equal(transport.calls.length, 0);
  const rows = await Promise.all(jobs.map((j) => jobRow(j.job.id)));
  assert.deepEqual(rows.map((r) => [r.status, r.attempts]).sort(), [["PENDING", 0], ["PENDING", 0], ["PENDING", 1]]);

  // Shopify recovered: the two untouched jobs go out; the throttled one waits for its Retry-After.
  const next = await m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport), log: quiet }).drain();
  assert.deepEqual([next.handled, next.outcomes], [2, { SENT: 2 }]);
  const after = await Promise.all(jobs.map((j) => jobRow(j.job.id)));
  assert.deepEqual(after.map((r) => r.status).sort(), ["PENDING", "SENT", "SENT"]);
});

test("a failed throttled lookup is not cached either: the next drain asks Shopify again", async () => {
  const shop = await makeShop("thr-cache");
  const first = await makeJob(shop);
  let n = 0;
  const flaky = async () => ({ scope: "", admin: { async graphql(query, { variables }) { n += 1; if (n === 1) throw http429(1); return { json: async () => ({ data: { node: { ...PRODUCT, id: variables.id } } }) }; } } });
  const transport = fakeTransport();
  const worker = m.createWorker({ shopIds: [shop.id], ctx: ctxWith(transport, { getAdmin: flaky }), log: quiet });
  assert.deepEqual((await worker.drain()).outcomes, { THROTTLED: 1 });
  await prisma.emailDelivery.update({ where: { id: first.job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } }); // its wait is over
  assert.deepEqual((await worker.drain()).outcomes, { SENT: 1 });
  assert.equal(n, 2);
});
