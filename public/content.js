(function initializeWikiMastersContentScript() {
  if (globalThis.__wikiMastersContentLoaded) return;
  globalThis.__wikiMastersContentLoaded = true;

const cardSelectors = [
  '[data-card-id]',
  '[data-card-number]',
  '[data-card]',
  'article[class*="card"]',
  '[class*="collection-card"]',
];
const apiBase = 'https://www.wiki-masters.com';
const collectionCacheKey = 'wikimasters-collection-cache-v3';
const biddingPriceCacheKey = 'wikimasters-bidding-prices-v1';

function isCollectionPage() {
  return window.location.pathname.toLowerCase().startsWith('/collection');
}

function isLoginPage() {
  return Boolean(document.querySelector('input[type="email"], input[type="password"]'));
}

function textFrom(element, selectors) {
  for (const selector of selectors) {
    const match = element.querySelector(selector);
    if (match?.textContent?.trim()) return match.textContent.trim();
  }
  return undefined;
}

function numberFrom(element, attributeNames, selectors) {
  for (const attributeName of attributeNames) {
    const value = element.getAttribute(attributeName);
    if (value) return value;
  }
  return textFrom(element, selectors);
}

function extractVisibleCards() {
  if (!isCollectionPage() || isLoginPage()) return [];

  const elements = Array.from(document.querySelectorAll(cardSelectors.join(', ')));
  const cards = elements.map((element) => ({
    id: element.getAttribute('data-card-id') || element.getAttribute('data-id') || undefined,
    name: element.getAttribute('data-card-name') || textFrom(element, ['[class*="name"]', 'h2', 'h3', 'h4']) || element.querySelector('img')?.alt || 'Carte WikiMasters',
    set: textFrom(element, ['[class*="set"]', '[class*="extension"]']),
    number: numberFrom(element, ['data-card-number', 'data-number'], ['[class*="number"]', '[class*="reference"]']),
    quantity: Number(element.getAttribute('data-quantity') || textFrom(element, ['[class*="quantity"]', '[class*="qty"]']) || '1'),
    wikimasterUrl: element instanceof HTMLAnchorElement ? element.href : window.location.href,
  }));

  return cards.filter((card, index, allCards) => allCards.findIndex((candidate) => `${candidate.name}|${candidate.number}` === `${card.name}|${card.number}`) === index);
}

function arrayFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  for (const key of ['items', 'cards', 'collection', 'auctions', 'selling', 'bidding', 'won', 'trades', 'listings', 'data', 'results']) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }
  return [];
}

