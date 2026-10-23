import prisma from "../db.server";
import { numericId } from "../utils/shopify-ids.server";
import { logEvent, mutate } from "./wishlist.server";
import { traceProxy } from "../utils/storefront-auth.server";
import { notOlderThan } from "./restock.server";
import {
  LookupError,
  fetchCustomerEmail,
  resolveStorefrontPurchasable,
  fetchVariantForNotify,
  getShopAdmin,
  hasCustomerScope,
} from "./shopify-lookup.server";

const SETTLE_WAITS_MS = [500, 1000];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const NOTIFY_CONSENT_SOURCE = "customer_account_one_click";

// Which of these variants (GIDs) the verified customer currently has an ACTIVE
// subscription for. Read-only: it never creates a Shop, Actor, session or event, only
// reports on this shop's and this customer's own rows, and returns numeric variant ids.
export async function listActiveSubscriptions({ shopDomain, customerGid }, variantGids) {
  if (!variantGids.length) return [];
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return [];
  const actor = await prisma.actor.findUnique({
    where: { shopId_customerGid: { shopId: shop.id, customerGid } },
  });
  if (!actor) return [];
  const rows = await prisma.notifySubscription.findMany({
    where: { shopId: shop.id, actorId: actor.id, status: "ACTIVE", variantGid: { in: variantGids } },
    select: { variantGid: true },
  });
  return rows.map((row) => numericId(row.variantGid));
}

// Subscribes the verified customer to restock notices for one variant.
//
// Everything Shopify-side is verified BEFORE any row is written, so a rejected
// request creates no Shop, Actor, session or event. Browser input is only the
// variant id; shop and customer come from the signed proxy identity.
//
// Data model: UNIQUE(shopId, actorId, variantGid) means one row per customer and
// variant. A FULFILLED or UNSUBSCRIBED row is reactivated for the next restock
// cycle by resetting baselineCycle to the variant's current restockCycle.
//
// One case needs more than the Admin API's word: stock held ONLY at a third-party fulfillment service's
// location (Shopify's sample "3p Fulfilled Snowboard"). The Admin API then reports the stock as sellable
// (quantity 18, available for sale) while the storefront shows "Sold out". For that case, and only that case
// (resolveStorefrontPurchasable verifies it from Shopify's own data), the public storefront decides; when the
// storefront cannot be read (password-protected store) the browser's observation (`storefrontSoldOut`) lets the
// customer subscribe, because the structural cause has been verified server-side and a forged claim can only
// subscribe someone to a variant that really is stocked at such a location. A browser claim never overrides a
// readable storefront, and it is ignored for every ordinary variant.
//
// The matching rule on the restock side (inventory-webhook.server.js): for such a variant Admin's "available"
// is not a restock, so a subscription taken here cannot trigger an email by itself.
export async function subscribeToNotify(identity, variantGid, deps = {}) {
  const { getAdmin = getShopAdmin, sleep = defaultSleep, storefrontSoldOut = false, purchasable = resolveStorefrontPurchasable } = deps;
  // When Shopify is first asked about stock. Ordering of availability observations is judged by
  // this moment, so a restock processed after it can never be overwritten by this older reading.
  const observedAt = new Date();
  const { admin, scope } = await getAdmin(identity.shopDomain);

  let variant = await fetchVariantForNotify(admin, variantGid);
  // Right after a stock change Shopify's fields can contradict each other for a moment: look again a
  // couple of times, then ask the customer to retry rather than guess either way.
  for (let i = 0; !variant.settled && i < SETTLE_WAITS_MS.length; i += 1) {
    await sleep(SETTLE_WAITS_MS[i]);
    variant = await fetchVariantForNotify(admin, variantGid);
  }
  if (!variant.settled) {
    traceProxy({ stage: "notify_unsettled", variant: numericId(variantGid), seen: variant.seen });
    throw new LookupError("inventory_unsettled", 503);
  }
  if (!variant.unavailable) {
    const verdict = await purchasable({ admin, shopDomain: identity.shopDomain, variant, variantGid }, deps);
    const accepted = verdict.purchasable === false || (verdict.purchasable === null && storefrontSoldOut === true);
    if (!accepted) {
      // Numbers and flags only (no customer data): what Shopify reported when a sold-out click was refused.
      traceProxy({ stage: "notify_variant_available", variant: numericId(variantGid), seen: variant.seen, basis: verdict.basis, storefrontSoldOut: storefrontSoldOut === true });
      throw new LookupError("variant_available", 409);
    }
    traceProxy({ stage: "notify_storefront_sold_out", variant: numericId(variantGid), basis: verdict.purchasable === false ? "storefront_confirmed" : "storefront_reported", seen: variant.seen });
  }

  if (!hasCustomerScope(scope)) throw new LookupError("customer_data_unavailable", 403);
  const email = await fetchCustomerEmail(admin, identity.customerGid);

  return mutate(identity, "NOTIFY_ME", async (tx, context) => {
    const { shop, actor } = context;
    const now = new Date();

    // Sold out when Shopify was read (verified above): record it, keep the restock cycle counter.
    let availability = await tx.variantAvailability.findUnique({
      where: { shopId_variantGid: { shopId: shop.id, variantGid } },
    });
    if (!availability) {
      availability = await tx.variantAvailability.create({
        data: {
          shopId: shop.id,
          variantGid,
          productGid: variant.productGid,
          inventoryItemGid: variant.inventoryItemGid,
          isInStock: false,
          sourceUpdatedAt: observedAt,
          lastSyncedAt: now,
        },
      });
    } else {
      const moved = await tx.variantAvailability.updateMany({
        where: { id: availability.id, ...notOlderThan(observedAt) },
        data: {
          productGid: variant.productGid,
          inventoryItemGid: variant.inventoryItemGid,
          isInStock: false,
          sourceUpdatedAt: observedAt,
          lastSyncedAt: now,
        },
      });
      // Re-read with the row now locked: this is the cycle the subscription will wait after.
      availability = await tx.variantAvailability.findUnique({ where: { id: availability.id } });
      // A newer observation (a restock processed after our stock check) says it is in stock again:
      // refuse rather than record a subscription against stock that already came back.
      if (moved.count === 0 && availability.isInStock) throw new LookupError("variant_available", 409);
    }

    const existing = await tx.notifySubscription.findFirst({
      where: { shopId: shop.id, actorId: actor.id, variantGid },
    });

    if (existing?.status === "ACTIVE") {
      if (existing.email !== email) {
        await tx.notifySubscription.update({ where: { id: existing.id }, data: { email } });
      }
      return { subscribed: true, changed: false };
    }

    if (existing) {
      await tx.notifySubscription.update({
        where: { id: existing.id },
        data: {
          status: "ACTIVE",
          email,
          baselineCycle: availability.restockCycle,
          consentedAt: now,
          consentSource: NOTIFY_CONSENT_SOURCE,
          unsubscribedAt: null,
        },
      });
    } else {
      await tx.notifySubscription.create({
        data: {
          shopId: shop.id,
          actorId: actor.id,
          productGid: variant.productGid,
          variantGid,
          email,
          baselineCycle: availability.restockCycle,
          consentedAt: now,
          consentSource: NOTIFY_CONSENT_SOURCE,
        },
      });
    }
    await logEvent(tx, context, "NOTIFY_SUBSCRIBED", variant.productGid, variantGid);
    return { subscribed: true, changed: true };
  });
}
