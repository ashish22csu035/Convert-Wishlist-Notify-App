import { unauthenticated } from "../shopify.server";
import { classifyAvailability } from "../utils/inventory.server";

const VARIANT_QUERY = `#graphql
  query NotifyVariant($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        inventoryPolicy
        sellableOnlineQuantity
        inventoryQuantity
        availableForSale
        product { id handle }
        inventoryItem { id tracked }
      }
    }
  }
`;

const CUSTOMER_QUERY = `#graphql
  query NotifyCustomer($id: ID!) {
    customer(id: $id) {
      id
      defaultEmailAddress { emailAddress }
    }
  }
`;

// Thrown for every reason the Admin API cannot give us what we need. `code` is
// the safe, customer-facing error code; nothing from Shopify's response is kept.
export class LookupError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Customer email needs read_customers AND Shopify's protected customer data
// approval. write_customers implies read_customers.
export function hasCustomerScope(scope) {
  const granted = String(scope ?? "").split(",").map((item) => item.trim());
  return granted.includes("read_customers") || granted.includes("write_customers");
}

// Offline Admin session for the verified shop. Returns { admin, scope }.
export async function getShopAdmin(shopDomain) {
  try {
    const { admin, session } = await unauthenticated.admin(shopDomain);
    return { admin, scope: session?.scope ?? "" };
  } catch {
    throw new LookupError("shop_unavailable", 503);
  }
}

async function run(admin, query, variables) {
  try {
    const response = await admin.graphql(query, { variables });
    return await response.json();
  } catch {
    throw new LookupError("shop_unavailable", 503);
  }
}

// The node lookup runs against the verified shop's own Admin API, so a variant
// id from another shop resolves to null. Returns the facts the subscription
// needs, and whether the variant is currently unavailable for sale.
export async function fetchVariantForNotify(admin, variantGid) {
  const json = await run(admin, VARIANT_QUERY, { id: variantGid });
  if (json.errors?.length) throw new LookupError("shop_unavailable", 503);
  const node = json.data?.node;
  if (!node?.id || node.id !== variantGid || !node.product?.id || !node.inventoryItem?.id) {
    throw new LookupError("variant_not_found", 404);
  }
  const state = classifyAvailability(node); // see app/utils/inventory.server.js
  return {
    productGid: node.product.id,
    productHandle: typeof node.product.handle === "string" ? node.product.handle : null,
    inventoryItemGid: node.inventoryItem.id,
    state,
    unavailable: state === "unavailable",
    // false: Shopify's fields contradict each other (not yet updated together). The caller must re-read
    // later and must not treat this read as evidence of either state.
    settled: state !== "unsettled",
    // What Shopify actually said, kept for diagnostics only. The decision above does not use it.
    seen: {
      sellableOnlineQuantity: node.sellableOnlineQuantity ?? null,
      inventoryQuantity: node.inventoryQuantity ?? null,
      availableForSale: node.availableForSale ?? null,
      inventoryPolicy: node.inventoryPolicy ?? null,
      tracked: node.inventoryItem.tracked ?? null,
    },
  };
}

