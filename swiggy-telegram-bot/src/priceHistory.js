const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const HISTORY_FILE = path.join(ROOT_DIR, 'price-history.json');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MAX_OBSERVATIONS = 100;
const RETENTION_DAYS = 60;

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadPriceHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (history && history.products && typeof history.products === 'object') {
        return history;
      }
    }
  } catch (error) {
    console.warn('[PriceHistory] Could not read history:', error.message);
  }
  return { version: 1, updatedAt: null, products: {} };
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getProductKey(item) {
  if (item.parentProductId) return `pid:${item.parentProductId}`;
  if (item.skuId) return `sku:${item.skuId}`;
  const normalized = normalizeName(item.name);
  return normalized ? `name:${normalized}` : '';
}

function getHistoricalPriceSignal(item) {
  const history = loadPriceHistory();
  const key = getProductKey(item);
  const product = history.products[key];
  if (!product || !Array.isArray(product.observations)) return null;

  const now = Date.now();
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const observations = product.observations.filter((observation) => {
    const timestamp = Date.parse(observation.observedAt);
    const price = Number(observation.price);
    return Number.isFinite(timestamp) &&
      timestamp < now &&
      now - timestamp <= retentionMs &&
      Number.isFinite(price) &&
      price > 1;
  });

  if (observations.length < 3) return null;

  const prices = observations.map((entry) => Number(entry.price)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const currentPrice = Number(item.price);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  const dropAmount = median - currentPrice;
  const dropPercent = median > 0 ? (dropAmount / median) * 100 : 0;

  if (dropPercent >= 70 && dropAmount >= 50) {
    return {
      alertType: 'HISTORICAL_PRICE_DROP',
      historicalMedian: median,
      historicalLowest: prices[0],
      historicalObservations: observations.length,
      historicalDropPercent: Math.round(dropPercent)
    };
  }
  return null;
}

function recordPriceObservations(items, campaignKey = 'default') {
  ensureDirectory(DATA_DIR);
  const observedAt = new Date().toISOString();
  const observations = [];
  const seen = new Set();

  for (const item of items || []) {
    const price = Number(item.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    const key = getProductKey(item);
    if (!key || key === 'name:') continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const mrp = Number(item.mrp);
    const discount = Number(item.discount);
    observations.push({
      key,
      name: String(item.name || 'Unknown product'),
      parentProductId: item.parentProductId || null,
      skuId: item.skuId || null,
      price,
      mrp: Number.isFinite(mrp) ? mrp : null,
      discount: Number.isFinite(discount) ? discount : null,
      campaignKey,
      observedAt
    });
  }

  const safeCampaign = String(campaignKey).replace(/[^a-z0-9_-]/gi, '_');
  const outputFile = path.join(DATA_DIR, `price-observations-${safeCampaign}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(observations, null, 2), 'utf8');
  console.log(`[PriceHistory] Recorded ${observations.length} observations for ${campaignKey}.`);
  return observations.length;
}

function mergeObservationFiles(inputDir = DATA_DIR) {
  const history = loadPriceHistory();
  const now = Date.now();
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  history.products = history.products || {};

  if (!fs.existsSync(inputDir)) {
    console.log('[PriceHistory] No observation directory found.');
    return;
  }

  const files = fs.readdirSync(inputDir).filter((file) =>
    /^price-observations-.*\.json$/.test(file)
  );
  let mergedCount = 0;

  for (const file of files) {
    try {
      const observations = JSON.parse(fs.readFileSync(path.join(inputDir, file), 'utf8'));
      if (!Array.isArray(observations)) continue;

      for (const observation of observations) {
        if (!observation || !observation.key) continue;
        const price = Number(observation.price);
        const timestamp = Date.parse(observation.observedAt);

        if (!Number.isFinite(price) || price <= 0 ||
            !Number.isFinite(timestamp) || timestamp > now + 5 * 60 * 1000 ||
            timestamp < cutoff) continue;

        const product = history.products[observation.key] || {
          name: observation.name,
          parentProductId: observation.parentProductId || null,
          skuId: observation.skuId || null,
          observations: []
        };

        product.name = observation.name || product.name;
        product.parentProductId = observation.parentProductId || product.parentProductId;
        product.skuId = observation.skuId || product.skuId;
        product.observations = Array.isArray(product.observations) ? product.observations : [];

        // Idempotency: avoid duplicate entries if a merge job is retried.
        const duplicate = product.observations.some((entry) =>
          entry.observedAt === observation.observedAt &&
          Number(entry.price) === price &&
          entry.campaignKey === observation.campaignKey
        );

        if (!duplicate) {
          product.observations.push({
            price,
            mrp: observation.mrp ?? null,
            discount: observation.discount ?? null,
            campaignKey: observation.campaignKey || 'default',
            observedAt: observation.observedAt
          });
          mergedCount++;
        }

        product.observations = product.observations
          .filter((entry) => {
            const time = Date.parse(entry.observedAt);
            return Number.isFinite(time) && time >= cutoff && time <= now;
          })
          .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
          .slice(-MAX_OBSERVATIONS);

        history.products[observation.key] = product;
      }
    } catch (error) {
      console.warn(`[PriceHistory] Could not merge ${file}:`, error.message);
    }
  }

  history.updatedAt = new Date().toISOString();
  ensureDirectory(path.dirname(HISTORY_FILE));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  console.log(`[PriceHistory] Merged ${mergedCount} new observations for ${Object.keys(history.products).length} products.`);
}

module.exports = {
  loadPriceHistory,
  getHistoricalPriceSignal,
  recordPriceObservations,
  mergeObservationFiles
};
