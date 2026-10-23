export const SESSION_MS = 30 * 60 * 1000;

export async function findOrCreateBrowsingSession(
  tx,
  { shopId, actorId, feature },
  now = new Date(),
) {
  return (
    (await tx.browsingSession.findFirst({
      where: { actorId, shopId, feature, expiresAt: { gt: now } },
      orderBy: { startedAt: "desc" },
    })) ??
    (await tx.browsingSession.create({
      data: {
        shopId,
        actorId,
        feature,
        startedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_MS),
      },
    }))
  );
}
