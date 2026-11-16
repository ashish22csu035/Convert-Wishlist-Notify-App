import { action as checkoutsCreateAction } from "./webhooks.checkouts.create";

// POST /webhooks/checkouts/update: the same verified handler as checkouts/create (see app/models/checkout-webhook.server.js).
export const action = checkoutsCreateAction;
