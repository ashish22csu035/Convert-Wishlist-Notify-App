import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { toGid, toShopDomain } from "../utils/shopify-ids.server";
import { ATTRIBUTION_WINDOW_DAYS, chooseTouch, itemsMatchedBy } from "./order-attribution.server";
import { claimEvent } from "./order-webhook.server";

// checkouts/create and checkouts/update -> CheckoutAttribution: the "Checkout initiated" stage of the Product Funnel.
//
// Why these webhooks: nothing else in the app knows that a customer reached checkout (the storefront script only sees
// the Wishlist page, and orders/paid arrives after payment). They need read_orders, which the app already has, and are
// signed like every other webhook. They say only that a checkout exists: no more is claimed.
//
// What is stored (and only this): for a LOGGED-IN customer who is a known Actor of the shop, one row per feature the
// checkout can be tied to, by the same last-touch rules as order attribution (chooseTouch), restricted to the two
// touches that make a journey and to the last 7 days:
//   WISHLIST   a WISHLIST_ADDED_TO_CART event for a product in the checkout (the customer added it from the Wishlist)
//   NOTIFY_ME  a RESTOCK_EMAIL_SENT event for a variant in the checkout (an email the mail server accepted)
// Guests, unknown customers and checkouts with no such touch store nothing. No email, address or name is read.
// A checkout is counted once per feature however often a webhook is delivered (UNIQUE shopId + checkoutKey + feature).
// Like orders, a checkout with a Wishlist line and a Notify Me line is in both rows.
//
// Two topics, because a checkout is created before Shopify has always attached the signed-in buyer to it: the create
// delivery can arrive without a customer id. (A real delivery did: processed, nothing matched, while the same customer's
// Wishlist cart additions and paid order matched fine, and the same rules matched when given that customer id.) The
// update deliveries carry the customer once it is known. Both run the same rules, `startedAt` is always the checkout's own
// created_at, and the unique row makes the second delivery a no-op. Updates are not logged in WebhookEvent (there can be
// many per checkout; the unique row is their idempotency). A create delivery that attributes nothing records WHY in
// WebhookEvent.errorCode, as a fixed word and never customer data (see attributeCheckoutWithReason).
//
// When a touch counts: its occurredAt is the moment the SERVER recorded it, which is always a little AFTER the customer really
// added the product (the storefront reports the addition once Shopify's cart confirms it). A customer who goes straight to
// checkout can therefore have a touch stamped a few seconds after the checkout's own created_at. A real example from the dev
// store: checkout created_at 11:53:26, the Notify Me cart-addition recorded at 11:53:28.377. Comparing touches to created_at
// alone rejects exactly the customers who check out fastest. So a touch counts when it was recorded up to the moment of the
// webhook's snapshot of the checkout (snapshotAt: Shopify's triggered-at time), but never more than GRACE_MS after created_at,
// so a checkout cannot be credited to something the customer did long after starting it. The product still has to be in the
// checkout payload and the touch inside the 7-day window measured back from snapshotAt.
const WINDOW_MS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const FUNNEL_TOUCHES = ["WISHLIST_ADDED_TO_CART", "RESTOCK_EMAIL_SENT"];
const GRACE_MS = 5 * 60 * 1000;
const CLASSIFY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CLASSIFY_LOOKAHEAD_MS = 60 * 60 * 1000;
const CREATE_TOPIC = "CHECKOUTS_CREATE";
const UPDATE_TOPIC = "CHECKOUTS_UPDATE";
const TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 10000 };
const errorCodeOf = (error) => String(error?.code ?? error?.name ?? "error").slice(0, 64);

