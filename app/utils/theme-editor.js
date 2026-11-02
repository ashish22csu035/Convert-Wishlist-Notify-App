// Theme-editor deep links for the Konvert theme app extension (extensions/konvert-wishlist). The block handles are the
// file names in extensions/konvert-wishlist/blocks: wishlist-embed (app embed) and wishlist-button (product page block).
// Without the app's API key the links fall back to the plain editor, never to a guessed id.
export function themeEditorLinks(shop, apiKey) {
  const editor = `https://${shop}/admin/themes/current/editor`;
  const key = encodeURIComponent(apiKey || "");
  return {
    embedUrl: key ? `${editor}?context=apps&activateAppId=${key}/wishlist-embed` : `${editor}?context=apps`,
    blockUrl: key ? `${editor}?template=product&addAppBlockId=${key}/wishlist-button&target=mainSection` : `${editor}?template=product`,
  };
}
