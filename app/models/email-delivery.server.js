import crypto from "node:crypto";
import prisma from "../db.server";
import { LookupError, fetchProductForEmail } from "./shopify-lookup.server";
import { buildRestockEmail } from "./restock-email.server";
import { hashToken, newToken, unsubscribeUrl } from "./unsubscribe.server";
import { addressOf } from "./mail-config.server";
import { QUOTA_BLOCKED, reserveForSend } from "./email-quota.server";

// Sends the restock emails queued by processRestock (EmailDelivery rows). One row = one email for one
// subscription in one restock cycle; UNIQUE(subscriptionId, restockCycle) makes a second row impossible.
//
// Row life cycle (existing DeliveryStatus values, no schema change):
//   PENDING  waiting (nextAttemptAt says when)
//   SENDING  claimed by exactly one worker; leaseExpiresAt says how long that claim holds
//   SENT     accepted by the SMTP server; the subscription is FULFILLED
//   FAILED   given up: a permanent refusal, or all attempts used
//   SKIPPED  no longer applicable (unsubscribed, already notified, sold out again, no recipient, product gone)
//   UNKNOWN  the outcome of a send is unknown: NEVER sent again automatically
//
// The rule that prevents a duplicate: outboundMessageId is written before the SMTP call and is the
// boundary. A claim that dies BEFORE that point provably sent nothing and is safely retried; a claim
// that dies after it might have delivered and becomes UNKNOWN instead.

export const MAX_ATTEMPTS = 5;
const THROTTLED_REASON = "shopify_throttled";
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

// 1 minute, 4, 16, 64, then capped at 2 hours.
export const backoffMs = (attempt) => Math.min(60 * 1000 * 4 ** Math.max(0, attempt - 1), 2 * 60 * 60 * 1000);

const scopeOf = (shopIds) => (shopIds ? { shopId: { in: shopIds } } : {});
const codeOf = (error) => String(error?.code ?? error?.name ?? "error").slice(0, 64);

// Atomically takes the next due PENDING job, or returns null. Taking a job also RESERVES its restock-email quota (see
// email-quota.server.js): the shop's quota is checked and the row claimed in one step under a per-shop lock, so of several workers racing
// for one row, or for the last unit of one shop's quota, exactly one wins.
//
// A shop whose quota is used up gets ALL its due jobs parked in one step and is left out of the rest of this call, and a candidate that
// could not be taken is never selected again by this call. So blocked work can neither fill the queue's front nor end the search early:
// the call keeps looking, batch after batch, until it claims a job or nothing eligible is left. It is bounded (MAX_CLAIM_ROUNDS batches),
// and each batch makes progress (a claim, a whole shop parked, or candidates set aside), so it cannot loop.
//
// Errors: a transient deadlock is retried inside reserveForSend. Any other failure for ONE candidate sets that candidate aside and the
// search goes on; only when EVERY attempt failed and nothing else happened is the last error thrown, so a broken database stops the run
// loudly instead of looking like an empty queue.
const CLAIM_BATCH = 10;
export const MAX_CLAIM_ROUNDS = 50;

export async function claimNext({ now = new Date(), leaseMs = DEFAULT_LEASE_MS, shopIds, enforce, db = prisma } = {}) {
  const blockedShops = [];
  const setAside = [];
  let failures = 0;
  let lastError = null;
  let progress = false;
  for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
    const where = { status: "PENDING", nextAttemptAt: { lte: now }, ...(setAside.length ? { id: { notIn: setAside } } : {}) };
    const shopFilter = { ...(shopIds ? { in: shopIds } : {}), ...(blockedShops.length ? { notIn: blockedShops } : {}) };
    if (Object.keys(shopFilter).length) where.shopId = shopFilter;
    const candidates = await db.emailDelivery.findMany({
      where,
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], // ids are random UUIDs: createdAt keeps the queue fair
      take: CLAIM_BATCH,
      select: { id: true, shopId: true },
    });
    if (!candidates.length) break;
    for (const { id, shopId } of candidates) {
      if (blockedShops.includes(shopId)) continue;
      let result;
      try {
        result = await reserveForSend(id, { now, leaseMs, db, ...(enforce === undefined ? {} : { enforce }) });
      } catch (error) {
        failures += 1;
        lastError = error;
        setAside.push(id);
        console.error("[worker] a job could not be claimed", JSON.stringify({ kind: error?.constructor?.name ?? "Error", code: codeOf(error) }));
        continue;
      }
      if (result?.job) return result.job;
      if (result?.aborted) {
        failures += 1;
        lastError = Object.assign(new Error(result.aborted), { code: result.aborted });
        setAside.push(id);
        continue;
      }
      progress = true;
      if (result?.blocked) blockedShops.push(shopId);
      else setAside.push(id); // taken by another worker, or no longer due
    }
  }
  if (failures && !progress) throw lastError;
  return null;
}