function valueFrom(item, keys, visited = new Set()) {
  if (!item || typeof item !== 'object' || visited.has(item)) return undefined;
  visited.add(item);
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null) return item[key];
  }
  for (const value of Object.values(item)) {
    const nested = valueFrom(value, keys, visited);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function displayValue(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return String(value.name ?? value.title ?? value.label ?? value.value ?? fallback);
  return String(value);
}

function shapeOf(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return typeof value;
  if (Array.isArray(value)) return `array[${value.length}]`;
  return `{${Object.keys(value).join(', ')}}`;
}

function asNumber(value) {
  const number = Number(String(value ?? '').replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

async function fetchJson(path, diagnostics) {
  diagnostics.push(`GET ${path}`);
  const response = await fetch(`${apiBase}${path}`, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    diagnostics.push(`${path} -> HTTP ${response.status}`);
    throw new Error(`${path} -> HTTP ${response.status}`);
  }
  const payload = await response.json();
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).join(', ') : 'array';
  diagnostics.push(`${path} -> OK (${arrayFrom(payload).length} éléments; clés: ${keys || 'aucune'})`);
  return payload;
}

function normalizeApiCards(payload) {
  return arrayFrom(payload).map((item, index) => {
    const name = displayValue(valueFrom(item, ['name', 'title', 'cardName', 'card_name', 'displayName', 'display_name', 'label', 'nom', 'card_title', 'cardTitle', 'wiki_title', 'wikipedia_title', 'title_fr', 'fr_title']));
    if (!name) return null;
    const cardId = valueFrom(item, ['card_id', 'cardId']) ?? valueFrom(item?.card, ['id', 'card_id', 'cardId']) ?? valueFrom(item, ['id']) ?? `wiki-${index}`;
    return {
      id: String(cardId),
      cardId: String(cardId),
      name,
      set: displayValue(valueFrom(item, ['set', 'setName', 'set_name', 'extension', 'collection', 'set_title', 'setTitle', 'category']), ''),
      number: displayValue(valueFrom(item, ['number', 'cardNumber', 'card_number', 'collectorNumber', 'collector_number', 'card_number_display']), ''),
      rarity: displayValue(valueFrom(item, ['rarity', 'rarityName', 'rarity_name']), ''),
      qScore: asNumber(valueFrom(item, ['q_score', 'qScore'])),
      quantity: asNumber(valueFrom(item, ['quantity', 'count', 'amount'])) || 1,
      imageUrl: valueFrom(item, ['image', 'imageUrl', 'image_url', 'thumbnail', 'picture']),
      wikimasterUrl: valueFrom(item, ['url', 'link']) || `${apiBase}/collection`,
    };
  }).filter(Boolean);
}

async function fetchAllCollectionPages(diagnostics) {
  const pages = [];
  const seenIds = new Set();
  const pageSize = 50;
  for (let page = 0; ; page += 1) {
    const payload = await fetchJson(`/api/my-collection?sort=rarity&page=${page}&limit=${pageSize}&stats=0`, diagnostics);
    const items = arrayFrom(payload);
    const newItems = items.filter((item) => {
      const id = valueFrom(item, ['card_id', 'cardId', 'id']) ?? `${valueFrom(item, ['name', 'title'])}|${valueFrom(item, ['number', 'card_number'])}`;
      if (seenIds.has(String(id))) return false;
      seenIds.add(String(id));
      return true;
    });
    pages.push(...newItems);
    const total = asNumber(valueFrom(payload, ['total', 'total_count', 'totalCount'])) || 0;
    diagnostics.push(`Collection page ${page}: ${newItems.length} nouvelles cartes (${pages.length}${total ? `/${total}` : ''})`);
    if (!items.length || !newItems.length || (total > 0 && pages.length >= total) || items.length < pageSize) break;
  }

  try {
    localStorage.setItem(collectionCacheKey, JSON.stringify({ fetchedAt: Date.now(), items: pages }));
  } catch {
    // Continue normally when storage is full or unavailable.
  }
  return pages;
}

function readCollectionCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(collectionCacheKey) || 'null');
    return Array.isArray(cached?.items) ? cached : undefined;
  } catch {
    return undefined;
  }
}

function analyzeCollectionFromCache() {
  const cached = readCollectionCache();
  if (!cached) return undefined;
  const diagnostics = [`Cache collection chargé (${cached.items.length} cartes)`];
  return {
    cards: normalizeApiCards(cached.items),
    auctions: [],
    marketplaceOpportunities: [],
    stats: {},
    summary: {},
    source: 'local-cache',
    diagnostics,
    fetchedAt: new Date(cached.fetchedAt || Date.now()).toISOString(),
  };
}

function isWithinNextThirtyMinutes(value) {
  const endAt = new Date(value).getTime();
  const now = Date.now();
  return Number.isFinite(endAt) && endAt >= now && endAt <= now + 30 * 60 * 1000;
}

async function fetchMarketplacePages(diagnostics, maxPages = 10) {
  const auctions = [];
  let firstPayload = {};
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await fetchJson(`/api/marketplace?page=${page}&limit=50&sort=ending_soon&mine=1`, diagnostics);
    if (page === 1) firstPayload = payload;
    const pageAuctions = normalizeAuctions({ auctions: payload?.auctions });
    auctions.push(...pageAuctions);
    const lastEnd = pageAuctions.at(-1)?.auctionEndsIn;
    if (!pageAuctions.length || (lastEnd && new Date(lastEnd).getTime() > Date.now() + 30 * 60 * 1000)) break;
  }
  return { ...firstPayload, auctions };
}

