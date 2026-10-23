import {
  authenticateStorefront,
  liquidResponse,
  logFailure,
  newRequestId,
} from "../utils/storefront-auth.server";

// Storefront URL: /apps/konvert-notify/my-wishlist (App Proxy -> /proxy/my-wishlist)
//
// Returns Liquid (Content-Type: application/liquid) so Shopify renders it inside
// the store's theme layout. The saved products are filled in by the theme app
// extension script, which loads them from the signed wishlist API with
// textContent only, so no customer data is ever placed into this Liquid.
const PAGE = `
<div class="kw-page" data-kw-page>
  <header class="kw-page__header">
    <h1 class="kw-page__title">
      Wishlisted products <span class="kw-page__count" data-kw-page-count></span>
    </h1>
    {% if customer %}
      <button type="button" class="kw-page__select" data-kw-select hidden>Select</button>
    {% endif %}
  </header>
  {% if customer %}
    <div class="kw-page__body" data-kw-page-body aria-live="polite">
      <p>Loading your wishlist&hellip;</p>
    </div>
    <noscript><p>JavaScript is required to view your wishlist.</p></noscript>
    <script>
      setTimeout(function () {
        var body = document.querySelector('[data-kw-page-body]');
        if (!window.KonvertWishlist && body) {
          body.textContent = 'The wishlist is temporarily unavailable. Please try again later.';
        }
      }, 6000);
    </script>
  {% else %}
    <p class="kw-page__login">
      Please <a href="{{ routes.account_login_url }}?return_url={{ request.path | url_encode }}">log in</a> to see your wishlist.
    </p>
  {% endif %}
</div>
`;

export const loader = async ({ request }) => {
  const requestId = newRequestId();
  try {
    await authenticateStorefront(request);
    return liquidResponse(PAGE, {
      headers: { "Cache-Control": "no-store", "X-KW-Request-Id": requestId },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    logFailure("GET my-wishlist", requestId, error);
    return liquidResponse(
      "<p>The wishlist is temporarily unavailable. Please try again later.</p>",
      { headers: { "Cache-Control": "no-store", "X-KW-Request-Id": requestId } },
    );
  }
};
