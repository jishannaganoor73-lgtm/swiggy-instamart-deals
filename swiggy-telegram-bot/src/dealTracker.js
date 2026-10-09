const fs = require('fs');
const path = require('path');
const { getHistoricalPriceSignal } = require('./priceHistory');

function getCacheFilePath(campaignKey = 'default') {
  return path.join(__dirname, '..', 'data', `deals_cache_${campaignKey}.json`);
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
  } catch (e) {
    console.warn(`[DealTracker] Could not load cache for ${campaignKey}:`, e.message);
  }
  return {
    lastDate: null, lastRunId: null, lastRunHour: null,
    lastCycleId: null, lastDailyCycleId: null, lastWeeklyCycleId: null,
    items: {}, lastRuns: {}
  };
}

function saveCache(cache, campaignKey = 'default') {
  const filePath = getCacheFilePath(campaignKey);
  ensureDataDir(filePath);
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error(`[DealTracker] Error saving cache for ${campaignKey}:`, e.message);
  }
}

function getIstWeekStart(istDate, resetDay = 1) {
  const day = istDate.getUTCDay();
  const diffDays = (day - resetDay + 7) % 7;
  return new Date(istDate.getTime() - diffDays * 86400000).toISOString().slice(0, 10);
}

function getIstContext(overrideDate = null, overrideHour = null, refreshCycle = 'daily', resetDay = 1) {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  let istDate;

  if (overrideDate) {
    const h = overrideHour !== null ? String(overrideHour).padStart(2, '0') : '00';
    istDate = new Date(`${overrideDate}T${h}:00:00.000Z`);
  } else {
    istDate = new Date(now.getTime() + istOffset);
  }

  const dateStr = overrideDate || istDate.toISOString().slice(0, 10);
  const hour = overrideHour !== null ? overrideHour : istDate.getUTCHours();
  const minuteSlot = istDate.getUTCMinutes() < 30 ? '00' : '30';
  const runId = `${dateStr}-${hour}:${minuteSlot}`;
  const dailyCycleId = `D-${dateStr}`;
  const weeklyCycleId = `W-${getIstWeekStart(istDate, resetDay)}`;

  return {
    dateStr, hour, runId,
    cycleId: refreshCycle === 'weekly' ? weeklyCycleId : dailyCycleId,
    dailyCycleId, weeklyCycleId, now: now.getTime()
  };
}

function normalizeProductName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
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
  if (item.parentProductId) return `pid:${item.parentProductId}`;
  const norm = normalizeProductName(item.name);
  if (norm) return `name:${norm}`;
  return String(item.skuId || item.name || '').trim().toLowerCase();
}

function getThreshold(item, minDiscount) {
  if (typeof minDiscount === 'number' && Number.isFinite(minDiscount)) return minDiscount;
  if (minDiscount && typeof minDiscount === 'object') {
    const value = item.dealType === 'essential' ? minDiscount.essentials : minDiscount.nonEssentials;
    if (Number.isFinite(Number(value)) && value !== '') return Number(value);
  }
  return 70;
}

function getSpecialType(price, discount) {
  if (price > 0 && price <= 1) return 'ONE_RUPEE_DEAL';
  if (discount >= 90) return 'POTENTIAL_PRICE_GLITCH';
  if (discount >= 80) return 'MAJOR_DISCOUNT';
  return null;
}

// Historical drops are unusual but may remain at the same price for multiple scans.
 // Avoid repeating the same historical alert more than once every 6 hours unless
 // the price improves by another 10% or more versus the last alerted price.
const HISTORICAL_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const HISTORICAL_REAL_IMPROVEMENT_RATIO = 0.90;

