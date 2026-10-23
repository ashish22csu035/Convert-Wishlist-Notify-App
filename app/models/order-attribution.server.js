import { Prisma } from "@prisma/client";

// Purchase attribution is recomputed from the order and recorded interactions.
// Each purchased line item gets one last-touch winner, and rows aggregate by
// order, feature, and product for idempotent reporting.
//
// Rules (from the PRD's purchase-matching section):
//   - Identity: the verified Shopify customer id on the order must belong to an Actor of the same shop
//     (a customer who used Wishlist or Notify Me). Guest orders, and orders whose payload carries no
//     customer id, are never attributed. No email or phone matching is done.
//   - Only paid orders count (PAID, PARTIALLY_REFUNDED, REFUNDED). Pending, authorized or voided orders get none.
//   - Wishlist saves and product clicks are lifetime touches for the PRODUCT bought (any variant of it),
//     while that saved item was still saved when the order was placed.
//   - A Wishlist-originated cart event qualifies for seven days; a stale latest cart suppresses Wishlist
//     touches for that product instead of falling back to an older save.
//   - Notify Me touch: a RESTOCK_EMAIL_SENT event for the exact VARIANT bought.
//     That event is only written when the SMTP server accepted the mail, so a subscription, a queued,
//     failed or unknown email never counts.
//   - The most recent qualifying touch wins for each line item (ties: the later event id).
//   - Revenue is credited only for line items matched by their winning touch.
//     The full order total stays on ShopifyOrder.totalPrice and is never credited to a feature.
//   - Net revenue is gross minus refunds on those same line items. An order that is cancelled or whose
//     credited items are fully refunded is REVERSED: kept for the record, excluded from reporting.

export const ATTRIBUTION_WINDOW_DAYS = 7;
const WINDOW_MS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const PAID_STATUSES = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];
const TOUCH_TYPES = ["WISHLIST_ADDED", "WISHLIST_ADDED_TO_CART", "WISHLIST_PRODUCT_CLICKED", "RESTOCK_EMAIL_SENT"];

const D = (value) => new Prisma.Decimal(value ?? 0);
const lessOf = (a, b) => (a.lessThan(b) ? a : b);
const compareTouch = (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

// Pure: which line items a touch event covers. Wishlist matches the product, Notify Me the variant
// (the successful-email event must carry an exact variant id).
export function itemsMatchedBy(event, items) {
  if (event.type === "RESTOCK_EMAIL_SENT") {
    return items.filter((item) => Boolean(event.variantGid) && item.variantGid === event.variantGid);
  }
  return items.filter((item) => item.productGid === event.productGid);
}

// Pure: picks one winner per line item. Wishlist saves/clicks are lifetime touches;
// only Wishlist cart events expire. A stale latest cart suppresses other Wishlist
// touches for that product, while Notify Me remains independently eligible.
export function chooseTouch(events, items, savedAtOrder, orderPlacedAt) {
  const orderTime = orderPlacedAt.getTime();
  const beforeOrder = events.filter((event) => event.occurredAt.getTime() <= orderTime);

  return items.flatMap((item) => {
    const latestCart = beforeOrder
      .filter((event) => event.type === "WISHLIST_ADDED_TO_CART" && event.productGid === item.productGid)
      .sort(compareTouch)[0];
    const staleCart = latestCart && orderTime - latestCart.occurredAt.getTime() > WINDOW_MS;

    const candidates = beforeOrder.filter((event) => {
      if (!itemsMatchedBy(event, [item]).length) return false;
      if (event.type === "RESTOCK_EMAIL_SENT") return true;
      if (staleCart) return false;
      if (event.type === "WISHLIST_ADDED_TO_CART") {
        return orderTime - event.occurredAt.getTime() <= WINDOW_MS;
      }
      return savedAtOrder.get(event.variantGid ?? event.productGid) === true;
    });
    candidates.sort(compareTouch);
    return candidates.length ? [{ event: candidates[0], item }] : [];
  });
}

// Recomputes the attribution of one stored order inside the caller's transaction.
export async function syncAttribution(tx, order) {
  const clear = () => tx.orderAttribution.deleteMany({ where: { orderId: order.id, shopId: order.shopId } });

  if (!order.customerGid || !PAID_STATUSES.includes(order.financialStatus)) {
    await clear();
    return null;
  }
  const actor = await tx.actor.findUnique({ where: { shopId_customerGid: { shopId: order.shopId, customerGid: order.customerGid } }, select: { id: true } });
  if (!actor) {
    await clear();
    return null;
  }
  const items = await tx.shopifyOrderLineItem.findMany({ where: { orderId: order.id, shopId: order.shopId } });
  if (!items.length) {
    await clear();
    return null;
  }

  const base = { shopId: order.shopId, actorId: actor.id };
  const events = await tx.activityEvent.findMany({
    where: { ...base, type: { in: TOUCH_TYPES }, occurredAt: { lte: order.placedAt } },
    select: { id: true, type: true, feature: true, occurredAt: true, productGid: true, variantGid: true },
  });

  // Was each saved item still saved when the order was placed? The latest add/remove up to then decides.
  const history = await tx.activityEvent.findMany({
    where: { ...base, type: { in: ["WISHLIST_ADDED", "WISHLIST_REMOVED"] }, occurredAt: { lte: order.placedAt }, productGid: { in: [...new Set(items.map((item) => item.productGid))] } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: { type: true, productGid: true, variantGid: true },
  });
  const savedAtOrder = new Map();
  for (const event of history) savedAtOrder.set(event.variantGid ?? event.productGid, event.type === "WISHLIST_ADDED");

  const chosen = chooseTouch(events, items, savedAtOrder, order.placedAt);
  if (!chosen.length) {
    await clear();
    return null;
  }

  const grouped = new Map();
  for (const { event, item } of chosen) {
    const key = `${event.feature}\u0000${item.productGid}`;
    const group = grouped.get(key) ?? {
      feature: event.feature,
      productGid: item.productGid,
      event,
      variantGid: item.variantGid,
      gross: D(0),
      refunded: D(0),
    };
    group.gross = group.gross.plus(item.lineTotal);
    group.refunded = group.refunded.plus(lessOf(D(item.refundedAmount), D(item.lineTotal)));
    if (compareTouch(event, group.event) < 0) {
      group.event = event;
      group.variantGid = item.variantGid;
    }
    grouped.set(key, group);
  }

  const ids = [];
  for (const group of grouped.values()) {
    const reversed = Boolean(order.cancelledAt) || order.financialStatus === "REFUNDED" ||
      (group.gross.greaterThan(0) && group.refunded.greaterThanOrEqualTo(group.gross));
    const data = {
      feature: group.feature,
      touchEventId: group.event.id,
      touchedAt: group.event.occurredAt,
      matchedProductGid: group.productGid,
      matchedVariantGid: group.variantGid ?? null,
      grossAmount: group.gross,
      refundedAmount: group.refunded,
      currencyCode: order.currencyCode,
      status: reversed ? "REVERSED" : "ACTIVE",
    };
    const saved = await tx.orderAttribution.upsert({
      where: {
        orderId_shopId_feature_matchedProductGid: {
          orderId: order.id,
          shopId: order.shopId,
          feature: group.feature,
          matchedProductGid: group.productGid,
        },
      },
      create: { shopId: order.shopId, orderId: order.id, ...data },
      update: data,
    });
    ids.push(saved.id);
  }
  await tx.orderAttribution.deleteMany({ where: { orderId: order.id, shopId: order.shopId, id: { notIn: ids } } });
  return grouped;
}
