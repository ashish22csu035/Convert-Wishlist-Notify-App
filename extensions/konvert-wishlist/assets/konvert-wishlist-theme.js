/* Konvert Wishlist: lets the product-page Wishlist button take on the size and type of the theme's own Add to cart button.
   It only READS the theme (computed styles of the Add to cart button next to the block) and WRITES custom properties on the
   Konvert block itself (.kw-block); konvert-wishlist.css turns them into the button's look, and every value has a fallback,
   so a theme without a recognisable button still gets the plain Konvert button. Nothing in the theme is changed. */
(function () {
  'use strict';
  if (window.__kwThemeMatch) return;
  window.__kwThemeMatch = true;

  // The theme's main purchase button, found by what it does (a submit button of the cart/add form) rather than by a theme's
  // class names; the class names only widen the net for themes whose button sits outside a <form>.
  var BUTTON = [
    'form[action*="/cart/add"] [type="submit"]:not([data-kw-button])',
    'form[action*="/cart/add"] [name="add"]',
    'product-form [type="submit"]:not([data-kw-button])',
    '[name="add"]:not([data-kw-button])',
    '.product-form__submit',
    '.add-to-cart'
  ].join(',');
  var SCOPE = 'product-form, form[action*="/cart/add"], .product-form, [class*="product-info"], [class*="product__info"], [class*="product-details"], .product, main, [id^="shopify-section"]';
  var TYPE = ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform', 'line-height'];

  function visible(node) {
    var box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  }

  // The nearest enclosing area that holds a visible purchase button; the search widens outwards from the block.
  function findButton(block) {
    var scope = block.parentElement;
    while (scope && scope !== document.documentElement) {
      if (scope.matches && scope.matches(SCOPE)) {
        var found = scope.querySelectorAll(BUTTON);
        for (var i = 0; i < found.length; i += 1) if (visible(found[i])) return found[i];
      }
      scope = scope.parentElement;
    }
    return null;
  }

  function px(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : null;
  }

  function apply(block) {
    var theme = findButton(block);
    var style = block.style;
    if (!theme) return;
    var cs = getComputedStyle(theme);
    var box = theme.getBoundingClientRect();
    var room = block.getBoundingClientRect().width || (block.parentElement && block.parentElement.clientWidth) || 0;

    // Height and corner radius of the theme's button (a pill stays a pill: the radius is capped by the height in CSS).
    if (box.height >= 32 && box.height <= 96) style.setProperty('--kw-theme-height', box.height + 'px');
    if (px(cs.borderTopLeftRadius) !== null) style.setProperty('--kw-theme-radius', cs.borderTopLeftRadius);
    TYPE.forEach(function (name) {
      if (cs.getPropertyValue(name)) style.setProperty('--kw-theme-' + name, cs.getPropertyValue(name));
    });
    var padX = px(cs.paddingLeft);
    if (padX !== null && padX > 0) style.setProperty('--kw-theme-pad-x', padX + 'px');

    // Width: a button that fills its row is matched by 100%; a narrower one (a theme that sizes it to its text) is matched by
    // its own width, never wider than the space the block has.
    if (room && box.width < room * 0.95) style.setProperty('--kw-theme-width', Math.round(box.width) + 'px');
    else style.removeProperty('--kw-theme-width');

    // Space above the block. Where the theme spaces its buttons with a flex/grid gap and the block sits in that same row or
    // column, the gap already separates them (no extra margin); otherwise the block borrows the theme's gap as its margin.
    var parent = theme.parentElement && getComputedStyle(theme.parentElement);
    var gap = parent && (parent.display.indexOf('flex') !== -1 || parent.display.indexOf('grid') !== -1) ? px(parent.rowGap) : null;
    if (gap !== null && gap > 0 && gap <= 40) style.setProperty('--kw-theme-gap', block.parentElement === theme.parentElement ? '0px' : gap + 'px');
    else style.removeProperty('--kw-theme-gap');
  }

  var timer = null;
  function run() {
    var blocks = document.querySelectorAll('.kw-block');
    for (var i = 0; i < blocks.length; i += 1) apply(blocks[i]);
  }
  function later() {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, 100);
  }

  run();
  window.addEventListener('load', later);
  window.addEventListener('resize', later);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(later);
  // The theme's button is drawn late by some themes (and re-drawn on variant changes): look again when its form changes.
  if (window.MutationObserver) {
    var forms = document.querySelectorAll('form[action*="/cart/add"], product-form');
    var watcher = new MutationObserver(later);
    for (var i = 0; i < forms.length; i += 1) watcher.observe(forms[i], { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] });
  }
})();
