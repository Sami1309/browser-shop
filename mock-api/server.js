const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');
let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
  Anthropic = Anthropic.default || Anthropic;
} catch (err) {
  console.warn('[mock-api] Anthropic SDK not found. Run npm install to enable LLM-backed detection.');
}

let OpenAI;
try {
  OpenAI = require('openai');
  OpenAI = OpenAI.default || OpenAI;
} catch (err) {
  console.warn('[mock-api] OpenAI client not found. Run npm install to enable Grok search.');
}

const dotenvPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(dotenvPath)) {
  require('dotenv').config({ path: dotenvPath });
}

const PORT = process.env.PORT || 8787;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const anthropic = anthropicKey && Anthropic ? new Anthropic({ apiKey: anthropicKey }) : null;

const openrouterKey = process.env.OPENROUTER_API_KEY;
const grokModel = process.env.OPENROUTER_GROK_MODEL || 'x-ai/grok-4-fast';
const openrouter = openrouterKey && OpenAI
  ? new OpenAI({ apiKey: openrouterKey, baseURL: 'https://openrouter.ai/api/v1' })
  : null;

const mockElementsEnabled = /^true$/i.test(process.env.ENABLE_MOCK_ELEMENTS || '');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const id = Math.random().toString(16).slice(2, 6);
  console.log(`[mock-api] --> [${id}] ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[mock-api] <-- [${id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

function randomBool(p = 0.7) { return Math.random() < p; }
function percent(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const selectorCache = new Map();

function cacheKeyFromUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/+$|$/g, '')}` || url;
  } catch {
    return url;
  }
}

function sanitizeSelectors(raw = {}) {
  const clean = {};
  for (const key of Object.keys(raw)) {
    const list = Array.isArray(raw[key]) ? raw[key] : [raw[key]];
    clean[key] = Array.from(new Set(list.filter(Boolean).map((s) => String(s).trim())));
  }
  return clean;
}

function sanitizeProduct(raw = {}, url) {
  const product = { ...raw };
  if (!product.url && url) product.url = url;
  if (typeof product.title === 'string') product.title = product.title.trim();
  if (typeof product.description === 'string') product.description = product.description.trim();
  if (typeof product.price === 'string') {
    const parsed = Number(product.price.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(parsed)) product.price = parsed;
  }
  if (typeof product.currency === 'string') product.currency = product.currency.trim().toUpperCase();
  return product;
}

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for up-to-date product information and pricing.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query describing the product(s) to research.'
        },
        num_results: {
          type: 'integer',
          description: 'Approximate number of search results to retrieve (1-10).',
          minimum: 1,
          maximum: 10
        }
      },
      required: ['query']
    }
  }
};

async function performWebSearch(query, numResults = 6) {
  const cleanedQuery = (query || '').trim();
  if (!cleanedQuery) return [];
  const limit = Math.max(1, Math.min(Number(numResults) || 6, 10));
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', cleanedQuery);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  url.searchParams.set('t', 'affilifind-extension');

  console.log(`[web-search] query="${cleanedQuery}" limit=${limit}`);
  const resp = await fetch(url, { headers: { 'User-Agent': 'AffiliFind/1.0 (+https://example.com)' } });
  if (!resp.ok) {
    console.warn('[web-search] duckduckgo response not ok', resp.status);
    return [];
  }
  const payload = await resp.json();
  const results = [];

  function pushResult(item) {
    if (!item || results.length >= limit) return;
    if (!item.title || !item.url) return;
    results.push({
      title: item.title,
      url: item.url,
      snippet: item.snippet || '',
      image: item.image || ''
    });
  }

  (payload.Results || []).forEach((result) => {
    pushResult({
      title: result.Text,
      url: result.FirstURL,
      snippet: result.Text,
      image: result.Icon?.URL || ''
    });
  });

  function harvestTopics(topics) {
    if (!Array.isArray(topics)) return;
    for (const topic of topics) {
      if (topic.Topics) {
        harvestTopics(topic.Topics);
        continue;
      }
      if (topic.Text && topic.FirstURL) {
        pushResult({
          title: topic.Text,
          url: topic.FirstURL,
          snippet: topic.Text,
          image: topic.Icon?.URL || ''
        });
      }
      if (results.length >= limit) break;
    }
  }

  harvestTopics(payload.RelatedTopics);

  if (!results.length && payload.AbstractText && payload.AbstractURL) {
    pushResult({ title: payload.AbstractText.slice(0, 80), url: payload.AbstractURL, snippet: payload.AbstractText });
  }

  return results.slice(0, limit);
}

function extractAssistantText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

