/* eslint-disable no-undef */

const state = { product: null, deal: null, history: [], settingsOpen: false };

const q = (s) => document.querySelector(s);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const safeHostname = (url, fallback = '') => {
  if (!url) return fallback || location.hostname;
  try {
    return new URL(url).hostname;
  } catch {
    return fallback || location.hostname;
  }
};

const normalizeUrl = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.sort?.();
    return u.toString();
  } catch {
    return String(url).trim();
  }
};

const thumbnailForUrl = (url, provided) => {
  if (provided) return provided;
  if (!url) return 'https://www.google.com/s2/favicons?sz=64&domain_url=example.com';
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(u.origin)}`;
  } catch {
    return 'https://www.google.com/s2/favicons?sz=64&domain_url=example.com';
  }
};

function productsMatch(recordProduct = {}, currentProduct = {}) {
  if (!recordProduct || !currentProduct) return false;
  const urlA = normalizeUrl(recordProduct.url);
  const urlB = normalizeUrl(currentProduct.url);
  if (urlA && urlB && urlA === urlB) return true;
  const skuA = (recordProduct.sku || '').toLowerCase();
  const skuB = (currentProduct.sku || '').toLowerCase();
  if (skuA && skuB && skuA === skuB) return true;
  const titleA = (recordProduct.title || '').trim().toLowerCase();
  const titleB = (currentProduct.title || '').trim().toLowerCase();
  return Boolean(titleA && titleB && titleA === titleB);
}

function hasDealApplied(product) {
  if (!product) return false;
  return state.history.some((item) => productsMatch(item.product, product));
}

function formatCurrency(amount, currencyCode = 'USD') {
  if (!Number.isFinite(amount)) return null;
  const code = typeof currencyCode === 'string' && currencyCode.length === 3
    ? currencyCode.toUpperCase()
    : 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function formatDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

async function refreshHistory() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_DEAL_HISTORY' }).catch(() => null);
  state.history = Array.isArray(res?.items) ? res.items : [];
  return state.history;
}

function setSettingsExpanded(expanded) {
  const panel = q('#settingsPanel');
  const toggle = q('#settingsToggle');
  state.settingsOpen = expanded;
  if (!panel || !toggle) return;
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  panel.classList.toggle('hidden', !expanded);
}

function toggleSettings() {
  setSettingsExpanded(!state.settingsOpen);
}

function renderDealsModal() {
  const totals = q('#dealsTotals');
  const list = q('#dealsList');
  const items = state.history;
  const totalSavings = items.reduce((sum, item) => sum + (Number(item.savingsValue) || 0), 0);
  const currencyGuess = items.find((entry) => entry.product?.currency)?.product.currency || 'USD';
  const totalDeals = items.length;
  const savingsLabel = Number(totalSavings) > 0 ? formatCurrency(totalSavings, currencyGuess) : '––';
  if (totals) {
    totals.innerHTML = `
      <div class="stat">
        <div class="stat-label">Deals applied</div>
        <div class="stat-value">${totalDeals}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Estimated saved</div>
        <div class="stat-value">${savingsLabel}</div>
      </div>
    `;
  }

  if (!list) return;
  list.innerHTML = '';
  if (!items.length) {
    list.append(el('<div class="empty-state">No deals applied yet. Use “Apply deal” and they will show up here.</div>'));
    return;
  }
  items.forEach((item) => {
    const discount = item.deal?.discountPercent;
    const coupon = item.deal?.couponCode;
    const merchant = item.deal?.merchant || 'Merchant';
    const priceLabel = Number(item.product?.price)
      ? formatCurrency(Number(item.product.price), item.product?.currency)
      : '';
    const node = el(`
      <div class="deal-entry">
        <img src="${item.product?.image || 'https://via.placeholder.com/64'}" alt="" />
        <div>
          <h3>${item.product?.title || 'Untitled product'}</h3>
          <div class="deal-meta">${merchant}${priceLabel ? ` · ${priceLabel}` : ''}</div>
          ${discount ? `<div class="deal-chip">${discount}% off${coupon ? ` · Code ${coupon}` : ''}</div>` : ''}
          <div class="deal-meta">Applied ${formatDate(item.addedAt)}</div>
        </div>
        <div class="deal-actions">
          <button class="secondary" data-url="${item.product?.url || '#'}" type="button">View</button>
          <button class="primary" data-url="${item.deal?.affiliateUrl || item.product?.url || '#'}" type="button">Open deal</button>
        </div>
      </div>
    `);
    node.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        const url = evt.currentTarget.dataset.url;
        if (url && url !== '#') {
          chrome.tabs.create({ url });
        }
      });
    });
    list.append(node);
  });
}

async function openDealsModal() {
  const modal = q('#dealsModal');
  if (!modal) return;
  await refreshHistory();
  renderDealsModal();
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    modal.classList.add('show');
  });
}

function closeDealsModal() {
  const modal = q('#dealsModal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    modal.classList.add('hidden');
  }, 200);
}

function buildDealRecord(product, affiliate, match, source = 'popup') {
  if (!product || !affiliate) return null;
  return {
    product: {
      title: product.title || '(untitled)',
      image: product.image || null,
      url: product.url || null,
      price: product.price || null,
      currency: product.currency || null,
      description: product.description || null
    },
    deal: {
      merchant: match?.merchant || (product.url ? new URL(product.url).hostname : 'Unknown'),
      discountPercent: affiliate.discountPercent || null,
      couponCode: affiliate.couponCode || null,
      affiliateUrl: affiliate.url
    },
    source
  };
}

function renderCurrentProduct(data) {
  const currentEl = q('#current-body');
  currentEl.innerHTML = '';

  if (data && 'product' in data) state.product = data.product;
  if (data && 'deal' in data) state.deal = data.deal || null;

  const product = state.product;
  const deal = state.deal;

  if (!product) {
    currentEl.append(el('<div class="small muted">No product detected on this tab.</div>'));
    return;
  }

  const safeTitle = product.title || '(untitled)';
  const hostname = safeHostname(product.url || location.href, 'this page');
  const affiliate = deal?.affiliate;
  const applied = hasDealApplied(product);
  const buttonLabel = applied ? 'Deal applied' : 'Apply deal';

  const row = el(`
    <div>
      <div><strong>${safeTitle}</strong></div>
      <div class="small muted">${hostname}</div>
      ${affiliate ? `
        <div style="margin-top:6px">
          <span>${affiliate.discountPercent ? `<b>${affiliate.discountPercent}% off</b>` : 'Deal available'}</span>
          ${affiliate.couponCode ? `<span class="small" style="margin-left:8px">Code: <b>${affiliate.couponCode}</b></span>` : ''}
          <div style="margin-top:6px">
            <button id="go-apply" class="primary" ${applied ? 'disabled' : ''}>${buttonLabel}</button>
          </div>
        </div>
      ` : '<div class="small muted" style="margin-top:6px">No direct deal found.</div>'}
      ${applied ? '<div class="deal-applied-pill">Deal applied</div>' : ''}
    </div>
  `);
  currentEl.append(row);

  if (affiliate?.url && !applied) {
    const btn = row.querySelector('#go-apply');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Applying…';
      await chrome.runtime.sendMessage({
        type: 'APPLY_AFFILIATE',
        affiliateUrl: affiliate.url,
        dealRecord: buildDealRecord(product, affiliate, deal.match)
      }).catch(() => null);
      await refreshHistory();
      renderCurrentProduct();
    });
  }
}

function renderSimilarProducts(items = []) {
  const list = q('#similar-list');
  list.innerHTML = '';
  if (!items.length) {
    list.append(el('<div class="small muted">No similar products found (or none with affiliate links).</div>'));
    return;
  }
  items.forEach((it) => {
    const merchantLabel = it.merchant || safeHostname(it.url || '', 'Deal');
    const node = el(`
      <div class="item">
        <img src="${it.image || ''}" alt="" />
        <div>
          <div class="title">${it.title || 'Untitled'}</div>
          <div class="meta">${merchantLabel} · ${it.discountPercent ? `${it.discountPercent}% off` : 'Deal'}</div>
        </div>
        <div class="actions">
          <button data-url="${it.affiliateUrl || it.url}">View</button>
        </div>
      </div>
    `);
    node.querySelector('button').addEventListener('click', (e) => {
      chrome.tabs.create({ url: e.currentTarget.dataset.url });
    });
    list.append(node);
  });
}

function setSuggestionsState({ status = '', loading = false, items = null } = {}) {
  const section = q('#suggestions');
  const statusEl = q('#suggestions-status');
  const body = q('#suggestions-body');

  if (loading) {
    section.classList.remove('hidden');
    statusEl.textContent = status || 'Searching...';
    body.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      body.append(el('<div class="skeleton" aria-hidden="true"></div>'));
    }
    return;
  }

  if (items && items.length) {
    section.classList.remove('hidden');
    statusEl.textContent = status || '';
    body.innerHTML = '';
    items.slice(0, 3).forEach((item) => {
      const safeUrl = item.url || '';
      const safeImage = thumbnailForUrl(safeUrl, item.image);
      const safeSummary = item.summary || 'No summary available yet.';
      body.append(el(`
        <div class="suggestion-card">
          <img src="${safeImage}" alt="" />
          <div>
            <div><strong>${item.title || 'Suggestion'}</strong></div>
            <div class="meta">${safeSummary}</div>
            ${item.priceRange ? `<div class="meta">${item.priceRange}</div>` : ''}
          </div>
          <div class="actions">
            <button ${safeUrl ? `data-url="${safeUrl}"` : 'disabled'}>${safeUrl ? 'View' : 'No link'}</button>
          </div>
        </div>
      `));
    });
    body.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const url = e.currentTarget.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });
  } else if (status) {
    section.classList.remove('hidden');
    statusEl.textContent = status;
    body.innerHTML = '<div class="small muted">No suggestions available.</div>';
  }
}

async function handleSearchSuggestions(btn) {
  const baseQuery = (state.product?.title || state.product?.description || '').trim();
  if (!state.product || !baseQuery) {
    setSuggestionsState({ status: 'No product to base search on.' });
    return;
  }
  btn.disabled = true;
  setSuggestionsState({ loading: true, status: 'Searching with Grok…' });
  const context = await collectPageContext().catch(() => ({}));
  const mergedProduct = {
    ...(state.product || {}),
    ...(context?.product || {})
  };
  if (!mergedProduct.url && state.product?.url) mergedProduct.url = state.product.url;
  const res = await chrome.runtime.sendMessage({
    type: 'SEARCH_PRODUCT_SUGGESTIONS',
    product: mergedProduct,
    productUrl: mergedProduct.url || state.product?.url || null,
    query: baseQuery,
    snippets: Array.isArray(context?.snippets) ? context.snippets.slice(0, 4) : []
  }).catch(() => null);
  btn.disabled = false;
  if (!res || res.error) {
    setSuggestionsState({ status: res?.error || 'Unable to fetch suggestions right now.' });
    return;
  }
  const items = Array.isArray(res.items) ? res.items.slice(0, 3) : [];
  setSuggestionsState({ items, status: items.length ? 'Powered by Grok search' : 'No suggestions returned.' });
}

async function collectPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return {};
    const context = await chrome.tabs.sendMessage(tab.id, { type: 'AFFILIFIND_PAGE_CONTEXT' }).catch(() => null);
    return context || {};
  } catch {
    return {};
  }
}

async function loadPopup() {
  const data = await chrome.runtime.sendMessage({ type: 'GET_POPUP_DATA' }).catch(() => null);
  if (!data) return;

  await refreshHistory();

  // Settings
  q('#autoInject').checked = !!data.config.autoInject;
  q('#apiBase').value = data.config.apiBase || '';
  q('#apiKey').value = data.config.apiKey || '';

  renderCurrentProduct(data);
  renderSimilarProducts(data.similar?.items || []);

  const viewDealsBtn = q('#viewDeals');
  if (viewDealsBtn) {
    viewDealsBtn.addEventListener('click', () => {
      openDealsModal();
    });
  }

  const closeDealsBtn = q('#closeDeals');
  if (closeDealsBtn) closeDealsBtn.addEventListener('click', closeDealsModal);

  const modal = q('#dealsModal');
  if (modal) {
    modal.addEventListener('click', (evt) => {
      if (evt.target?.dataset?.closeModal !== undefined) {
        closeDealsModal();
      }
    });
  }

  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') closeDealsModal();
  });

  const settingsToggle = q('#settingsToggle');
  if (settingsToggle) settingsToggle.addEventListener('click', toggleSettings);
  setSettingsExpanded(false);

  q('#searchSimilar').addEventListener('click', (e) => handleSearchSuggestions(e.currentTarget));

  // Save settings
  q('#save').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({
      type: 'SET_CONFIG',
      updates: {
        autoInject: q('#autoInject').checked,
        apiBase: q('#apiBase').value.trim(),
        apiKey: q('#apiKey').value.trim()
      }
    });
    q('#saved').textContent = 'Saved';
    setTimeout(() => q('#saved').textContent = '', 1200);
  });
}

document.addEventListener('DOMContentLoaded', loadPopup);