function normalizeAuctions(payload, listing = false) {
  const items = payload?.auction ? [{ ...payload.auction, bids: payload.bids ?? payload.auction.bids }] : arrayFrom(payload);
  return items.map((item, index) => {
    const name = displayValue(valueFrom(item, ['name', 'title', 'cardName', 'card_name', 'displayName', 'display_name', 'label', 'nom', 'card_title', 'cardTitle', 'wiki_title', 'wikipedia_title', 'title_fr', 'fr_title']));
    if (!name) return null;
    const cardId = valueFrom(item, ['card_id', 'cardId']) ?? valueFrom(item?.card, ['id', 'card_id', 'cardId']);
    const bids = Array.isArray(item.bids) ? item.bids : [];
    const bidAmounts = bids.map((bid) => asNumber(bid?.amount)).filter((amount) => amount !== undefined);
    return {
      id: String(valueFrom(item, ['id', 'tradeId', 'listingId']) ?? `trade-${index}`),
      cardId: cardId ? String(cardId) : undefined,
      sellerId: valueFrom(item, ['seller_id', 'sellerId']),
      name,
      number: displayValue(valueFrom(item, ['number', 'cardNumber', 'card_number', 'collectorNumber', 'collector_number']), ''),
      rarity: displayValue(valueFrom(item, ['rarity', 'rarityName', 'rarity_name']), displayValue(valueFrom(item?.card, ['rarity', 'rarityName', 'rarity_name']), '')),
      auctionCount: bids.length || asNumber(valueFrom(item, ['auctionCount', 'bidCount', 'bid_count', 'offers'])) || 0,
      bidAmounts,
      currentBid: asNumber(valueFrom(item, ['currentBid', 'current_bid'])),
      currentBidderId: valueFrom(item, ['current_bidder_id', 'currentBidderId']) ?? valueFrom(item?.current_bidder, ['id']),
      highestBid: asNumber(valueFrom(item, ['highestBid', 'highest_bid', 'currentBid', 'current_bid', 'last_bid', 'effective_bid', 'price', 'amount'])),
      startingPrice: asNumber(valueFrom(item, ['startingPrice', 'starting_price', 'base_amount', 'minPrice', 'minimum_price'])),
      initialPrice: asNumber(valueFrom(item, ['listing_base_amount', 'base_amount', 'startingPrice', 'starting_price'])),
      purchasePrice: asNumber(valueFrom(item, ['final_price', 'finalPrice', 'effective_bid', 'current_bid', 'amount'])),
      qScore: asNumber(valueFrom(item, ['q_score', 'qScore'])),
      auctionEndsIn: String(valueFrom(item, ['endsIn', 'endingIn', 'endDate', 'end_date', 'end_at', 'expiresAt', 'expires_at']) ?? ''),
      status: String(valueFrom(item, ['status', 'state']) ?? 'active'),
      url: valueFrom(item, ['url', 'link', 'listingUrl']),
      imageUrl: valueFrom(item, ['image', 'imageUrl', 'image_url', 'thumbnail']),
      listing,
    };
  }).filter(Boolean);
}

async function enrichAuctionsWithBids(auctions, diagnostics) {
  return Promise.all(auctions.map(async (auction) => {
    try {
      const payload = await fetchJson(`/api/marketplace/${encodeURIComponent(auction.id)}`, diagnostics);
      const detailed = normalizeAuctions(payload, auction.listing)[0];
      return detailed ? { ...auction, ...detailed, owned: auction.owned } : auction;
    } catch {
      return auction;
    }
  }));
}

async function fetchAverageCardPrice(name, rarity, diagnostics) {
  if (!name) return { cardId: undefined, marketPrice: 0 };
  const lookupKey = `${name.trim().toLowerCase()}|${String(rarity || '').trim().toLowerCase()}`;
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(biddingPriceCacheKey) || '{}');
    const cached = cache[lookupKey];
    if (cached && Number.isFinite(Number(cached.marketPrice))) return cached;
  } catch {
    // Continue with the API when the cache is unavailable.
  }
  const cards = await fetchJson(`/api/cards?page=0&q=${encodeURIComponent(name)}&sort=rarity`, diagnostics);
  const match = normalizeApiCards(cards).find((card) => !rarity || card.rarity?.toLowerCase() === String(rarity).toLowerCase()) || normalizeApiCards(cards)[0];
  if (!match?.cardId) return { cardId: undefined, marketPrice: 0 };
  const sales = await fetchJson(`/api/marketplace/cards/${encodeURIComponent(match.cardId)}/sales?scope=summary`, diagnostics);
  const marketPrice = priceFromSalesSummary(sales, rarity || match.rarity);
  try {
    const result = { cardId: match.cardId, marketPrice };
    localStorage.setItem(biddingPriceCacheKey, JSON.stringify({ ...cache, [lookupKey]: result }));
  } catch {
    // Continue normally when storage is unavailable.
  }
  return { cardId: match.cardId, marketPrice };
}

function viewerIdFromMarketplace(payload) {
  const cacheKey = 'wikimasters-viewer-id-v1';
  const candidate = valueFrom(payload, ['viewer_id', 'viewerId', 'current_user_id', 'currentUserId', 'user_id', 'userId']) ?? payload?.selling?.[0]?.seller_id;
  if (candidate) {
    try { localStorage.setItem(cacheKey, String(candidate)); } catch { /* Ignore unavailable storage. */ }
    return String(candidate);
  }
  try { return localStorage.getItem(cacheKey) || undefined; } catch { return undefined; }
}