// What a finished run leaves behind. Read-only: nothing is changed. The counts never overlap:
//   quotaBlocked  PENDING jobs parked because the plan's restock-email quota is used up (with a retry date, or without one: Basic's
//                 lifetime quota has none); they are waiting for quota, not for a timer
//   scheduled     the other PENDING jobs whose next attempt is in the future (a retry after a transient error): a LATER worker run sends
//                 them once they are due
//   unknown       jobs whose outcome is unknown: never resent automatically, a person must look at them
export async function queueSnapshot({ now = new Date(), shopIds } = {}) {
  const [quotaBlocked, scheduled, unknown] = await Promise.all([
    prisma.emailDelivery.count({ where: { status: "PENDING", errorCode: QUOTA_BLOCKED, ...scopeOf(shopIds) } }),
    prisma.emailDelivery.aggregate({
      where: { status: "PENDING", nextAttemptAt: { gt: now }, OR: [{ errorCode: null }, { errorCode: { not: QUOTA_BLOCKED } }], ...scopeOf(shopIds) },
      _count: { _all: true },
      _min: { nextAttemptAt: true },
    }),
    prisma.emailDelivery.count({ where: { status: "UNKNOWN", ...scopeOf(shopIds) } }),
  ]);
  return { scheduled: scheduled._count._all, nextAttemptAt: scheduled._min.nextAttemptAt, unknown, quotaBlocked };
}

// A SENDING row whose lease ran out belongs to a worker that died. If it had not reached the SMTP call
// (no outboundMessageId) nothing was sent: it goes back to PENDING (or FAILED when attempts are used up).
// If it had, the email may have gone out: UNKNOWN, left for a person to look at.
export async function recoverExpiredLeases({ now = new Date(), shopIds } = {}) {
  const expired = await prisma.emailDelivery.findMany({
    where: { status: "SENDING", leaseExpiresAt: { lt: now }, ...scopeOf(shopIds) },
    select: { id: true, attempts: true, outboundMessageId: true },
  });
  let recovered = 0;
  for (const row of expired) {
    const base = { id: row.id, status: "SENDING", leaseExpiresAt: { lt: now } };
    const result = row.outboundMessageId
      ? await prisma.emailDelivery.updateMany({ where: { ...base, outboundMessageId: { not: null } }, data: { status: "UNKNOWN", errorCode: "lease_expired", leaseExpiresAt: null } })
      : row.attempts >= MAX_ATTEMPTS
        ? await prisma.emailDelivery.updateMany({ where: { ...base, outboundMessageId: null }, data: { status: "FAILED", errorCode: "max_attempts", leaseExpiresAt: null } })
        : await prisma.emailDelivery.updateMany({ where: { ...base, outboundMessageId: null }, data: { status: "PENDING", nextAttemptAt: now, leaseExpiresAt: null } });
    recovered += result.count;
  }
  return recovered;
}

// How an SMTP error should be treated:
//   "permanent"  the server explicitly refused the message (5xx) or the address is unusable: not delivered
//   "retry"      the server explicitly declined for now (4xx), or it failed before any message data was sent
//   "ambiguous"  the connection broke while or after the message data was sent: it may have been delivered
const BEFORE_DATA = new Set(["CONN", "EHLO", "HELO", "LHLO", "STARTTLS", "AUTH", "AUTH PLAIN", "AUTH LOGIN", "AUTH XOAUTH2", "MAIL FROM", "RCPT TO"]);
export function classifySmtpError(error) {
  const reply = Number(error?.responseCode);
  if (reply >= 500 && reply < 600) return "permanent";
  if (reply >= 400 && reply < 500) return "retry";
  if (error?.code === "EENVELOPE") return "permanent";
  if (error?.code === "EAUTH" || error?.code === "ECONNECTION" || error?.code === "EDNS" || BEFORE_DATA.has(error?.command)) return "retry";
  return "ambiguous";
}

