// The sample product photos the settings previews (Wishlist Settings and Notify Me Settings) draw their storefront pages
// with. They are static files in public/preview-products/ (served from the app's own origin, so nothing depends on an
// outside host), described in public/preview-products/CREDITS.md. They are preview decoration only: they are never
// uploaded, never stored in a shop and never connected to a real product or a customer's Wishlist.
//
// `position` is the CSS object-position that keeps the product inside the crop when a card or thumbnail is narrower than the
// photo; `fit` is "cover" unless the whole product must stay visible.

export const PREVIEW_IMAGE_BASE = "/preview-products/";

export const PREVIEW_PRODUCT_IMAGES = {
  tee: { file: "tee.jpg", position: "50% 50%" },
  tote: { file: "tote.jpg", position: "50% 50%" },
  mug: { file: "mug.jpg", position: "50% 55%" },
  beanie: { file: "beanie.jpg", position: "50% 45%" },
  bottle: { file: "bottle.jpg", position: "50% 50%" },
  shirt: { file: "shirt.jpg", position: "50% 30%" },
  crossbody: { file: "crossbody.jpg", position: "50% 40%" },
  backpack: { file: "backpack.jpg", position: "50% 50%" },
};

export const previewImageUrl = (key) => `${PREVIEW_IMAGE_BASE}${PREVIEW_PRODUCT_IMAGES[key].file}`;
export const previewImagePosition = (key) => PREVIEW_PRODUCT_IMAGES[key].position;
