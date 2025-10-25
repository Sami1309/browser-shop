/* eslint-disable no-undef */

// ---- Config ----
const DEFAULTS = {
  API_BASE: 'http://localhost:8787',
  API_KEY: '',
  AUTO_INJECT: true
};

// ---- Storage helpers ----
const STORAGE_PREFIX = 'affilifind:';
const sessionArea = (chrome.storage && chrome.storage.session) || (chrome.storage && chrome.storage.local) || null;
const sessionIsEphemeral = Boolean(chrome.storage && chrome.storage.session);

function withPrefix(key) {
  return `${STORAGE_PREFIX}${key}`;
}

async function sessionGet(key) {
  if (!sessionArea) return undefined;
  if (!sessionIsEphemeral && key.startsWith('deal:')) return undefined;
  try {
    const res = await sessionArea.get(withPrefix(key));
    return res[withPrefix(key)];
  } catch (err) {
    console.warn('[AffiliFind] sessionGet failed', err);
    return undefined;
  }
}

async function sessionSet(key, value) {
  if (!sessionArea) return;
  if (!sessionIsEphemeral && key.startsWith('deal:')) return;
  try {
    await sessionArea.set({ [withPrefix(key)]: value });
  } catch (err) {
    console.warn('[AffiliFind] sessionSet failed', err);
  }
}

async function sessionRemove(key) {
  if (!sessionArea) return;
  try {
    await sessionArea.remove(withPrefix(key));
  } catch (err) {
    console.warn('[AffiliFind] sessionRemove failed', err);
  }
}

function cacheKeyFromUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/+$|$/g, '')}`;
  } catch {
    return url;
  }
}

// ---- In-memory caches ----
const DEAL_HISTORY_KEY = withPrefix('dealHistory');

const mem = {
  productByTab: new Map(),
  dealCache: new Map(),
  remoteIntel: new Map(),
  searchCache: new Map()
};

function computeSavingsValue(entry) {
  if (!entry || !entry.product || !entry.deal) return null;
  const price = Number(entry.product.price);
  const discount = Number(entry.deal.discountPercent);
  if (!Number.isFinite(price) || !Number.isFinite(discount)) return null;
  const savings = (price * discount) / 100;
  if (!Number.isFinite(savings) || savings <= 0) return null;
  return Math.round(savings * 100) / 100;
}

async function getDealHistory() {
  const res = await chrome.storage.local.get(DEAL_HISTORY_KEY);
  const list = Array.isArray(res[DEAL_HISTORY_KEY]) ? res[DEAL_HISTORY_KEY] : [];
  return list;
}

async function addDealHistory(entry) {
  if (!entry) return;
  const current = await getDealHistory();
  const now = Date.now();
  const id = (globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(16).slice(2)}`);
  const savingsValue = computeSavingsValue(entry);
  const next = [{ id, addedAt: now, savingsValue, ...entry }, ...current].slice(0, 100);
  await chrome.storage.local.set({ [DEAL_HISTORY_KEY]: next });
}

async function getConfig() {
  const { apiBase, apiKey, autoInject } = await chrome.storage.sync.get({
    apiBase: DEFAULTS.API_BASE,
    apiKey: DEFAULTS.API_KEY,
    autoInject: DEFAULTS.AUTO_INJECT
  });
  return { apiBase, apiKey, autoInject };
}

async function setConfig(updates) {
  await chrome.storage.sync.set(updates);
}

