// Stands in for the server-only modules the Dashboard route imports for its loader, when only its component is rendered.
export const loadMerchantContext = () => {
  throw new Error("not used: the test supplies the loader data");
};
export const getDashboard = loadMerchantContext;
export const getAttribution = loadMerchantContext;
export const hasOrderScope = loadMerchantContext;
export const describeItem = (_catalog, row) => ({ title: row.productGid ? "Blue Hat" : null, variantTitle: null, found: true, price: 12, imageUrl: null });
export const fetchCatalog = loadMerchantContext;
