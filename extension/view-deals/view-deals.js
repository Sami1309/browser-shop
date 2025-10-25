const grid = document.getElementById('deals');
const emptyState = document.getElementById('empty');
const template = document.getElementById('deal-card-template');
const refreshBtn = document.getElementById('refresh');

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function renderDeals(items) {
  grid.innerHTML = '';
  if (!items.length) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  items.forEach((item) => {
    const node = template.content.cloneNode(true);
    const img = node.querySelector('.deal-thumb');
    img.src = item.product?.image || 'https://via.placeholder.com/120x120?text=Deal';
    img.alt = item.product?.title || 'Product image';

    node.querySelector('.deal-title').textContent = item.product?.title || 'Untitled product';
    node.querySelector('.deal-meta').textContent = [
      item.deal?.merchant,
      item.product?.price ? `$${item.product.price}` : null
    ].filter(Boolean).join(' · ');

    const badge = node.querySelector('.deal-badge');
    const discount = item.deal?.discountPercent;
    badge.textContent = discount ? `${discount}% off` : 'Deal applied';
    if (item.deal?.couponCode) {
      badge.textContent += ` · Code: ${item.deal.couponCode}`;
    }

    node.querySelector('.deal-time').textContent = `Applied on ${formatDate(item.addedAt)}`;

    const productLink = node.querySelectorAll('.deal-actions a')[0];
    const dealLink = node.querySelectorAll('.deal-actions a')[1];
    productLink.href = item.product?.url || '#';
    dealLink.href = item.deal?.affiliateUrl || item.product?.url || '#';

    grid.appendChild(node);
  });
}

async function loadDeals() {
  refreshBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'GET_DEAL_HISTORY' }).catch(() => null);
  refreshBtn.disabled = false;
  if (!res || !Array.isArray(res.items)) {
    emptyState.classList.remove('hidden');
    emptyState.innerHTML = '<p>Unable to load deals. Please reopen this page.</p>';
    return;
  }
  renderDeals(res.items);
}

refreshBtn.addEventListener('click', loadDeals);
loadDeals();
