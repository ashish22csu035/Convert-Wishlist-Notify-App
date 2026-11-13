import prisma from "../db.server";

// The lock that serializes every limit that must hold across simultaneous requests of ONE shop (the restock-email quota and the
// store-wide wishlist cap): the shop's ShopSubscription row, locked with SELECT ... FOR UPDATE until the end of the transaction.
//
// Why that row and not the Shop row: the Shop row is the parent of Actor, BrowsingSession and many other rows, and InnoDB takes a
// SHARED lock on a parent row for every insert of a child. A transaction that held that shared lock and then asked for the exclusive
// one would deadlock with another doing the same (found by test: simultaneous first additions from several customers). Nothing has a
// foreign key to ShopSubscription, so locking it can only ever make a transaction WAIT for another one that is about to finish.
//
// The row must exist before the lock is taken, and it is created OUTSIDE the transaction (two creators racing is harmless: the loser
// reads the winner's row). A free Basic row is a real state, not a guess: it is the same as having no row.
export async function ensureShopSubscription(shopId, { db = prisma } = {}) {
  try {
    return await db.shopSubscription.upsert({ where: { shopId }, create: { shopId }, update: {} });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return db.shopSubscription.findUniqueOrThrow({ where: { shopId } });
  }
}

// Held until the end of the surrounding transaction. Call ensureShopSubscription first. The only lock a limit check takes; a
// customer's own row lock (wishlist writes) is always taken before it, never after, so there is one order and no cycle.
export const lockShopLimits = (tx, shopId) => tx.$queryRaw`SELECT id FROM ShopSubscription WHERE shopId = ${shopId} FOR UPDATE`;