function findAlertWorthyDeals(items, minDiscount = 70, campaignKey = 'default', options = {}) {
  const cache = loadCache(campaignKey);
  const alertList = [];
  const refreshCycle = options.refreshCycle || 'daily';
  const resetDay = options.weeklyResetDay !== undefined ? options.weeklyResetDay : 1;
  const weeklyCategories = options.weeklyCategories || [];

  const { dateStr, hour, runId, cycleId, dailyCycleId, weeklyCycleId, now } =
    getIstContext(options.overrideDate, options.overrideHour, refreshCycle, resetDay);

  const isDailyFirstRun =
    cache.lastDailyCycleId !== dailyCycleId ||
    (!cache.lastDailyCycleId && cache.lastDate !== dateStr) ||
    ((hour === 9 || hour === 10) && (cache.lastRunHour === null || cache.lastRunHour < 9));

  const isWeeklyFirstRun =
    cache.lastWeeklyCycleId !== weeklyCycleId ||
    (!cache.lastWeeklyCycleId && cache.lastCycleId !== cycleId && refreshCycle === 'weekly');

  const seenInCurrentRun = new Map();
  const qualifyingKeys = new Set();

  for (const item of items || []) {
    const price = Number(item.price);
    const mrp = Number(item.mrp);
    const discount = Number(item.discount);

    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(discount)) continue;

    const threshold = getThreshold(item, minDiscount);
    const specialType = getSpecialType(price, discount);
    const historicalSignal = specialType ? null : getHistoricalPriceSignal(item);

    if (!specialType && !historicalSignal && discount < threshold) continue;

    const itemKey = getCanonicalItemKey(item);
    if (!itemKey) continue;
    qualifyingKeys.add(itemKey);

    if (seenInCurrentRun.has(itemKey)) {
      const existing = seenInCurrentRun.get(itemKey);
      if (price < existing.price) {
        Object.assign(existing, item, {
          price,
          mrp: Number.isFinite(mrp) ? mrp : existing.mrp,
          discount,
          alertType: specialType || (historicalSignal && historicalSignal.alertType) || existing.alertType
        });
      }
      continue;
    }

    const isItemWeekly = weeklyCategories.includes(item.category) || refreshCycle === 'weekly';
    const itemCycle = isItemWeekly ? 'weekly' : 'daily';
    const itemCycleId = isItemWeekly ? weeklyCycleId : dailyCycleId;
    const isFirstRunOfItemCycle = isItemWeekly ? isWeeklyFirstRun : isDailyFirstRun;
    const prev = cache.items[itemKey];

    const prevAlertedPrice = prev ? Number(prev.lastAlertedPrice ?? prev.price) : null;
    const prevAlertedDiscount = prev ? Number(prev.lastAlertedDiscount ?? prev.discount) : null;
    const prevAlertedType = prev ? (prev.lastAlertedType || null) : null;
    const alreadyAlertedInCycle = Boolean(prev && (
      prev.lastAlertedCycle === itemCycleId ||
      (!prev.lastAlertedCycle && itemCycle === 'daily' && prev.lastAlertedDate === dateStr)
    ));

    const priceChanged = prev && Number.isFinite(prevAlertedPrice) && price !== prevAlertedPrice;
    const discountChanged = prev && Number.isFinite(prevAlertedDiscount) && discount !== prevAlertedDiscount;

    let shouldAlert = false;
    let alertType = 'NEW_DEAL';
    const exceptionalType = specialType || (historicalSignal && historicalSignal.alertType);

    if (exceptionalType) {
      const sameExceptionalAlert = prevAlertedType === exceptionalType;
      if (exceptionalType === 'HISTORICAL_PRICE_DROP' && sameExceptionalAlert) {
        const lastAlertedAt = Number(prev && prev.lastAlertedAt) || 0;
        const cooldownExpired = !lastAlertedAt || (now - lastAlertedAt) >= HISTORICAL_ALERT_COOLDOWN_MS;
        const materiallyLower = Number.isFinite(prevAlertedPrice) &&
          price <= prevAlertedPrice * HISTORICAL_REAL_IMPROVEMENT_RATIO;
        shouldAlert = cooldownExpired || materiallyLower;
      } else {
        // Preserve existing behavior for ₹1 deals, glitches and major discounts.
        shouldAlert = !(sameExceptionalAlert && prevAlertedPrice === price);
      }
      if (shouldAlert) alertType = exceptionalType;
    } else if (isFirstRunOfItemCycle) {
      shouldAlert = true;
      alertType = prev ? (itemCycle === 'weekly' ? 'WEEKLY_REFRESH' : 'DAILY_DROP') : 'NEW_DEAL';
    } else if (!prev || !alreadyAlertedInCycle) {
      shouldAlert = true;
      alertType = 'NEW_DEAL';
    } else if (priceChanged || discountChanged) {
      shouldAlert = true;
      alertType = Number.isFinite(prevAlertedPrice) && price < prevAlertedPrice
        ? 'PRICE_DROP'
        : 'DISCOUNT_CHANGE';
    }

    const normalizedMrp = Number.isFinite(mrp) ? mrp : item.mrp;

    if (shouldAlert) {
      alertList.push({
        ...item,
        price,
        mrp: normalizedMrp,
        discount,
        alertType,
        prevPrice: prevAlertedPrice,
        prevDiscount: prevAlertedDiscount,
        historicalMedian: historicalSignal ? historicalSignal.historicalMedian : undefined,
        historicalDropPercent: historicalSignal ? historicalSignal.historicalDropPercent : undefined,
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
      mrp: normalizedMrp,
      discount,
      lastAlertedPrice: shouldAlert ? price : (prev ? prev.lastAlertedPrice : undefined),
      lastAlertedDiscount: shouldAlert ? discount : (prev ? prev.lastAlertedDiscount : undefined),
      lastAlertedType: shouldAlert ? alertType : (prev ? prev.lastAlertedType : undefined),
      lastAlertedAt: shouldAlert ? now : (prev ? prev.lastAlertedAt : undefined),
      lastAlertedDate: shouldAlert ? dateStr : (prev ? prev.lastAlertedDate : undefined),
      lastAlertedHour: shouldAlert ? hour : (prev ? prev.lastAlertedHour : undefined),
      lastAlertedCycle: shouldAlert ? itemCycleId : (prev ? prev.lastAlertedCycle : undefined),
      lastSeenRunId: runId,
      firstSeen: prev ? prev.firstSeen : now,
      lastSeen: now
    };

    seenInCurrentRun.set(itemKey, {
      ...item,
      price,
      mrp: normalizedMrp,
      discount,
      alertType: exceptionalType || alertType
    });
  }

  const priority = {
    ONE_RUPEE_DEAL: 4,
    POTENTIAL_PRICE_GLITCH: 3,
    HISTORICAL_PRICE_DROP: 2,
    MAJOR_DISCOUNT: 1
  };

  alertList.sort((a, b) =>
    (priority[b.alertType] || 0) - (priority[a.alertType] || 0) ||
    Number(b.discount || 0) - Number(a.discount || 0)
  );

  const totalMetCriteria = (items || []).filter((item) => {
    const price = Number(item.price);
    const discount = Number(item.discount);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(discount)) return false;
    return Boolean(getSpecialType(price, discount)) ||
      discount >= getThreshold(item, minDiscount) ||
      Boolean(getHistoricalPriceSignal(item));
  }).length;

  const suppressedCount = Math.max(0, qualifyingKeys.size - alertList.length);
  console.log(
    `[DealTracker:${campaignKey}] Total Scanned: ${(items || []).length} | ` +
    `Meets Criteria: ${totalMetCriteria} | Alerts: ${alertList.length} | ` +
    `Suppressed: ${suppressedCount} | Cycle: ${refreshCycle}/${cycleId}`
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
  saveCache(cache, campaignKey);
  return alertList;
}

function getCachedDeals(campaignKey = 'default', minDiscount = 0) {
  const cache = loadCache(campaignKey);
  return Object.values(cache.items || {})
    .filter((val) => Number(val.discount) >= minDiscount)
    .sort((a, b) => Number(b.discount) - Number(a.discount));
}

module.exports = {
  loadCache,
  saveCache,
  findAlertWorthyDeals,
  getCachedDeals,
  getIstContext
};