// Pure. The checkout in the shape used here, or null when the payload is not a usable checkout.
export function parseCheckout(payload) {
  if (!payload || typeof payload !== "object") return null;
  const key = String(payload.token ?? payload.id ?? "").trim();
  const startedAt = new Date(payload.created_at);
  if (!key || key.length > 191 || Number.isNaN(startedAt.getTime())) return null;
  const items = [];
  for (const line of Array.isArray(payload.line_items) ? payload.line_items : []) {
    const productGid = toGid("Product", line?.product_id);
    if (!productGid) continue; // a custom line has no product
    items.push({ productGid, variantGid: toGid("ProductVariant", line.variant_id) });
  }
  return { key, startedAt, customerGid: toGid("Customer", payload.customer?.id), items };
}

// Pure. The moment the checkout payload is a snapshot of: Shopify's triggered-at time when it is usable (not before the
// checkout was created, not in the future), capped at GRACE_MS after created_at; otherwise created_at itself.
export function snapshotAt(checkout, triggeredAt, now = new Date()) {
  const start = checkout.startedAt.getTime();
  const triggered = triggeredAt instanceof Date ? triggeredAt.getTime() : new Date(triggeredAt ?? NaN).getTime();
  if (!Number.isFinite(triggered) || triggered < start || triggered > now.getTime() + 60 * 1000) return checkout.startedAt;
  return new Date(Math.min(triggered, start + GRACE_MS));
}

// Writes the rows of one checkout. Returns { features, reason }: how many features it was attributed to and, when that is 0,
// the fixed word saying why (never customer data):
//   no_items               the payload had no product line
//   no_customer            the payload carried no customer id (a guest, or the buyer not attached yet)
//   unknown_customer       the customer has never used this shop's Wishlist or Notify Me
//   no_touch_no_events     the customer has no Wishlist cart addition or restock email in the last 30 days
//   no_touch_other_product they have some, but none for a product (Wishlist) or variant (Notify Me) in this checkout
//   no_touch_recorded_late a matching touch exists but was recorded after the checkout's snapshot
//   no_touch_stale         a matching touch exists but is older than the 7-day window
export async function attributeCheckoutWithReason(client, shopId, checkout, { snapshot = checkout.startedAt } = {}) {
  if (!checkout.items.length) return { features: 0, reason: "no_items" };
  if (!checkout.customerGid) return { features: 0, reason: "no_customer" };
  const actor = await client.actor.findUnique({ where: { shopId_customerGid: { shopId, customerGid: checkout.customerGid } }, select: { id: true } });
  if (!actor) return { features: 0, reason: "unknown_customer" };
  const all = await client.activityEvent.findMany({
    where: { shopId, actorId: actor.id, type: { in: FUNNEL_TOUCHES }, occurredAt: { gte: new Date(snapshot.getTime() - CLASSIFY_LOOKBACK_MS), lte: new Date(snapshot.getTime() + CLASSIFY_LOOKAHEAD_MS) } },
    select: { id: true, type: true, feature: true, occurredAt: true, productGid: true, variantGid: true },
  });
  const from = snapshot.getTime() - WINDOW_MS;
  const eligible = all.filter((event) => event.occurredAt.getTime() >= from && event.occurredAt.getTime() <= snapshot.getTime());
  const winners = new Map(); // feature -> latest winning event
  for (const { event } of chooseTouch(eligible, checkout.items, new Map(), snapshot)) {
    const best = winners.get(event.feature);
    if (!best || event.occurredAt > best.occurredAt) winners.set(event.feature, event);
  }
  for (const [feature, event] of winners) {
    await client.checkoutAttribution.upsert({
      where: { shopId_checkoutKey_feature: { shopId, checkoutKey: checkout.key, feature } },
      create: { shopId, actorId: actor.id, checkoutKey: checkout.key, feature, touchEventId: event.id, startedAt: checkout.startedAt },
      update: {},
    });
  }
  if (winners.size) return { features: winners.size, reason: null };
  if (!all.length) return { features: 0, reason: "no_touch_no_events" };
  const matching = all.filter((event) => itemsMatchedBy(event, checkout.items).length > 0);
  if (!matching.length) return { features: 0, reason: "no_touch_other_product" };
  if (matching.some((event) => event.occurredAt.getTime() > snapshot.getTime())) return { features: 0, reason: "no_touch_recorded_late" };
  return { features: 0, reason: "no_touch_stale" };
}

