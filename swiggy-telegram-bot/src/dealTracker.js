const fs = require('fs');
const path = require('path');
const { getHistoricalPriceSignal } = require('./priceHistory');

function getCacheFilePath(campaignKey = 'default') {
  return path.join(
    __dirname,
    '..',
    'data',
    `deals_cache_${campaignKey}.json`
  );
}

function ensureDataDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadCache(campaignKey = 'default') {
  const filePath = getCacheFilePath(campaignKey);
  ensureDataDir(filePath);

  try {
    if (fs.existsSync(filePath)) {
      const cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      cache.items = cache.items || {};
      cache.lastRuns = cache.lastRuns || {};

      return cache;
    }
  } catch (error) {
    console.warn(
      `[DealTracker] Could not load cache for ${campaignKey}:`,
      error.message
    );
  }

  return {
    lastDate: null,
    lastRunId: null,
    lastRunHour: null,
    lastCycleId: null,
    lastDailyCycleId: null,
    lastWeeklyCycleId: null,
    items: {},
    lastRuns: {}
  };
}

function saveCache(cache, campaignKey = 'default') {
  const filePath = getCacheFilePath(campaignKey);
  ensureDataDir(filePath);

  try {
    const temporaryPath = `${filePath}.tmp`;

    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(cache, null, 2),
      'utf8'
    );

    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    console.error(
      `[DealTracker] Error saving cache for ${campaignKey}:`,
      error.message
    );
  }
}

function getIstWeekStart(istDate, resetDay = 1) {
  const day = istDate.getUTCDay();
  const diffDays = (day - resetDay + 7) % 7;

  return new Date(
    istDate.getTime() - diffDays * 86400000
  ).toISOString().slice(0, 10);
}

function getIstContext(
  overrideDate = null,
  overrideHour = null,
  refreshCycle = 'daily',
  resetDay = 1
) {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;

  let istDate;

  if (overrideDate) {
    const hour = overrideHour !== null
      ? String(overrideHour).padStart(2, '0')
      : '00';

    istDate = new Date(`${overrideDate}T${hour}:00:00.000Z`);
  } else {
    istDate = new Date(now.getTime() + istOffset);
  }

  const dateStr = overrideDate || istDate.toISOString().slice(0, 10);

  const hour = overrideHour !== null
    ? overrideHour
    : istDate.getUTCHours();

  const minuteSlot = istDate.getUTCMinutes() < 30 ? '00' : '30';

  const runId = `${dateStr}-${hour}:${minuteSlot}`;
  const dailyCycleId = `D-${dateStr}`;

  const weeklyCycleId = `W-${getIstWeekStart(
    istDate,
    resetDay
  )}`;

  return {
    dateStr,
    hour,
    runId,
    cycleId: refreshCycle === 'weekly'
      ? weeklyCycleId
      : dailyCycleId,
    dailyCycleId,
    weeklyCycleId,
    now: now.getTime()
  };
}

function normalizeProductName(name) {
  if (!name) return '';

  return name
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[-\s,]+(?:uk\s*\d+|\d+\s*uk)\b/gi, ' ')
    .replace(/[-\s,]+(?:xs|s|m|l|xl|xxl|xxxl)\b/gi, ' ')
    .replace(/\b\d+\s*w\b/gi, ' ')
    .replace(/\b\d+\s*pieces?\b/gi, ' ')
    .replace(/\b\d+k\b/gi, ' ')
    .replace(/[-_,\s]+/g, ' ')
    .trim();
}

function getCanonicalItemKey(item) {
  const pack = String(item.pack || '').trim().toLowerCase().replace(/\s+/g, '');

  // A real SKU id identifies one exact pack/variant (skuId falls back to the
  // product name when Swiggy gives none, so ignore that case).
  if (item.skuId && item.skuId !== item.name) {
    return `sku:${item.skuId}`;
  }

  // Never merge different pack sizes of the same parent product: their prices
  // differ and would otherwise look like endless "price drops".
  if (item.parentProductId) {
    return `pid:${item.parentProductId}|${pack}`;
  }

  const normalizedName = normalizeProductName(item.name);

  return normalizedName ? `name:${normalizedName}|${pack}` : '';
}

function getThreshold(item, minDiscount) {
  if (
    typeof minDiscount === 'number' &&
    Number.isFinite(minDiscount)
  ) {
    return minDiscount;
  }

  if (minDiscount && typeof minDiscount === 'object') {
    const value = item.dealType === 'essential'
      ? minDiscount.essentials
      : minDiscount.nonEssentials;

    if (value !== undefined && value !== '' &&
        Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return 70;
}

function getActualDiscount(price, mrp) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(mrp) ||
    price <= 0 ||
    mrp <= 0 ||
    price >= mrp
  ) {
    return 0;
  }

  return ((mrp - price) / mrp) * 100;
}

