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

const errorCodeOf = (error) => String(error?.code ?? error?.name ?? "error").slice(0, 64);

// Returns { status, outcome, results? }. `status` is the HTTP status to answer with:
// 200 = handled or safely ignored (nothing is lost), 503 = failed, Shopify should retry.
export async function handleInventoryLevelWebhook(input, deps = {}) {
  const { getAdmin = getShopAdmin, restock = processRestock, now = () => new Date(), sleep = defaultSleep, purchasable = resolveStorefrontPurchasable } = deps;

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
  const claim = await claimEvent({
    shopDomain,
    shopId: shop.id,
    key,
    webhookId: String(input.webhookId ?? key).slice(0, 191),
    itemGid,
    triggeredAt: triggered && !Number.isNaN(triggered.getTime()) ? triggered : null,
  });
  // A duplicate of finished work is acknowledged. One still being worked on by another delivery is
  // acknowledged too: if that one fails it answers 5xx itself and Shopify retries it.
  if (claim.skip) return { status: 200, outcome: claim.skip };

  try {
    const observedAt = now(); // BEFORE asking Shopify, so a slower read can never look newer than a later one
    const { admin } = await getAdmin(shopDomain);
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
          console.log("[restock] inventory event", JSON.stringify({ shop: shopDomain, event: key, item: itemGid.split("/").pop(), variant: variantGid.split("/").pop(), state: variant.state, seen: variant.seen ?? null, outcome: "storefront_unconfirmed", basis: verdict.basis }));
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
    return exhausted ? { status: 200, outcome: "unresolved" } : { status: 503, outcome: "failed" };
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
  const summary = { found: rows.length, processed: 0, ignored: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
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