// The same, returning only how many features the checkout was attributed to.
export const attributeCheckout = async (client, shopId, checkout, options) => (await attributeCheckoutWithReason(client, shopId, checkout, options)).features;

// In a transaction, repeated on a race on the same row (safe: every write is an upsert).
async function attributeWithRetry(shopId, checkout, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => attributeCheckoutWithReason(tx, shopId, checkout, options), TX_OPTIONS);
    } catch (error) {
      if ((error?.code !== "P2002" && error?.code !== "P2034") || attempt >= 2) throw error;
    }
  }
}

// Returns { status, outcome }: 200 handled or safely ignored, 503 retry.
export async function handleCheckoutWebhook(input) {
  const shopDomain = toShopDomain(input.shopDomain);
  const key = String(input.eventId || input.webhookId || "").trim();
  const checkout = parseCheckout(input.payload);
  const topic = String(input.topic ?? "").toUpperCase().replace(/[/.]/g, "_");
  const isUpdate = topic === UPDATE_TOPIC;
  if ((topic !== CREATE_TOPIC && !isUpdate) || !shopDomain || !key || key.length > 191 || !checkout) {
    return { status: 200, outcome: "ignored_invalid" }; // signed but unusable: a retry cannot help
  }
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || shop.status !== "ACTIVE") return { status: 200, outcome: "ignored_shop" };
  const options = { snapshot: snapshotAt(checkout, input.triggeredAt) };

  if (isUpdate) {
    // Many updates arrive per checkout. Nothing to do without a customer and a product line, or once the checkout is
    // attributed. No audit row: the unique row is the idempotency.
    if (!checkout.customerGid || !checkout.items.length) return { status: 200, outcome: "ignored_no_customer" };
    const done = await prisma.checkoutAttribution.findFirst({ where: { shopId: shop.id, checkoutKey: checkout.key }, select: { id: true } });
    if (done) return { status: 200, outcome: "already_attributed" };
    try {
      const { features, reason } = await attributeWithRetry(shop.id, checkout, options);
      return { status: 200, outcome: features ? "processed" : reason };
    } catch (error) {
      console.error("[checkouts] webhook failed", JSON.stringify({ shop: shopDomain, code: errorCodeOf(error) }));
      return { status: 503, outcome: "failed" };
    }
  }

  const triggered = input.triggeredAt ? new Date(input.triggeredAt) : null;
  const claim = await claimEvent({
    shopDomain,
    shopId: shop.id,
    topic: CREATE_TOPIC,
    key,
    webhookId: String(input.webhookId ?? key).slice(0, 191),
    orderGid: toGid("Checkout", checkout.key.replace(/\D/g, "")),
    triggeredAt: triggered && !Number.isNaN(triggered.getTime()) ? triggered : null,
  });
  if (claim.skip) return { status: 200, outcome: claim.skip };

  try {
    const { features, reason } = await attributeWithRetry(shop.id, checkout, options);
    await prisma.webhookEvent.update({ where: { id: claim.event.id }, data: { status: "PROCESSED", errorCode: features ? null : reason, processedAt: new Date() } });
    return { status: 200, outcome: features ? "processed" : reason };
  } catch (error) {
    console.error("[checkouts] webhook failed", JSON.stringify({ shop: shopDomain, code: errorCodeOf(error) }));
    try {
      await prisma.webhookEvent.update({ where: { id: claim.event.id }, data: { status: "FAILED", errorCode: errorCodeOf(error) } });
    } catch {
      /* stays RECEIVED and is retaken once the lease has expired */
    }
    return { status: 503, outcome: "failed" };
  }
}
