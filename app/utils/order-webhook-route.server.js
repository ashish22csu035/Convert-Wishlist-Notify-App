import { authenticate } from "../shopify.server";
import { handleOrderWebhook } from "../models/order-webhook.server";

// Shared by POST /webhooks/orders/paid and /webhooks/orders/updated (registered in shopify.app.toml).
// authenticate.webhook verifies Shopify's HMAC and the required headers: a bad signature is a 401,
// missing headers a 400, and any non-POST a 405 (those Responses are thrown and returned as-is).
// Nothing in the body is used before that check passes.
//
// One console line per delivery (no signature, token, customer or order contents), so "Shopify did not
// deliver" (no line), "rejected" (status) and "processed or why not" (outcome) can be told apart.
export async function orderWebhookAction(request) {
  let context;
  try {
    context = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) {
      console.warn("[orders] webhook rejected before processing", JSON.stringify({ status: error.status }));
      throw error;
    }
    if (error instanceof SyntaxError) {
      console.warn("[orders] webhook rejected before processing", JSON.stringify({ status: 400, reason: "body_not_json" }));
      return new Response(undefined, { status: 400 });
    }
    console.error("[orders] webhook could not be authenticated", error?.name);
    return new Response(undefined, { status: 503 });
  }

  try {
    const { status, outcome } = await handleOrderWebhook({
      shopDomain: context.shop,
      topic: context.topic,
      webhookId: context.webhookId,
      eventId: context.eventId,
      triggeredAt: context.triggeredAt,
      payload: context.payload,
    });
    console.log("[orders] webhook handled", JSON.stringify({ shop: context.shop, topic: context.topic, webhookId: context.webhookId ?? null, outcome, status }));
    return new Response(undefined, { status });
  } catch (error) {
    console.error("[orders] webhook failed", JSON.stringify({ shop: context.shop, topic: context.topic, name: error?.name ?? "error", code: error?.code ?? null }));
    return new Response(undefined, { status: 503 }); // Shopify retries
  }
}
