import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { billingEnforced } from "./plans.server";
import { getEntitlements, quotaRetryAt, restockEmailUsage } from "./entitlements.server";
import { ensureShopSubscription, lockShopLimits } from "./shop-lock.server";
import { withTransientRetry } from "./db-retry.server";

// Restock-email quota: the check AND the reservation happen in one step, under a per-shop lock, when a worker claims a job.
//
// Why this is atomic across workers: the claim runs in a transaction that first takes the shop's limits lock
// (SELECT ... FOR UPDATE on its ShopSubscription row, see shop-lock.server.js). Two workers claiming for the same shop therefore run one after the other, and the second sees the
// first one's reservation (a SENDING row, counted by restockEmailUsage) before it decides. Under READ COMMITTED each statement reads
// what the other transaction has committed. Only ONE lock is ever taken here (then the delivery row is updated), and the wishlist
// cap takes the same lock after the customer's row, so there is a single consistent order and no deadlock cycle.
//
// A reservation is simply the row being SENDING. It ends as: SENT (kept, now a real send), UNKNOWN (kept: it may have been delivered,
// so time alone never releases it and it is never resent), or PENDING / FAILED / SKIPPED (released: nothing was sent). Retries of one
// delivery reuse the same row, so they never hold two reservations.
//
// A job the quota cannot cover is not claimed and keeps no lease. It stays PENDING and is parked (together with the shop's other due
// jobs) with errorCode "quota_exhausted":
//   paid plan, verified period   nextAttemptAt = the end of that period (the start of the next one)
//   anything else (Basic's lifetime quota, an unknown period)   nextAttemptAt = NULL: never picked up on a timer, and no reset date is
//                                invented. wakeQuotaBlocked puts it back when a verification shows a new plan or period.
// It is therefore not retried every worker tick, and it never blocks other jobs (the claim loop moves on to the next candidate).

export const QUOTA_BLOCKED = "quota_exhausted";

const TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 10000 };

// Tries to claim one PENDING job for sending. Returns
//   { job }                          claimed (SENDING, lease set, planAtSend and reservedAt recorded)
//   { blocked: true, retryAt }       the quota is used up: ALL of the shop's due jobs are parked in one step (not claimed, no lease)
//   { aborted: "..." }               the entitlement lookup failed (a database or infrastructure error): NOTHING was stamped, reserved
//                                    or parked, because Basic was not a finding about this merchant, only a failed read
//   null                             not claimable any more (another worker took it, or it is not due)
// `enforce` false still records the attribution but never blocks (see billingEnforced).
//
// Plan-at-send semantics (explicit): planAtSend is the effective plan AT THE MOMENT OF THIS CLAIM, decided under the shop's limits lock
// from the stored subscription (paid only while verified and fresh, otherwise Basic). It is written once here and copied into the SENT
// update, so a later plan change, a lapsed verification or a downgrade never re-attributes it, and a reservation can never borrow the quota
// of a plan that was not verified when it was made. A transient database deadlock rolls the whole claim back and reruns it (bounded).
export async function reserveForSend(candidateId, { now = new Date(), leaseMs, enforce = billingEnforced(), db = prisma, retry } = {}) {
  const head = await db.emailDelivery.findUnique({ where: { id: candidateId }, select: { shopId: true } });
  if (!head) return null;
  await ensureShopSubscription(head.shopId, { db }); // the lock row exists before the transaction starts
  return withTransientRetry(
    () =>
      db.$transaction(async (tx) => {
        const row = await tx.emailDelivery.findUnique({ where: { id: candidateId }, select: { shopId: true, status: true, nextAttemptAt: true, errorCode: true } });
        if (!row || row.status !== "PENDING" || !row.nextAttemptAt || row.nextAttemptAt > now) return null;

        await lockShopLimits(tx, row.shopId);
        const entitlements = await getEntitlements(row.shopId, { now, db: tx });
        if (entitlements.lookupFailed) return { aborted: "entitlement_lookup_failed" };
        if (enforce) {
          const usage = await restockEmailUsage(row.shopId, entitlements, { db: tx });
          if (usage.remaining <= 0) {
            // Every due job of this shop is blocked by the same exhausted quota: park them all in this one statement, so a shop with
            // thousands of them costs ONE step and cannot fill the queue's front while other shops wait.
            const retryAt = quotaRetryAt(entitlements, now);
            const parked = await tx.emailDelivery.updateMany({ where: { shopId: row.shopId, status: "PENDING", nextAttemptAt: { lte: now } }, data: { nextAttemptAt: retryAt, errorCode: QUOTA_BLOCKED } });
            return parked.count > 0 ? { blocked: true, retryAt, parked: parked.count } : null;
          }
        }
        const claimed = await tx.emailDelivery.updateMany({
          where: { id: candidateId, status: "PENDING", nextAttemptAt: { lte: now } },
          data: {
            status: "SENDING",
            attempts: { increment: 1 },
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            planAtSend: entitlements.plan.key,
            reservedAt: now,
            ...(row.errorCode === QUOTA_BLOCKED ? { errorCode: null } : {}),
          },
        });
        return claimed.count === 1 ? { job: await tx.emailDelivery.findUnique({ where: { id: candidateId } }) } : null;
      }, TX_OPTIONS),
    retry,
  );
}

// Puts a shop's quota-blocked jobs back in the queue (due now). They are checked again when claimed, so one that is still over quota
// is simply parked again. Called when a verification shows a different plan or billing period.
export const wakeQuotaBlocked = (shopId, { now = new Date(), db = prisma } = {}) =>
  db.emailDelivery.updateMany({
    where: { shopId, status: "PENDING", errorCode: QUOTA_BLOCKED, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { gt: now } }] },
    data: { nextAttemptAt: now },
  });
