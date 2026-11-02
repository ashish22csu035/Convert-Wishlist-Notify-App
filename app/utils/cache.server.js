import Redis from "ioredis";

// A tiny Redis cache for report data. The cache is an optimisation only: every helper here answers "no" (null / false)
// instead of throwing when Redis is not configured, down, slow or confused, and the caller then does the work itself.
//
//   - REDIS_URL unset  -> caching is off (host-side development without Redis keeps working).
//   - The client is created on first use. Commands fail fast: no offline queue, short timeouts.
//   - After a failure Redis is left alone for CACHE_BACKOFF_MS (30 s), so a dead Redis costs one slow attempt, not one
//     per request. ioredis keeps reconnecting in the background; the next attempt after the pause uses the new connection.
//   - Only an error code is ever logged: never a key, a value, a URL or a payload.
const COMMAND_TIMEOUT_MS = 150;
const CONNECT_TIMEOUT_MS = 500;
const DEFAULT_BACKOFF_MS = 30 * 1000;

let client = null;
let clientUrl = null;
let pausedUntil = 0;
let lastLoggedAt = 0;

export const cacheEnabled = () => Boolean(process.env.REDIS_URL);
export const keyPrefix = () => process.env.REDIS_KEY_PREFIX || "kw";

// CACHE_BACKOFF_MS exists so the tests can shorten the pause.
const backoffMs = () => (process.env.CACHE_BACKOFF_MS && Number(process.env.CACHE_BACKOFF_MS) >= 0 ? Number(process.env.CACHE_BACKOFF_MS) : DEFAULT_BACKOFF_MS);

function noteFailure(error) {
  pausedUntil = Date.now() + backoffMs();
  if (Date.now() - lastLoggedAt > 60 * 1000) {
    lastLoggedAt = Date.now();
    console.warn(`[cache] redis unavailable: ${String(error?.code ?? error?.name ?? "error").slice(0, 64)}`);
  }
}

// The connected client, or null when caching is off, paused after a failure, or not connected right now.
async function connected() {
  const url = process.env.REDIS_URL;
  if (!url || Date.now() < pausedUntil) return null;
  try {
    if (client && clientUrl !== url) await closeCache();
    if (!client) {
      client = new Redis(url, {
        lazyConnect: true,
        enableOfflineQueue: false, // a command on a broken connection fails at once instead of waiting
        maxRetriesPerRequest: 0,
        commandTimeout: COMMAND_TIMEOUT_MS,
        connectTimeout: CONNECT_TIMEOUT_MS,
        retryStrategy: (times) => Math.min(times * 200, 5000),
      });
      clientUrl = url;
      client.on("error", noteFailure); // an 'error' event without a listener would crash the process
    }
    if (client.status === "wait") await client.connect();
    return client.status === "ready" ? client : null; // connecting / reconnecting: behave as a miss
  } catch (error) {
    noteFailure(error);
    return null;
  }
}

async function run(command) {
  const redis = await connected();
  if (!redis) return null;
  try {
    return await command(redis);
  } catch (error) {
    noteFailure(error);
    return null;
  }
}

// The stored string, or null (miss, or Redis not usable).
export const cacheGet = (key) => run((redis) => redis.get(key));

// Stores a string with a time to live. Returns whether it was stored.
export const cacheSet = async (key, value, ttlSeconds) => (await run((redis) => redis.set(key, value, "EX", ttlSeconds))) === "OK";

// A per-shop version number as a string ("0" until it has ever been bumped), or null when Redis is not usable.
// Callers put the version in their cache keys; bumping it makes every older key unreachable (they expire by TTL).
export const cacheVersion = (key) => run(async (redis) => (await redis.get(key)) ?? "0");

// Returns the new version, or null when Redis is not usable.
export const cacheBump = (key) => run((redis) => redis.incr(key));

// Closes the connection (the worker calls this before it exits). Safe to call at any time and more than once.
export async function closeCache() {
  const old = client;
  client = null;
  clientUrl = null;
  pausedUntil = 0;
  if (!old) return;
  try {
    await Promise.race([old.quit(), new Promise((resolve) => setTimeout(resolve, 500))]);
  } catch {
    /* the connection is already gone */
  }
  old.disconnect();
}