async function analyzeDomWithLLM({ url, dom, missingFields = [] }) {
  if (!anthropic) {
    throw new Error('Anthropic API key not configured; cannot perform remote detection');
  }

  const trimmedDom = typeof dom === 'string'
    ? (dom.length > 160000
      ? `${dom.slice(0, 70000)}\n<!-- DOM TRIMMED -->\n${dom.slice(-70000)}`
      : dom)
    : '';

  const missingList = missingFields.length ? missingFields.join(', ') : 'title and description';
  const systemPrompt = [
    'You are a DOM analysis agent that extracts structured product data from messy HTML.',
    'Respond with valid minified JSON that matches this TypeScript type:',
    '{ "product": { "title": string, "description": string, "price"?: number | string, "currency"?: string, "sku"?: string, "brand"?: string, "image"?: string, "url"?: string },',
    '  "selectors": { "title"?: string[], "description"?: string[], "price"?: string[], "sku"?: string[], "brand"?: string[], "image"?: string[] } }',
    'Selectors must be simple CSS selectors pointing at elements that contain the requested data.',
    'If a field is unknown, set it to an empty string and return an empty selector array. No additional commentary.'
  ].join(' ');

  const messageContent = [
    `Target URL: ${url}`,
    `Fields needed: ${missingList}`,
    'DOM_SNIPPET_START',
    trimmedDom,
    'DOM_SNIPPET_END'
  ].join('\n');

  const messages = [];
  messages.push({
    role: 'user',
    content: messageContent,
  });

  const startTime = Date.now();
  console.log(`[anthropic] request start url=${url} missing=[${missingFields.join(', ')}] size=${trimmedDom.length}`);
  const response = await anthropic.messages.create({
    model: anthropicModel,
    max_tokens: 2000,
    system: systemPrompt,
    messages,
    temperature: 0.0,
  });

  const duration = Date.now() - startTime;
  console.log(`[anthropic] request complete url=${url} duration=${duration}ms`);
  if (!response.content || response.content.length === 0) {
    throw new Error('No content returned from Claude');
  }

  const textContent = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!textContent) {
    throw new Error('No text content returned from Claude');
  }

  const cleaned = textContent
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[mock-api] Failed to parse LLM response', textContent);
    throw new Error('LLM returned malformed JSON');
  }

  return {
    ...parsed,
    meta: { durationMs: duration }
  };
}

async function fetchSearchSuggestions({ query, context, product, domSnippet, selectorHints }) {
  if (!openrouter) {
    throw new Error('OpenRouter API key not configured; cannot perform Grok search');
  }
  const cleanedQuery = (query || '').trim();
  if (!cleanedQuery) throw new Error('query is required');

  const domSnippetClean = typeof domSnippet === 'string'
    ? (domSnippet.length > 32000
      ? `${domSnippet.slice(0, 15000)}\n<!-- DOM TRIMMED -->\n${domSnippet.slice(-8000)}`
      : domSnippet)
    : '';

  const productJson = product ? JSON.stringify(product).slice(0, 4000) : '';
  const selectorJson = selectorHints ? JSON.stringify(selectorHints).slice(0, 2000) : '';

  const systemPrompt = [
    'You are a lightning-fast shopping research co-pilot.',
    'Return strict minified JSON of shape {"items":[{"title":"","summary":"","priceRange":"","url":"","image":""}]}.',
    'Use any provided DOM snippet and product metadata to anchor the exact item we need alternatives for.',
    'Summaries must mention the standout feature + merchant or brand; include price ranges when available.',
    'Every item must include an https URL and an image (thumbnail) URL. Prefer images surfaced via search results or the DOM snippet.',
    'Never include prose outside JSON.'
  ].join(' ');

  const userPrompt = [
    `Find up to 3 compelling alternatives for: ${cleanedQuery}.`,
    context ? `Context: ${context}.` : null,
    productJson ? `Known product metadata: ${productJson}` : null,
    selectorJson ? `Selectors that surfaced useful data: ${selectorJson}` : null,
    domSnippetClean ? `DOM_SNIPPET_START\n${domSnippetClean}\nDOM_SNIPPET_END` : null,
    'Prefer options that are in stock and have clear buying links. JSON only.'
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  let turns = 0;
  while (turns < 4) {
    turns += 1;
    console.log(`[grok-search] turn=${turns} query="${cleanedQuery}"`);
    const response = await openrouter.chat.completions.create({
      model: grokModel,
      messages,
      tools: [WEB_SEARCH_TOOL],
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 800
    });
    const choice = response?.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error('No response returned from Grok');
    }

    const message = choice.message;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls
      });

      for (const call of message.tool_calls) {
        const fn = call.function?.name;
        if (fn !== 'web_search') continue;
        let args;
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch (err) {
          console.warn('[grok-search] failed to parse tool args', err);
          args = {};
        }
        const results = await performWebSearch(args.query || cleanedQuery, args.num_results || 6);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ results })
        });
      }
      continue;
    }

    const textContent = extractAssistantText(message).trim();
    if (!textContent) throw new Error('No text content returned from Grok search');
    const cleaned = textContent.replace(/^```json\s*/i, '').replace(/```$/i, '');
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[mock-api] Failed to parse Grok search response', cleaned);
      throw new Error('Search suggestions JSON malformed');
    }
    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 3) : [];
    return items.map((item) => ({
      title: item.title || item.name || cleanedQuery,
      summary: item.summary || item.description || '',
      priceRange: item.priceRange || item.price || '',
      url: item.url || '',
      image: item.image || ''
    }));
  }

  throw new Error('Grok did not produce a final answer');
}

