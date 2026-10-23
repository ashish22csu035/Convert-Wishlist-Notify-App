import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { toGid, toShopDomain } from "../utils/shopify-ids.server";
import { syncAttribution } from "./order-attribution.server";

// orders/paid and orders/updated -> ShopifyOrder, ShopifyOrderLineItem and (through
// syncAttribution) OrderAttribution.
//
// Why these two topics and nothing else (read_orders is the only scope they need):
//   orders/paid     the moment an order becomes eligible for attribution (PRD: paid orders only)
//   orders/updated  every later change to the same order: edits, cancellation, refunds and financial
//                   status changes all arrive here with the whole current order, so one idempotent
//                   upsert keeps the stored copy and the attribution correct. refunds/create,
//                   orders/cancelled and orders/edited would add nothing the payload does not already say.
//
// Safety, in the same style as the inventory webhook (WebhookEvent: UNIQUE shopDomain + topic + dedupeKey):
//   - the route has already verified Shopify's HMAC; nothing here runs on an unverified body
//   - a duplicate delivery of finished work is acknowledged and does nothing
//   - an older version of an order (updated_at before the stored one) never overwrites a newer one
//   - orders are only stored for known, ACTIVE shops, and every row carries that shop's id
//   - no customer email, phone, name or address is read or stored: only the verified customer id
//
// Money is the shop's own currency (shop_money), line totals are price x quantity minus the line's
// discounts (tax and shipping are not revenue of the item), refunds are the refunded line subtotals.

const TOPICS = { ORDERS_PAID: "ORDERS_PAID", ORDERS_UPDATED: "ORDERS_UPDATED" };
const LEASE_MS = 60 * 1000;

const normalizeTopic = (topic) => String(topic ?? "").toUpperCase().replace(/[/.]/g, "_");
const errorCodeOf = (error) => String(error?.code ?? error?.name ?? "error").slice(0, 64);

function decimal(value) {
  if (value === null || value === undefined || value === "") return new Prisma.Decimal(0);
  const parsed = new Prisma.Decimal(String(value)); // throws on garbage: the caller treats that as an invalid order
  if (!parsed.isFinite()) throw new TypeError("not a finite amount");
  return parsed;
}
const shopMoney = (set, fallback) => decimal(set?.shop_money?.amount ?? fallback);
const dateOf = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Pure. Returns the order in the shape stored, or null when the payload is not a usable order.
export function parseOrder(payload) {
  try {
    if (!payload || typeof payload !== "object") return null;
    const orderGid = toGid("Order", payload.admin_graphql_api_id ?? payload.id);
    const placedAt = dateOf(payload.created_at);
    if (!orderGid || !placedAt) return null;

    const currency = String(payload.total_price_set?.shop_money?.currency_code ?? payload.currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return null;

    // Refunded amount per line item, summed over every refund on the order.
    const refundedByLine = new Map();
    let totalRefunded = new Prisma.Decimal(0);
    for (const refund of Array.isArray(payload.refunds) ? payload.refunds : []) {
      for (const line of Array.isArray(refund?.refund_line_items) ? refund.refund_line_items : []) {
        const amount = shopMoney(line.subtotal_set, line.subtotal);
        const key = String(line.line_item_id);
        refundedByLine.set(key, (refundedByLine.get(key) ?? new Prisma.Decimal(0)).plus(amount));
        totalRefunded = totalRefunded.plus(amount);
      }
    }

    const lineItems = [];
    for (const line of Array.isArray(payload.line_items) ? payload.line_items : []) {
      const productGid = toGid("Product", line?.product_id);
      const lineItemGid = toGid("LineItem", line?.admin_graphql_api_id ?? line?.id);
      const quantity = Number(line?.current_quantity ?? line?.quantity);
      if (!productGid || !lineItemGid || !Number.isInteger(quantity) || quantity <= 0) continue; // custom or removed lines
      const gross = shopMoney(line.price_set, line.price).times(quantity).minus(shopMoney(line.total_discount_set, line.total_discount));
      const lineTotal = gross.lessThan(0) ? new Prisma.Decimal(0) : gross;
      const refunded = refundedByLine.get(String(line.id)) ?? new Prisma.Decimal(0);
      lineItems.push({
        lineItemGid,
        productGid,
        variantGid: toGid("ProductVariant", line.variant_id),
        quantity,
        lineTotal,
        refundedAmount: refunded.greaterThan(lineTotal) ? lineTotal : refunded,
      });
    }

    return {
      orderGid,
      orderName: String(payload.name ?? payload.order_number ?? orderGid.split("/").pop()).slice(0, 64),
      customerGid: toGid("Customer", payload.customer?.id),
      placedAt,
      shopifyUpdatedAt: dateOf(payload.updated_at) ?? placedAt,
      cancelledAt: payload.cancelled_at ? dateOf(payload.cancelled_at) : null,
      financialStatus: String(payload.financial_status ?? "unknown").toUpperCase().slice(0, 32),
      currencyCode: currency,
      totalPrice: shopMoney(payload.total_price_set, payload.total_price),
      totalRefunded,
      lineItems,
    };
  } catch {
    return null;
  }
}

// Returns { event } when this delivery owns the work, or { skip: "duplicate" | "in_progress" }.
async function claimEvent({ shopDomain, shopId, topic, key, webhookId, orderGid, triggeredAt }) {
  const data = { shopDomain, shopId, topic, dedupeKey: key, webhookId, resourceGid: orderGid, triggeredAt, status: "RECEIVED", attempts: 1 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { event: await prisma.webhookEvent.create({ data }) };
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
    const existing = await prisma.webhookEvent.findUnique({ where: { shopDomain_topic_dedupeKey: { shopDomain, topic, dedupeKey: key } } });
    if (!existing) continue;
    if (existing.status === "PROCESSED" || existing.status === "IGNORED") return { skip: "duplicate" };
    const claimed = await prisma.webhookEvent.updateMany({
      where: { id: existing.id, OR: [{ status: "FAILED" }, { status: "RECEIVED", receivedAt: { lt: new Date(Date.now() - LEASE_MS) } }] },
      data: { status: "RECEIVED", receivedAt: new Date(), attempts: { increment: 1 }, errorCode: null },
    });
    return claimed.count ? { event: existing } : { skip: "in_progress" };
  }
  return { skip: "in_progress" };
}

const TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 10000 };

