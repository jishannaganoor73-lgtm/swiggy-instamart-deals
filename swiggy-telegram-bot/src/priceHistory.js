const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const HISTORY_FILE = path.join(ROOT_DIR, 'price-history.json');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const MAX_OBSERVATIONS = 100;
const RETENTION_DAYS = 60;

// Treat same-price observations within this window as duplicates
// when they come from different campaigns.
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

// Ignore observations timestamped too far into the future.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadPriceHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const history = JSON.parse(
        fs.readFileSync(HISTORY_FILE, 'utf8')
      );

      if (
        history &&
        history.products &&
        typeof history.products === 'object'
      ) {
        return history;
      }
    }
  } catch (error) {
    console.warn(
      '[PriceHistory] Could not read history:',
      error.message
    );
  }

  return {
    version: 1,
    updatedAt: null,
    products: {}
  };
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getProductKey(item) {
  if (item.parentProductId) {
    return `pid:${item.parentProductId}`;
  }

  if (item.skuId) {
    return `sku:${item.skuId}`;
  }

  const normalized = normalizeName(item.name);

  return normalized ? `name:${normalized}` : '';
}

function getValidTimestamp(value) {
  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function isValidObservation(observation, now = Date.now()) {
  if (!observation) return false;

  const price = Number(observation.price);
  const timestamp = getValidTimestamp(observation.observedAt);

  if (!Number.isFinite(price) || price <= 0) {
    return false;
  }

  if (timestamp === null) {
    return false;
  }

  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  return (
    timestamp >= now - retentionMs &&
    timestamp <= now + FUTURE_TOLERANCE_MS
  );
}

/**
 * Remove exact duplicates and same-price observations that were
 * recorded by different campaigns within a short time window.
 *
 * Observations from separate scans are retained when they occur
 * outside the duplicate window.
 */
function deduplicateObservations(observations) {
  const sorted = [...observations].sort((a, b) => {
    return (
      Date.parse(a.observedAt) -
      Date.parse(b.observedAt)
    );
  });

  const result = [];
  const exactSeen = new Set();

  for (const observation of sorted) {
    const timestamp = Date.parse(observation.observedAt);
    const price = Number(observation.price);
    const campaignKey = observation.campaignKey || 'default';

    const exactKey = [
      timestamp,
      price,
      campaignKey
    ].join('|');

    // Protect against retries of the same artifact.
    if (exactSeen.has(exactKey)) {
      continue;
    }

    exactSeen.add(exactKey);

    // A product observed by multiple campaigns at the same price
    // within five minutes should count as one historical sample.
    const duplicateNearby = result.some((existing) => {
      const existingTimestamp = Date.parse(existing.observedAt);
      const existingPrice = Number(existing.price);

      return (
        existingPrice === price &&
        Math.abs(timestamp - existingTimestamp) <=
          DUPLICATE_WINDOW_MS
      );
    });

    if (!duplicateNearby) {
      result.push(observation);
    }
  }

  return result;
}

function getHistoricalPriceSignal(item) {
  const history = loadPriceHistory();
  const key = getProductKey(item);

  if (!key) return null;

  const product = history.products[key];

  if (!product || !Array.isArray(product.observations)) {
    return null;
  }

  const now = Date.now();
  const cutoff =
    now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const validObservations = product.observations.filter(
    (observation) => {
      const timestamp = getValidTimestamp(
        observation.observedAt
      );

      const price = Number(observation.price);

      return (
        timestamp !== null &&
        timestamp < now &&
        timestamp >= cutoff &&
        Number.isFinite(price) &&
        price > 1
      );
    }
  );

  // Require at least three historical observations.
  if (validObservations.length < 3) {
    return null;
  }

  // Prevent repeated campaign observations from inflating
  // the historical sample count.
  const observations = deduplicateObservations(
    validObservations
  );

  if (observations.length < 3) {
    return null;
  }

  const prices = observations
    .map((entry) => Number(entry.price))
    .sort((a, b) => a - b);

  // Calculate the median price.
  const middle = Math.floor(prices.length / 2);

  const median =
    prices.length % 2 === 0
      ? (prices[middle - 1] + prices[middle]) / 2
      : prices[middle];

  const currentPrice = Number(item.price);

  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return null;
  }

  const dropAmount = median - currentPrice;

  const dropPercent =
    median > 0
      ? (dropAmount / median) * 100
      : 0;

  // Preserve the existing historical-drop thresholds.
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

function recordPriceObservations(
  items,
  campaignKey = 'default'
) {
  ensureDirectory(DATA_DIR);

  const observedAt = new Date().toISOString();
  const observations = [];
  const seen = new Set();

  for (const item of items || []) {
    const price = Number(item.price);

    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }

    const key = getProductKey(item);

    if (!key) {
      continue;
    }

    // Deduplicate products within this campaign scan.
    if (seen.has(key)) {
      continue;
    }

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
      discount: Number.isFinite(discount)
        ? discount
        : null,
      campaignKey,
      observedAt
    });
  }

  const safeCampaign = String(campaignKey)
    .replace(/[^a-z0-9_-]/gi, '_');

  const outputFile = path.join(
    DATA_DIR,
    `price-observations-${safeCampaign}.json`
  );

  fs.writeFileSync(
    outputFile,
    JSON.stringify(observations, null, 2),
    'utf8'
  );

  console.log(
    `[PriceHistory] Recorded ${observations.length} observations for ${campaignKey}.`
  );

  return observations.length;
}

