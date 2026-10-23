import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findOrCreateBrowsingSession,
  SESSION_MS,
} from "../app/models/browsing-session.server.js";

function createTransaction() {
  const sessions = [];
  const queries = [];
  let nextId = 1;

  return {
    sessions,
    queries,
    browsingSession: {
      async findFirst({ where }) {
        queries.push(where);
        return (
          sessions
            .filter(
              (session) =>
                session.actorId === where.actorId &&
                session.shopId === where.shopId &&
                session.feature === where.feature &&
                session.expiresAt > where.expiresAt.gt,
            )
            .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
        );
      },
      async create({ data }) {
        const session = { id: nextId++, ...data };
        sessions.push(session);
        return session;
      },
    },
  };
}

test("Wishlist and Notify Me sessions are separate for the same shop and customer", async () => {
  const tx = createTransaction();
  const identity = { shopId: 12, actorId: 34 };
  const startedAt = new Date("2026-10-19T10:00:00.000Z");

  const wishlist = await findOrCreateBrowsingSession(
    tx,
    { ...identity, feature: "WISHLIST" },
    startedAt,
  );
  const notifyMe = await findOrCreateBrowsingSession(
    tx,
    { ...identity, feature: "NOTIFY_ME" },
    startedAt,
  );

  assert.notEqual(notifyMe.id, wishlist.id);
  assert.deepEqual(
    tx.sessions.map(({ feature }) => feature).sort(),
    ["NOTIFY_ME", "WISHLIST"],
  );
  assert.equal(wishlist.expiresAt.getTime() - wishlist.startedAt.getTime(), SESSION_MS);
  assert.equal(notifyMe.expiresAt.getTime() - notifyMe.startedAt.getTime(), SESSION_MS);
});

test("session lookup explicitly scopes by feature and never extends the 30-minute expiry", async () => {
  const tx = createTransaction();
  const startedAt = new Date("2026-10-19T10:00:00.000Z");
  const identity = { shopId: 12, actorId: 34, feature: "NOTIFY_ME" };
  const first = await findOrCreateBrowsingSession(tx, identity, startedAt);

  const reused = await findOrCreateBrowsingSession(
    tx,
    identity,
    new Date(startedAt.getTime() + 5 * 60 * 1000),
  );

  assert.equal(reused.id, first.id);
  assert.equal(reused.expiresAt.getTime(), first.expiresAt.getTime());
  assert.ok(tx.queries.every((where) => where.feature === "NOTIFY_ME"));
});

test("an expired feature session is left intact and a new fixed window is created", async () => {
  const tx = createTransaction();
  const startedAt = new Date("2026-10-19T10:00:00.000Z");
  const identity = { shopId: 12, actorId: 34, feature: "NOTIFY_ME" };
  const expired = await findOrCreateBrowsingSession(tx, identity, startedAt);

  const next = await findOrCreateBrowsingSession(
    tx,
    identity,
    new Date(startedAt.getTime() + SESSION_MS),
  );

  assert.notEqual(next.id, expired.id);
  assert.equal(expired.expiresAt.getTime(), startedAt.getTime() + SESSION_MS);
  assert.equal(next.expiresAt.getTime() - next.startedAt.getTime(), SESSION_MS);
});