function markOutbid(auctions, viewerId) {
  return auctions.map((auction) => ({
    ...auction,
    outbid: Boolean(viewerId && auction.currentBidderId && String(auction.currentBidderId) !== String(viewerId)),
  }));
}

function priceFromSalesSummary(payload, rarity) {
  const summary = payload?.summary;
  const rarityPrice = summary && rarity ? asNumber(summary[rarity]?.average) : undefined;
  if (rarityPrice !== undefined && rarityPrice > 0) return rarityPrice;
  const firstAverage = summary && Object.values(summary).map((entry) => asNumber(entry?.average)).find((price) => price !== undefined && price > 0);
  if (firstAverage !== undefined) return firstAverage;
  const directPrice = valueFrom(payload, [
    'estimated_price', 'estimatedPrice', 'market_price', 'marketPrice',
    'average_price', 'averagePrice', 'median_price', 'medianPrice',
    'last_sale_price', 'lastSalePrice', 'sale_price', 'salePrice', 'price',
  ]);
  const parsedDirectPrice = asNumber(directPrice);
  if (parsedDirectPrice !== undefined && parsedDirectPrice > 0) return parsedDirectPrice;

  const sales = arrayFrom(payload).map((sale) => asNumber(valueFrom(sale, ['price', 'amount', 'sale_price', 'salePrice']))).filter((price) => price !== undefined && price > 0);
  return sales.length ? sales[0] : 0;
}

async function analyzeCollectionFromApi() {
  const diagnostics = [`Page active : ${window.location.href}`];
  let results;
  try {
    results = await Promise.all([
      fetchAllCollectionPages(diagnostics),
      fetchJson('/api/my-collection/stats?sort=rarity', diagnostics),
    ]);
  } catch {
    error.diagnostics = diagnostics;
    throw error;
  }
  const [collection, stats] = results;
  const cards = normalizeApiCards(collection);
  diagnostics.push(`Normalisation : ${cards.length} cartes`);
  const collectionItems = arrayFrom(collection);
  diagnostics.push(`Structure collection[0] : ${shapeOf(collectionItems[0])}`);
  return {
    cards,
    auctions: [],
    marketplaceOpportunities: [],
    stats,
    summary: {
      estimatedValue: asNumber(valueFrom(stats, ['estimatedValue', 'estimated_value', 'totalValue', 'total_value', 'value', 'wikibidous'])),
      potentialGain: asNumber(valueFrom(stats, ['potentialGain', 'potential_gain', 'profit', 'gain'])),
    },
    source: 'wikimasters-api',
    diagnostics,
    fetchedAt: new Date().toISOString(),
  };
}

async function analyzeMarketplaceFromApi() {
  const diagnostics = [`Page active : ${window.location.href}`];
  const [marketplace, marketplaceMine] = await Promise.all([
    fetchMarketplacePages(diagnostics),
    fetchJson('/api/marketplace/mine', diagnostics),
  ]);
  const marketplaceAuctions = normalizeAuctions({ auctions: marketplace.auctions });
  const marketplaceSelling = normalizeAuctions({ auctions: marketplace.selling || marketplaceMine?.selling }, true);
  const enrichedSelling = await enrichAuctionsWithBids(marketplaceSelling, diagnostics);
  return {
    auctions: enrichedSelling.map((auction) => ({ ...auction, owned: true })),
    marketplaceOpportunities: marketplaceAuctions.filter((auction) => isWithinNextThirtyMinutes(auction.auctionEndsIn)).map((auction) => ({ ...auction, marketOpportunity: true, owned: false })),
    diagnostics,
  };
}

async function analyzeSalesFromApi() {
  const diagnostics = [`Page active : ${window.location.href}`];
  const marketplace = await fetchJson('/api/marketplace?page=1&limit=50&sort=ending_soon&mine=1', diagnostics);
  const selling = normalizeAuctions({ auctions: marketplace?.selling }, true);
  const bidding = normalizeAuctions({ bidding: marketplace?.bidding });
  const won = normalizeAuctions({ auctions: marketplace?.won }, true);
  const enrichedSelling = await enrichAuctionsWithBids(selling, diagnostics);
  const enrichedBidding = await Promise.all((await enrichAuctionsWithBids(bidding, diagnostics)).map(async (auction) => {
    try {
      const price = await fetchAverageCardPrice(auction.name, auction.rarity, diagnostics);
      return { ...auction, cardId: price.cardId || auction.cardId, marketPrice: price.marketPrice };
    } catch {
      return auction;
    }
  }));
  return {
    auctions: enrichedSelling.map((auction) => ({ ...auction, owned: true })),
    bidding: markOutbid(enrichedBidding, viewerIdFromMarketplace(marketplace)).map((auction) => ({ ...auction, status: 'bidding', owned: false, bidding: true })),
    won: won.map((auction) => ({ ...auction, owned: true, listing: false, status: 'won' })),
    marketplaceOpportunities: [],
    diagnostics,
  };
}

