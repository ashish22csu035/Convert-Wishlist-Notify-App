import prisma from "../db.server";
import { FALLBACK_PLAN, PLANS, VERIFICATION_MAX_AGE_MS, VERIFIED_SOURCES, getPlan } from "./plans.server";

// What a shop is entitled to, and how much of it is used. This phase only MEASURES: nothing here deletes, edits or blocks
// anything, and nothing calls Shopify. Enforcement (the storefront, the email worker, the report screens) will call these
// helpers later.
//
// Resolving the plan (resolveEntitlements, pure):
//   BASIC row                     -> Basic ("free"): needs no Shopify subscription
//   paid row, ACTIVE, verified by a recognised
//   source (VERIFIED_SOURCES), within VERIFICATION_MAX_AGE_MS,
//   with billing-period boundaries
//   that have not ended           -> that plan ("verified")
//   anything else (no row, a paid row that is not ACTIVE, never verified, verification too old, no or ended period,
//   unknown plan, a failed lookup) -> Basic ("fallback", with the reason): conservative and temporary. The stored row is
//   not changed, existing data is kept, and the next successful verification restores the paid plan.
// The recommendation (PlanRecommendation) is never read here: advice is not proof of a subscription or a payment.

const fallback = (reason) => ({ plan: PLANS[FALLBACK_PLAN], state: "fallback", reason, billingPeriod: null });

// `subscription` is a ShopSubscription row or null. Never throws.
export function resolveEntitlements(subscription, now = new Date()) {
  if (!subscription) return fallback("no_subscription");
  const plan = getPlan(subscription.plan);
  if (!plan) return fallback("unknown_plan");
  if (!plan.paid) return { plan, state: "free", reason: null, billingPeriod: null };

  if (subscription.status !== "ACTIVE") return fallback(`subscription_${String(subscription.status).toLowerCase()}`);
  if (!subscription.verifiedAt || !subscription.verificationSource) return fallback("not_verified");
  if (!VERIFIED_SOURCES.includes(subscription.verificationSource)) return fallback("verification_source_unrecognised"); // only a real source can verify (see plans.server.js)
  const age = now.getTime() - new Date(subscription.verifiedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > VERIFICATION_MAX_AGE_MS) return fallback("verification_stale");
  const start = subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : null;
  const end = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return fallback("billing_period_unknown");
  if (now >= end) return fallback("billing_period_ended");
  return { plan, state: "verified", reason: null, billingPeriod: { start, end } };
}

// The shop's effective entitlements.
//   - the lookup worked: resolveEntitlements decides (a missing, stale or unverified subscription is Basic, as agreed)
//   - the lookup itself FAILED (a database or infrastructure error): Basic as well, but marked `lookupFailed: true`. That is NOT a
//     statement about the merchant's subscription, so anything that records a decision on it (a quota reservation, a plan stamp) must
//     check the flag and stop instead of persisting Basic. Only the error's class and code are logged, never its message.
export async function getEntitlements(shopId, { now = new Date(), db = prisma } = {}) {
  try {
    const subscription = await db.shopSubscription.findUnique({ where: { shopId } });
    return resolveEntitlements(subscription, now);
  } catch (error) {
    console.error("[entitlements] lookup failed", JSON.stringify({ kind: error?.constructor?.name ?? "Error", code: error?.code ?? null }));
    return { ...fallback("lookup_failed"), lookupFailed: true };
  }
}

// ---------- Wishlist: one allowance for the whole shop ----------

// Active items of every customer of this shop together (a removal deletes its row). Other shops are never counted.
export const countActiveWishlistItems = (shopId, { db = prisma } = {}) => db.wishlistItem.count({ where: { shopId } });

// Over the limit is a state, not an error: existing items are kept and only new additions would be refused (later).
export async function wishlistCapacity(shopId, entitlements, { db = prisma } = {}) {
  const limit = entitlements.plan.wishlistItems;
  const used = await countActiveWishlistItems(shopId, { db });
  return { limit, used, remaining: Math.max(0, limit - used), overLimit: used > limit, canAdd: used < limit };
}

// ---------- Restock emails: the quota period follows the plan ----------

