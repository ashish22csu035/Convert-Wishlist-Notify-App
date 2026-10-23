import { unauthenticated } from "../shopify.server";
import { sellableCap } from "../utils/inventory.server";

const QUERY = `#graphql
  query VariantInventory($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryPolicy
        sellableOnlineQuantity
        inventoryItem {
          tracked
        }
      }
    }
  }
`;

// Reads the sellable quantity of variants through the shop's offline Admin
// session. This runs only on the server: the access token never reaches the
// browser. Returns { "<numeric variant id>": { max: number | null } }, where
// `max: null` means the store sells without a limit (untracked inventory or
// "continue selling when out of stock").
export async function fetchSellableCaps(shopDomain, variantIds) {
  const { admin } = await unauthenticated.admin(shopDomain);
  const response = await admin.graphql(QUERY, {
    variables: { ids: variantIds.map((id) => `gid://shopify/ProductVariant/${id}`) },
  });
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`inventory_query_failed:${json.errors.length}`);
  }

  const result = {};
  for (const node of json.data?.nodes ?? []) {
    if (!node?.id) continue;
    result[String(node.id).split("/").pop()] = { max: sellableCap(node) };
  }
  return result;
}
