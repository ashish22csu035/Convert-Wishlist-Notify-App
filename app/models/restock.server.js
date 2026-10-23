import { Prisma } from "@prisma/client";
import prisma from "../db.server";

// Restock detection core: turns "this variant is now in / out of stock" into
//   - the VariantAvailability state (restockCycle goes up exactly once per out -> in change), and
//   - one PENDING EmailDelivery per eligible subscription and restock cycle.
// It sends nothing. A webhook is only a hint that something changed: callers must read the
// variant's CURRENT availability from Shopify (same rule as subscribing, see
// fetchVariantForNotify) and pass it in, together with the moment they started that read.
//
// Ordering: `observedAt` is the time the authoritative read began. VariantAvailability.sourceUpdatedAt
// holds the newest observation applied so far, and an observation older than it is ignored, so a slow
// or replayed event can never put the variant back into an earlier state. Everything is done with
// conditional UPDATEs and the existing UNIQUE(subscriptionId, restockCycle), so duplicate or
// concurrent calls cannot raise the cycle twice or create two jobs.

// A row can be moved by an observation that is not older than the one it already has.
export function notOlderThan(observedAt) {
  return { OR: [{ sourceUpdatedAt: null }, { sourceUpdatedAt: { lte: observedAt } }] };
}

const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5000,
  timeout: 10000,
};

// Returns { outcome, restockCycle?, jobsCreated? } where outcome is one of:
//   "restocked"      out -> in: cycle +1, jobs created
//   "out_of_stock"   in -> out: state updated, cycle unchanged
//   "unchanged"      already in that state (duplicate event)
//   "stale"          a newer observation is already applied: nothing changed
//   "untracked"      nobody has ever subscribed to this variant: nothing to do
//   "unknown_shop"   the shop is not an active, known shop: nothing to do
export async function processRestock({ shopDomain, variantGid, inStock, observedAt }) {
  if (typeof inStock !== "boolean") throw new TypeError("inStock must be a boolean");
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    throw new TypeError("observedAt must be the Date at which Shopify was read");
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => apply(tx, { shopDomain, variantGid, inStock, observedAt }), TX_OPTIONS);
    } catch (error) {
      // P2034: deadlock / write conflict. Safe to repeat: every step is conditional.
      if (error?.code !== "P2034" || attempt >= 2) throw error;
    }
  }
}

async function apply(tx, { shopDomain, variantGid, inStock, observedAt }) {
  const shop = await tx.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || shop.status !== "ACTIVE") return { outcome: "unknown_shop" };

  const row = await tx.variantAvailability.findUnique({
    where: { shopId_variantGid: { shopId: shop.id, variantGid } },
    select: { id: true },
  });
  if (!row) return { outcome: "untracked" };

  const now = new Date();
  // The state change itself. InnoDB re-checks the WHERE against the latest committed row when it
  // has to wait for a lock, so of several simultaneous identical events exactly one matches.
  const moved = await tx.variantAvailability.updateMany({
    where: { id: row.id, isInStock: !inStock, ...notOlderThan(observedAt) },
    data: {
      isInStock: inStock,
      sourceUpdatedAt: observedAt,
      lastSyncedAt: now,
      ...(inStock ? { restockCycle: { increment: 1 } } : {}),
    },
  });

  if (moved.count === 0) {
    // Either it is already in this state (duplicate) or a newer observation exists (stale).
    const touched = await tx.variantAvailability.updateMany({
      where: { id: row.id, ...notOlderThan(observedAt) },
      data: { sourceUpdatedAt: observedAt, lastSyncedAt: now },
    });
    return { outcome: touched.count ? "unchanged" : "stale" };
  }

  if (!inStock) return { outcome: "out_of_stock" };

  // We hold the row's lock, so this is the cycle we just created.
  const { restockCycle } = await tx.variantAvailability.findUnique({
    where: { id: row.id },
    select: { restockCycle: true },
  });

  // Eligible: ACTIVE and subscribed before this cycle (baselineCycle is the cycle they subscribed in).
  const subscriptions = await tx.notifySubscription.findMany({
    where: { shopId: shop.id, variantGid, status: "ACTIVE", baselineCycle: { lt: restockCycle } },
    select: { id: true },
  });
  let jobsCreated = 0;
  if (subscriptions.length) {
    const created = await tx.emailDelivery.createMany({
      data: subscriptions.map((subscription) => ({
        shopId: shop.id,
        subscriptionId: subscription.id,
        restockCycle,
        variantGid,
        status: "PENDING",
        nextAttemptAt: now,
      })),
      skipDuplicates: true, // UNIQUE(subscriptionId, restockCycle)
    });
    jobsCreated = created.count;
  }
  return { outcome: "restocked", restockCycle, jobsCreated };
}