app.post('/v1/product-intel', async (req, res) => {
  const { url, dom, missingFields } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const cacheKey = cacheKeyFromUrl(url);
  if (selectorCache.has(cacheKey)) {
    console.log(`[product-intel] cache hit for ${cacheKey}`);
    return res.json({ source: 'cache', cacheKey, ...selectorCache.get(cacheKey) });
  }

  if (!dom) {
    return res.status(400).json({ error: 'dom is required when cache miss occurs' });
  }

  try {
    console.log(`[product-intel] cache miss for ${cacheKey}; invoking LLM`);
    const intel = await analyzeDomWithLLM({ url, dom, missingFields });
    const product = sanitizeProduct(intel.product || {}, url);
    const selectors = sanitizeSelectors(intel.selectors || {});
    const payload = { product, selectors, cachedAt: Date.now(), meta: intel.meta };
    selectorCache.set(cacheKey, payload);
    console.log(`[product-intel] stored selectors for ${cacheKey} (duration ${intel.meta?.durationMs || '?'}ms)`);
    res.json({ source: 'llm', cacheKey, ...payload });
  } catch (err) {
    console.error('[mock-api] product-intel failure', err);
    res.status(500).json({ error: err.message || 'LLM analysis failed' });
  }
});

app.post('/v1/search-suggestions', async (req, res) => {
  const { query, context, product, domSnippet, selectorHints } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }
  try {
    console.log(`[search-suggestions] query=${query} domBytes=${domSnippet ? domSnippet.length : 0}`);
    const items = await fetchSearchSuggestions({ query, context, product, domSnippet, selectorHints });
    res.json({ items });
  } catch (err) {
    console.error('[mock-api] search-suggestions failure', err);
    res.status(500).json({ error: err.message || 'Search failed' });
  }
});

app.get('/v1/affiliate-links', (req, res) => {
  const { url, title, sku, upc, brand } = req.query;
  const hasDeal = randomBool(0.75);
  const merchant = url ? new URL(url).hostname : 'merchant.test';
  const discount = hasDeal ? percent(10, 30) : null;
  const code = hasDeal ? `SAVE${discount}` : null;

  res.json({
    match: { url, title, sku, upc, brand, merchant },
    affiliate: hasDeal ? {
      url: `https://example-deals.test/track?to=${encodeURIComponent(url || 'https://store.test/product')}&discount=${discount}`,
      discountPercent: discount,
      couponCode: code,
      expiresAt: new Date(Date.now() + 7 * 864e5).toISOString()
    } : null
  });
});

app.get('/v1/similar', (req, res) => {
  if (!mockElementsEnabled) {
    return res.json({ items: [], mocked: false });
  }

  const { url, title } = req.query;
  const merchant = url ? new URL(url).hostname : 'merchant.test';
  const base = title || 'Sample Product';
  const items = Array.from({ length: 6 }).map((_, i) => {
    const discount = percent(5, 25);
    return {
      title: `${base} (Alt ${i + 1})`,
      merchant,
      image: 'https://picsum.photos/seed/' + encodeURIComponent(`${base}-${i}`) + '/64/64',
      url: `https://store.test/product/${i + 1}`,
      affiliateUrl: `https://example-deals.test/track?to=${encodeURIComponent(`https://store.test/product/${i + 1}`)}&discount=${discount}`,
      discountPercent: discount
    };
  });
  res.json({ items, mocked: true });
});

app.listen(PORT, () => {
  console.log(`Mock affiliate API listening on http://localhost:${PORT}`);
  if (!anthropic) {
    console.warn('[mock-api] No Anthropic API key detected. Remote DOM analysis endpoint will return 500 errors.');
  }
  if (!openrouter) {
    console.warn('[mock-api] No OpenRouter API key detected. Search suggestions endpoint will return 500 errors.');
  }
  if (!mockElementsEnabled) {
    console.log('[mock-api] Mocked elements disabled (ENABLE_MOCK_ELEMENTS=false). /v1/similar will return empty results.');
  }
});