// What the public storefront says about one variant, as the customer's browser would see it
// (/products/<handle>.js). true / false, or null when it cannot be read: a password-protected store, a
// redirect, an unpublished product, a non-JSON answer, a timeout. The shop domain comes from the verified
// proxy identity (already validated as *.myshopify.com) and the handle from Shopify's own answer.
export async function fetchStorefrontAvailability(shopDomain, handle, variantId, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!shopDomain || !handle || !/^[0-9]{1,20}$/.test(String(variantId))) return null;
  try {
    const response = await fetchImpl(`https://${shopDomain}/products/${encodeURIComponent(handle)}.js`, {
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const json = await response.json();
    const variant = Array.isArray(json?.variants) ? json.variants.find((item) => String(item?.id) === String(variantId)) : null;
    return typeof variant?.available === "boolean" ? variant.available : null;
  } catch {
    return null;
  }
}

const TOPOLOGY_LEVELS_QUERY = `query StockTopologyLevels($id: ID!) {
  node(id: $id) {
    ... on ProductVariant {
      inventoryItem {
        inventoryLevels(first: 50) {
          pageInfo { hasNextPage }
          nodes { location { id } quantities(names: ["available"]) { name quantity } }
        }
      }
    }
  }
}`;
const TOPOLOGY_SERVICES_QUERY = `query StockTopologyServices { shop { fulfillmentServices { type location { id } } } }`;

// Where a variant's sellable stock sits, using only access the app already has (the location ids on inventory
// levels, and the shop's fulfillment services with their locations; location names, online-order flags and
// publications need other permissions and are not used). `thirdPartyOnly` is true when every location holding
// stock is the location of a THIRD_PARTY fulfillment service, false when any stock is at an ordinary location,
// and null when that cannot be established (no stock, more than 50 locations, a denied or failed request).
// Stock held only by a third-party service is the one case where the Admin API reports quantity and
// "available for sale" while the storefront can show "Sold out" (Shopify's sample "3p Fulfilled Snowboard").
export async function fetchStockTopology(admin, variantGid) {
  try {
    const [levelsJson, servicesJson] = await Promise.all([
      admin.graphql(TOPOLOGY_LEVELS_QUERY, { variables: { id: variantGid } }).then((r) => r.json()),
      admin.graphql(TOPOLOGY_SERVICES_QUERY).then((r) => r.json()),
    ]);
    const levels = levelsJson?.data?.node?.inventoryItem?.inventoryLevels;
    const services = servicesJson?.data?.shop?.fulfillmentServices;
    if (levelsJson?.errors?.length || servicesJson?.errors?.length || !levels || !Array.isArray(levels.nodes) || !Array.isArray(services) || levels.pageInfo?.hasNextPage) {
      return { thirdPartyOnly: null };
    }
    const stocked = levels.nodes.filter((level) => (level.quantities ?? []).some((q) => q?.name === "available" && Number(q.quantity) > 0));
    if (!stocked.length) return { thirdPartyOnly: null };
    const thirdParty = new Set(services.filter((service) => service?.type === "THIRD_PARTY" && service.location?.id).map((service) => service.location.id));
    return { thirdPartyOnly: stocked.every((level) => thirdParty.has(level.location?.id)) };
  } catch {
    return { thirdPartyOnly: null };
  }
}

// Whether a variant that the Admin API reports as sellable can really be bought on the storefront.
//   purchasable true   Admin is authoritative (stock at an ordinary location, or the public storefront says so)
//   purchasable false  the public storefront says it is sold out
//   purchasable null   stock is only at a third-party fulfillment location AND the public storefront cannot be
//                      read (password-protected store, unpublished product): Admin alone cannot decide
// The storefront is only consulted in the third-party-only case, so every ordinary variant costs two small
// requests at most and behaves exactly as before.
export async function resolveStorefrontPurchasable({ admin, shopDomain, variant, variantGid }, { stockTopology = fetchStockTopology, storefrontCheck = fetchStorefrontAvailability } = {}) {
  const stocked = variant.seen?.tracked !== false && variant.seen?.inventoryPolicy === "DENY";
  if (!stocked) return { purchasable: true, basis: "admin" };
  const topology = await stockTopology(admin, variantGid);
  if (topology.thirdPartyOnly !== true) return { purchasable: true, basis: "admin" };
  const answer = await storefrontCheck(shopDomain, variant.productHandle, String(variantGid).split("/").pop());
  if (answer === null) return { purchasable: null, basis: "storefront_unreadable" };
  return { purchasable: answer, basis: "storefront" };
}

export async function fetchCustomerEmail(admin, customerGid) {
  const json = await run(admin, CUSTOMER_QUERY, { id: customerGid });
  if (json.errors?.length) {
    const denied = json.errors.some((error) => error?.extensions?.code === "ACCESS_DENIED");
    throw new LookupError(denied ? "customer_data_unavailable" : "shop_unavailable", denied ? 403 : 503);
  }
  const customer = json.data?.customer;
  if (!customer?.id) throw new LookupError("customer_not_found", 404);
  const email = customer.defaultEmailAddress?.emailAddress;
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) {
    throw new LookupError("customer_email_unavailable", 422);
  }
  return email.toLowerCase();
}

const EMAIL_PRODUCT_QUERY = `#graphql
  query RestockEmailProduct($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        title
        product { title handle onlineStoreUrl status }
      }
    }
  }
`;

// Current product details for a restock email, read from the shop at send time (never stored copies,
// so a renamed or unpublished product is reflected). Throws LookupError: shop_unavailable (retry later)
// or variant_not_found (the variant or product is gone: nothing to send).
export async function fetchProductForEmail(admin, variantGid) {
  const json = await run(admin, EMAIL_PRODUCT_QUERY, { id: variantGid });
  if (json.errors?.length) throw new LookupError("shop_unavailable", 503);
  const node = json.data?.node;
  if (!node?.id || node.id !== variantGid || !node.product) throw new LookupError("variant_not_found", 404);
  return {
    productTitle: typeof node.product.title === "string" ? node.product.title.trim() : "",
    handle: typeof node.product.handle === "string" ? node.product.handle : "",
    onlineStoreUrl: typeof node.product.onlineStoreUrl === "string" ? node.product.onlineStoreUrl : null,
    status: node.product.status ?? null,
    variantTitle: typeof node.title === "string" ? node.title.trim() : "",
  };
}
