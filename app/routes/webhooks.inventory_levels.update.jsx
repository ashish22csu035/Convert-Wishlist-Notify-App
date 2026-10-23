import { authenticate } from "../shopify.server";
import { handleInventoryLevelWebhook } from "../models/inventory-webhook.server";

// POST /webhooks/inventory_levels/update (registered in shopify.app.toml).
// authenticate.webhook verifies Shopify's HMAC and the required headers: a bad signature is a 401,
// missing headers a 400, and any non-POST a 405 (those Responses are thrown and returned as-is).
// The handler stays quick: it records restock state and queues jobs, and never sends email.
//
// Diagnostics (console, one line per delivery, no secrets, signatures, tokens or customer data) tell
// the two failure kinds apart:
//   - no "[restock] inventory webhook" line at all     -> Shopify did not deliver to this server
//     (webhook not registered for this app version/dev session, or a stale tunnel URL)
//   - "rejected before processing" with a status      -> it arrived but failed verification (401/400/405)
//   - "handled" with an outcome                       -> it arrived and was processed (or why it was not)
//   - "failed"                                        -> it arrived but the application could not process it
export const action = async ({ request }) => {
  let context;
  try {
    context = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) {
      console.warn("[restock] inventory webhook rejected before processing", JSON.stringify({ status: error.status }));
      throw error;
    }
    // A correctly signed body that is not JSON can never be processed: do not ask for retries.
    if (error instanceof SyntaxError) {
      console.warn("[restock] inventory webhook rejected before processing", JSON.stringify({ status: 400, reason: "body_not_json" }));
      return new Response(undefined, { status: 400 });
    }
    console.error("[restock] inventory webhook could not be authenticated", error?.name);
    return new Response(undefined, { status: 503 });
  }

  const item = context.payload?.inventory_item_id;
  try {
    const { status, outcome, results } = await handleInventoryLevelWebhook({
      shopDomain: context.shop,
      topic: context.topic,
      webhookId: context.webhookId,
      eventId: context.eventId,
      triggeredAt: context.triggeredAt,
      payload: context.payload,
    });
    console.log(
      "[restock] inventory webhook handled",
      JSON.stringify({ shop: context.shop, item: item ?? null, webhookId: context.webhookId ?? null, outcome, status, results: results ?? null }),
    );
    return new Response(undefined, { status });
  } catch (error) {
    console.error("[restock] inventory webhook failed", JSON.stringify({ shop: context.shop, item: item ?? null, webhookId: context.webhookId ?? null, name: error?.name ?? "error", code: error?.code ?? null }));
    return new Response(undefined, { status: 503 }); // Shopify retries
  }
};