function getSpecialType(price, discount, mrp) {
  if (Number.isFinite(price) && price > 0 && price <= 1) {
    return 'ONE_RUPEE_DEAL';
  }

  if (
    !Number.isFinite(price) ||
    price <= 1 ||
    !Number.isFinite(mrp) ||
    mrp <= 0 ||
    price >= mrp
  ) {
    return null;
  }

  const actualDiscount = getActualDiscount(price, mrp);

  if (actualDiscount >= 90) {
    return 'POTENTIAL_PRICE_GLITCH';
  }

  if (actualDiscount >= 80) {
    return 'MAJOR_DISCOUNT';
  }

  return null;
}

// A repeat alert for the same product needs a REAL improvement, not noise.
const MIN_PRICE_IMPROVEMENT_RATIO = 0.90; // must be >= 10% cheaper than last alert

const ALERT_PRIORITY = {
  ONE_RUPEE_DEAL: 4,
  POTENTIAL_PRICE_GLITCH: 3,
  HISTORICAL_PRICE_DROP: 2,
  MAJOR_DISCOUNT: 1
};

// Products already alerted by any campaign in THIS process (e.g. `all` / `glitch`
// runs several campaigns back to back), so one product is never sent twice.
const alertedThisProcess = new Map();

function findAlertWorthyDeals(
  items,
  minDiscount = 70,
  campaignKey = 'default',
  options = {}
) {
  const cache = loadCache(campaignKey);
  const alertList = [];

  const refreshCycle = options.refreshCycle || 'daily';

  const resetDay = options.weeklyResetDay !== undefined
    ? options.weeklyResetDay
    : 1;

  const weeklyCategories = options.weeklyCategories || [];

  const {
    dateStr,
    hour,
    runId,
    cycleId,
    dailyCycleId,
    weeklyCycleId,
    now
  } = getIstContext(
    options.overrideDate,
    options.overrideHour,
    refreshCycle,
    resetDay
  );

  const seenInCurrentRun = new Map();
  const qualifyingKeys = new Set();

  const bestByKey = new Map();

  for (const candidate of items || []) {
    const key = getCanonicalItemKey(candidate);
    if (!key) continue;

    const candPrice = Number(candidate.price);
    const old = bestByKey.get(key);

    if (
      !old ||
      candPrice < Number(old.price) ||
      (candPrice === Number(old.price) &&
        Number(candidate.discount) > Number(old.discount))
    ) {
      bestByKey.set(key, candidate);
    }
  }

  for (const item of bestByKey.values()) {
    const price = Number(item.price);
    const mrp = Number(item.mrp);

    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(mrp) ||
      mrp <= 0
    ) {
      continue;
    }

    const itemKey = getCanonicalItemKey(item);

    if (!itemKey) continue;

    const actualDiscount = getActualDiscount(price, mrp);

    const specialType = getSpecialType(
      price,
      Number(item.discount),
      mrp
    );

    const validGenuineDiscount =
      price > 1 &&
      price < mrp;

    const discount = validGenuineDiscount
      ? actualDiscount
      : 0;

    const threshold = getThreshold(item, minDiscount);

    const historicalSignal =
      !specialType && validGenuineDiscount
        ? getHistoricalPriceSignal({
            ...item,
            price,
            mrp
          })
        : null;

    if (
      !specialType &&
      !historicalSignal &&
      (!validGenuineDiscount || actualDiscount < threshold)
    ) {
      continue;
    }

    qualifyingKeys.add(itemKey);

    // Avoid duplicate entries when the same product appears
    // multiple times in one worker's product list.
    if (seenInCurrentRun.has(itemKey)) {
      const existing = seenInCurrentRun.get(itemKey);

      if (price < existing.price) {
        existing.price = price;
        existing.mrp = mrp;
        existing.discount = discount;
      }

      continue;
    }

    const prev = cache.items[itemKey];

    const previousPrice = prev
      ? Number(prev.lastAlertedPrice)
      : NaN;

    const previousType = prev
      ? prev.lastAlertedType
      : null;

    const exceptionalType =
      specialType ||
      (historicalSignal && historicalSignal.alertType) ||
      null;

    let shouldAlert = false;
    let alertType = 'NEW_DEAL';

    if (!prev || !Number.isFinite(previousPrice)) {
      shouldAlert = true;
      alertType = exceptionalType || 'NEW_DEAL';
    } else {
      const priceIsLower = price < previousPrice;
      const priceIsSame = price === previousPrice;

      // Same price: never resend, unless it has become a MUCH rarer kind of
      // deal (e.g. ordinary discount -> price glitch / Rs 1).
      if (priceIsSame) {
        shouldAlert =
          (ALERT_PRIORITY[exceptionalType] || 0) >= 3 &&
          (ALERT_PRIORITY[exceptionalType] || 0) >
            (ALERT_PRIORITY[previousType] || 0);
      } else if (priceIsLower) {
        // Only a meaningful drop (>= 10% below the last ALERTED price) or a
        // fall to Rs 1 counts; tiny wobbles are ignored.
        shouldAlert =
          price <= previousPrice * MIN_PRICE_IMPROVEMENT_RATIO ||
          (specialType === 'ONE_RUPEE_DEAL' && previousPrice > 1);

        alertType = exceptionalType || 'PRICE_DROP';
      } else {
        // Higher prices should not trigger repeat deal alerts.
        shouldAlert = false;
      }

      if (shouldAlert && exceptionalType) {
        alertType = exceptionalType;
      }
    }

    // Remember that this product has now been alerted (even if another
    // campaign already sent it), so future runs do not repeat it.
    const recordAlert = shouldAlert;

    if (shouldAlert) {
      const sentPrice = alertedThisProcess.get(itemKey);

      if (sentPrice !== undefined && price >= sentPrice) {
        shouldAlert = false;
      } else {
        alertedThisProcess.set(itemKey, price);
      }
    }

    if (shouldAlert) {
      alertList.push({
        ...item,
        _itemKey: itemKey,
        _prevEntry: prev ? JSON.parse(JSON.stringify(prev)) : null,
        price,
        mrp,
        discount,
        alertType,
        prevPrice: Number.isFinite(previousPrice)
          ? previousPrice
          : undefined,
        historicalMedian: historicalSignal
          ? historicalSignal.historicalMedian
          : undefined,
        historicalDropPercent: historicalSignal
          ? historicalSignal.historicalDropPercent
          : undefined,
        campaignKey,
        dealType: item.dealType || campaignKey,
        searchQuery: item.searchQuery || ''
      });
    }

    cache.items[itemKey] = {
      ...(prev || {}),
      name: item.name,
      category: item.category || '',
      skuId: item.skuId || null,
      parentProductId: item.parentProductId || null,
      price,
      mrp,
      discount,
      lastAlertedPrice: recordAlert
        ? price
        : (prev ? prev.lastAlertedPrice : undefined),
      lastAlertedType: recordAlert
        ? alertType
        : (prev ? prev.lastAlertedType : undefined),
      lastAlertedAt: recordAlert
        ? now
        : (prev ? prev.lastAlertedAt : undefined),
      lastAlertedDate: recordAlert
        ? dateStr
        : (prev ? prev.lastAlertedDate : undefined),
      lastAlertedHour: recordAlert
        ? hour
        : (prev ? prev.lastAlertedHour : undefined),
      lastAlertedCycle: recordAlert
        ? cycleId
        : (prev ? prev.lastAlertedCycle : undefined),
      lastSeenRunId: runId,
      firstSeen: prev ? prev.firstSeen : now,
      lastSeen: now
    };

    seenInCurrentRun.set(itemKey, {
      price,
      mrp,
      discount
    });
  }

  const priority = ALERT_PRIORITY;

  alertList.sort((a, b) =>
    (priority[b.alertType] || 0) - (priority[a.alertType] || 0) ||
    Number(b.discount || 0) - Number(a.discount || 0)
  );

  const suppressedCount = Math.max(
    0,
    qualifyingKeys.size - alertList.length
  );

  console.log(
    `[DealTracker:${campaignKey}] ` +
    `Scanned: ${(items || []).length} | ` +
    `Qualified: ${qualifyingKeys.size} | ` +
    `Alerts: ${alertList.length} | ` +
    `Suppressed: ${suppressedCount}`
  );

  cache.lastDate = dateStr;
  cache.lastRunHour = hour;
  cache.lastRunId = runId;
  cache.lastCycleId = cycleId;
  cache.lastDailyCycleId = dailyCycleId;
  cache.lastWeeklyCycleId = weeklyCycleId;

  cache.lastRuns[runId] = {
    timestamp: now,
    cycleId,
    refreshCycle,
    totalItems: (items || []).length,
    alertsFound: alertList.length,
    suppressedCount
  };

  // Bound run-history growth.
  const runIds = Object.keys(cache.lastRuns);

  if (runIds.length > 200) {
    runIds
      .sort((a, b) =>
        Number(cache.lastRuns[a].timestamp || 0) -
        Number(cache.lastRuns[b].timestamp || 0)
      )
      .slice(0, runIds.length - 200)
      .forEach((id) => delete cache.lastRuns[id]);
  }

  saveCache(cache, campaignKey);

  return alertList;
}

/**
 * Undo the "already alerted" bookkeeping for alerts that could NOT be delivered
 * to Telegram, so the next run tries to send them again.
 */
function revertAlerts(alerts, campaignKey = 'default') {
  if (!Array.isArray(alerts) || alerts.length === 0) return;
  const cache = loadCache(campaignKey);

  for (const alert of alerts) {
    const key = alert._itemKey;
    if (!key) continue;
    alertedThisProcess.delete(key);

    if (alert._prevEntry) cache.items[key] = alert._prevEntry;
    else delete cache.items[key];
  }

  saveCache(cache, campaignKey);
  console.warn(`[DealTracker:${campaignKey}] Reverted ${alerts.length} undelivered alerts (will retry next run).`);
}

function getCachedDeals(campaignKey = 'default', minDiscount = 0) {
  const cache = loadCache(campaignKey);

  return Object.values(cache.items || {})
    .filter((item) => Number(item.discount) >= minDiscount)
    .sort((a, b) => Number(b.discount) - Number(a.discount));
}

module.exports = {
  loadCache,
  saveCache,
  findAlertWorthyDeals,
  getCachedDeals,
  revertAlerts,
  getIstContext
};
