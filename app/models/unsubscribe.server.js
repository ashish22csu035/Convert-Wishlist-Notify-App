import crypto from "node:crypto";
import prisma from "../db.server";

// One-click unsubscribe. The link in a restock email carries a random 256-bit token. Only its SHA-256
// hash is stored (EmailDelivery.linkTokenHash, unique), so a database leak does not reveal usable
// links, and nothing in the link contains a customer, shop or subscription id.

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function unsubscribeUrl(baseUrl, token) {
  return `${baseUrl}/notify/unsubscribe?t=${token}`;
}

async function findByToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  return prisma.emailDelivery.findUnique({
    where: { linkTokenHash: hashToken(token) },
    select: { id: true, shopId: true, subscriptionId: true },
  });
}

// Does the token belong to a real email? (Used to render the confirmation page; changes nothing.)
export async function isKnownToken(token) {
  return Boolean(await findByToken(token));
}

// Returns "unsubscribed" (state changed now), "already" (nothing more will be sent for this item),
// or "unknown" (not a valid token). Repeating the call is harmless.
export async function unsubscribeByToken(token) {
  const delivery = await findByToken(token);
  if (!delivery) return "unknown";

  return prisma.$transaction(async (tx) => {
    // ACTIVE -> UNSUBSCRIBED only. A FULFILLED subscription has already been emailed and receives no
    // more mail for this item, and an UNSUBSCRIBED one is already done.
    const changed = await tx.notifySubscription.updateMany({
      where: { id: delivery.subscriptionId, shopId: delivery.shopId, status: "ACTIVE" },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
    });
    if (changed.count !== 1) return "already";

    const subscription = await tx.notifySubscription.findUnique({
      where: { id: delivery.subscriptionId },
      select: { shopId: true, actorId: true, productGid: true, variantGid: true },
    });
    await tx.activityEvent.create({
      data: {
        shopId: subscription.shopId,
        actorId: subscription.actorId,
        type: "NOTIFY_UNSUBSCRIBED",
        feature: "NOTIFY_ME",
        productGid: subscription.productGid,
        variantGid: subscription.variantGid,
      },
    });
    return "unsubscribed";
  });
}
