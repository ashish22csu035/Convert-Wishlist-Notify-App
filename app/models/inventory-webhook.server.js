import prisma from "../db.server";
import { toShopDomain } from "../utils/shopify-ids.server";
import { traceProxy } from "../utils/storefront-auth.server";
import { processRestock } from "./restock.server";
import { LookupError, fetchVariantForNotify, getShopAdmin, resolveStorefrontPurchasable } from "./shopify-lookup.server";

// inventory_levels/update -> restock detection.
//
// The webhook only says "some inventory level of this inventory item changed" (one location's
// quantity). That is NOT the variant's availability: other locations, tracking and the oversell
// policy decide that. So the payload is used only to find which tracked variant to look at; its
// quantity is never trusted. For a tracked variant the current availability is read from Shopify
// (same rule as subscribing) and handed to processRestock together with the moment that read began.
//
// Delivery safety, using the existing WebhookEvent table (UNIQUE shopDomain + topic + dedupeKey):
//   - RECEIVED  claimed by one delivery that is still working on it
//   - PROCESSED / IGNORED  finished: any duplicate is acknowledged and does nothing
//   - FAILED    processing failed (we answered 5xx): the retry may claim it again
// The row is marked PROCESSED only after processRestock has finished. Everything downstream is
// idempotent, so even a crash between processing and the status update only costs a harmless replay.

const TOPIC = "INVENTORY_LEVELS_UPDATE";
const LEASE_MS = 60 * 1000; // a RECEIVED event untouched for this long is considered abandoned
const SETTLE_WAITS_MS = [600, 1200]; // pauses before re-reading a variant whose fields disagree
// An event is attempted at most this often (Shopify redeliveries plus recoverInventoryEvents). An event that
// is still unresolved after that is flagged (FAILED / inventory_unresolved, logged as an error) instead of being
// guessed at or retried for ever; the next real inventory change for the variant starts a fresh event.
export const MAX_EVENT_ATTEMPTS = 8;
export const UNRESOLVED_CODE = "inventory_unresolved";
const RECOVERY_MIN_AGE_MS = 2 * 60 * 1000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseInventoryItemGid(payload) {
  const raw = payload && typeof payload === "object" ? payload.inventory_item_id : undefined;
  if (typeof raw === "number" ? !Number.isSafeInteger(raw) || raw <= 0 : typeof raw !== "string") return null;
  const text = String(raw);
  return /^[1-9][0-9]{0,19}$/.test(text) ? `gid://shopify/InventoryItem/${text}` : null;
}

// Admin GraphQL accounting for ONE event (measurement only, it changes nothing about the requests). Every request
// made through the wrapped admin counts, retries and repeated reads included, whether it resolves or throws. Time is
// the wait for each request's response; requests that overlap (the two topology reads) are summed, so the total can
// exceed the wall-clock time. Database queries, sleeps and storefront HTTP requests never go through admin.graphql.
// The meter is created per handler call, so concurrent events cannot mix their numbers.
const graphqlKindOf = (query) => /\b(?:query|mutation)\s+([A-Za-z_]\w*)/.exec(String(query ?? ""))?.[1] ?? "unknown";

export function createGraphqlMeter(clock = () => performance.now()) {
  const calls = [];
  let totalMs = 0;
  return {
    wrap: (admin) => ({
      ...admin,
      async graphql(query, options) {
        const started = clock();
        try {
          return await admin.graphql(query, options);
        } finally {
          const ms = clock() - started;
          totalMs += ms;
          calls.push({ kind: graphqlKindOf(query), ms: Math.round(ms * 10) / 10 });
        }
      },
    }),
    snapshot: () => ({ graphqlCount: calls.length, graphqlMs: Math.round(totalMs * 10) / 10, graphqlCalls: [...calls] }),
  };
}

const normalizeTopic = (topic) => String(topic ?? "").toUpperCase().replace(/[/.]/g, "_");

