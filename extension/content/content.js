/* eslint-disable no-undef */

(function () {
  const log = (...args) => {
    if (typeof console === 'undefined' || typeof console.debug !== 'function') return;
    try {
      console.debug('[AffiliFind]', ...args);
    } catch {
      // ignore logging errors
    }
  };
  const CORE_FIELDS = ['title', 'description'];
  const STATE = {
    product: null,
    deal: null,
    uiMounted: false,
    lastKey: null,
    scanning: false,
    scanQueued: false,
    remotePromise: null,
    remoteIntelCache: new Map(),
    learnedSelectors: Object.create(null)
  };

  const BASE_SELECTORS = {
    title: [
      "[itemprop='name']",
      "meta[property='og:title']",
      "meta[name='twitter:title']",
      '#productTitle',
      "h1[data-automation='product-title']",
      "h1[data-test='product-title']",
      'h1'
    ],
    price: [
      "[itemprop='price']",
      "[property='product:price:amount']",
      "meta[itemprop='price']",
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '#priceblock_saleprice',
      '.a-price .a-offscreen',
      "[data-test*='price']",
      '.price',
      '.product-price'
    ],
    description: [
      '#feature-bullets',
      '#productDescription',
      '#bookDescription_feature_div',
      '.product-description',
      "[data-feature-name='productDescription']",
      "[itemprop='description']",
      '.a-row.stack-container',
      '.productOverview',
      "meta[name='description']"
    ],
    brand: [
      "[itemprop='brand']",
      '#bylineInfo',
      '.brand',
      "meta[name='brand']"
    ],
    sku: [
      "[itemprop='sku']",
      "meta[name='sku']",
      "meta[property='og:sku']",
      "meta[name='product:retailer_item_id']"
    ],
    image: [
      "meta[property='og:image']",
      '#landingImage',
      '#imgTagWrapperId img',
      '.product-image img'
    ]
  };

  function debounce(fn, wait = 400) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function ensureSelectorSet(field) {
    if (!STATE.learnedSelectors[field]) {
      STATE.learnedSelectors[field] = new Set();
    }
    return STATE.learnedSelectors[field];
  }

  function mergeProducts(base = {}, override = {}) {
    return { ...base, ...override };
  }

  function combineSelectors(field, fallback = []) {
    const learned = STATE.learnedSelectors[field] ? Array.from(STATE.learnedSelectors[field]) : [];
    const base = fallback.length ? fallback : (BASE_SELECTORS[field] || []);
    return Array.from(new Set([...base, ...learned].filter(Boolean)));
  }

  function readFromSelectors(selectors = [], { attribute, html } = {}) {
    for (const selector of selectors) {
      if (!selector) continue;
      let node;
      try {
        node = document.querySelector(selector);
      } catch (err) {
        continue;
      }
      if (!node) continue;
      if (attribute) {
        const value = node.getAttribute(attribute);
        if (value) return value.trim();
      }
      if (html) {
        const value = node.innerHTML?.trim();
        if (value) return value;
      }
      const attrFallbacks = ['content', 'src', 'data-src', 'href', 'value'];
      for (const attr of attrFallbacks) {
        const attrValue = node.getAttribute?.(attr);
        if (attrValue) return attrValue.trim();
      }
      const text = node.textContent?.trim();
      if (text) return text;
    }
    return undefined;
  }

  function parsePrice(value) {
    if (value == null || value === '') return undefined;
    const raw = String(value);
    const digits = raw.replace(/[^0-9.,]/g, '').trim();
    if (!digits) return undefined;
    const hasComma = digits.includes(',');
    const hasDot = digits.includes('.');
    let normalized = digits;
    if (hasComma && hasDot) {
      normalized = digits.lastIndexOf('.') > digits.lastIndexOf(',')
        ? digits.replace(/,/g, '')
        : digits.replace(/\./g, '').replace(/,/g, '.');
    } else if (hasComma) {
      const parts = digits.split(',');
      normalized = parts[parts.length - 1].length === 2
        ? digits.replace(/\./g, '').replace(/,/g, '.')
        : digits.replace(/,/g, '');
    }
    const num = Number(normalized);
    return Number.isFinite(num) ? num : undefined;
  }

  function canonicalUrl() {
    return document.querySelector("link[rel='canonical']")?.href ||
      document.querySelector("link[rel='alternate'][hreflang='x-default']")?.href ||
      document.querySelector("meta[property='og:url']")?.content ||
      undefined;
  }

  function pickFirst(arr) {
    return Array.isArray(arr) ? arr[0] : arr;
  }

  function parseJSONLDSafely(txt) {
    try {
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  function findProductFromJSONLD() {
    const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']"));
    for (const script of scripts) {
      const data = parseJSONLDSafely(script.textContent);
      if (!data) continue;
      const nodes = []
        .concat(data)
        .concat(data?.['@graph'] || [])
        .filter(Boolean);
      for (const node of nodes) {
        const type = node?.['@type'];
        if (!type) continue;
        const types = Array.isArray(type) ? type : [type];
        if (!types.includes('Product')) continue;
        const offers = pickFirst(node.offers) || {};
        return {
          title: node.name || node.title,
          description: node.description,
          brand: (typeof node.brand === 'string' ? node.brand : node.brand?.name) || undefined,
          sku: node.sku || undefined,
          mpn: node.mpn || undefined,
          gtin: node.gtin || node.gtin13 || node.gtin12 || node.gtin14 || node.gtin8 || undefined,
          image: pickFirst(node.image) || undefined,
          price: parsePrice(offers.price || offers.lowPrice || offers.highPrice),
          currency: offers.priceCurrency || offers.priceCurrencyCode || undefined,
          url: node.url || canonicalUrl() || location.href
        };
      }
    }
    return null;
  }

  function extractProductHeuristics() {
    const title = readFromSelectors(combineSelectors('title')) || document.querySelector('meta[property="og:title"]')?.content || document.title || undefined;
    const price = parsePrice(readFromSelectors(combineSelectors('price')));
    const descriptionRaw = readFromSelectors(
      combineSelectors('description'),
      { html: true }
    );
    let description = descriptionRaw
      ? descriptionRaw.replace(/\s+/g, ' ').trim()
      : undefined;
    if (!description) {
      const metaDescription = document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('meta[property="og:description"]')?.content;
      if (metaDescription) description = metaDescription.trim();
    }
    const sku = readFromSelectors(combineSelectors('sku'));
    const brand = readFromSelectors(combineSelectors('brand'));
    const image = readFromSelectors(combineSelectors('image'), { attribute: 'src' }) ||
      readFromSelectors(["meta[property='og:image']"], { attribute: 'content' });

    const url = canonicalUrl() || location.href;

    const product = {
      title,
      price,
      description,
      sku,
      brand,
      image,
      url,
      currency: readFromSelectors(["meta[property='product:price:currency']", "meta[itemprop='priceCurrency']"], { attribute: 'content' })
    };

    return product.title || product.description ? product : null;
  }

  function detectLocally() {
    const structured = findProductFromJSONLD();
    const heuristics = extractProductHeuristics();
    if (!structured && !heuristics) return null;
    const merged = mergeProducts(structured || {}, heuristics || {});
    if (!merged.description) {
      const desc = readFromSelectors(combineSelectors('description'), { html: true });
      if (desc) merged.description = desc.replace(/\s+/g, ' ').trim();
    }
    if (!merged.title) {
      merged.title = readFromSelectors(combineSelectors('title'));
    }
    return merged.title || merged.description ? merged : null;
  }

  function hasCoreFields(product) {
    return CORE_FIELDS.every((field) => Boolean(product?.[field]));
  }

  function snapshotDom(limit = 160000) {
    const candidates = [
      document.querySelector('#dp'),
      document.querySelector('#centerCol'),
      document.querySelector('#ppd'),
      document.querySelector('#dp-container'),
      document.querySelector('main'),
      document.body
    ].filter(Boolean);
    const headInfo = [
      `<title>${document.title || ''}</title>`,
      canonicalUrl() ? `<link rel="canonical" href="${canonicalUrl()}" />` : ''
    ].join('\n');
    const html = [headInfo]
      .concat(candidates.map((el) => el.outerHTML))
      .join('\n');
    if (html.length <= limit) return html;
    const half = Math.floor(limit / 2);
    return `${html.slice(0, half)}\n<!-- AFFILIFIND_DOM_TRUNCATED -->\n${html.slice(-half)}`;
  }

  function registerSelectors(selectorMap = {}) {
    Object.entries(selectorMap).forEach(([field, selectors]) => {
      if (!selectors) return;
      const set = ensureSelectorSet(field);
      (Array.isArray(selectors) ? selectors : [selectors])
        .filter(Boolean)
        .forEach((sel) => set.add(sel));
    });
  }

  function applySelectorsToProduct(product = {}, selectorMap = {}) {
    const result = { ...product };
    Object.entries(selectorMap).forEach(([field, selectors]) => {
      if (!selectors || result[field]) return;
      const value = readFromSelectors(selectors, { html: field === 'description' });
      if (value) {
        result[field] = field === 'description'
          ? value.replace(/\s+/g, ' ').trim()
          : value.trim();
      }
    });
    return result;
  }

  async function requestRemoteIntel(missingFields = []) {
    const urlKey = location.href.split('#')[0];
    if (STATE.remoteIntelCache.has(urlKey)) return STATE.remoteIntelCache.get(urlKey);
    if (STATE.remotePromise) return STATE.remotePromise;

    const payload = {
      url: location.href,
      dom: snapshotDom(),
      missingFields
    };

    STATE.remotePromise = chrome.runtime.sendMessage({
      type: 'REMOTE_PRODUCT_INTEL',
      payload
    }).then((res) => {
      if (res && !res.error) {
        STATE.remoteIntelCache.set(urlKey, res);
      }
      return res;
    }).catch((err) => {
      console.warn('[AffiliFind] Remote detection failed', err);
      return null;
    }).finally(() => {
      STATE.remotePromise = null;
    });

    return STATE.remotePromise;
  }

  function serializeSelectorHints() {
    return Object.keys({ ...BASE_SELECTORS, ...STATE.learnedSelectors }).reduce((acc, field) => {
      const selectors = combineSelectors(field);
      if (selectors.length) acc[field] = selectors;
      return acc;
    }, {});
  }

  async function detectProduct() {
    const local = detectLocally();
    if (local && hasCoreFields(local)) return local;

    const missingFields = CORE_FIELDS.filter((field) => !(local && local[field]));
    const remote = await requestRemoteIntel(missingFields);
    if (!remote || remote.error) return local;

    if (remote.selectors) registerSelectors(remote.selectors);

    const combined = mergeProducts(local || {}, remote.product || {});
    const enriched = applySelectorsToProduct(combined, remote.selectors || {});

    if (!enriched.url) enriched.url = location.href;

    if (hasCoreFields(enriched)) return enriched;
    return enriched.title || enriched.description ? enriched : local;
  }

  // ---- UI helpers ----
  function removeWidget() {
    const existing = document.getElementById('affilifind-widget');
    if (existing) existing.remove();
    STATE.uiMounted = false;
  }

  function flashDealApplied() {
    const old = document.getElementById('affilifind-flash-ring');
    if (old) old.remove();
    const ring = document.createElement('div');
    ring.id = 'affilifind-flash-ring';
    ring.className = 'affilifind-flash-ring';
    document.documentElement.appendChild(ring);
    requestAnimationFrame(() => {
      ring.classList.add('visible');
    });
    setTimeout(() => ring.classList.add('fade'), 900);
    setTimeout(() => ring.remove(), 1600);
  }

  function mountWidget(deal) {
    if (STATE.uiMounted) return;
    const root = document.createElement('div');
    root.id = 'affilifind-widget';
    root.setAttribute('aria-live', 'polite');
    root.innerHTML = `
      <div class="af-card" role="dialog" aria-label="Affiliate deal">
        <div class="af-row">
          <div class="af-badge">Deal</div>
          <div class="af-title">${deal?.merchant || 'Affiliate offer'}</div>
        </div>
        <div class="af-discount">
          ${deal?.discountPercent ? `<strong>${deal.discountPercent}% off</strong>` : ''}
          ${deal?.couponCode ? `<span class="af-code">Code: <b>${deal.couponCode}</b></span>` : ''}
        </div>
        <div class="af-actions">
          <button id="af-apply">Apply deal</button>
          <button id="af-close" aria-label="Close">✕</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    const buildDealRecord = () => {
      if (!STATE.product || !STATE.deal) return null;
      return {
        product: {
          title: STATE.product.title || document.title,
          image: STATE.product.image || null,
          url: STATE.product.url || location.href,
          price: STATE.product.price || null,
          currency: STATE.product.currency || null,
          description: STATE.product.description || null
        },
        deal: {
          merchant: STATE.deal.merchant,
          discountPercent: STATE.deal.discountPercent || null,
          couponCode: STATE.deal.couponCode || null,
          affiliateUrl: STATE.deal.affiliateUrl
        },
        source: 'content'
      };
    };

    root.querySelector('#af-apply').addEventListener('click', async (e) => {
      e.preventDefault();
      if (deal?.couponCode && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(deal.couponCode);
        } catch (err) {
          console.warn('[AffiliFind] Failed to copy coupon', err);
        }
      }
      flashDealApplied();
      chrome.runtime.sendMessage({
        type: 'APPLY_AFFILIATE',
        affiliateUrl: deal.affiliateUrl,
        dealRecord: buildDealRecord()
      });
    });

    root.querySelector('#af-close').addEventListener('click', () => {
      removeWidget();
    });

    STATE.uiMounted = true;
  }

  function buildProductKey(product) {
    if (!product) return null;
    return JSON.stringify({ url: product.url, sku: product.sku, gtin: product.gtin, title: product.title });
  }

  async function runScan() {
    if (STATE.scanning) {
      STATE.scanQueued = true;
      return;
    }
    STATE.scanning = true;
    STATE.scanQueued = false;

    try {
      const product = await detectProduct();
      if (!product) {
        log('No product detected; will retry.');
        STATE.product = null;
        return;
      }

      const newKey = buildProductKey(product);
      if (newKey && STATE.lastKey && STATE.lastKey === newKey) {
        STATE.product = product;
        return;
      }

      STATE.lastKey = newKey;
      STATE.product = product;
      removeWidget();

      chrome.runtime.sendMessage({ type: 'PRODUCT_DETECTED', product }).catch(() => {});

      const deal = await chrome.runtime.sendMessage({ type: 'LOOKUP_AFFILIATE', product }).catch(() => null);
      if (deal && deal.match && deal.affiliate?.url) {
        STATE.deal = {
          merchant: deal.match.merchant || (product.url ? new URL(product.url).hostname : location.hostname),
          discountPercent: deal.affiliate.discountPercent || null,
          couponCode: deal.affiliate.couponCode || null,
          affiliateUrl: deal.affiliate.url
        };
        const cfg = await chrome.storage.sync.get({ autoInject: true });
        if (cfg.autoInject) mountWidget(STATE.deal);
      } else {
        STATE.deal = null;
      }
    } finally {
      STATE.scanning = false;
      if (STATE.scanQueued) runScan();
    }
  }

  function resetForNavigation() {
    STATE.lastKey = null;
    STATE.remotePromise = null;
    STATE.remoteIntelCache.clear();
    STATE.learnedSelectors = Object.create(null);
    removeWidget();
  }

  function hookHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    const emit = () => window.dispatchEvent(new Event('affilifind-url-change'));

    history.pushState = function () {
      const r = origPush.apply(this, arguments);
      setTimeout(emit, 0);
      return r;
    };
    history.replaceState = function () {
      const r = origReplace.apply(this, arguments);
      setTimeout(emit, 0);
      return r;
    };

    window.addEventListener('popstate', emit, { passive: true });
    window.addEventListener('affilifind-url-change', debounce(() => {
      resetForNavigation();
      runScan();
    }, 250));
  }

  function watchDOM() {
    const observer = new MutationObserver(debounce(() => {
      runScan();
    }, 500));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  hookHistory();
  watchDOM();
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'AFFILIFIND_DEAL_APPLIED') {
      flashDealApplied();
      sendResponse?.({ ok: true });
      return;
    }
    if (msg?.type === 'AFFILIFIND_PAGE_CONTEXT') {
      const product = STATE.product || detectLocally() || null;
      const selectors = serializeSelectorHints();
      sendResponse?.({
        product,
        domSnippet: snapshotDom(120000),
        selectors: Object.keys(selectors).length ? selectors : null
      });
      return;
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runScan, { once: true });
  }
  runScan();
})();
