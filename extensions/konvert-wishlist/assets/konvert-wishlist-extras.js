/* global publish, subscribe, PUB_SUB_EVENTS -- optional Dawn-style theme globals, always checked with typeof before use */
(function () {
  'use strict';

  var kw = window.KonvertWishlist;
  if (!kw || kw.extrasLoaded) return;
  kw.extrasLoaded = true;

  var config = kw.config;
  var items = kw.items;
  var el = kw.el;
  var productCache = {};
  var PRODUCT_CACHE_MS = 30 * 1000;

  var CARD_SELECTOR =
    '.card-wrapper, .product-card-wrapper, .product-card, .grid-product, .product-item, .product-grid-item, .grid__item, li';
  var MEDIA_SELECTOR =
    '.card__inner, .card__media, .product-card__image, .product-card__media, .grid-product__image-wrapper, .product-item__image-wrapper, .grid-product__image, .media';
  var CARD_EXCLUDE ='header, footer, nav, dialog, [role="dialog"], [data-kw-button]';

  function productUrl(handle, variantId) {
    var url = kw.shopRoot() + 'products/' + encodeURIComponent(handle);
    return variantId ? url + '?variant=' + encodeURIComponent(variantId) : url;
  }

  function handleFromHref(href) {
    var match = /\/products\/([^/?#]+)/.exec(href || '');
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]).toLowerCase();
    } catch (error) {
      return null;
    }
  }

  // Product details come from the storefront's own public product JSON.
  function fetchProduct(handle) {
    // The copy kept for the tab is short-lived: it carries stock status, and a copy that never
    // expired kept showing a variant as sold out (or in stock) long after the store changed.
    var key = 'kw:p5:' + handle;
    if (productCache[handle]) return productCache[handle];
    try {
      var stored = JSON.parse(window.sessionStorage.getItem(key) || 'null');
      if (stored && stored.product && Date.now() - Number(stored.at) < PRODUCT_CACHE_MS && Date.now() >= Number(stored.at)) {
        productCache[handle] = Promise.resolve(stored.product);
        return productCache[handle];
      }
    } catch (error) {
      /* sessionStorage unavailable: continue without a cache */
    }
    productCache[handle] = fetch(kw.shopRoot() + 'products/' + encodeURIComponent(handle) + '.js', {
      cache: 'no-cache',
      headers: { Accept: 'application/json' }
    })
      .then(function (response) {
        if (!response.ok) throw new Error('product_not_found');
        return response.json();
      })
      .then(function (product) {
        var variants = (product.variants || []).map(function (variant) {
          return {
            id: String(variant.id),
            title: variant.title ? String(variant.title) : '',
            available: Boolean(variant.available),
            price: typeof variant.price === 'number' ? variant.price : null,
            compareAt:
              typeof variant.compare_at_price === 'number' && variant.compare_at_price > variant.price
                ? variant.compare_at_price
                : null,
            image: (variant.featured_image && variant.featured_image.src) || null
          };
        });
        // The variant a product-level heart (a collection card) saves: the FIRST variant in
        // the product's own variant order, which is the order of this product JSON. Stock does
        // not matter: a sold-out first variant is saved like any other (saving a variant is
        // not buying it), a later available variant is never substituted, and nothing is
        // chosen at random.
        var firstVariant = variants[0];
        var slim = {
          id: String(product.id),
          title: product.title,
          handle: product.handle,
          image: product.featured_image || null,
          available: Boolean(product.available),
          price: typeof product.price === 'number' ? product.price : null,
          compareAt:
            typeof product.compare_at_price === 'number' && product.compare_at_price > product.price
              ? product.compare_at_price
              : null,
          defaultVariantId: firstVariant ? firstVariant.id : null,
          variants: variants
        };
        try {
          window.sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), product: slim }));
        } catch (error) {
          /* ignore */
        }
        return slim;
      });
    productCache[handle].catch(function () {
      delete productCache[handle];
    });
    return productCache[handle];
  }
  kw.lookup = fetchProduct;

  /* ---------- core: requests, variant-specific wishlist state, toast, hearts ---------- */

  var toastTimer = null;

  function request(options) {
    var init = {
      method: options.method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      keepalive: Boolean(options.keepalive)
    };
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(options.path || config.apiPath, init).then(function (response) {
      function fail(message) {
        var failure = new Error(message);
        failure.status = response.status;
        throw failure;
      }
      return response.json().then(
        function (data) {
          if (!response.ok) fail((data && data.error) || 'request_failed');
          return data;
        },
        function () {
          fail('bad_response');
        }
      );
    });
  }

  function recordWishlistCartAdds(rows) {
    return Promise.all(rows.map(function (row) {
    return kw.request({
      method: 'POST',
      keepalive: true,
      body: { op: 'cart_add', productId: row.item.productId, variantId: row.item.variantId }
    }).catch(function (error) {
      warn('wishlist cart activity failed', error);
    });
    }));
  }
  kw.request = request;

  function warn(what, error) {
    if (window.console) console.warn('[konvert-wishlist] ' + what, error && error.message, error && error.status);
  }

  // A wishlist item is one VARIANT. Items are keyed by variant id. An older item saved
  // before items were variant-specific has no variant: it is keyed "p<productId>" and is
  // never treated as any particular variant.
  function itemKey(item) {
    return item.variantId ? String(item.variantId) : 'p' + item.productId;
  }
  kw.itemKey = itemKey;

  function loadItems() {
    return request({ method: 'GET' }).then(
      function (data) {
        items.clear();
        (data.items || []).forEach(function (item) {
          items.set(itemKey(item), item);
        });
        render();
      },
      function (error) {
        warn('could not load wishlist', error);
        showToast(config.text.error, false);
        throw error;
      }
    );
  }

  function hideToast() {
    var existing = document.querySelector('.kw-toast');
    if (existing) existing.remove();
    window.clearTimeout(toastTimer);
  }

  function showToast(message, withLogin) {
    hideToast();
    var box = el('div', 'kw-toast');
    box.setAttribute('role', 'alert');
    var line = el('span', '', message + ' ');
    if (withLogin) {
      var link = el('a', '', config.text.loginLink);
      link.href = loginHref();
      line.appendChild(link);
    }
    var close = el('button', '', '×');
    close.type = 'button';
    close.setAttribute('aria-label', config.text.close);
    close.addEventListener('click', hideToast);
    box.appendChild(line);
    box.appendChild(close);
    document.body.appendChild(box);
    toastTimer = window.setTimeout(hideToast, 10000);
  }
  kw.showToast = showToast;

  // The variant currently selected in the product form. Read fresh every time (never
  // cached) so it cannot go stale: the form's id input, then the ?variant= URL
  // parameter the theme keeps in sync, then the variant the page was rendered with.
  function selectedVariantId(button) {
    var scope = (button && button.closest && button.closest('section')) || document;
    var input =
      scope.querySelector('form[action*="/cart/add"] [name="id"]') ||
      document.querySelector('form[action*="/cart/add"] [name="id"]');
    if (input && /^[0-9]+$/.test(String(input.value))) return String(input.value);
    var fromUrl = new URLSearchParams(window.location.search).get('variant');
    if (fromUrl && /^[0-9]+$/.test(fromUrl)) return fromUrl;
    return (button && button.getAttribute('data-kw-variant-id')) || null;
  }
  kw.selectedVariantId = selectedVariantId;

  // The variant a heart stands for right now.
  //   product page button: the variant selected in the product form
  //   product card heart:  the product's FIRST variant in Shopify's variant order, in stock or
  //                        not (see fetchProduct), stored on the button once it has been looked up
  function variantOf(button) {
    if (button.classList.contains('kw-btn--product')) return selectedVariantId(button);
    return button.getAttribute('data-kw-variant-id') || null;
  }

  function render() {
    var buttons = document.querySelectorAll('[data-kw-button]');
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      var variantId = variantOf(button);
      var saved = Boolean(variantId) && items.has(String(variantId));
      var state = saved ? config.text.saved : config.text.add;
      var title = button.getAttribute('data-kw-title');
      var label = button.querySelector('[data-kw-label]');
      button.setAttribute('aria-pressed', saved ? 'true' : 'false');
      if (label) label.textContent = state;
      if (button.classList.contains('kw-btn--card')) button.setAttribute('aria-label', title ? state + ': ' + title : state);
    }
    var badge = document.querySelector('.kw-header-icon__count');
    if (badge) {
      badge.textContent = String(items.size);
      badge.hidden = !items.size;
    }
    var icon = document.querySelector('.kw-header-icon');
    if (icon) icon.classList.toggle('kw-header-icon--filled', items.size > 0);
  }
  kw.render = render;

  // Product page buttons carry the product's details. Card hearts only know the handle:
  // the product is looked up, and its first variant (in variant order) is stored on the heart.
  function resolveProduct(button) {
    var id = button.getAttribute('data-kw-product-id');
    var handle = button.getAttribute('data-kw-handle');
    var title = button.getAttribute('data-kw-title');
    var isProductPage = button.classList.contains('kw-btn--product');
    if (id && handle && title && (isProductPage || button.hasAttribute('data-kw-variant-id'))) {
      return Promise.resolve({ id: id, handle: handle, title: title });
    }
    return fetchProduct(handle).then(function (product) {
      button.setAttribute('data-kw-product-id', product.id);
      button.setAttribute('data-kw-title', product.title);
      if (!isProductPage) button.setAttribute('data-kw-variant-id', product.defaultVariantId || '');
      return product;
    });
  }
  kw.resolveProduct = resolveProduct;

  // Add or remove the variant this heart stands for. Each variant is its own entry, so
  // toggling one never touches another variant of the same product.
  function toggle(button) {
    if (!config.loggedIn) {
      startLogin(button);
      return;
    }
    kw.setBusy(button, true);
    resolveProduct(button)
      .then(function (product) {
        var variantId = variantOf(button);
        if (!variantId) {
          showToast(text('noVariantToSave', 'This product cannot be saved from here. Please open the product page.'), false);
          return null;
        }
        var key = String(variantId);
        var isSaved = items.has(key);
        return request({
          method: 'POST',
          body: {
            op: isSaved ? 'remove' : 'add',
            productId: product.id,
            variantId: variantId,
            handle: product.handle,
            title: product.title
          }
        }).then(function (result) {
          if (result.saved) {
            items.set(key, { productId: String(product.id), variantId: key, title: product.title, handle: product.handle });
          } else {
            items.delete(key);
          }
          render();
        });
      })
      .catch(function (error) {
        warn('toggle failed', error);
        var auth = error.status === 401;
        showToast(auth ? config.text.loginPrompt : error.message === 'wishlist_full' ? config.text.full : config.text.error, auth);
      })
      .then(function () {
        kw.setBusy(button, false);
      });
  }
  kw.toggle = toggle;

  // Product pages: keep the heart in step with the selected variant. Themes change the
  // variant in several ways (option inputs, variant buttons, a section re-render that
  // updates the form's id input and the URL), so this listens for all of them and then
  // simply re-reads the selected variant. Nothing is cached, and the check is debounced.
  function watchVariantChanges() {
    var productButton = document.querySelector('.kw-btn--product');
    if (!productButton || kw.variantWatch) return;
    kw.variantWatch = true;
    var last = selectedVariantId(productButton);
    var timer = null;

    function check() {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        var now = selectedVariantId(productButton);
        if (now !== last) {
          last = now;
          render();
        }
      }, 60);
    }

    document.addEventListener('change', check, true);
    window.addEventListener('popstate', check);
    try {
      // Dawn-style themes publish a variantChange event after they update the form.
      if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined' && PUB_SUB_EVENTS.variantChange) {
        subscribe(PUB_SUB_EVENTS.variantChange, check);
      }
    } catch (error) {
      /* theme integration is best effort */
    }
    if (window.MutationObserver) {
      new MutationObserver(check).observe(document.querySelector('main') || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['value', 'checked', 'selected', 'aria-checked', 'class']
      });
    }
  }


  /* ---------- header icon ---------- */

  // ---- the "My Wishlist" icon in the theme header ----
  //
  // The icon always goes in the theme header, beside the cart (or the other header
  // icons). It is never moved into the menu drawer and never floated.
  //
  // Header grids give their icon row a fixed share of the width, so on narrow
  // screens one more icon can make the header taller (the logo wraps) or push into
  // the logo. So after inserting the icon the header is measured against how it
  // looked without it. If it grew, scrolls sideways, or the icon overlaps other
  // header content, the header's own 3-column grid (menu | logo | icons) is told to
  // size its side columns to their content (kw-header--tight) so the logo takes
  // the leftover space instead of a fixed share, the same layout Dawn uses itself
  // for headers with an app block. If that is still not enough (very narrow
  // screens) the header also uses the page's standard side padding
  // (kw-header--compact). Only the header's column sizing and side padding change:
  // every existing control stays in place.
  var headerLink = null;
  var resizeTimer = null;
  var observeTimer = null;
  var lastCart = null; // the theme cart link the last placement was measured against

  function findCartLink() {
    return document.querySelector(
      'header a[href$="/cart"], header [id^="cart-icon"], header a[href*="/cart"]'
    );
  }

  // Where the icon goes: before the cart link; failing that the header's icon row;
  // failing that the end of the header element itself.
  function findAnchor() {
    var cart = findCartLink();
    if (cart && cart.parentNode) return { header: cart.closest('header') || cart.parentNode, parent: cart.parentNode, before: cart, cart: cart };
    var row = document.querySelector('header .header__icons');
    if (row) return { header: row.closest('header') || row, parent: row, before: null, cart: null };
    var header = document.querySelector('header');
    return header ? { header: header, parent: header, before: null, cart: null } : null;
  }

  function overlapsHeaderContent(link, header) {
    var box = link.getBoundingClientRect();
    var nodes = header.querySelectorAll('a, button, summary, img, svg, h1, h2, p, span');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node === link || link.contains(node) || node.contains(link)) continue;
      var rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (window.getComputedStyle(node).visibility === 'hidden') continue;
      var x = Math.min(box.right, rect.right) - Math.max(box.left, rect.left);
      var y = Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top);
      if (x > 1 && y > 1) return true;
    }
    return false;
  }

  // The icon is removed from the page and any earlier header adjustment undone,
  // so the next measurement sees the header exactly as the theme made it. Stale
  // copies (left by a re-rendered section) are removed too.
  function resetEntry() {
    var copies = document.querySelectorAll('.kw-header-icon');
    for (var i = 0; i < copies.length; i += 1) copies[i].remove();
    var tight = document.querySelectorAll('.kw-header--tight');
    for (var j = 0; j < tight.length; j += 1) tight[j].classList.remove('kw-header--tight', 'kw-header--compact');
  }

  function headerIsDisturbed(header, link, baseHeight) {
    return (
      header.getBoundingClientRect().height > baseHeight + 1 ||
      header.scrollWidth > header.clientWidth + 1 ||
      overlapsHeaderContent(link, header)
    );
  }

  // The 3-column layout (menu | logo | icons) is the only one the adjustment fits.
  function hasThreeColumnGrid(header) {
    var style = window.getComputedStyle(header);
    return style.display === 'grid' && String(style.gridTemplateColumns || '').split(' ').length === 3;
  }

  function placeEntry() {
    if (!headerLink) return;
    resetEntry();
    var anchor = findAnchor();
    lastCart = anchor && anchor.cart;
    if (!anchor) return; // the theme has no <header> element to put it in

    var baseHeight = anchor.header.getBoundingClientRect().height;
    anchor.parent.insertBefore(headerLink, anchor.before);
    if (headerIsDisturbed(anchor.header, headerLink, baseHeight) && hasThreeColumnGrid(anchor.header)) {
      // Step 1: size the header's side columns to their content.
      anchor.header.classList.add('kw-header--tight');
      // Step 2, only if that was not enough (very narrow screens): the page's
      // standard 1.5rem side padding instead of the header's wider padding.
      if (headerIsDisturbed(anchor.header, headerLink, baseHeight)) anchor.header.classList.add('kw-header--compact');
    }
  }

  function mountHeaderIcon() {
    if (!config.headerIcon || document.querySelector('.kw-header-icon')) return;
    var link = el('a', 'kw-header-icon');
    link.href = config.pagePath;
    link.setAttribute('aria-label', config.text.headerLabel);
    var heart = el('span', 'kw-heart');
    heart.setAttribute('aria-hidden', 'true');
    var count = el('span', 'kw-header-icon__count', '0');
    count.hidden = true;
    link.appendChild(heart);
    link.appendChild(count);
    headerLink = link;
    kw.injectHearts(link);
    placeEntry();

    // Re-check when the available width changes: a window resize or rotation, or a
    // scrollbar appearing once the page content has loaded (which fires no resize
    // event but makes the header narrower).
    function schedulePlacement() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(placeEntry, 150);
    }
    window.addEventListener('resize', schedulePlacement);
    if (window.ResizeObserver) {
      var lastWidth = document.documentElement.clientWidth;
      new ResizeObserver(function () {
        var width = document.documentElement.clientWidth;
        if (width === lastWidth) return; // our own header changes alter heights, not the width
        lastWidth = width;
        schedulePlacement();
      }).observe(document.documentElement);
    }

    // The theme re-rendered its header (theme editor, section reload) and took the
    // icon with it, or now has a different cart link: place it again. Our own
    // changes never trigger work, because the icon is still in the document.
    function recheck() {
      window.clearTimeout(observeTimer);
      observeTimer = window.setTimeout(function () {
        var anchor = findAnchor();
        if (!document.body.contains(headerLink) || (anchor && anchor.cart !== lastCart)) placeEntry();
      }, 200);
    }
    if (window.MutationObserver) new MutationObserver(recheck).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('shopify:section:load', recheck);
  }

  /* ---------- collection cards ---------- */

  var resolveQueue = [];
  var resolveRunning = 0;

  // Looks up product ids for logged-in customers so hearts show saved state.
  function pumpResolveQueue() {
    while (resolveRunning < 4 && resolveQueue.length) {
      var button = resolveQueue.shift();
      resolveRunning += 1;
      kw.resolveProduct(button)
        .catch(function () {})
        .then(function () {
          resolveRunning -= 1;
          kw.render();
          pumpResolveQueue();
        });
    }
  }

  // Pages whose product cards get a heart: the home page (Featured products), collection
  // pages, search results, and the recommendations on a product page. These all use the
  // same card markup. Anything else (cart, blog, custom pages...) is left alone, so hearts
  // never appear on unrelated list items such as cart lines.
  var CARD_PAGE_TYPES = ['index', 'collection', 'search', 'product'];

  function scanCards() {
    if (!config.collectionCards || CARD_PAGE_TYPES.indexOf(config.pageType) === -1) return;
    // On a product page the page's own product is handled by its product button, never by a card heart.
    var ownButton = document.querySelector('.kw-btn--product');
    var ownHandle = ownButton ? String(ownButton.getAttribute('data-kw-handle') || '').toLowerCase() : null;
    var scope = document.querySelector('main, #MainContent, [role="main"]') || document.body;
    var links = scope.querySelectorAll('a[href*="/products/"]');
    var seen = [];

    for (var i = 0; i < links.length; i += 1) {
      var link = links[i];
      if (link.closest(CARD_EXCLUDE)) continue;
      var handle = handleFromHref(link.getAttribute('href'));
      if (!handle) continue;
      var card = link.closest(CARD_SELECTOR);
      if (!card || seen.indexOf(card) !== -1 || card.querySelector('.kw-btn--card')) continue;
      seen.push(card);

      // Skip containers that hold more than one product (not a single card).
      var handles = {};
      var inner = card.querySelectorAll('a[href*="/products/"]');
      for (var j = 0; j < inner.length; j += 1) {
        var other = handleFromHref(inner[j].getAttribute('href'));
        if (other) handles[other] = true;
      }
      if (Object.keys(handles).length !== 1) continue;
      if (ownHandle && handles[ownHandle]) continue;

      var button = el('button', 'kw-btn kw-btn--card');
      button.type = 'button';
      button.setAttribute('data-kw-button', '');
      button.setAttribute('data-kw-handle', handle);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', config.text.add);
      button.appendChild(el('span', 'kw-heart'));
      kw.injectHearts(button);

      // Sit over the product image when the card has an identifiable image
      // container, so the heart can never overlap the title, price or variant
      // controls below it. Otherwise fall back to the card itself.
      card.classList.add('kw-card-host');
      var media = card.querySelector(MEDIA_SELECTOR);
      var anchor = media && media.querySelector('img') ? media : card;
      var position = window.getComputedStyle(anchor).position;
      if (!position || position === 'static') {
        anchor.style.position = 'relative';
      }
      anchor.appendChild(button);
      if (config.loggedIn) {
        resolveQueue.push(button);
        pumpResolveQueue();
      }
    }
  }

  /* ---------- My Wishlist page (table layout) ---------- */

  var MAX_QTY = 99;
  var NUMERIC_ID = /^[0-9]+$/;
  var currencyFormat = null;
  var rows = [];
  var selectMode = false;
  var pageBody = null;
  var table = null;
  var bulk = null;
  var selectAllBox = null;
  var selectButtonWired = false;

  // Falls back to English when the extension locale has no value for a key.
  function text(key, fallback) {
    return config.text[key] || fallback;
  }

  // Prices come from the store's own product JSON (cents, presentment currency).
  // Nothing is hardcoded and nothing is shown when the value is missing.
  function formatPrice(cents) {
    if (typeof cents !== 'number') return '';
    var code = window.Shopify && window.Shopify.currency && window.Shopify.currency.active;
    if (!code) return (cents / 100).toFixed(2);
    try {
      if (!currencyFormat) {
        currencyFormat = new Intl.NumberFormat(document.documentElement.lang || undefined, {
          style: 'currency',
          currency: code
        });
      }
      return currencyFormat.format(cents / 100);
    } catch (error) {
      return (cents / 100).toFixed(2) + ' ' + code;
    }
  }

  function updateHeading() {
    var node = document.querySelector('[data-kw-page-count]');
    if (!node) return;
    var total = items.size;
    node.textContent = '(' + total + ' ' + (total === 1 ? 'Item' : 'Items') + ')';
  }

  // Which variant a row stands for and whether it can be bought, from real availability
  // data in the product JSON. A row is ONE saved variant:
  //   in      the saved variant is available
  //   out     the saved variant is sold out
  //   legacy  an older item saved before items were variant-specific: it has no variant
  //           and is never matched to one (no guessing which variant it meant)
  //   unknown the saved variant no longer exists in the product data
  function resolveVariant(item, product) {
    if (!item.variantId) return { variant: null, state: 'legacy' };
    var variants = product.variants || [];
    var wanted = String(item.variantId);
    for (var i = 0; i < variants.length; i += 1) {
      if (variants[i].id === wanted) return { variant: variants[i], state: variants[i].available ? 'in' : 'out' };
    }
    return { variant: null, state: 'unknown' };
  }

  /* ----- inventory -----
     The storefront's product JSON only says whether a variant is available, not
     how many can be bought. The exact sellable quantity comes from our own signed
     endpoint (server-side Admin API). max === null means "no limit" (untracked
     inventory or the store allows overselling). Shopify's cart stays the final
     authority: this only keeps the selector sensible. */

  function quantityCap(row) {
    return typeof row.max === 'number' ? Math.min(MAX_QTY, row.max) : MAX_QTY;
  }

  function applyMax(row, max) {
    row.max = typeof max === 'number' ? max : null;
    if (row.max === 0) {
      row.purchasable = false;
      row.state = 'out';
      setStock(row, 'out');
      setAction(row, 'out');
    }
    if (row.qty > quantityCap(row)) row.qty = Math.max(1, quantityCap(row));
    row.refreshQuantity();
  }

  // Fails quietly: without inventory data the selector is simply not limited.
  function loadInventory(list) {
    var ids = [];
    list.forEach(function (row) {
      // Only buyable variants need a stock limit: one the storefront already reports as unavailable
      // cannot become buyable.
      if (row.purchasable && row.variant && NUMERIC_ID.test(String(row.variant.id)) && ids.indexOf(row.variant.id) === -1) {
        ids.push(row.variant.id);
      }
    });
    if (!ids.length || !config.inventoryPath) return Promise.resolve();
    return fetch(config.inventoryPath + '?ids=' + ids.join(','), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        if (!data || data.unavailable || !data.variants) return;
        list.forEach(function (row) {
          var info = row.variant && data.variants[row.variant.id];
          if (info) applyMax(row, info.max);
        });
      })
      .catch(function () {});
  }

  /* ----- cart ----- */

  function parseJson(response) {
    return response.json().catch(function () {
      return {};
    });
  }

  function unconfirmed() {
    var failure = new Error('cart_unconfirmed');
    failure.userMessage = text('cartUnconfirmed', 'We could not confirm that this was added to your cart. Please check your cart.');
    return failure;
  }

  // Lets the active theme refresh its own cart UI, when it offers a way to:
  // Dawn-style themes publish a cartUpdate event and render #cart-icon-bubble
  // from a section. Anything else is left alone, and a plain DOM event is fired
  // for custom themes to listen to.
  function refreshThemeCart(cart) {
    try {
      if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined' && PUB_SUB_EVENTS.cartUpdate) {
        publish(PUB_SUB_EVENTS.cartUpdate, { source: 'konvert-wishlist', cartData: cart });
      }
    } catch (error) {
      /* theme integration is best effort */
    }
    try {
      document.dispatchEvent(new CustomEvent('kw:cart-updated', { detail: cart }));
    } catch (error) {
      /* CustomEvent unavailable */
    }
    var bubble = document.querySelector('#cart-icon-bubble');
    if (!bubble) return;
    fetch(kw.shopRoot() + '?sections=cart-icon-bubble', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (sections) {
        var html = sections && sections['cart-icon-bubble'];
        if (!html) return;
        var section = new DOMParser().parseFromString(html, 'text/html').querySelector('.shopify-section');
        if (section) bubble.innerHTML = section.innerHTML;
      })
      .catch(function () {});
  }

  // Shopify Ajax Cart API (https://shopify.dev/docs/api/ajax/reference/cart).
  // Success is only reported after cart.js confirms the lines are in the cart.
  function addToCart(lines) {
    return fetch(kw.shopRoot() + 'cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: lines })
    })
      .then(function (response) {
        return parseJson(response).then(function (data) {
          if (!response.ok) {
            var failure = new Error('cart_add_failed');
            failure.status = response.status;
            failure.userMessage = (data && (data.description || data.message)) || null;
            throw failure;
          }
          return data;
        });
      })
      .then(function () {
        return fetch(kw.shopRoot() + 'cart.js', { headers: { Accept: 'application/json' } });
      })
      .then(function (response) {
        if (!response.ok) throw unconfirmed();
        return parseJson(response);
      })
      .then(function (cart) {
        var present = lines.every(function (line) {
          return (cart.items || []).some(function (entry) {
            return String(entry.variant_id) === String(line.id) && entry.quantity >= line.quantity;
          });
        });
        if (!present) throw unconfirmed();
        refreshThemeCart(cart);
        return cart;
      });
  }

  function cartFailed(error) {
    if (window.console && console.warn) {
      console.warn('[konvert-wishlist] add to cart failed:', error && error.message, error && error.status);
    }
    // A 422 from the cart is Shopify refusing the quantity (stock). Its own text
    // can contain the remaining quantity, so it is never shown: customers get a
    // generic message and the quantity limit is refreshed silently.
    var message =
      error && error.status === 422
        ? text('cartStock', 'We could not add that quantity because not enough stock is available. Please choose a smaller quantity.')
        : (error && error.userMessage) || text('cartError', 'We could not add this to your cart. Please try again.');
    kw.showToast(message, false);
  }

  // Checked before anything is sent.
  function validateRow(row) {
    if (!row.variant || !NUMERIC_ID.test(String(row.variant.id))) {
      return text('invalidVariant', 'This product option cannot be added from here. Please open the product page.');
    }
    if (!(row.qty >= 1 && row.qty <= quantityCap(row))) {
      return text('invalidQuantity', 'Please enter a valid quantity.');
    }
    return null;
  }

  function lineFor(row) {
    return { id: Number(row.variant.id), quantity: row.qty };
  }

  /* ----- row building ----- */

  function cell(className) {
    return el('td', 'kw-td ' + className);
  }

  // "Subtotal: $X" for the chosen quantity. Only an estimate: discounts, taxes
  // and shipping are applied in the cart and at checkout.
  function updateLine(row) {
    var cents = row.unitCents;
    if (!row.purchasable || typeof cents !== 'number') {
      row.line.hidden = true;
      return;
    }
    row.line.textContent = text('lineTotal', 'Subtotal') + ': ' + formatPrice(cents * row.qty);
    row.line.title = text(
      'lineTotalHint',
      'Estimated subtotal (price × quantity). Discounts, taxes and shipping are applied in the cart and at checkout.'
    );
    row.line.hidden = false;
  }

  function buildQuantity(row) {
    var box = el('div', 'kw-qty');
    var minus = el('button', 'kw-qty__btn', '−');
    var input = el('input', 'kw-qty__input');
    var plus = el('button', 'kw-qty__btn', '+');
    minus.type = 'button';
    plus.type = 'button';
    minus.setAttribute('aria-label', text('qtyDecrease', 'Decrease quantity'));
    plus.setAttribute('aria-label', text('qtyIncrease', 'Increase quantity'));
    input.type = 'number';
    input.min = '1';
    input.setAttribute('aria-label', text('quantity', 'Quantity') + ': ' + row.item.title);

    // The limit is enforced silently: it is never written to the page (no label,
    // no max attribute, no tooltip). "+" simply becomes disabled at the limit.
    function refresh() {
      var cap = quantityCap(row);
      input.value = String(row.qty);
      input.disabled = !row.purchasable || row.busy || Boolean(row.pendingRemoval);
      minus.disabled = input.disabled || row.qty <= 1;
      plus.disabled = input.disabled || row.qty >= cap;
      updateLine(row);
    }
    function set(value) {
      var number = parseInt(value, 10);
      if (!(number >= 1)) number = 1;
      if (number > quantityCap(row)) number = Math.max(1, quantityCap(row));
      row.qty = number;
      refresh();
    }
    minus.addEventListener('click', function () {
      set(row.qty - 1);
    });
    plus.addEventListener('click', function () {
      set(row.qty + 1);
    });
    input.addEventListener('change', function () {
      set(input.value);
    });

    box.appendChild(minus);
    box.appendChild(input);
    box.appendChild(plus);
    row.refreshQuantity = refresh;
    refresh();
    return box;
  }

  function setStock(row, state) {
    var labels = {
      in: text('inStock', 'In stock'),
      out: text('outOfStock', 'Out of stock'),
      legacy: text('legacyVariant', 'Variant not saved'),
      unknown: text('availabilityUnavailable', 'Availability unavailable')
    };
    row.stock.className = 'kw-stock kw-stock--' + state;
    row.stock.textContent = labels[state];
  }

  function setAction(row, kind) {
    row.action.textContent = '';
    var button;
    if (kind === 'in') {
      button = el('button', 'kw-btn-cart', text('addToCart', 'Add to cart'));
      button.type = 'button';
      button.addEventListener('click', function () {
        addRowToCart(row, button);
      });
    } else if (kind === 'retry') {
      // The product is already in the cart; only the wishlist removal is retried.
      row.action.appendChild(el('span', 'kw-action__note', text('addedToCart', 'Added to cart')));
      button = el('button', 'kw-btn-cart kw-btn-cart--outline', text('retryRemove', 'Remove from wishlist'));
      button.type = 'button';
      button.addEventListener('click', function () {
        retryRemoval(row, button);
      });
    } else if (kind === 'legacy') {
      // Saved before items were variant-specific: link to the product so the customer can
      // pick and save a variant. Nothing is added to the cart for a variant nobody chose.
      button = el('a', 'kw-btn-cart kw-btn-cart--outline', text('viewProduct', 'View product'));
      button.href = productUrl(row.item.handle, null);
    } else if (kind === 'out' && row.item.variantId && !notifyRefused[String(row.item.variantId)]) {
      // A sold-out saved variant: Notify Me for exactly that variant. The wishlist item stays.
      var variantId = String(row.item.variantId);
      var done = Boolean(notified[variantId]);
      button = el(
        'button',
        'kw-btn-cart kw-btn-cart--notify',
        done ? text('notifySubscribed', "You're on the list!") : text('notifyMe', 'Notify Me'),
      );
      button.type = 'button';
      // Locked once subscribed, and while the server is still being asked whether it already is.
      button.disabled = done || Boolean(notifyLoading[variantId]);
      button.addEventListener('click', function () {
        runNotify(
          button,
          variantId,
          row.item.handle,
          function () {
            // The storefront itself (checked again just now) sells this variant: the copy was stale.
            row.state = 'in';
            row.purchasable = Boolean(row.variant);
            setStock(row, 'in');
            setAction(row, 'in');
            row.refreshQuantity();
          },
          function () {
            // The server refused, but the storefront still says sold out: show it as sold out.
            setAction(row, 'out');
          }
        );
      });
    } else {
      button = el(
        'button',
        'kw-btn-cart kw-btn-cart--disabled',
        kind === 'out' ? text('soldOut', 'Sold out') : text('unavailableButton', 'Unavailable')
      );
      button.type = 'button';
      button.disabled = true;
    }
    row.action.appendChild(button);
  }

  function fillRow(row, product) {
    var item = row.item;
    var result = resolveVariant(item, product);
    row.variant = result.variant;
    row.state = result.state;
    row.purchasable = result.state === 'in' && Boolean(result.variant);

    // Several variants: say which one this row is (for example "Large / Red").
    if (result.variant && result.variant.title && (product.variants || []).length > 1) {
      row.variantLine.textContent = result.variant.title;
    }

    var picture = (result.variant && result.variant.image) || product.image;
    if (picture) {
      var image = document.createElement('img');
      image.src = picture;
      image.alt = item.title;
      image.loading = 'lazy';
      row.thumb.appendChild(image);
    } else {
      row.thumb.classList.add('kw-thumb--empty');
    }

    var cents = result.variant && result.variant.price !== null ? result.variant.price : product.price;
    var compareAt = result.variant ? result.variant.compareAt : product.compareAt;
    row.unitCents = typeof cents === 'number' ? cents : null;
    var priceText = formatPrice(cents);
    row.price.textContent = priceText;
    if (priceText && compareAt && compareAt > cents) {
      row.price.appendChild(el('s', 'kw-price__compare', formatPrice(compareAt)));
    }

    setStock(row, result.state);
    setAction(row, result.state);
    row.refreshQuantity();
  }

  // The product JSON could not be loaded (deleted or unpublished product).
  function failRow(row) {
    row.purchasable = false;
    row.thumb.classList.add('kw-thumb--empty');
    setStock(row, 'unknown');
    setAction(row, 'unknown');
    row.refreshQuantity();
  }

  function selectedRows() {
    return rows.filter(function (row) {
      return row.check.checked;
    });
  }

  function updateBulk() {
    if (!bulk) return;
    var chosen = selectedRows();
    bulk.count.textContent = chosen.length + ' ' + text('selectedCount', 'selected');
    bulk.add.disabled = chosen.length === 0;
    bulk.remove.disabled = chosen.length === 0;
    selectAllBox.checked = rows.length > 0 && chosen.length === rows.length;
  }

  function setSelectMode(on) {
    selectMode = on;
    var button = document.querySelector('[data-kw-select]');
    if (button) {
      button.textContent = on ? text('cancel', 'Cancel') : text('select', 'Select');
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (table) table.classList.toggle('kw-table--select', on);
    if (bulk) bulk.box.hidden = !on;
    if (!on) {
      rows.forEach(function (row) {
        row.check.checked = false;
      });
    }
    updateBulk();
  }

  // Removes one product from the customer's wishlist through the existing
  // authenticated API (keyed by this row's own product id). Resolves true or
  // false; the table is only changed after the server confirms.
  function removeOne(row) {
    return kw.request({ method: 'POST', body: { op: 'remove', productId: row.item.productId, variantId: row.item.variantId } }).then(
      function () {
        items.delete(itemKey(row.item));
        row.tr.remove();
        var index = rows.indexOf(row);
        if (index !== -1) rows.splice(index, 1);
        return true;
      },
      function () {
        return false;
      }
    );
  }

  // Count, store-wide wishlist state and the empty state after rows were removed.
  function afterRemoval() {
    kw.render();
    updateHeading();
    if (!items.size) renderPage();
    else updateBulk();
  }

  function removeRows(list) {
    var failed = 0;
    list.forEach(function (row) {
      row.removeButton.disabled = true;
    });
    return list
      .reduce(function (chain, row) {
        return chain.then(function () {
          return removeOne(row).then(function (removed) {
            if (!removed) {
              failed += 1;
              row.removeButton.disabled = false;
            }
          });
        });
      }, Promise.resolve())
      .then(function () {
        if (failed) kw.showToast(text('removeError', 'We could not remove some products. Please try again.'), false);
        afterRemoval();
      });
  }

  function setBusy(row, busy) {
    row.busy = busy;
    row.removeButton.disabled = busy;
    row.refreshQuantity();
  }

  // Add to cart for one row, then (only after Shopify confirmed the cart) remove
  // that row's product from the wishlist.
  //   - row.busy blocks double clicks and duplicate submissions.
  //   - A failed or unconfirmed cart add leaves the wishlist untouched.
  //   - If the cart add worked but the removal failed, the cart is never added
  //     to again: the row switches to a "retry removal" state instead.
  function addRowToCart(row, button) {
    if (row.busy || row.pendingRemoval) return;
    var problem = validateRow(row);
    if (problem) {
      kw.showToast(problem, false);
      return;
    }
    var label = button.textContent;
    setBusy(row, true);
    button.disabled = true;
    button.textContent = text('adding', 'Adding…');

    addToCart([lineFor(row)]).then(
      function () {
        return recordWishlistCartAdds([row]).then(function () {
          return removeOne(row);
        }).then(function (removed) {
          if (removed) {
            kw.showToast(text('addedToCart', 'Added to cart'), false);
            afterRemoval();
            return;
          }
          row.pendingRemoval = true;
          setBusy(row, false);
          setAction(row, 'retry');
          kw.showToast(
            text(
              'cartAddedRemoveFailed',
              'Added to your cart, but we could not remove it from your wishlist. You can try removing it again.'
            ),
            false
          );
        });
      },
      function (error) {
        cartFailed(error);
        button.textContent = label;
        button.disabled = false;
        setBusy(row, false);
        // Stock may have changed since the page loaded: refresh the limit silently.
        if (error && error.status === 422) loadInventory([row]);
      }
    );
  }

  // Retries only the wishlist removal for a product that is already in the cart.
  function retryRemoval(row, button) {
    if (row.busy) return;
    setBusy(row, true);
    button.disabled = true;
    removeOne(row).then(function (removed) {
      if (removed) {
        afterRemoval();
        return;
      }
      setBusy(row, false);
      button.disabled = false;
      kw.showToast(text('removeError', 'We could not remove some products. Please try again.'), false);
    });
  }

  function buildRow(item) {
    var row = { item: item, qty: 1, max: null, unitCents: null, variant: null, state: 'unknown', purchasable: false };
    var url = productUrl(item.handle, item.variantId);
    var tr = el('tr', 'kw-row');
    row.tr = tr;

    function recordClick() {
      kw.request({
        method: 'POST',
        keepalive: true,
        body: { op: 'click', productId: item.productId, variantId: item.variantId }
      }).catch(function () {});
    }

    var tdSelect = cell('kw-td--select');
    row.check = el('input', 'kw-check');
    row.check.type = 'checkbox';
    row.check.setAttribute('aria-label', text('selectRow', 'Select') + ': ' + item.title);
    row.check.addEventListener('change', updateBulk);
    tdSelect.appendChild(row.check);

    var tdRemove = cell('kw-td--remove');
    row.removeButton = el('button', 'kw-row__remove', '×');
    row.removeButton.type = 'button';
    row.removeButton.setAttribute('aria-label', text('removeLabel', 'Remove from wishlist') + ': ' + item.title);
    row.removeButton.title = text('removeLabel', 'Remove from wishlist');
    row.removeButton.addEventListener('click', function () {
      removeRows([row]);
    });
    tdRemove.appendChild(row.removeButton);

    var tdImage = cell('kw-td--image');
    row.thumb = el('a', 'kw-thumb');
    row.thumb.href = url;
    row.thumb.setAttribute('aria-label', item.title);
    row.thumb.addEventListener('click', recordClick);
    tdImage.appendChild(row.thumb);

    var tdName = cell('kw-td--name');
    var title = el('a', 'kw-row__title', item.title);
    title.href = url;
    title.addEventListener('click', recordClick);
    tdName.appendChild(title);
    row.variantLine = el('span', 'kw-row__variant');
    tdName.appendChild(row.variantLine);

    var tdPrice = cell('kw-td--price');
    row.price = el('span', 'kw-price');
    row.line = el('div', 'kw-line');
    row.line.hidden = true;
    tdPrice.appendChild(row.price);
    tdPrice.appendChild(row.line);

    var tdStock = cell('kw-td--stock');
    row.stock = el('span', 'kw-stock kw-stock--unknown');
    tdStock.appendChild(row.stock);

    var tdQty = cell('kw-td--qty');
    tdQty.appendChild(buildQuantity(row));

    var tdAction = cell('kw-td--action');
    row.action = el('div', 'kw-action');
    tdAction.appendChild(row.action);

    [tdSelect, tdRemove, tdImage, tdName, tdPrice, tdStock, tdQty, tdAction].forEach(function (td) {
      tr.appendChild(td);
    });

    row.loaded = fetchProduct(item.handle).then(
      function (product) {
        fillRow(row, product);
      },
      function () {
        failRow(row);
      }
    );
    return row;
  }

  function buildHead() {
    var thead = el('thead');
    var tr = el('tr');
    var selectTh = el('th', 'kw-th kw-th--select');
    selectAllBox = el('input', 'kw-check');
    selectAllBox.type = 'checkbox';
    selectAllBox.setAttribute('aria-label', text('selectAll', 'Select all products'));
    selectAllBox.addEventListener('change', function () {
      rows.forEach(function (row) {
        row.check.checked = selectAllBox.checked;
      });
      updateBulk();
    });
    selectTh.appendChild(selectAllBox);
    tr.appendChild(selectTh);
    [
      ['kw-th--remove', text('colRemove', 'Remove')],
      ['kw-th--image', text('colImage', 'Product image')],
      ['kw-th--name', text('colName', 'Product name')],
      ['kw-th--price', text('colPrice', 'Price')],
      ['kw-th--stock', text('colStock', 'Stock status')],
      ['kw-th--qty', text('colQuantity', 'Quantity')],
      ['kw-th--action', text('colAction', 'Action')]
    ].forEach(function (column) {
      var th = el('th', 'kw-th ' + column[0], column[1]);
      th.scope = 'col';
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    return thead;
  }

  function buildBulk() {
    var box = el('div', 'kw-bulk');
    box.hidden = true;
    var count = el('span', 'kw-bulk__count');
    var add = el('button', 'kw-btn-cart kw-btn-cart--compact', text('addSelected', 'Add selected to cart'));
    var remove = el('button', 'kw-btn-cart kw-btn-cart--outline kw-btn-cart--compact', text('removeSelected', 'Remove selected'));
    add.type = 'button';
    remove.type = 'button';

    add.addEventListener('click', function () {
      var buyable = selectedRows().filter(function (row) {
        return row.purchasable && row.variant && !row.busy && !row.pendingRemoval;
      });
      if (!buyable.length) {
        kw.showToast(text('nonePurchasable', 'None of the selected products can be added to the cart.'), false);
        return;
      }
      for (var i = 0; i < buyable.length; i += 1) {
        var problem = validateRow(buyable[i]);
        if (problem) {
          kw.showToast(buyable[i].item.title + ': ' + problem, false);
          return;
        }
      }
      var label = add.textContent;
      add.disabled = true;
      add.textContent = text('adding', 'Adding…');
      addToCart(buyable.map(lineFor))
        .then(function () {
          return recordWishlistCartAdds(buyable).then(function () {
            kw.showToast(text('addedToCart', 'Added to cart'), false);
          });
        })
        .catch(function (error) {
          cartFailed(error);
          if (error && error.status === 422) loadInventory(buyable);
        })
        .then(function () {
          add.textContent = label;
          updateBulk();
        });
    });
    remove.addEventListener('click', function () {
      removeRows(selectedRows());
    });

    box.appendChild(count);
    box.appendChild(add);
    box.appendChild(remove);
    return { box: box, count: count, add: add, remove: remove };
  }

  function wireSelectButton() {
    var button = document.querySelector('[data-kw-select]');
    if (!button) return;
    button.hidden = !items.size;
    if (selectButtonWired) return;
    selectButtonWired = true;
    button.textContent = text('select', 'Select');
    button.addEventListener('click', function () {
      setSelectMode(!selectMode);
    });
  }

  function renderEmpty(body) {
    var empty = el('div', 'kw-empty');
    var icon = el('span', 'kw-empty__icon');
    var heart = el('span', 'kw-heart');
    heart.setAttribute('aria-hidden', 'true');
    icon.appendChild(heart);
    kw.injectHearts(icon);
    empty.appendChild(icon);
    empty.appendChild(el('h2', 'kw-empty__title', text('empty', 'Your wishlist is empty.')));
    empty.appendChild(
      el('p', 'kw-empty__text', text('emptyHint', 'Tap the heart on any product to save it here for later.'))
    );
    var shop = el('a', 'kw-empty__link', text('continueShopping', 'Continue shopping'));
    shop.href = kw.shopRoot() + 'collections/all';
    empty.appendChild(shop);
    body.appendChild(empty);
  }

  function renderPage() {
    var body = pageBody;
    body.textContent = '';
    rows = [];
    table = null;
    bulk = null;
    selectMode = false;
    updateHeading();
    wireSelectButton();
    if (!items.size) {
      renderEmpty(body);
      return;
    }

    setSelectMode(false);
    bulk = buildBulk();
    body.appendChild(bulk.box);

    var wrap = el('div', 'kw-table-wrap');
    table = el('table', 'kw-table');
    table.appendChild(buildHead());
    var tbody = el('tbody');
    var built = [];
    items.forEach(function (item) {
      var row = buildRow(item);
      rows.push(row);
      built.push(row);
      tbody.appendChild(row.tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);
    updateBulk();

    // Once every product is loaded, look up real sellable quantities in one request.
    Promise.all(
      built.map(function (row) {
        return row.loaded;
      })
    ).then(function () {
      // Sold-out rows: ask the server which of them the customer is already subscribed to.
      // The Notify Me buttons stay locked until it answers, so a repeat request is not offered.
      var soldOut = function () {
        return built
          .filter(function (row) {
            return row.state === 'out' && row.item.variantId;
          })
          .map(function (row) {
            return row.item.variantId;
          });
      };
      var status = loadNotifyStatus(soldOut());
      refreshNotifyUi();
      return Promise.all([status, loadInventory(built)]).then(function () {
        // The inventory check can mark more rows sold out.
        var more = loadNotifyStatus(soldOut());
        refreshNotifyUi();
        return more;
      });
    });
  }

  // Opening My Wishlist is wishlist engagement: the server opens or reuses the
  // customer's 30-minute browsing session. Sent once per page load, fire and
  // forget, and only on the My Wishlist page (never on ordinary storefront pages).
  function recordPageOpen() {
    if (!config.loggedIn || kw.pageOpenSent) return;
    kw.pageOpenSent = true;
    kw.request({ method: 'POST', body: { op: 'open' } }).catch(function () {});
  }

  function hydratePage() {
    pageBody = document.querySelector('[data-kw-page-body]');
    if (!pageBody) return;
    if (config.wishlistOff) {
      pageBody.textContent = config.text.wishlistOff || 'The wishlist is currently unavailable.';
      return;
    }
    recordPageOpen();
    kw.ready.then(
      function () {
        renderPage();
      },
      function () {
        var button = document.querySelector('[data-kw-select]');
        if (button) button.hidden = true;
        pageBody.textContent = config.text.loadError;
      }
    );
  }  /* ---------- logged-out visitors: remember the product, go to login ---------- */

  // Only same-store, relative return paths are ever used: a path that could be
  // read as another host ("//evil.example", "/\evil.example") becomes "/".
  function safePath(path) {
    if (typeof path !== 'string' || path.charAt(0) !== '/') return '/';
    var second = path.charAt(1);
    if (second === '/' || second === '\\') return '/';
    return path;
  }

  // The store's own login URL (routes.account_login_url, correct for classic and
  // new customer accounts). Anything on another origin falls back to the
  // standard storefront login route.
  function storeLoginUrl() {
    var fallback = '/account/login';
    try {
      var url = new URL(config.loginUrl || fallback, window.location.origin);
      return url.origin === window.location.origin ? url.pathname + url.search : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function loginHref() {
    var base = storeLoginUrl();
    var returnPath = safePath(window.location.pathname + window.location.search);
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'return_url=' + encodeURIComponent(returnPath);
  }
  kw.loginHref = loginHref;

  // The intent kept across the login round trip: only the product handle and
  // variant id, in this tab's sessionStorage for at most 30 minutes. No customer
  // data, and nothing in the URL (a crafted link must never change a wishlist).
  var PENDING_TTL_MS = 30 * 60 * 1000;
  var HANDLE_PATTERN = /^[\p{L}\p{N}_-]{1,255}$/u;
  var ID_PATTERN = /^[0-9]{1,20}$/;

  function validIntent(value) {
    if (!value || typeof value !== 'object') return null;
    var handle = String(value.h || '').toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return null;
    var variant = value.v === null || value.v === undefined || value.v === '' ? null : String(value.v);
    if (variant !== null && !ID_PATTERN.test(variant)) return null;
    var stamp = Number(value.t);
    var now = Date.now();
    if (!(stamp > 0) || stamp > now + 60000 || now - stamp > PENDING_TTL_MS) return null;
    return { h: handle, v: variant, t: stamp };
  }
  kw.validIntent = validIntent;

  // Called by the main script (button already shown as busy). Nothing is written
  // to the wishlist here: restorePending() saves the product after login.
  function startLogin(button) {
    var handle = button.getAttribute('data-kw-handle');
    var variantId = button.classList.contains('kw-btn--product') ? kw.selectedVariantId(button) : null;
    // An unusable variant id is dropped; the product itself is still remembered.
    var intent = validIntent({ h: handle, v: variantId, t: Date.now() }) || validIntent({ h: handle, v: null, t: Date.now() });
    if (intent) {
      try {
        window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent));
      } catch (error) {
        /* storage unavailable: the customer can click the heart again after login */
      }
    }
    kw.showToast(text('loginRedirect', 'Please log in to save this to your wishlist. Taking you to the login page\u2026'), true);
    window.location.assign(loginHref());
  }
  kw.startLogin = startLogin;



/* ---------- finish a wishlist action started while logged out ---------- */

  var PENDING_KEY = 'kw:pending';

  function readPending() {
    try {
      var raw = window.sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      var intent = kw.validIntent(JSON.parse(raw));
      if (!intent) window.sessionStorage.removeItem(PENDING_KEY);
      return intent;
    } catch (error) {
      return null;
    }
  }

  function clearPending() {
    try {
      window.sessionStorage.removeItem(PENDING_KEY);
    } catch (error) {
      /* storage unavailable */
    }
  }

  function buttonsForHandle(handle) {
    return Array.prototype.filter.call(document.querySelectorAll('[data-kw-button]'), function (button) {
      return (button.getAttribute('data-kw-handle') || '').toLowerCase() === handle;
    });
  }

  // Runs once per page load after the customer comes back from logging in. The
  // pending intent is removed BEFORE anything is sent, so a refresh, a retry or
  // a failure can never save the product twice or loop. The server still
  // verifies the customer from Shopify's signed proxy request and ignores duplicates.
  function restorePending() {
    var pending = readPending();
    if (!pending) return;

    if (!config.loggedIn) {
      // Login was cancelled or has not finished: add nothing, keep the intent for
      // the rest of the login window and say what is needed.
      kw.showToast(text('loginStillRequired', 'Please log in to finish saving this item to your wishlist.'), true);
      return;
    }

    clearPending();
    var buttons = buttonsForHandle(pending.h);
    buttons.forEach(function (button) {
      kw.setBusy(button, true);
    });

    kw.ready
      .catch(function () {})
      .then(function () {
        return kw.lookup(pending.h);
      })
      .then(function (product) {
        // The exact variant chosen on the product page, or (a card heart) the product's first
        // variant in variant order, whatever its stock. Never a guess.
        var variantId = pending.v || product.defaultVariantId;
        if (!variantId) {
          kw.showToast(text('noVariantToSave', 'This product cannot be saved from here. Please open the product page.'), false);
          return null;
        }
        var key = String(variantId);
        var saved = function () {
          kw.render();
          kw.showToast(text('savedAfterLogin', 'Saved to your wishlist.'), false);
        };
        if (items.has(key)) {
          saved();
          return null;
        }
        return kw
          .request({
            method: 'POST',
            body: { op: 'add', productId: product.id, variantId: variantId, handle: product.handle, title: product.title }
          })
          .then(function (result) {
            if (result.saved) {
              items.set(key, { productId: String(product.id), variantId: key, title: product.title, handle: product.handle });
            }
            buttons.forEach(function (button) {
              button.setAttribute('data-kw-product-id', product.id);
              button.setAttribute('data-kw-title', product.title);
              if (!button.classList.contains('kw-btn--product')) button.setAttribute('data-kw-variant-id', key);
            });
            saved();
            return null;
          });
      })
      .catch(function (error) {
        if (error && error.status === 401) kw.showToast(config.text.loginPrompt, true);
        else if (error && error.message === 'wishlist_full') kw.showToast(config.text.full, false);
        else kw.showToast(config.text.error, false);
      })
      .then(function () {
        buttons.forEach(function (button) {
          kw.setBusy(button, false);
        });
      });
  }
  kw.restorePending = restorePending;


  /* ---------- Notify Me ---------- */
  //
  // Sold-out variants get Notify Me instead of Add to cart.
  //   Product page: the THEME's own Add to cart button is relabelled and its click is
  //                 taken over while the selected variant is sold out. No second button.
  //   My Wishlist:  the "Sold out" placeholder of a saved variant becomes Notify Me.
  // Only the variant id is sent to the server. Shop, customer and email are resolved
  // server-side from Shopify's signed proxy request; stock is re-checked there too.

  var NOTIFY_PENDING_KEY = 'kw:pending-notify';
  var notified = {}; // variant id -> true when the SERVER says the customer is subscribed
  var notifying = {}; // variant id -> subscribe request in flight
  var notifyChecked = {}; // variant id -> true (status loaded) | 'error' (could not be loaded)
  var notifyLoading = {}; // variant id -> status request in flight
  var notifyRefused = {}; // variant id -> true when the server refused it as sellable while the storefront says sold out
  var notifyStock = null; // { variant id: available } from fresh product JSON (product page only)
  var CART_FORM = 'form[action*="/cart/add"]';

  function notifyHandle() {
    return (config.productHandle || handleFromHref(window.location.pathname) || '').toLowerCase() || null;
  }

  function notifyErrorMessage(error) {
    var code = error && error.message;
    // The store's app is not allowed to read customer data (store-side setup), as opposed to
    // this customer having no email on file.
    if (code === 'customer_data_unavailable') {
      return text('notifyUnavailable', "Back-in-stock notifications aren't available right now. Please contact the store.");
    }
    if (code === 'customer_email_unavailable' || code === 'customer_not_found') {
      return text('notifyEmailError', "We couldn't find an email address on your account, so we can't set up this notification.");
    }
    if (code === 'feature_disabled') return text('notifyUnavailable', "Back-in-stock notifications aren't available right now. Please contact the store.");
    if (code === 'inventory_unsettled') return text('notifyNotOffered', "We couldn't confirm that this item is out of stock yet, so we haven't set up a notification. Please try again in a moment.");
    if (code === 'variant_available') return text('notifyAvailable', 'Good news: this item is back in stock.');
    return text('notifyError', "We couldn't set up your notification. Please try again.");
  }

  // Asks the server which of these variants the signed-in customer is already subscribed to.
  // The server is the only source of truth: nothing is remembered in the browser, so a reload
  // or another page shows the same state. If the answer cannot be loaded the variant is NOT
  // shown as subscribed; Notify Me stays usable and the server (which never duplicates a
  // subscription) decides when it is clicked.
  function loadNotifyStatus(variantIds) {
    if (!config.loggedIn || !config.notifyPath) return Promise.resolve();
    var wanted = [];
    variantIds.forEach(function (id) {
      id = String(id);
      if (/^[0-9]{1,20}$/.test(id) && !notifyChecked[id] && !notifyLoading[id] && wanted.indexOf(id) === -1) wanted.push(id);
    });
    wanted = wanted.slice(0, 50);
    if (!wanted.length) return Promise.resolve();
    wanted.forEach(function (id) {
      notifyLoading[id] = true;
    });
    return request({ method: 'GET', path: config.notifyPath + '?ids=' + wanted.join(',') })
      .then(function (data) {
        if (!data || !Array.isArray(data.subscribed)) throw new Error('bad_response');
        var yes = data.subscribed.map(String);
        wanted.forEach(function (id) {
          notifyChecked[id] = true;
          if (yes.indexOf(id) !== -1) notified[id] = true;
        });
      })
      .catch(function (error) {
        warn('notify status unavailable', error);
        wanted.forEach(function (id) {
          notifyChecked[id] = 'error';
        });
      })
      .then(function () {
        wanted.forEach(function (id) {
          delete notifyLoading[id];
        });
        refreshNotifyUi();
      });
  }

  // One request per variant at a time; a second click joins the one in flight.
  function subscribeVariant(variantId) {
    var key = String(variantId);
    if (notified[key]) return Promise.resolve();
    if (notifying[key]) return notifying[key];
    notifying[key] = request({ method: 'POST', path: config.notifyPath, body: { op: 'subscribe', variantId: key, storefrontSoldOut: Boolean(notifyStock && notifyStock[key] === false) } }).then(
      function () {
        notified[key] = true;
        delete notifying[key];
      },
      function (error) {
        delete notifying[key];
        throw error;
      }
    );
    return notifying[key];
  }

  function refreshNotifyUi() {
    syncNotifyButtons();
    rows.forEach(function (row) {
      if (row.state === 'out' && row.item.variantId) setAction(row, 'out');
    });
  }

  function startNotifyLogin(handle, variantId) {
    var intent = kw.validIntent({ h: handle, v: variantId, t: Date.now() });
    if (intent && intent.v) {
      try {
        window.sessionStorage.setItem(NOTIFY_PENDING_KEY, JSON.stringify(intent));
      } catch (error) {
        /* storage unavailable: the customer can click Notify Me again after login */
      }
    }
    showToast(text('notifyLoginRedirect', 'Please log in to be notified. Taking you to the login page…'), true);
    window.location.assign(loginHref());
  }

  // The server (Shopify Admin data) said this variant is sellable, yet the page offered Notify Me.
  // Ask the storefront again, without any cache, and report what it says now:
  //   true  - the storefront sells it now (the earlier copy was stale)
  //   false - the storefront still says sold out: the two sources disagree
  //   null  - could not be checked
  // Only the storefront's own answer is ever used to show Add to cart; the server's answer
  // is used only to refuse a subscription.
  function recheckStock(handle, variantId) {
    if (!handle) return Promise.resolve(null);
    delete productCache[handle];
    try {
      window.sessionStorage.removeItem('kw:p5:' + handle);
    } catch (error) {
      /* storage unavailable */
    }
    return fetchProduct(handle).then(
      function (product) {
        var found = null;
        (product.variants || []).forEach(function (variant) {
          if (variant.id === String(variantId)) found = variant;
        });
        if (!found) return null;
        if (notifyStock) notifyStock[String(variantId)] = found.available;
        return found.available;
      },
      function () {
        return null;
      }
    );
  }

  // onAvailable: the storefront itself now sells this variant. onRefused: the server refused
  // because it believes the variant is sellable, but the storefront still shows it as sold out.
  function runNotify(button, variantId, handle, onAvailable, onRefused) {
    if (!/^[0-9]{1,20}$/.test(String(variantId || ''))) {
      showToast(text('notifyError', "We couldn't set up your notification. Please try again."), false);
      return;
    }
    if (!config.loggedIn) {
      startNotifyLogin(handle, String(variantId));
      return;
    }
    if (button.disabled || notifying[String(variantId)] || notifyLoading[String(variantId)]) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    subscribeVariant(variantId)
      .then(
        function () {
          showToast(text('notifySuccess', "You're on the list!"), false);
        },
        function (error) {
          warn('notify failed', error);
          if (error && error.message === 'variant_available') {
            return recheckStock(handle, variantId).then(function (storefrontSells) {
              if (storefrontSells === true) {
                showToast(text('notifyAvailable', 'Good news: this item is back in stock.'), false);
                if (onAvailable) onAvailable();
              } else {
                // Never shown as available on the server's word alone: back to the theme's sold-out look.
                notifyRefused[String(variantId)] = true;
                showToast(text('notifyNotOffered', "We couldn't confirm that this item is out of stock yet, so we haven't set up a notification. Please try again in a moment."), false);
                if (onRefused) onRefused();
              }
            });
          }
          var auth = error && error.status === 401;
          showToast(auth ? config.text.loginPrompt : notifyErrorMessage(error), auth);
        }
      )
      .then(function () {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        refreshNotifyUi();
      });
  }

  // ----- product page: the theme's Add to cart button -----

  function addButtonOf(form) {
    var named = form.querySelector('button[name="add"]');
    if (named) return named;
    var candidates = form.querySelectorAll('button[type="submit"], input[type="submit"]');
    for (var i = 0; i < candidates.length; i += 1) {
      if (!candidates[i].closest('.shopify-payment-button, [data-kw-button]')) return candidates[i];
    }
    return null;
  }

  // The element whose text is the button label (Dawn: a <span> next to a spinner).
  function labelOf(button) {
    var spans = button.querySelectorAll('span');
    for (var i = 0; i < spans.length; i += 1) {
      if (!spans[i].children.length && !/spinner|loading/.test(spans[i].className)) return spans[i];
    }
    return button;
  }

  function formVariantId(form) {
    var input = form.querySelector('[name="id"]');
    return input && /^[0-9]+$/.test(String(input.value)) ? String(input.value) : null;
  }

  // Idempotent: it only writes when something differs, so the MutationObserver that
  // calls it cannot loop on its own changes.
  function syncNotifyButtons() {
    if (!notifyStock) return;
    var forms = document.querySelectorAll(CART_FORM);
    for (var i = 0; i < forms.length; i += 1) {
      var button = addButtonOf(forms[i]);
      if (!button) continue;
      var variantId = formVariantId(forms[i]);
      var available = variantId ? notifyStock[variantId] : undefined;
      var label = labelOf(button);
      var active = button.hasAttribute('data-kw-notify');

      if (available === false && !notifyRefused[variantId]) {
        var done = Boolean(notified[variantId]);
        var wanted = done ? text('notifySubscribed', "You're on the list!") : text('notifyMe', 'Notify Me');
        if (!active) {
          // Remember the theme's own sold-out state so it can be handed back exactly.
          button.setAttribute('data-kw-orig-label', label.textContent);
          button.setAttribute('data-kw-orig-disabled', button.disabled ? 'true' : 'false');
          button.setAttribute('data-kw-notify', '1');
        }
        if (label.textContent !== wanted) label.textContent = wanted;
        // Ask the server whether this customer is already subscribed to THIS variant.
        if (config.loggedIn && !notifyChecked[variantId] && !notifyLoading[variantId]) loadNotifyStatus([variantId]);
        // The theme disables Add to cart for a sold-out variant; Notify Me must be clickable,
        // except once subscribed or while the server is still being asked.
        var locked = done || Boolean(notifyLoading[variantId]);
        if (button.disabled !== locked) button.disabled = locked;
        if (button.hasAttribute('aria-disabled')) button.removeAttribute('aria-disabled');
      } else if (active) {
        button.removeAttribute('data-kw-notify');
        var ours = [text('notifyMe', 'Notify Me'), text('notifySubscribed', "You're on the list!")];
        var origLabel = button.getAttribute('data-kw-orig-label');
        var origDisabled = button.getAttribute('data-kw-orig-disabled');
        button.removeAttribute('data-kw-orig-label');
        button.removeAttribute('data-kw-orig-disabled');
        if (available === false) {
          // The storefront still says sold out: give the button back exactly as the theme had it.
          if (origLabel !== null && ours.indexOf(label.textContent) !== -1) label.textContent = origLabel;
          if (origDisabled !== null) button.disabled = origDisabled === 'true';
        } else {
          if (ours.indexOf(label.textContent) !== -1) label.textContent = text('addToCart', 'Add to cart');
          if (available === true && button.disabled) button.disabled = false;
        }
      }
    }
  }

  function watchNotifyProduct() {
    var timer = null;
    function check() {
      window.clearTimeout(timer);
      timer = window.setTimeout(syncNotifyButtons, 60);
    }
    document.addEventListener('change', check, true);
    window.addEventListener('popstate', check);
    try {
      if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined' && PUB_SUB_EVENTS.variantChange) {
        subscribe(PUB_SUB_EVENTS.variantChange, check);
      }
    } catch (error) {
      /* theme integration is best effort */
    }
    if (window.MutationObserver) {
      new MutationObserver(check).observe(document.querySelector('main') || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['value', 'checked', 'selected', 'aria-checked', 'class', 'disabled']
      });
    }

    // Take over the click while the selected variant is sold out. Capture phase, so the
    // theme's own handler and the form submit never run.
    document.addEventListener(
      'click',
      function (event) {
        var button = event.target.closest && event.target.closest('[data-kw-notify]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        var form = button.closest('form');
        if (form) runNotify(button, formVariantId(form), notifyHandle());
      },
      true
    );
    document.addEventListener(
      'submit',
      function (event) {
        var form = event.target;
        // Only a submit that comes from the Notify Me button (or an Enter key with no button) is
        // stopped; any other submit button in the form, such as the theme's Buy it now, is left alone.
        var from = event.submitter;
        if (from && !(from.hasAttribute && from.hasAttribute('data-kw-notify'))) return;
        if (form && form.querySelector && form.querySelector('[data-kw-notify]')) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
  }

  // Product page: availability comes from FRESH product JSON (never the session cache used
  // for wishlist rows), so a restocked variant is not offered Notify Me. The server
  // re-checks stock either way.
  function startNotifyProduct() {
    var handle = notifyHandle();
    if (!config.notifyEnabled || config.pageType !== 'product' || !handle || !document.querySelector(CART_FORM)) {
      return Promise.resolve();
    }
    return fetch(kw.shopRoot() + 'products/' + encodeURIComponent(handle) + '.js', {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
      .then(function (response) {
        if (!response.ok) throw new Error('product_not_found');
        return response.json();
      })
      .then(function (product) {
        notifyStock = {};
        (product.variants || []).forEach(function (variant) {
          notifyStock[String(variant.id)] = Boolean(variant.available);
        });
        watchNotifyProduct();
        syncNotifyButtons();
      })
      .catch(function (error) {
        warn('notify availability unavailable', error);
      });
  }

  // ----- finish a Notify Me started while logged out -----

  function restoreNotify() {
    var raw = null;
    var intent = null;
    try {
      raw = window.sessionStorage.getItem(NOTIFY_PENDING_KEY);
      intent = raw ? kw.validIntent(JSON.parse(raw)) : null;
    } catch (error) {
      intent = null;
    }
    if (!raw) return;
    if (!intent || !intent.v) {
      try {
        window.sessionStorage.removeItem(NOTIFY_PENDING_KEY);
      } catch (error) {
        /* storage unavailable */
      }
      return;
    }
    // Only on the page the customer started from; elsewhere the intent waits (30 minutes).
    var onProduct = config.pageType === 'product' && notifyHandle() === intent.h;
    if (!onProduct && !document.querySelector('[data-kw-page-body]')) return;
    if (!config.loggedIn) {
      showToast(text('notifyLoginStillRequired', 'Please log in to finish setting up your notification.'), true);
      return;
    }
    // Removed BEFORE sending, so a refresh or a failure can never repeat it. The server
    // still verifies the customer, the variant and its stock.
    try {
      window.sessionStorage.removeItem(NOTIFY_PENDING_KEY);
    } catch (error) {
      /* storage unavailable */
    }
    subscribeVariant(intent.v).then(
      function () {
        showToast(text('notifySuccess', "You're on the list!"), false);
        refreshNotifyUi();
      },
      function (error) {
        warn('notify restore failed', error);
        var auth = error && error.status === 401;
        showToast(auth ? config.text.loginPrompt : notifyErrorMessage(error), auth);
      }
    );
  }

  function startNotify() {
    startNotifyProduct().then(function () {
      kw.ready.catch(function () {}).then(restoreNotify);
    });
  }

  /* ---------- start ---------- */

  if (config.loggedIn) {
    kw.ready = loadItems();
    kw.ready.catch(function () {});
  }
  mountHeaderIcon();
  scanCards();
  watchVariantChanges();
  kw.render();
  hydratePage();
  startNotify();

  if (window.MutationObserver && config.collectionCards) {
    var pending = null;
    new MutationObserver(function () {
      window.clearTimeout(pending);
      pending = window.setTimeout(function () {
        kw.injectHearts(document);
        scanCards();
      }, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