// Returns { event } when this delivery owns the work, or { skip: "duplicate" | "in_progress" }.
async function claimEvent({ shopDomain, shopId, key, webhookId, itemGid, triggeredAt }) {
  const data = {
    shopDomain,
    shopId,
    topic: TOPIC,
    dedupeKey: key,
    webhookId,
    resourceGid: itemGid,
    triggeredAt,
    status: "RECEIVED",
    attempts: 1,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { event: await prisma.webhookEvent.create({ data }) };
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
    const existing = await prisma.webhookEvent.findUnique({
      where: { shopDomain_topic_dedupeKey: { shopDomain, topic: TOPIC, dedupeKey: key } },
    });
    if (!existing) continue; // vanished between the two statements: try creating again
    if (existing.status === "PROCESSED" || existing.status === "IGNORED") return { skip: "duplicate" };
    // FAILED (a retry) or an abandoned RECEIVED. The conditional update lets exactly one claimant win.
    const claimed = await prisma.webhookEvent.updateMany({
      where: {
        id: existing.id,
        OR: [{ status: "FAILED" }, { status: "RECEIVED", receivedAt: { lt: new Date(Date.now() - LEASE_MS) } }],
      },
      data: { status: "RECEIVED", receivedAt: new Date(), attempts: { increment: 1 }, errorCode: null },
    });
    return claimed.count ? { event: { ...existing, attempts: existing.attempts + 1 } } : { skip: "in_progress" };
  }
  return { skip: "in_progress" };
}

export const THROTTLED_CODE = "shopify_throttled";
const errorCodeOf = (error) => (error?.throttled ? THROTTLED_CODE : String(error?.code ?? error?.name ?? "error").slice(0, 64));

// Per-shop cool-down after Shopify throttled us. While a shop cools down, no inventory event of that shop asks the
// Admin API (neither a live webhook nor recovery), and the event is deferred: it spends no attempt, is never marked
// finished, and stays eligible for the next delivery or recovery run after the cool-down.
// Limitations: the state is in this process's memory only. A restart forgets it, and the web server and the worker are
// separate processes that do not see each other's cool-downs. The worst case is one extra throttled request per
// process, which is what happened before this existed.
// How long: Shopify's Retry-After, never more than 5 minutes; 1 minute when it gave none (or an unusable value).
export const COOLDOWN_DEFAULT_MS = 60 * 1000;
export const COOLDOWN_MAX_MS = 5 * 60 * 1000;
const cooldowns = new Map(); // shop domain -> epoch ms until which Shopify is not asked

export function cooldownMsOf(retryAfterMs) {
  const ms = Number(retryAfterMs);
  if (Number.isNaN(ms) || ms <= 0) return COOLDOWN_DEFAULT_MS;
  return Math.min(ms, COOLDOWN_MAX_MS);
}

export function startShopCooldown(shopDomain, retryAfterMs, nowMs = Date.now()) {
  const until = nowMs + cooldownMsOf(retryAfterMs);
  if (until > (cooldowns.get(shopDomain) ?? 0)) cooldowns.set(shopDomain, until); // a cool-down is never shortened
}

// The epoch ms the shop cools down until, or null when it does not (an expired entry is dropped).
function coolingUntil(shopDomain, nowMs) {
  const until = cooldowns.get(shopDomain);
  if (until === undefined) return null;
  if (until <= nowMs) {
    cooldowns.delete(shopDomain);
    return null;
  }
  return until;
}

// Forgets every cool-down (tests, or an operator who knows Shopify has recovered).
export const clearShopCooldowns = () => cooldowns.clear();

// A delivery arrives for a cooling shop and has no row yet: keep it as FAILED with 0 attempts so the recovery run can
// replay it after the cool-down (Shopify's own redeliveries are few and short). Nothing is claimed, so there is no lease.
async function deferNewEvent(data, nowMs) {
  try {
    await prisma.webhookEvent.create({ data: { ...data, status: "FAILED", attempts: 0, errorCode: THROTTLED_CODE } });
    return { status: 503, outcome: "deferred" };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
  }
  const existing = await prisma.webhookEvent.findUnique({ where: { shopDomain_topic_dedupeKey: { shopDomain: data.shopDomain, topic: TOPIC, dedupeKey: data.dedupeKey } } });
  // The same answers as claimEvent: finished work is a duplicate, work another delivery is doing is its own to answer.
  if (existing?.status === "PROCESSED" || existing?.status === "IGNORED") return { status: 200, outcome: "duplicate" };
  if (existing?.status === "RECEIVED" && existing.receivedAt.getTime() >= nowMs - LEASE_MS) return { status: 200, outcome: "in_progress" };
  return { status: 503, outcome: "deferred" }; // a FAILED row (or an abandoned claim) is left exactly as it is
}

// The shop started cooling down after this delivery had claimed its event: give the claim back, and the attempt it
// took. Only a row still exactly as this claim left it is touched (another claimant would have raised attempts).
async function releaseClaim(event) {
  await prisma.webhookEvent.updateMany({
    where: { id: event.id, status: "RECEIVED", attempts: event.attempts },
    data: { status: "FAILED", errorCode: THROTTLED_CODE, attempts: { decrement: 1 } },
  });
}