async function placeBid(auctionId, amount) {
  const response = await fetch(`${apiBase}/api/marketplace/${encodeURIComponent(auctionId)}/bid`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Number(amount) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || payload?.error || `Enchère impossible (HTTP ${response.status})`);
  return payload;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_COLLECTION') {
    sendResponse({ isCollectionPage: isCollectionPage(), requiresLogin: isLoginPage(), cards: extractVisibleCards() });
  }
  if (message?.type === 'FETCH_CARD_PRICE') {
    const cardId = message.payload?.cardId;
    const rarity = message.payload?.rarity;
    if (!cardId) {
      sendResponse({ ok: false, error: 'Identifiant de carte manquant' });
      return false;
    }
    const path = `/api/marketplace/cards/${encodeURIComponent(cardId)}/sales?scope=summary`;
    fetchJson(path, []).then((payload) => sendResponse({ ok: true, cardId, marketPrice: priceFromSalesSummary(payload, rarity) })).catch((error) => sendResponse({ ok: false, cardId, error: error.message, marketPrice: 0 }));
    return true;
  }
  if (message?.type === 'PLACE_BID') {
    const { auctionId, amount } = message.payload || {};
    if (!auctionId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      sendResponse({ ok: false, error: 'Montant d’enchère invalide' });
      return false;
    }
    placeBid(auctionId, amount).then((bid) => sendResponse({ ok: true, bid })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'ANALYZE_MARKETPLACE_API') {
    analyzeMarketplaceFromApi().then((snapshot) => sendResponse({ ok: true, snapshot })).catch((error) => sendResponse({ ok: false, error: error.message, diagnostics: error.diagnostics || [] }));
    return true;
  }
  if (message?.type === 'ANALYZE_SALES_API') {
    analyzeSalesFromApi().then((snapshot) => sendResponse({ ok: true, snapshot })).catch((error) => sendResponse({ ok: false, error: error.message, diagnostics: error.diagnostics || [] }));
    return true;
  }
  if (message?.type === 'CREATE_AUCTION') {
    const { cardId, baseAmount, durationMinutes } = message.payload || {};
    if (!cardId || !Number.isFinite(Number(baseAmount)) || !Number.isFinite(Number(durationMinutes))) {
      sendResponse({ ok: false, error: 'Paramètres d’enchère invalides' });
      return false;
    }
    fetch(`${apiBase}/api/marketplace`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: cardId, base_amount: Number(baseAmount), duration_minutes: Number(durationMinutes) }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || payload?.error || `Création impossible (HTTP ${response.status})`);
      sendResponse({ ok: true, auction: payload });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'ANALYZE_WIKIMASTERS_API') {
    analyzeCollectionFromApi().then((snapshot) => sendResponse({ ok: true, snapshot })).catch((error) => sendResponse({ ok: false, error: error.message, diagnostics: error.diagnostics || [] }));
    return true;
  }
  if (message?.type === 'LOAD_COLLECTION_CACHE') {
    const snapshot = analyzeCollectionFromCache();
    sendResponse(snapshot ? { ok: true, snapshot } : { ok: false, error: 'Cache collection vide' });
  }
});

let collectionStatusTimer;

function stopCollectionStatusReporting() {
  if (collectionStatusTimer !== undefined) {
    window.clearInterval(collectionStatusTimer);
    collectionStatusTimer = undefined;
  }
}

function hasExtensionContext() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function reportCollectionStatus() {
  if (!isCollectionPage() || !hasExtensionContext()) {
    stopCollectionStatusReporting();
    return;
  }
  try {
    chrome.runtime.sendMessage({
      type: 'COLLECTION_STATUS',
      payload: { requiresLogin: isLoginPage(), cards: extractVisibleCards(), url: window.location.href },
    }).catch(() => stopCollectionStatusReporting());
  } catch {
    stopCollectionStatusReporting();
  }
}

if (isCollectionPage()) {
  reportCollectionStatus();
  collectionStatusTimer = window.setInterval(reportCollectionStatus, 2000);
  window.addEventListener('pagehide', stopCollectionStatusReporting, {once: true});
}
})();