function mergeObservationFiles(inputDir = DATA_DIR) {
  const history = loadPriceHistory();

  const now = Date.now();

  const cutoff =
    now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  history.products = history.products || {};

  if (!fs.existsSync(inputDir)) {
    console.log(
      '[PriceHistory] No observation directory found.'
    );
    return;
  }

  const files = fs.readdirSync(inputDir).filter((file) =>
    /^price-observations-.*\.json$/.test(file)
  );

  let mergedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const fullPath = path.join(inputDir, file);

    try {
      const observations = JSON.parse(
        fs.readFileSync(fullPath, 'utf8')
      );

      if (!Array.isArray(observations)) {
        console.warn(
          `[PriceHistory] Skipping invalid observation file: ${file}`
        );
        continue;
      }

      for (const observation of observations) {
        if (!observation || !observation.key) {
          skippedCount++;
          continue;
        }

        if (!isValidObservation(observation, now)) {
          skippedCount++;
          continue;
        }

        const price = Number(observation.price);
        const timestamp = Date.parse(
          observation.observedAt
        );

        // Ensure the observation is within the allowed time range.
        if (
          !Number.isFinite(price) ||
          price <= 0 ||
          timestamp < cutoff ||
          timestamp > now + FUTURE_TOLERANCE_MS
        ) {
          skippedCount++;
          continue;
        }

        const key = observation.key;

        const product =
          history.products[key] || {
            name: observation.name,
            parentProductId:
              observation.parentProductId || null,
            skuId: observation.skuId || null,
            observations: []
          };

        product.name =
          observation.name || product.name;

        product.parentProductId =
          observation.parentProductId ||
          product.parentProductId ||
          null;

        product.skuId =
          observation.skuId ||
          product.skuId ||
          null;

        product.observations =
          Array.isArray(product.observations)
            ? product.observations
            : [];

        const candidate = {
          price,
          mrp: observation.mrp ?? null,
          discount: observation.discount ?? null,
          campaignKey:
            observation.campaignKey || 'default',
          observedAt: observation.observedAt
        };

        const candidateTime = Date.parse(
          candidate.observedAt
        );

        // First, avoid merging the exact same observation twice.
        const exactDuplicate =
          product.observations.some((entry) => {
            return (
              entry.observedAt === candidate.observedAt &&
              Number(entry.price) === candidate.price &&
              (entry.campaignKey || 'default') ===
                candidate.campaignKey
            );
          });

        if (exactDuplicate) {
          skippedCount++;
          history.products[key] = product;
          continue;
        }

        // Next, avoid counting the same price observed by
        // different campaigns within five minutes as another
        // independent historical sample.
        const nearbyDuplicate =
          product.observations.some((entry) => {
            const existingTime = Date.parse(
              entry.observedAt
            );

            return (
              Number(entry.price) === candidate.price &&
              Number.isFinite(existingTime) &&
              Math.abs(candidateTime - existingTime) <=
                DUPLICATE_WINDOW_MS
            );
          });

        if (!nearbyDuplicate) {
          product.observations.push(candidate);
          mergedCount++;
        } else {
          skippedCount++;
        }

        // Remove expired or invalid entries, deduplicate, sort,
        // and preserve the most recent 100 observations.
        product.observations = deduplicateObservations(
          product.observations.filter((entry) => {
            const entryTime = Date.parse(
              entry.observedAt
            );

            const entryPrice = Number(entry.price);

            return (
              Number.isFinite(entryTime) &&
              entryTime >= cutoff &&
              entryTime <= now &&
              Number.isFinite(entryPrice) &&
              entryPrice > 0
            );
          })
        )
          .sort(
            (a, b) =>
              Date.parse(a.observedAt) -
              Date.parse(b.observedAt)
          )
          .slice(-MAX_OBSERVATIONS);

        history.products[key] = product;
      }
    } catch (error) {
      console.warn(
        `[PriceHistory] Could not merge ${file}:`,
        error.message
      );
    }
  }

  history.version = history.version || 1;
  history.updatedAt = new Date().toISOString();

  ensureDirectory(path.dirname(HISTORY_FILE));

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2),
    'utf8'
  );

  console.log(
    `[PriceHistory] Merged ${mergedCount} new observations; ` +
    `skipped ${skippedCount} duplicates or invalid entries; ` +
    `tracking ${Object.keys(history.products).length} products.`
  );
}

module.exports = {
  loadPriceHistory,
  getHistoricalPriceSignal,
  recordPriceObservations,
  mergeObservationFiles
};