// Moves a claimed row to its next state. Only a row still SENDING is touched.
const settle = (id, data, from = ["SENDING"]) =>
  prisma.emailDelivery.updateMany({ where: { id, status: { in: from } }, data: { leaseExpiresAt: null, ...data } });

// Product details for the emails of one drain (or one pass), so N subscribers of the same variant cost one Shopify
// lookup instead of N. Keyed by shop AND variant, so shops never share an entry. Only a successful answer is kept:
// a failed lookup is forgotten at once and the next job asks Shopify again. Jobs asking for a key that is still in
// flight share that one request. Nothing outlives the object, and the worker makes a new one per drain, so details
// are never carried to the next run (a renamed or unpublished product is seen within one run's length).
export function createProductCache() {
  const entries = new Map();
  return {
    get(shopId, variantGid, load) {
      const key = JSON.stringify([shopId, variantGid]);
      let entry = entries.get(key);
      if (!entry) {
        entry = load();
        entries.set(key, entry);
        entry.catch(() => {
          if (entries.get(key) === entry) entries.delete(key);
        });
      }
      return entry;
    },
  };
}

// Why a claimed job should not be sent, or null when it is eligible.
function ineligibleReason(job, subscription, availability) {
  if (!subscription || subscription.shopId !== job.shopId) return "subscription_missing";
  if (subscription.status !== "ACTIVE") return "subscription_not_active"; // unsubscribed, or already notified
  if (subscription.variantGid !== job.variantGid) return "variant_mismatch";
  if (job.restockCycle <= subscription.baselineCycle) return "already_covered"; // subscribed after this restock
  if (!availability || !availability.isInStock || availability.restockCycle < job.restockCycle) return "out_of_stock_again";
  return null;
}

