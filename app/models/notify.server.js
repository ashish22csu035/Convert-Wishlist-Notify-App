import prisma from "../db.server";
import { numericId } from "../utils/shopify-ids.server";
import { hashToken } from "./unsubscribe.server";
import { ATTRIBUTION_WINDOW_DAYS } from "./order-attribution.server";
import { WishlistError, logEvent, mutate } from "./wishlist.server";
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
  const progress = { stage: "start" };
  try {
    return await subscribe(identity, variantGid, deps, progress);
  } catch (error) {
    // Which step failed, for the server log (the storefront only ever sees the short error code).
    if (error && typeof error === "object" && !error.stage) error.stage = progress.stage;
    throw error;
  }
}

async function subscribe(identity, variantGid, deps, progress) {
  const { getAdmin = getShopAdmin, sleep = defaultSleep, storefrontSoldOut = false, purchasable = resolveStorefrontPurchasable } = deps;
  // When Shopify is first asked about stock. Ordering of availability observations is judged by
  // this moment, so a restock processed after it can never be overwritten by this older reading.
  const observedAt = new Date();
  progress.stage = "admin_session";
  const { admin, scope } = await getAdmin(identity.shopDomain);

  progress.stage = "variant_lookup";

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
    progress.stage = "availability_check";
    const verdict = await purchasable({ admin, shopDomain: identity.shopDomain, variant, variantGid }, deps);
    const accepted = verdict.purchasable === false || (verdict.purchasable === null && storefrontSoldOut === true);
    if (!accepted) {
      // Numbers and flags only (no customer data): what Shopify reported when a sold-out click was refused.
      traceProxy({ stage: "notify_variant_available", variant: numericId(variantGid), seen: variant.seen, basis: verdict.basis, storefrontSoldOut: storefrontSoldOut === true });
      throw new LookupError("variant_available", 409);
    }
    traceProxy({ stage: "notify_storefront_sold_out", variant: numericId(variantGid), basis: verdict.purchasable === false ? "storefront_confirmed" : "storefront_reported", seen: variant.seen });
  }

  progress.stage = "customer_lookup";
  if (!hasCustomerScope(scope)) throw new LookupError("customer_data_unavailable", 403, { reason: "scope_not_granted" });
  const email = await fetchCustomerEmail(admin, identity.customerGid);

  progress.stage = "save";
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

// The storefront reports that the EMAILED variant is now in the cart, after the customer came from a restock email.
//
// The email's product link carries an opaque token (?kw_n=, saved only as a hash on the EmailDelivery). Nothing the browser
// sends is trusted beyond that token: the shop and the customer come from the signed proxy identity, and the delivery,
// the variant and the product come from the database. A cart addition is recorded (one NOTIFY_ADDED_TO_CART event) only when
//   - the token belongs to a restock email of THIS shop that the mail server accepted (status SENT);
//   - that email was sent to THIS signed-in customer (a forwarded link cannot credit someone else's email);
//   - the variant in the cart is exactly the variant the email was about (an unrelated product is never counted);
//   - the email is at most ATTRIBUTION_WINDOW_DAYS old (the same 7 days as every other touch).
// UNIQUE(emailDeliveryId) makes a repeated report (a retry, a second tab) change nothing: { recorded: false, duplicate: true }.
// It writes no session and creates no Shop or Actor, and a refusal writes nothing. The browser only calls this after Shopify's own
// cart shows the line, so a failed cart addition is never sent (and is never trusted if it were: see the storefront script).
const CART_WINDOW_MS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export async function recordNotifyCartAdd({ shopDomain, customerGid }, { token, variantGid }, now = () => new Date()) {
  const refuse = () => new WishlistError("attribution_invalid", 422);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token) || !variantGid) throw refuse();
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || shop.status !== "ACTIVE") throw refuse();
  const actor = await prisma.actor.findUnique({ where: { shopId_customerGid: { shopId: shop.id, customerGid } }, select: { id: true } });
  if (!actor) throw refuse();
  const delivery = await prisma.emailDelivery.findUnique({
    where: { cartTokenHash: hashToken(token) },
    select: { id: true, shopId: true, status: true, variantGid: true, sentAt: true, subscription: { select: { actorId: true, productGid: true } } },
  });
  if (!delivery || delivery.shopId !== shop.id || delivery.status !== "SENT" || delivery.subscription.actorId !== actor.id) throw refuse();
  if (delivery.variantGid !== variantGid) throw refuse();
  if (!delivery.sentAt || now().getTime() - delivery.sentAt.getTime() > CART_WINDOW_MS) throw refuse();
  try {
    await prisma.activityEvent.create({
      data: { shopId: shop.id, actorId: actor.id, type: "NOTIFY_ADDED_TO_CART", feature: "NOTIFY_ME", productGid: delivery.subscription.productGid, variantGid: delivery.variantGid, emailDeliveryId: delivery.id },
    });
  } catch (error) {
    if (error?.code === "P2002") return { recorded: false, duplicate: true };
    throw error;
  }
  return { recorded: true, duplicate: false };
}