// Quota usage, counted from the shop's own delivery records and attributed by `planAtSend` (the plan the email was reserved
// under, see email-quota.server.js), never by the shop's CURRENT plan. Two separate parts, reported separately and added for `used`:
//
//   sent      HISTORICAL usage: emails that were SENT.
//               Basic (lifetime)       SENT rows attributed to BASIC, and legacy SENT rows with no attribution (sent before attribution
//                                      existed): the agreed legacy rule. Emails sent under a paid plan never count.
//               paid (billing period)  SENT rows attributed to THAT plan whose sentAt is in [period start, period end): start included,
//                                      end excluded, as Shopify reported them. Legacy and Basic rows never count against a paid plan.
//   reserved  RESERVATION accounting: rows that hold the quota without being a confirmed send: SENDING (claimed, in flight) and UNKNOWN
//             (the outcome is not known; it may have been delivered and is NEVER resent). This is about preventing overshoot and a
//             duplicate send, not history. For Basic it also covers such rows with no attribution (claimed before attribution existed):
//             their plan is unknown, so they stay reserved against Basic, the conservative side. A reservation is dated by reservedAt
//             and counts in the period it was made in until it is SENT; from then on it is history, dated by sentAt.
//
// A row that went back to PENDING, or ended FAILED or SKIPPED, sent nothing and holds nothing. Each delivery is ONE row (UNIQUE
// subscription + restock cycle), so a retry of the same delivery cannot be counted twice, and a row moving from reserved to sent moves
// between the two parts, never into both.
export async function restockEmailUsage(shopId, entitlements, { db = prisma } = {}) {
  const { quota, period } = entitlements.plan.restockEmails;
  const key = entitlements.plan.key;
  let sentWhere;
  let reservedWhere;
  let window = null;
  if (period === "billing_period") {
    // resolveEntitlements only gives a billing-period plan when the boundaries are known; this guards a hand-built value.
    if (!entitlements.billingPeriod) throw new TypeError("a billing-period quota needs the billing period");
    window = entitlements.billingPeriod;
    const inside = { gte: window.start, lt: window.end };
    sentWhere = { shopId, status: "SENT", planAtSend: key, sentAt: inside };
    reservedWhere = { shopId, status: { in: RESERVING_STATUSES }, planAtSend: key, reservedAt: inside };
  } else {
    const attributed = key === "BASIC" ? [{ planAtSend: key }, { planAtSend: null }] : [{ planAtSend: key }];
    sentWhere = { shopId, status: "SENT", OR: attributed };
    reservedWhere = { shopId, status: { in: RESERVING_STATUSES }, OR: attributed };
  }
  const sent = await db.emailDelivery.count({ where: sentWhere });
  const reserved = await db.emailDelivery.count({ where: reservedWhere });
  const used = sent + reserved;
  return { quota, used, sent, reserved, remaining: Math.max(0, quota - used), exceeded: used >= quota, period: window ? { start: window.start, end: window.end } : "lifetime" };
}

const RESERVING_STATUSES = ["SENDING", "UNKNOWN"];

// When quota-blocked work may be tried again: the end of the verified billing period (= the start of the next one) for a paid plan,
// and null whenever no real date is known: a lifetime quota never resets by itself, and a missing or unknown period is never guessed.
export const quotaRetryAt = (entitlements, now = new Date()) => {
  const end = entitlements.plan.restockEmails.period === "billing_period" ? entitlements.billingPeriod?.end : null;
  return end && end > now ? end : null;
};

// ---------- Analytics history ----------

export const analyticsHistoryDays = (entitlements) => entitlements.plan.analyticsHistoryDays;

// The longest range the merchant may ask for: a longer request is shortened, never refused or zeroed.
export const clampHistoryDays = (requestedDays, entitlements) => {
  const limit = analyticsHistoryDays(entitlements);
  const days = Number(requestedDays);
  return Number.isFinite(days) && days > 0 ? Math.min(days, limit) : limit;
};

// The preset ranges (for example [7, 30, 90]) this plan may use.
export const allowedRangeDays = (ranges, entitlements) => ranges.filter((days) => days <= analyticsHistoryDays(entitlements));