// ---- API calls ----
async function apiFetch(path, params = {}) {
  const { apiBase, apiKey } = await getConfig();
  const url = new URL(path, apiBase);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(url.toString(), { headers, credentials: 'omit', mode: 'cors' });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function lookupDeal(product) {
  const cacheKey = JSON.stringify({ t: product?.title, sku: product?.sku, url: product?.url, upc: product?.gtin });
  if (mem.dealCache.has(cacheKey)) return mem.dealCache.get(cacheKey);

  if (sessionIsEphemeral) {
    const cached = await sessionGet(`deal:${cacheKey}`);
    if (cached) {
      mem.dealCache.set(cacheKey, cached);
      return cached;
    }
  }

  const data = await apiFetch('/v1/affiliate-links', {
    url: product?.url,
    title: product?.title,
    sku: product?.sku || product?.mpn,
    upc: product?.gtin,
    brand: product?.brand,
    price: product?.price,
    currency: product?.currency
  });

  mem.dealCache.set(cacheKey, data);
  if (sessionIsEphemeral) await sessionSet(`deal:${cacheKey}`, data);
  return data;
}

async function fetchSimilar(product, limit = 6) {
  const key = JSON.stringify({ sim: true, t: product?.title, upc: product?.gtin });
  if (mem.dealCache.has(key)) return mem.dealCache.get(key);

  if (sessionIsEphemeral) {
    const cached = await sessionGet(`deal:${key}`);
    if (cached) {
      mem.dealCache.set(key, cached);
      return cached;
    }
  }

  const data = await apiFetch('/v1/similar', {
    url: product?.url,
    title: product?.title,
    upc: product?.gtin,
    sku: product?.sku || product?.mpn,
    brand: product?.brand,
    limit
  });

  mem.dealCache.set(key, data);
  if (sessionIsEphemeral) await sessionSet(`deal:${key}`, data);
  return data;
}

async function fetchRemoteProductIntel(payload = {}) {
  const url = payload?.url;
  if (!url) throw new Error('url is required for remote intel');
  const cacheKey = cacheKeyFromUrl(url);
  if (mem.remoteIntel.has(cacheKey)) return mem.remoteIntel.get(cacheKey);

  const { apiBase, apiKey } = await getConfig();
  const endpoint = new URL('/v1/product-intel', apiBase);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(endpoint.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Product intel API ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  mem.remoteIntel.set(cacheKey, data);
  return data;
}

async function searchProductSuggestions(payload = {}) {
  const query = payload?.query?.trim();
  if (!query) throw new Error('query is required for search suggestions');
  const cacheKey = `${query.toLowerCase()}::${payload?.context || ''}::${payload?.product?.url || ''}`;
  if (mem.searchCache.has(cacheKey)) return mem.searchCache.get(cacheKey);

  const { apiBase, apiKey } = await getConfig();
  const endpoint = new URL('/v1/search-suggestions', apiBase);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(endpoint.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Search suggestions API ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  mem.searchCache.set(cacheKey, data);
  return data;
}

// ---- Messaging ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'PRODUCT_DETECTED') {
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        mem.productByTab.set(tabId, { product: msg.product, lastLookupAt: Date.now() });
        await sessionSet(`tab:${tabId}`, msg.product);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'LOOKUP_AFFILIATE') {
      const product = msg.product;
      const deal = await lookupDeal(product).catch(e => ({ error: e.message }));
      sendResponse(deal);
      return;
    }

    if (msg?.type === 'SIMILAR_PRODUCTS') {
      const product = msg.product;
      const similar = await fetchSimilar(product, msg.limit || 6).catch(e => ({ error: e.message }));
      sendResponse(similar);
      return;
    }

    if (msg?.type === 'REMOTE_PRODUCT_INTEL') {
      const intel = await fetchRemoteProductIntel(msg.payload || {}).catch(e => ({ error: e.message }));
      sendResponse(intel);
      return;
    }

    if (msg?.type === 'GET_POPUP_DATA') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      let product = mem.productByTab.get(tabId)?.product;
      if (!product) product = await sessionGet(`tab:${tabId}`);

      let deal = null;
      let similar = { items: [] };

      if (product) {
        deal = await lookupDeal(product).catch(() => null);
        similar = await fetchSimilar(product, 6).catch(() => ({ items: [] }));
      }

      const config = await getConfig();
      sendResponse({ product, deal, similar, config });
      return;
    }

    if (msg?.type === 'APPLY_AFFILIATE') {
      const appliedAt = Date.now();
      if (msg.dealRecord) {
        await addDealHistory(msg.dealRecord);
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'AFFILIFIND_DEAL_APPLIED' }).catch(() => {});
      }
      sendResponse({ ok: true, appliedAt });
      return;
    }

    if (msg?.type === 'SET_CONFIG') {
      await setConfig(msg.updates || {});
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'GET_DEAL_HISTORY') {
      const history = await getDealHistory();
      sendResponse({ items: history });
      return;
    }

    if (msg?.type === 'SEARCH_PRODUCT_SUGGESTIONS') {
      const query = (msg?.query || msg?.product?.title || '').trim();
      if (!query) {
        sendResponse({ error: 'No query provided' });
        return;
      }
      const result = await searchProductSuggestions({
        query,
        context: msg?.product?.brand || '',
        product: msg?.product || null,
        domSnippet: msg?.domSnippet || null,
        selectorHints: msg?.selectorHints || null
      }).catch(e => ({ error: e.message }));
      sendResponse(result);
      return;
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  mem.productByTab.delete(tabId);
  await sessionRemove(`tab:${tabId}`);
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await getConfig();
  await setConfig({ ...DEFAULTS, ...current });
});
