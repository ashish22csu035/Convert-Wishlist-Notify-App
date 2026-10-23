// Read-only product details (title, image, price) for the merchant screens, fetched live from the
// shop's Admin API. Nothing is stored, and nothing is invented: when Shopify cannot be reached, or a
// product or variant no longer exists, the screens fall back to the ids they already hold.

const CATALOG_QUERY = `#graphql
  query KonvertCatalog($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id
        title
        handle
        featuredMedia { preview { image { url } } }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
      }
      ... on ProductVariant {
        id
        title
        price
        product { id title featuredMedia { preview { image { url } } } }
      }
    }
  }
`;

const CHUNK = 100;
const EMPTY = { available: false, currencyCode: null, products: {}, variants: {} };

const imageOf = (product) => product?.featuredMedia?.preview?.image?.url ?? null;

// Returns { available, currencyCode, products: { [gid]: {...} }, variants: { [gid]: {...} } }.
// A gid missing from the maps was not found (deleted) or could not be read.
export async function fetchCatalog(admin, { productGids = [], variantGids = [] } = {}) {
  const ids = [...new Set([...productGids, ...variantGids].filter(Boolean))].slice(0, 500);
  if (!admin || ids.length === 0) return { ...EMPTY, products: {}, variants: {} };

  const result = { available: true, currencyCode: null, products: {}, variants: {} };
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const response = await admin.graphql(CATALOG_QUERY, { variables: { ids: ids.slice(i, i + CHUNK) } });
      const json = await response.json();
      if (!json?.data) throw new Error("catalog_lookup_failed");
      result.currencyCode = json.data.shop?.currencyCode ?? result.currencyCode;
      for (const node of json.data.nodes ?? []) {
        if (!node) continue;
        if (node.__typename === "Product") {
          result.products[node.id] = {
            title: node.title,
            handle: node.handle,
            imageUrl: imageOf(node),
            price: node.priceRangeV2?.minVariantPrice?.amount ?? null,
          };
        } else if (node.__typename === "ProductVariant") {
          result.variants[node.id] = {
            title: node.title,
            price: node.price ?? null,
            productTitle: node.product?.title ?? null,
            imageUrl: imageOf(node.product),
          };
        }
      }
    }
  } catch {
    return { ...EMPTY, products: {}, variants: {} };
  }
  return result;
}

// What to show for a product/variant pair. `fallback` is the title kept in our own database, if any.
export function describeItem(catalog, { productGid, variantGid, fallbackTitle = null }) {
  const variant = variantGid ? catalog.variants[variantGid] : null;
  const product = productGid ? catalog.products[productGid] : null;
  const variantTitle = variant?.title && variant.title.toLowerCase() !== "default title" ? variant.title : null;
  return {
    title: product?.title ?? variant?.productTitle ?? fallbackTitle,
    variantTitle,
    imageUrl: product?.imageUrl ?? variant?.imageUrl ?? null,
    price: variant?.price ?? product?.price ?? null,
    found: Boolean(product || variant),
  };
}
