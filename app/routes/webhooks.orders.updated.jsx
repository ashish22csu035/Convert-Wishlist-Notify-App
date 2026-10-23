import { orderWebhookAction } from "../utils/order-webhook-route.server";

// POST /webhooks/orders/updated: see app/utils/order-webhook-route.server.js
export const action = ({ request }) => orderWebhookAction(request);