// ctx: { transport, config: { mailFrom, baseUrl }, getAdmin, now?, leaseMs?, productCache? }
// Returns the resulting status, for logging and tests. Never logs addresses.
export async function processJob(job, ctx) {
  const { transport, config, getAdmin } = ctx;
  const now = () => (ctx.now ? ctx.now() : new Date());
  const leaseMs = ctx.leaseMs ?? DEFAULT_LEASE_MS;

  const [subscription, availability, shop, settings] = await Promise.all([
    prisma.notifySubscription.findUnique({ where: { id: job.subscriptionId } }),
    prisma.variantAvailability.findUnique({ where: { shopId_variantGid: { shopId: job.shopId, variantGid: job.variantGid } } }),
    prisma.shop.findUnique({ where: { id: job.shopId } }),
    prisma.shopSettings.findUnique({ where: { shopId: job.shopId } }),
  ]);

  const skip = async (reason) => {
    await settle(job.id, { status: "SKIPPED", errorCode: reason });
    return "SKIPPED";
  };
  // `notBeforeMs`: a wait Shopify asked for (Retry-After); the retry is never earlier than the normal backoff or that.
  const retryLater = async (reason, notBeforeMs = 0) => {
    if (job.attempts >= MAX_ATTEMPTS) {
      // Nothing was sent, so no message id or unsubscribe token is kept for it.
      await settle(job.id, { status: "FAILED", errorCode: reason, outboundMessageId: null, linkTokenHash: null });
      return "FAILED";
    }
    await settle(job.id, { status: "PENDING", errorCode: reason, nextAttemptAt: new Date(now().getTime() + Math.max(backoffMs(job.attempts), notBeforeMs)), outboundMessageId: null, linkTokenHash: null });
    return "PENDING";
  };

  const reason = ineligibleReason(job, subscription, availability);
  if (reason) return skip(reason);
  if (!shop || shop.status !== "ACTIVE") return skip("shop_inactive");
  if (settings && settings.notifyMeEnabled === false) return skip("notify_disabled"); // the merchant switched Notify Me off
  if (!addressOf(subscription.email)) return skip("no_recipient");

  // Current product details from Shopify. Nothing is invented: no title or link, no email.
  let product;
  try {
    const lookup = async () => {
      const { admin } = await getAdmin(shop.domain);
      return fetchProductForEmail(admin, job.variantGid);
    };
    product = ctx.productCache ? await ctx.productCache.get(job.shopId, job.variantGid, lookup) : await lookup();
  } catch (error) {
    if (error instanceof LookupError && error.code === "variant_not_found") return skip("product_unavailable");
    if (error instanceof LookupError && error.throttled) {
      // Same bounded retry as any transient failure, but reported as THROTTLED so the worker stops claiming more jobs now.
      const settled = await retryLater(THROTTLED_REASON, error.retryAfterMs ?? 0);
      return settled === "PENDING" ? "THROTTLED" : settled;
    }
    return retryLater(error instanceof LookupError ? error.code : "product_lookup_failed");
  }
  if (product.status !== "ACTIVE") return skip("product_unavailable");

  // The link's token and the message id exist only for this attempt, and are saved BEFORE the SMTP call.
  const token = newToken();
  const messageId = `<${crypto.randomUUID()}@${new URL(config.baseUrl).hostname}>`;
  const mail = buildRestockEmail({
    shop,
    settings,
    product,
    variantGid: job.variantGid,
    recipient: subscription.email,
    mailFrom: config.mailFrom,
    unsubscribeLink: unsubscribeUrl(config.baseUrl, token),
    messageId,
  });
  if (!mail) return skip("product_unavailable"); // no title or no safe link: never sent with invented details

  const marked = await prisma.emailDelivery.updateMany({
    where: { id: job.id, status: "SENDING" },
    data: { outboundMessageId: messageId, linkTokenHash: hashToken(token), leaseExpiresAt: new Date(now().getTime() + leaseMs) },
  });
  if (marked.count !== 1) return "LEASE_LOST"; // someone else owns it now; send nothing

  let info;
  try {
    info = await transport.sendMail(mail);
  } catch (error) {
    const kind = classifySmtpError(error);
    console.error("[worker] send failed", JSON.stringify({ job: job.id, kind, code: codeOf(error) }));
    if (kind === "retry") return retryLater(`smtp_${codeOf(error)}`.slice(0, 64));
    if (kind === "permanent") {
      await settle(job.id, { status: "FAILED", errorCode: `smtp_${codeOf(error)}`.slice(0, 64) });
      return "FAILED";
    }
    await settle(job.id, { status: "UNKNOWN", errorCode: "send_outcome_unknown" }); // may have been delivered: never resend automatically
    return "UNKNOWN";
  }
  if (!info || !Array.isArray(info.accepted) || info.accepted.length === 0) {
    await settle(job.id, { status: "FAILED", errorCode: "smtp_not_accepted" });
    return "FAILED";
  }

  // Accepted. Record it; if this bookkeeping itself fails the row stays SENDING with its message id,
  // so the lease expiry turns it into UNKNOWN: it can never be sent twice.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.emailDelivery.updateMany({
        where: { id: job.id, status: { in: ["SENDING", "UNKNOWN"] } },
        // The plan the quota was reserved under when this job was claimed, written with sentAt in the same update. A row claimed
        // before attribution existed has none: BASIC, the conservative reading, never a guess from the shop's current plan.
        data: { status: "SENT", sentAt: now(), planAtSend: job.planAtSend ?? "BASIC", leaseExpiresAt: null, errorCode: null },
      });
      await tx.notifySubscription.updateMany({ where: { id: subscription.id, status: "ACTIVE" }, data: { status: "FULFILLED" } });
      await tx.activityEvent.create({
        data: {
          shopId: job.shopId,
          actorId: subscription.actorId,
          type: "RESTOCK_EMAIL_SENT",
          feature: "NOTIFY_ME",
          productGid: subscription.productGid,
          variantGid: job.variantGid,
        },
      });
    });
  } catch (error) {
    console.error("[worker] sent, but could not record it", JSON.stringify({ job: job.id, code: codeOf(error) }));
    return "SENT_UNRECORDED";
  }
  return "SENT";
}
