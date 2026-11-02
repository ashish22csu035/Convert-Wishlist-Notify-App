// Tests for app/utils/cache.server.js: the Redis helpers that must never throw and never slow the app down.
//
// Run: node --test tests/cache-util.test.mjs
// No database is used. The tests against a real Redis need a DISPOSABLE one on a loopback port, started by you:
//   docker run --rm -d --name kwtest-redis -p 127.0.0.1:6390:6379 redis:7-alpine
//   $env:TEST_REDIS_URL="redis://127.0.0.1:6390"; $env:TEST_REDIS_CONTAINER="kwtest-redis"
// Without TEST_REDIS_URL those tests are skipped. They only touch keys under their own prefix and never flush anything.
import "./helpers/resolve-extensionless.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const REAL = process.env.TEST_REDIS_URL;
const CONTAINER = process.env.TEST_REDIS_CONTAINER;
const RUN = Date.now().toString(36);
const cache = await import("../app/utils/cache.server.js");

const quiet = async (fn) => {
  const original = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(String(line));
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = original;
  }
};
const use = async (url, extra = {}) => {
  await cache.closeCache();
  if (url) process.env.REDIS_URL = url;
  else delete process.env.REDIS_URL;
  process.env.REDIS_KEY_PREFIX = `kwtest:${RUN}`;
  process.env.CACHE_BACKOFF_MS = "0";
  Object.assign(process.env, extra);
};

after(async () => {
  await cache.closeCache();
  delete process.env.REDIS_URL;
  delete process.env.CACHE_BACKOFF_MS;
});

test("without REDIS_URL caching is off and every helper answers 'no' without throwing", async () => {
  await use(null);
  assert.equal(cache.cacheEnabled(), false);
  assert.deepEqual([await cache.cacheGet("k"), await cache.cacheSet("k", "v", 10), await cache.cacheVersion("v"), await cache.cacheBump("v")], [null, false, null, null]);
});

test("Redis unreachable: helpers answer 'no' quickly, the pause makes later calls instant, nothing sensitive is logged", async () => {
  await use("redis://127.0.0.1:1", { CACHE_BACKOFF_MS: "400" }); // nothing listens on port 1
  const { value, lines } = await quiet(async () => {
    const t = Date.now();
    const first = await cache.cacheGet("secret-key-name");
    const firstMs = Date.now() - t;
    const t2 = Date.now();
    const rest = [await cache.cacheGet("k"), await cache.cacheSet("k", "customer-value", 10), await cache.cacheVersion("v"), await cache.cacheBump("v")];
    return { first, firstMs, rest, restMs: Date.now() - t2 };
  });
  assert.equal(value.first, null);
  assert.ok(value.firstMs < 2500, `the first failure took ${value.firstMs} ms`);
  assert.deepEqual(value.rest, [null, false, null, null]);
  assert.ok(value.restMs < 50, `calls during the pause took ${value.restMs} ms`);
  assert.ok(lines.length >= 1 && lines.length <= 1, "one log line, not one per call");
  assert.ok(!/127\.0\.0\.1|secret-key-name|customer-value|redis:\/\//.test(lines.join("\n")), `log line: ${lines.join(" | ")}`);
});

test("closeCache is safe when nothing was opened and when called twice", async () => {
  await use(null);
  await cache.closeCache();
  await cache.closeCache();
});

test("real Redis: values, TTL, versions and prefixes", { skip: !REAL && "set TEST_REDIS_URL (see the header)" }, async () => {
  await use(REAL);
  const key = `${cache.keyPrefix()}:unit:${Math.random().toString(36).slice(2)}`;
  assert.equal(await cache.cacheGet(key), null, "a miss");
  assert.equal(await cache.cacheSet(key, JSON.stringify({ a: null, b: [1, 2], c: "x" }), 5), true);
  assert.deepEqual(JSON.parse(await cache.cacheGet(key)), { a: null, b: [1, 2], c: "x" });
  const { default: Redis } = await import("ioredis");
  const direct = new Redis(REAL);
  const ttl = await direct.ttl(key);
  assert.ok(ttl > 0 && ttl <= 5, `ttl ${ttl}`);
  const versionKey = `${cache.keyPrefix()}:unit-ver:${RUN}`;
  assert.equal(await cache.cacheVersion(versionKey), "0", "never bumped");
  assert.equal(await cache.cacheBump(versionKey), 1);
  assert.equal(await cache.cacheBump(versionKey), 2);
  assert.equal(await cache.cacheVersion(versionKey), "2");
  await direct.del(key, versionKey); // only the keys this test made
  direct.disconnect();
});

test("real Redis that stops answering after it worked: helpers fall back to 'no', then recover", { skip: !(REAL && CONTAINER) && "set TEST_REDIS_URL and TEST_REDIS_CONTAINER" }, async () => {
  await use(REAL);
  const key = `${cache.keyPrefix()}:pause:${RUN}`;
  assert.equal(await cache.cacheSet(key, "1", 30), true);
  execFileSync("docker", ["pause", CONTAINER]);
  try {
    const { value } = await quiet(async () => {
      const t = Date.now();
      const got = await cache.cacheGet(key);
      return { got, ms: Date.now() - t };
    });
    assert.equal(value.got, null);
    assert.ok(value.ms < 1500, `took ${value.ms} ms`);
    assert.deepEqual([await cache.cacheSet(key, "2", 30), await cache.cacheVersion("v"), await cache.cacheBump("v")], [false, null, null]);
  } finally {
    execFileSync("docker", ["unpause", CONTAINER]);
  }
  let recovered = null;
  for (let i = 0; i < 20 && recovered === null; i += 1) {
    recovered = await cache.cacheGet(key);
    if (recovered === null) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // the write that timed out while Redis was frozen may still have been executed once it woke up: either value is fine
  assert.ok(["1", "2"].includes(recovered), "the same client works again once Redis answers");
  const { default: Redis } = await import("ioredis");
  const direct = new Redis(REAL);
  await direct.del(key);
  direct.disconnect();
});
