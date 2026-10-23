import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { findOrCreateBrowsingSession } from "./browsing-session.server";
import { numericId } from "../utils/shopify-ids.server";

// A browsing session lasts exactly 30 minutes from its start. Activity never
// extends it (the database also enforces expiresAt = startedAt + 30 minutes).
export const MAX_WISHLIST_ITEMS = 200;

// Shop.currencyCode is required by the schema but is not known on the
// storefront path. "XXX" is the ISO 4217 code for "no currency"; the install
// sync fills in the real currency later.
const UNKNOWN_CURRENCY = "XXX";

export class WishlistError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ReadCommitted so that every statement sees rows committed by a concurrent
// request that held the per-customer lock before us.
const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5000,
  timeout: 10000,
};

function toClientItem(row) {
  return {
    productId: numericId(row.productGid),
    variantId: numericId(row.variantGid),
    title: row.productTitle,
    handle: row.productHandle,
  };
}

// Finds or creates the Shop, the Actor (verified customer GID) and the current
// BrowsingSession. The Actor row is locked until the transaction ends, so two
// simultaneous requests from the same customer run one after the other.
async function openCustomerContext(tx, { shopDomain, customerGid }, feature) {
  const shop = await tx.shop.upsert({
    where: { domain: shopDomain },
    create: { domain: shopDomain, currencyCode: UNKNOWN_CURRENCY },
    update: {},
  });
  if (shop.status !== "ACTIVE") throw new WishlistError("shop_inactive", 403);

  const actor = await tx.actor.upsert({
    where: { shopId_customerGid: { shopId: shop.id, customerGid } },
    create: { shopId: shop.id, customerGid },
    update: { lastSeenAt: new Date() },
  });
  await tx.$queryRaw`SELECT id FROM Actor WHERE id = ${actor.id} FOR UPDATE`;

  const session = await findOrCreateBrowsingSession(
    tx,
    { shopId: shop.id, actorId: actor.id, feature },
  );

  return { shop, actor, session };
}

export async function mutate(identity, feature, work) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const context = await openCustomerContext(tx, identity, feature);
        return work(tx, context);
      }, TX_OPTIONS);
    } catch (error) {
      // P2002: lost a unique-key race on first insert. P2034: deadlock/conflict.
      const retryable = error?.code === "P2002" || error?.code === "P2034";
      if (!retryable || attempt >= 2) throw error;
    }
  }
}

export function logEvent(tx, { shop, actor, session }, type, productGid, variantGid) {
  return tx.activityEvent.create({
    data: {
      shopId: shop.id,
      actorId: actor.id,
      browsingSessionId: session.id,
      type,
      feature: session.feature,
      productGid,
      variantGid: variantGid ?? null,
    },
  });
}

// Read-only: does not create a Shop, Actor or session for unknown customers.
export async function listWishlist({ shopDomain, customerGid }) {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return [];
  const actor = await prisma.actor.findUnique({
    where: { shopId_customerGid: { shopId: shop.id, customerGid } },
  });
  if (!actor) return [];
  const rows = await prisma.wishlistItem.findMany({
    where: { shopId: shop.id, actorId: actor.id },
    orderBy: { createdAt: "desc" },
    take: MAX_WISHLIST_ITEMS,
  });
  return rows.map(toClientItem);
}

// A wishlist item is one specific product VARIANT. The same customer can save several
// variants of one product, but never the same variant twice: the database enforces
// UNIQUE(actorId, variantGid), and this code checks first so a repeat is a quiet no-op
// (no duplicate row and no second "added" event). Findings use findFirst on purpose, so
// they do not depend on the generated compound-unique key.
export function addToWishlist(identity, { productGid, variantGid, title, handle }) {
  return mutate(identity, "WISHLIST", async (tx, context) => {
    const { shop, actor } = context;
    if (!variantGid) throw new WishlistError("variant_required", 400);

    const existing = await tx.wishlistItem.findFirst({ where: { actorId: actor.id, variantGid } });
    if (existing) {
      const count = await tx.wishlistItem.count({ where: { actorId: actor.id } });
      return { saved: true, changed: false, count };
    }

    const count = await tx.wishlistItem.count({ where: { actorId: actor.id } });
    if (count >= MAX_WISHLIST_ITEMS) throw new WishlistError("wishlist_full", 409);

    await tx.wishlistItem.create({
      data: {
        shopId: shop.id,
        actorId: actor.id,
        productGid,
        variantGid,
        productTitle: title,
        productHandle: handle,
      },
    });
    await logEvent(tx, context, "WISHLIST_ADDED", productGid, variantGid);
    return { saved: true, changed: true, count: count + 1 };
  });
}

// Which stored item a request means: the exact variant, or (older rows saved before
// items were variant-specific) the product-level row that has no variant.
function itemWhere(actorId, { productGid, variantGid }) {
  return variantGid ? { actorId, variantGid } : { actorId, productGid, variantGid: null };
}

export function removeFromWishlist(identity, { productGid, variantGid }) {
  return mutate(identity, "WISHLIST", async (tx, context) => {
    const { actor } = context;
    const existing = await tx.wishlistItem.findFirst({ where: itemWhere(actor.id, { productGid, variantGid }) });
    if (existing) {
      await tx.wishlistItem.delete({ where: { id: existing.id } });
      await logEvent(tx, context, "WISHLIST_REMOVED", existing.productGid, existing.variantGid);
    }
    const count = await tx.wishlistItem.count({ where: { actorId: actor.id } });
    return { saved: false, changed: Boolean(existing), count };
  });
}

// The customer opened the My Wishlist page. Opens the customer's current browsing
// session (or reuses the unexpired one) through the same openCustomerContext as
// every other wishlist write, and records nothing else: no ActivityEvent, and the
// session's fixed 30-minute expiry is never touched. Ordinary storefront pages
// never call this.
export function recordWishlistOpen(identity) {
  return mutate(identity, "WISHLIST", async () => ({ opened: true }));
}

// A Notify Me form interaction opens its own fixed-duration session, separate
// from Wishlist engagement. Ordinary browsing never calls this operation.
export function recordNotifyMeOpen(identity) {
  return mutate(identity, "NOTIFY_ME", async () => ({ opened: true }));
}

// Customer opened a saved product from the My Wishlist page. Only recorded for
// products that are really on this customer's wishlist.
export function recordWishlistClick(identity, { productGid, variantGid }) {
  return mutate(identity, "WISHLIST", async (tx, context) => {
    const existing = await tx.wishlistItem.findFirst({ where: itemWhere(context.actor.id, { productGid, variantGid }) });
    if (existing) {
      await logEvent(tx, context, "WISHLIST_PRODUCT_CLICKED", existing.productGid, existing.variantGid);
    }
    return { saved: Boolean(existing), changed: Boolean(existing) };
  });
}

// Called only after the My Wishlist page confirms that Shopify added the line.
export function recordWishlistCartAdd(identity, { productGid, variantGid }) {
  return mutate(identity, "WISHLIST", async (tx, context) => {
    const existing = await tx.wishlistItem.findFirst({ where: itemWhere(context.actor.id, { productGid, variantGid }) });
    if (existing?.productGid === productGid) {
      await logEvent(tx, context, "WISHLIST_ADDED_TO_CART", existing.productGid, existing.variantGid);
    }
    return { recorded: existing?.productGid === productGid };
  });
}