// Returns { status, outcome, results? }. `status` is the HTTP status to answer with:
// 200 = handled or safely ignored (nothing is lost), 503 = failed, Shopify should retry.
export async function handleInventoryLevelWebhook(input, deps = {}) {
  const { getAdmin = getShopAdmin, restock = processRestock, now = () => new Date(), sleep = defaultSleep, purchasable = resolveStorefrontPurchasable, clock } = deps;

  const shopDomain = toShopDomain(input.shopDomain);
  const key = String(input.eventId || input.webhookId || "").trim();
  const itemGid = parseInventoryItemGid(input.payload);
  if (!shopDomain || !key || key.length > 191 || normalizeTopic(input.topic) !== TOPIC || !itemGid) {
    // A signed webhook that is not what this route expects can never succeed on retry.
    console.warn("[restock] inventory webhook ignored: invalid request");
    return { status: 200, outcome: "ignored_invalid" };
  }

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || shop.status !== "ACTIVE") return { status: 200, outcome: "ignored_shop" };

  // Only inventory items behind a variant someone subscribed to are of interest. Everything else
  // (the vast majority of inventory changes) is acknowledged without writing anything.
  const tracked = await prisma.variantAvailability.findMany({
    where: { shopId: shop.id, inventoryItemGid: itemGid },
    select: { variantGid: true },
  });
  if (!tracked.length) return { status: 200, outcome: "untracked" };

  const triggered = input.triggeredAt ? new Date(input.triggeredAt) : null;
  const eventData = {
    shopDomain,
    shopId: shop.id,
    topic: TOPIC,
    dedupeKey: key,
    webhookId: String(input.webhookId ?? key).slice(0, 191),
    resourceGid: itemGid,
    triggeredAt: triggered && !Number.isNaN(triggered.getTime()) ? triggered : null,
  };
  const logDeferred = (until) =>
    console.log("[restock] inventory event deferred", JSON.stringify({ shop: shopDomain, event: key, item: itemGid.split("/").pop(), reason: "shopify_cooldown", retryInMs: until - now().getTime() }));

  // Shopify is throttling this shop: do not ask it again yet (see the cool-down notes above).
  const coolingBefore = coolingUntil(shopDomain, now().getTime());
  if (coolingBefore) {
    const deferred = await deferNewEvent(eventData, now().getTime());
    if (deferred.outcome === "deferred") logDeferred(coolingBefore);
    return deferred;
  }

  const claim = await claimEvent({ shopDomain, shopId: shop.id, key, webhookId: eventData.webhookId, itemGid, triggeredAt: eventData.triggeredAt });
  // A duplicate of finished work is acknowledged. One still being worked on by another delivery is
  // acknowledged too: if that one fails it answers 5xx itself and Shopify retries it.
  if (claim.skip) return { status: 200, outcome: claim.skip };

  // Another event may have been throttled while this one was being claimed.
  const coolingAfter = coolingUntil(shopDomain, now().getTime());
  if (coolingAfter) {
    await releaseClaim(claim.event);
    logDeferred(coolingAfter);
    return { status: 503, outcome: "deferred" };
  }

  const meter = createGraphqlMeter(clock);
  try {
    const observedAt = now(); // BEFORE asking Shopify, so a slower read can never look newer than a later one
    const { admin: shopAdmin } = await getAdmin(shopDomain);
    const admin = meter.wrap(shopAdmin);
    const results = [];
    for (const { variantGid } of tracked) {
      let variant;
      try {
        variant = await fetchVariantForNotify(admin, variantGid);
        // Right after an inventory change Shopify may still report the previous sellable quantity.
        // Re-read a couple of times (kept well inside Shopify's 5 s webhook timeout).
        for (let i = 0; !variant.settled && i < SETTLE_WAITS_MS.length; i += 1) {
          await sleep(SETTLE_WAITS_MS[i]);
          variant = await fetchVariantForNotify(admin, variantGid);
        }
        if (!variant.settled) {
          // Still contradictory: never record a state from it. Fail the event so it is retried.
          const unsettled = new Error("inventory_not_settled");
          unsettled.code = "inventory_not_settled";
          unsettled.seen = variant.seen;
          throw unsettled;
        }
      } catch (error) {
        if (error instanceof LookupError && error.code === "variant_not_found") {
          results.push("variant_not_found"); // deleted in Shopify: nothing to process, retrying cannot help
          continue;
        }
        throw error;
      }
      let inStock = !variant.unavailable;
      if (inStock) {
        // Admin says sellable. For stock that sits only at a third-party fulfillment location that is not proof the
        // storefront sells it (see resolveStorefrontPurchasable): only a readable storefront can announce a restock.
        const verdict = await purchasable({ admin, shopDomain, variant, variantGid }, deps);
        if (verdict.purchasable === null) {
          // Cannot be confirmed: no state change, no job, nothing to retry (a retry would read the same thing).
          results.push("storefront_unconfirmed");
          console.log("[restock] inventory event", JSON.stringify({ shop: shopDomain, event: key, item: itemGid.split("/").pop(), variant: variantGid.split("/").pop(), state: variant.state, seen: variant.seen ?? null, outcome: "storefront_unconfirmed", basis: verdict.basis, ...meter.snapshot() }));
          continue;
        }
        if (verdict.purchasable === false) inStock = false;
      }
      const result = await restock({ shopDomain, variantGid, inStock, observedAt });
      results.push(result.outcome);
      // One redacted line per event and variant: ids, attempt, what Shopify returned, the decision and its effect.
      console.log(
        "[restock] inventory event",
        JSON.stringify({
          shop: shopDomain,
          event: key,
          attempt: claim.event.attempts,
          item: itemGid.split("/").pop(),
          variant: variantGid.split("/").pop(),
          state: variant.state,
          settled: variant.settled,
          seen: variant.seen ?? null,
          outcome: result.outcome,
          cycleAfter: result.restockCycle ?? null,
          jobsCreated: result.jobsCreated ?? null,
          // Admin GraphQL requests of this EVENT so far (all its variants up to this one); the last line of an event is its total.
          ...meter.snapshot(),
        }),
      );
      // Diagnostics (same file as the proxy trace): what Shopify answered for this event and
      // what was done with it. Numbers and flags only: no tokens, emails or customer data.
      traceProxy({
        stage: "inventory_webhook",
        variant: variantGid.split("/").pop(),
        item: itemGid.split("/").pop(),
        sawUnavailable: variant.unavailable,
        settled: variant.settled,
        seen: variant.seen ?? null,
        payloadAvailable: Number.isFinite(Number(input.payload?.available)) ? Number(input.payload.available) : null,
        outcome: result.outcome,
        restockCycle: result.restockCycle ?? null,
        jobsCreated: result.jobsCreated ?? null,
        msSinceTrigger: triggered && !Number.isNaN(triggered.getTime()) ? observedAt.getTime() - triggered.getTime() : null,
        readMs: Date.now() - observedAt.getTime(),
      });
    }
    const nothingToDo = results.every((outcome) => outcome === "variant_not_found");
    await prisma.webhookEvent.update({
      where: { id: claim.event.id },
      data: {
        status: nothingToDo ? "IGNORED" : "PROCESSED",
        errorCode: nothingToDo ? "variant_not_found" : null,
        processedAt: new Date(),
      },
    });
    return { status: 200, outcome: nothingToDo ? "ignored_variant" : "processed", results };
  } catch (error) {
    const code = errorCodeOf(error);
    if (error?.throttled) startShopCooldown(shopDomain, error.retryAfterMs, now().getTime());
    const attempt = claim.event.attempts;
    const exhausted = attempt >= MAX_EVENT_ATTEMPTS;
    console.error(
      "[restock] inventory event failed",
      JSON.stringify({
        shop: shopDomain,
        event: key,
        item: itemGid.split("/").pop(),
        attempt,
        reason: code,
        seen: error?.seen ?? null,
        decision: exhausted ? "flagged_unresolved" : "retry",
        throttled: error?.throttled === true,
        ...meter.snapshot(),
      }),
    );
    try {
      await prisma.webhookEvent.update({
        where: { id: claim.event.id },
        data: exhausted ? { status: "FAILED", errorCode: UNRESOLVED_CODE, processedAt: null } : { status: "FAILED", errorCode: code },
      });
    } catch {
      /* it stays RECEIVED and is retried once the lease has expired */
    }
    // Exhausted: answer 200 so Shopify stops redelivering (repeated failures can get the webhook removed).
    // The FAILED / inventory_unresolved row and the error line above are the visible flag.
    // A throttled event is still a plain failure for Shopify (503, redelivered later); the outcome only tells the
    // recovery loop that Shopify is rate limiting, so it stops asking instead of spending every event's attempts.
    if (exhausted) return { status: 200, outcome: "unresolved" };
    return { status: 503, outcome: error?.throttled ? "throttled" : "failed" };
  }
}

