(function () {
  'use strict';
  // Kept small on purpose (app block scripts are limited to 10 KB). It shows the heart
  // icons and hands every click to konvert-wishlist-extras.js, which holds the wishlist
  // logic (saving variants, login redirect, header icon, cards, My Wishlist page) and is
  // loaded on demand.

  if (window.KonvertWishlist) return;

  var HEART_SVG =
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path class="kw-i-heart" d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5.5 6.2 5.5c1.9 0 3.4 1 4.3 2.4l1.5 2 1.5-2c.9-1.4 2.4-2.4 4.3-2.4 3.2 0 5 3.1 3.7 6.3C19.5 16.4 12 21 12 21z"/><path class="kw-i-star" d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/><path class="kw-i-bookmark" d="M6 3h12v18l-6-4.5L6 21z"/></svg>';

  var config = readConfig();
  var kw = {
    config: config,
    items: new Map(),
    ready: Promise.resolve(),
    lookup: null,
    el: el,
    injectHearts: injectHearts,
    setBusy: setBusy,
    shopRoot: shopRoot
  };

  // Shopify's translation filter HTML-escapes its output (an apostrophe arrives as &#39;), but
  // these strings are only ever shown with textContent, so they are turned back into plain text.
  // One pass, so "&amp;#39;" becomes the literal text "&#39;" and is never decoded twice.
  // (Kept self-contained: readConfig() runs before the rest of this file's variables are set.)
  function plain(value) {
    var entities = { '&#39;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' };
    return String(value).replace(/&#39;|&quot;|&amp;|&lt;|&gt;/g, function (entity) {
      return entities[entity];
    });
  }

  function readConfig() {
    var merged = { loggedIn: false, apiPath: '', loginUrl: '/account/login', text: {} };
    var nodes = document.querySelectorAll('script[data-kw-config]');
    for (var i = 0; i < nodes.length; i += 1) {
      var parsed;
      try {
        parsed = JSON.parse(nodes[i].textContent);
      } catch (error) {
        continue;
      }
      merged.loggedIn = Boolean(parsed.loggedIn);
      merged.headerIcon = merged.headerIcon || Boolean(parsed.headerIcon);
      merged.collectionCards = merged.collectionCards || Boolean(parsed.collectionCards);
      merged.notifyEnabled = merged.notifyEnabled || Boolean(parsed.notifyEnabled);
      ['apiPath', 'notifyPath', 'featuresPath', 'productHandle', 'inventoryPath', 'pagePath', 'loginUrl', 'pageType', 'extrasUrl'].forEach(function (key) {
        if (parsed[key]) merged[key] = parsed[key];
      });
      Object.keys(parsed.text || {}).forEach(function (key) {
        if (parsed.text[key]) merged.text[key] = plain(parsed.text[key]);
      });
    }
    return merged;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function shopRoot() {
    var routes = window.Shopify && window.Shopify.routes;
    return (routes && routes.root) || '/';
  }

  function injectHearts(root) {
    var spots = root.querySelectorAll('.kw-heart');
    for (var i = 0; i < spots.length; i += 1) {
      if (!spots[i].firstChild) spots[i].innerHTML = HEART_SVG;
    }
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    button.classList.toggle('kw-btn--loading', busy);
  }

  var PENDING_KEY = 'kw:pending';

  function hasPending() {
    try {
      return Boolean(
        window.sessionStorage.getItem(PENDING_KEY) || window.sessionStorage.getItem('kw:pending-notify'),
      );
    } catch (error) {
      return false;
    }
  }

  // The extras script is loaded once, on demand.
  var extrasPromise = null;
  function ensureExtras() {
    if (kw.toggle) return Promise.resolve();
    if (!config.extrasUrl) return Promise.reject(new Error('extras_unavailable'));
    if (!extrasPromise) {
      extrasPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = config.extrasUrl;
        script.defer = true;
        script.onload = resolve;
        script.onerror = function () {
          extrasPromise = null;
          reject(new Error('extras_failed'));
        };
        document.head.appendChild(script);
      });
    }
    return extrasPromise;
  }

  function init() {
    document.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-kw-button]');
      if (!button || config.wishlistOff) return;
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      setBusy(button, true);
      ensureExtras().then(
        function () {
          kw.toggle(button);
        },
        function () {
          // The extras script could not load: a logged-out visitor still gets to the login page.
          setBusy(button, false);
          if (!config.loggedIn) window.location.assign(config.loginUrl || '/account/login');
        }
      );
    }, true);

    loadFeatures().then(function (features) {
      applyFeatures(features);
      applyAppearance(features && features.appearance, true);
      injectHearts(document);

      var needsExtras =
        document.querySelector('[data-kw-button]') ||
        config.headerIcon ||
        config.collectionCards ||
        config.notifyEnabled ||
        document.querySelector('[data-kw-page-body]');
      if (needsExtras) ensureExtras().catch(function () {});

      // A wishlist action saved before login is finished by the extras script.
      if (hasPending() && !(config.wishlistOff && !config.notifyEnabled)) {
        ensureExtras().then(function () {
          kw.restorePending();
        }, function () {});
      }
    });
  }

  // Which features the merchant has switched on (the server enforces the same switches on every write).
  // Kept for a minute per browser tab so pages do not each wait for it; if it cannot be read, nothing is hidden.
  var FEATURES_KEY = 'kw:features';
  function readCache() {
    try {
      return JSON.parse(window.sessionStorage.getItem(FEATURES_KEY) || 'null');
    } catch (error) {
      return null; /* storage unavailable or damaged */
    }
  }
  function loadFeatures() {
    var cached = readCache();
    if (cached && cached.v && Date.now() - cached.t < 60000) return Promise.resolve(cached.v);
    if (!config.featuresPath) return Promise.resolve(null);
    return fetch(config.featuresPath, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (json) {
        if (!json || typeof json !== 'object') return null;
        var value = { wishlist: json.wishlist !== false, notifyMe: json.notifyMe !== false, appearance: json.appearance && typeof json.appearance === 'object' ? json.appearance : null };
        try {
          window.sessionStorage.setItem(FEATURES_KEY, JSON.stringify({ t: Date.now(), v: value }));
        } catch (error) {
          /* storage unavailable */
        }
        return value;
      })
      .catch(function () {
        return null;
      });
  }

  function applyFeatures(features) {
    if (!features) return;
    if (features.wishlist === false) {
      config.wishlistOff = true;
      config.headerIcon = false;
      config.collectionCards = false;
      document.documentElement.classList.add('kw-wishlist-off');
    }
    if (features.notifyMe === false) config.notifyEnabled = false;
  }

  // Wishlist Settings (sparse: only what the merchant changed). Words and on/off become data-kw-<section>-<key> attributes
  // on <html>, numbers and colours --kw-<section>-<key> variables; the CSS gives them meaning. `final` also applies the
  // two switches that change behaviour, not looks.
  var applied = [];
  var WORD = /^[A-Za-z]{1,30}$/;
  function applyAppearance(a, final) {
    var root = document.documentElement;
    applied.forEach(function (name) {
      if (name.indexOf('--') === 0) root.style.removeProperty(name);
      else root.removeAttribute(name);
    });
    applied = [];
    if (!a || typeof a !== 'object') return;
    Object.keys(a).forEach(function (section) {
      var part = a[section];
      if (!part || typeof part !== 'object' || !WORD.test(section)) return;
      Object.keys(part).forEach(function (key) {
        var value = part[key];
        if (!WORD.test(key)) return;
        var name = ('kw-' + section + '-' + key).replace(/[A-Z]/g, function (l) { return '-' + l.toLowerCase(); });
        var num = typeof value === 'number' && isFinite(value) && Math.abs(value) <= 10000;
        var text = typeof value === 'string';
        if (num || (text && /^#[0-9a-f]{6}$/i.test(value))) {
          root.style.setProperty('--' + name, String(value));
          applied.push('--' + name);
        }
        if (num || typeof value === 'boolean' || (text && /^[a-z_-]{1,16}$/.test(value))) {
          root.setAttribute('data-' + name, String(value));
          applied.push('data-' + name);
        }
      });
    });
    if (final) {
      if ((a.collectionPage || {}).enabled === false) config.collectionCards = false;
      if ((a.wishlistPage || {}).headerIcon === false) config.headerIcon = false;
    }
  }
  var early = readCache(); // last known look first: no flash of the default one
  if (early && early.v) applyAppearance(early.v.appearance);

  window.KonvertWishlist = kw;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
