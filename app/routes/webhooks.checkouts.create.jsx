import { authenticate } from "../shopify.server";
import { handleCheckoutWebhook } from "../models/checkout-webhook.server";

// POST /webhooks/checkouts/create (registered in shopify.app.toml). Same contract as the order webhooks: the HMAC is
// verified by authenticate.webhook before anything in the body is used (bad signature 401, missing headers 400,
// non-POST 405), a failure the sender can fix by retrying answers 503, and the log line carries no customer data.
export const action = async ({ request }) => {
  let context;
  try {
    context = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof SyntaxError) return new Response(undefined, { status: 400 });
    return new Response(undefined, { status: 503 });
  }
  try {
    const { status, outcome } = await handleCheckoutWebhook({
      shopDomain: context.shop,
      topic: context.topic,
      webhookId: context.webhookId,
      eventId: context.eventId,
      triggeredAt: context.triggeredAt,
      payload: context.payload,
    });
    console.log("[checkouts] webhook handled", JSON.stringify({ shop: context.shop, outcome, status }));
    return new Response(undefined, { status });
  } catch (error) {
    console.error("[checkouts] webhook failed", JSON.stringify({ shop: context.shop, name: error?.name ?? "error" }));
    return new Response(undefined, { status: 503 });
  }
};