// Stores the order and refreshes its attribution in one transaction. Returns "applied" or "stale".
async function applyOrder(shopId, order) {
  return prisma.$transaction(async (tx) => {
    const fields = {
      orderName: order.orderName,
      customerGid: order.customerGid,
      placedAt: order.placedAt,
      cancelledAt: order.cancelledAt,
      financialStatus: order.financialStatus,
      currencyCode: order.currencyCode,
      totalPrice: order.totalPrice,
      totalRefunded: order.totalRefunded,
      shopifyUpdatedAt: order.shopifyUpdatedAt,
    };
    await tx.shopifyOrder.upsert({
      where: { shopId_orderGid: { shopId, orderGid: order.orderGid } },
      create: { shopId, orderGid: order.orderGid, ...fields },
      update: {},
    });
    // The row is locked until the end, so two deliveries for one order run one after the other.
    const [{ id }] = await tx.$queryRaw`SELECT id FROM ShopifyOrder WHERE shopId = ${shopId} AND orderGid = ${order.orderGid} FOR UPDATE`;
    const stored = await tx.shopifyOrder.findUnique({ where: { id } });
    if (stored.shopifyUpdatedAt > order.shopifyUpdatedAt) return "stale"; // a newer version is already stored

    const saved = await tx.shopifyOrder.update({ where: { id }, data: fields });
    await tx.shopifyOrderLineItem.deleteMany({ where: { orderId: id, shopId, lineItemGid: { notIn: order.lineItems.map((item) => item.lineItemGid) } } });
    for (const item of order.lineItems) {
      await tx.shopifyOrderLineItem.upsert({
        where: { orderId_lineItemGid: { orderId: id, lineItemGid: item.lineItemGid } },
        create: { shopId, orderId: id, ...item },
        update: { productGid: item.productGid, variantGid: item.variantGid, quantity: item.quantity, lineTotal: item.lineTotal, refundedAmount: item.refundedAmount },
      });
    }
    await syncAttribution(tx, saved);
    return "applied";
  }, TX_OPTIONS);
}

// Returns { status, outcome }. status is the HTTP status: 200 handled or safely ignored, 503 retry.
export async function handleOrderWebhook(input) {
  const topic = normalizeTopic(input.topic);
  const shopDomain = toShopDomain(input.shopDomain);
  const key = String(input.eventId || input.webhookId || "").trim();
  const order = parseOrder(input.payload);
  if (!TOPICS[topic] || !shopDomain || !key || key.length > 191 || !order) {
    console.warn("[orders] webhook ignored: invalid request");
    return { status: 200, outcome: "ignored_invalid" }; // signed but unusable: a retry cannot help
  }
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || shop.status !== "ACTIVE") return { status: 200, outcome: "ignored_shop" };

  const triggered = input.triggeredAt ? dateOf(input.triggeredAt) : null;
  const claim = await claimEvent({ shopDomain, shopId: shop.id, topic, key, webhookId: String(input.webhookId ?? key).slice(0, 191), orderGid: order.orderGid, triggeredAt: triggered });
  if (claim.skip) return { status: 200, outcome: claim.skip };

  try {
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await applyOrder(shop.id, order);
        break;
      } catch (error) {
        // P2002: two first deliveries for one order raced to create it. P2034: deadlock / write conflict.
        // Every step is conditional or an upsert, so repeating is safe.
        if ((error?.code !== "P2002" && error?.code !== "P2034") || attempt >= 2) throw error;
      }
    }
    await prisma.webhookEvent.update({
      where: { id: claim.event.id },
      data: { status: result === "stale" ? "IGNORED" : "PROCESSED", errorCode: result === "stale" ? "stale_order" : null, processedAt: new Date() },
    });
    return { status: 200, outcome: result === "stale" ? "stale" : "processed" };
  } catch (error) {
    console.error("[orders] webhook failed", JSON.stringify({ shop: shopDomain, code: errorCodeOf(error) }));
    try {
      await prisma.webhookEvent.update({ where: { id: claim.event.id }, data: { status: "FAILED", errorCode: errorCodeOf(error) } });
    } catch {
      /* stays RECEIVED and is retaken once the lease has expired */
    }
    return { status: 503, outcome: "failed" };
  }
}
