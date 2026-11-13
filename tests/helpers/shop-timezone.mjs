// Test helper: the session source first asks the Admin API for shop.ianaTimezone and then runs the ShopifyQL query. A stubbed Admin client
// answers the first question with this (and does not count it as an analytics request).
export const isTimezoneQuery = (document) => typeof document === "string" && document.includes("ianaTimezone");
export const shopZoneAnswer = (zone = "UTC") => ({ data: { shop: { ianaTimezone: zone } } });