// Recovery for events that did not finish: FAILED ones (Admin API down, Shopify fields still contradicting each
// other) and RECEIVED ones whose handler died. Shopify redelivers a failed webhook only a few times over a few hours
// and not at all after a 200, so the worker calls this at the start of every run. It replays the STORED real event
// (shop + inventory item id) through the normal handler, so it reads Shopify afresh, never invents a restock, and
// uses the same claim / dedupe / idempotency rules. Events that reached MAX_EVENT_ATTEMPTS are left flagged.
export async function recoverInventoryEvents({ limit = 25, minAgeMs = RECOVERY_MIN_AGE_MS, now = () => new Date(), deps, shopDomains } = {}) {
  const cutoff = new Date(now().getTime() - minAgeMs);
  const leaseCutoff = new Date(now().getTime() - LEASE_MS);
  const rows = await prisma.webhookEvent.findMany({
    where: {
      topic: TOPIC,
      attempts: { lt: MAX_EVENT_ATTEMPTS },
      ...(shopDomains ? { shopDomain: { in: shopDomains } } : {}),
      OR: [
        { status: "FAILED", errorCode: { not: UNRESOLVED_CODE }, receivedAt: { lt: cutoff } },
        { status: "RECEIVED", receivedAt: { lt: leaseCutoff } },
      ],
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  const summary = { found: rows.length, processed: 0, ignored: 0, skipped: 0, failed: 0 }; // + throttled / deferred, only when Shopify rate limited or a shop is cooling down
  for (const row of rows) {
    // Shopify answered "too fast": the rest of this batch stays as it is (no attempt spent) for a later run.
    if (summary.throttled) break;
    const itemId = parseStoredInventoryItemId(row.resourceGid);
    if (!itemId) {
      // Legacy / corrupt row: there is no real inventory item to look at, so nothing may be rebuilt from it.
      if (await retireEvent(row, "invalid_resource", now)) summary.ignored += 1;
      else summary.skipped += 1;
      console.warn("[restock] inventory recovery ignored event: invalid stored resource", JSON.stringify({ shop: row.shopDomain, event: row.id }));
      continue;
    }
    const result = await handleInventoryLevelWebhook(
      { shopDomain: row.shopDomain, topic: TOPIC, webhookId: row.webhookId, eventId: row.dedupeKey, triggeredAt: row.triggeredAt, payload: { inventory_item_id: itemId } },
      deps,
    );
    // HTTP 200 only means "nothing is lost", not "processed": count by outcome.
    switch (result.outcome) {
      case "processed":
        summary.processed += 1;
        break;
      case "ignored_variant": // the handler has already closed the row
        summary.ignored += 1;
        break;
      case "duplicate":
      case "in_progress": // finished or owned by someone else: not ours to count
        summary.skipped += 1;
        break;
      case "ignored_invalid":
      case "ignored_shop":
      case "untracked":
        // The handler returned before claiming the row; close it so every run does not pick it up again.
        if (await retireEvent(row, result.outcome, now)) summary.ignored += 1;
        else summary.skipped += 1;
        break;
      case "throttled": // retry later, and stop this batch (see the top of the loop)
        summary.failed += 1;
        summary.throttled = 1;
        break;
      case "deferred": // the shop is cooling down: nothing was asked, no attempt spent, the event waits for a later run
        summary.deferred = (summary.deferred ?? 0) + 1;
        break;
      default: // "failed" (retry later) and "unresolved" (flagged)
        summary.failed += 1;
    }
  }
  return summary;
}

// Strict: only a real inventory item GID yields an id (the stored value is rebuilt into a payload).
function parseStoredInventoryItemId(resourceGid) {
  const match = /^gid:\/\/shopify\/InventoryItem\/([1-9][0-9]{0,19})$/.exec(String(resourceGid ?? ""));
  return match ? match[1] : null;
}

// Closes an unrecoverable row as IGNORED, only if it is still exactly as it was read (a concurrent claim or
// completion changes status / attempts / receivedAt, and then this does nothing). Returns whether it closed it.
async function retireEvent(row, errorCode, now) {
  const done = await prisma.webhookEvent.updateMany({
    where: { id: row.id, status: row.status, attempts: row.attempts, receivedAt: row.receivedAt },
    data: { status: "IGNORED", errorCode: errorCode.slice(0, 64), processedAt: now() },
  });
  return done.count === 1;
}
