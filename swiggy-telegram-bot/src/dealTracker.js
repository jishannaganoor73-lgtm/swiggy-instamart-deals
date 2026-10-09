const fs = require('fs');
const path = require('path');

function getCacheFilePath(campaignKey = 'default') {
  return path.join(__dirname, '..', 'data', `deals_cache_${campaignKey}.json`);
}

function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadCache(campaignKey = 'default') {
  const filePath = getCacheFilePath(campaignKey);
  ensureDataDir(filePath);

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.warn(
      `[DealTracker] Could not load cache for ${campaignKey}, starting fresh:`,
      e.message
    );
  }

  return {
    lastDate: null,
    lastRunId: null,
    lastRunHour: null,
    lastCycleId: null,
    items: {},
    lastRuns: {}
  };
}

function saveCache(cache, campaignKey = 'default') {
  const filePath = getCacheFilePath(campaignKey);
  ensureDataDir(filePath);

  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error(
      `[DealTracker] Error saving cache for ${campaignKey}:`,
      e.message
    );
  }
}

function getIstWeekStart(istDate, resetDay = 1) {
  const day = istDate.getUTCDay();
  const diffDays = (day - resetDay + 7) % 7;
  const start = new Date(istDate.getTime() - diffDays * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
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
    const h = overrideHour !== null
      ? String(overrideHour).padStart(2, '0')
      : '00';

    istDate = new Date(`${overrideDate}T${h}:00:00.000Z`);
  } else {
    istDate = new Date(now.getTime() + istOffset);
  }

  const dateStr = overrideDate || istDate.toISOString().slice(0, 10);
  const hour = overrideHour !== null ? overrideHour : istDate.getUTCHours();
  const minuteSlot = istDate.getUTCMinutes() < 30 ? '00' : '30';
  const runId = `${dateStr}-${hour}:${minuteSlot}`;

  const dailyCycleId = `D-${dateStr}`;
  const weekStartStr = getIstWeekStart(istDate, resetDay);
  const weeklyCycleId = `W-${weekStartStr}`;

  const cycleId = refreshCycle === 'weekly'
    ? weeklyCycleId
    : dailyCycleId;

  return {
    dateStr,
    hour,
    runId,
    cycleId,
    dailyCycleId,
    weeklyCycleId,
    now: now.getTime()
  };
}

function normalizeProductName(name) {
  if (!name) return '';

  let str = name.trim().toLowerCase();

  str = str.replace(/\([^)]*\)/g, ' ');
  str = str.replace(/[-\s,]+(?:uk\s*\d+|\d+\s*uk)\b/gi, ' ');
  str = str.replace(/[-\s,]+(?:xs|s|m|l|xl|xxl|xxxl)\b/gi, ' ');
  str = str.replace(/\b\d+\s*w\b/gi, ' ');
  str = str.replace(/\b\d+\s*piece(?:s)?\b/gi, ' ');
  str = str.replace(/\b\d+k\b/gi, ' ');
  str = str.replace(/[-_,\s]+/g, ' ').trim();

  return str;
}

function getCanonicalItemKey(item) {
  if (item.parentProductId) {
    return `pid:${item.parentProductId}`;
  }

  const norm = normalizeProductName(item.name);

  if (norm) {
    return `name:${norm}`;
  }

  return (item.name || '').trim().toLowerCase() || String(item.skuId || '');
}

/**
 * Special alert rules:
 * - ONE_RUPEE_DEAL: price > 0 and <= ₹1
 * - POTENTIAL_PRICE_GLITCH: discount >= 90%
 * - MAJOR_DISCOUNT: discount >= 80%
 *
 * Existing cycle-based duplicate suppression is preserved.
 */
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

  const isDailyFirstRun =
    cache.lastDailyCycleId !== dailyCycleId ||
    (!cache.lastDailyCycleId && cache.lastDate !== dateStr) ||
    ((hour === 9 || hour === 10) &&
      (cache.lastRunHour === null || cache.lastRunHour < 9));

  const isWeeklyFirstRun =
    cache.lastWeeklyCycleId !== weeklyCycleId ||
    (!cache.lastWeeklyCycleId &&
      cache.lastCycleId !== cycleId &&
      refreshCycle === 'weekly');

  const seenInCurrentRun = new Map();

  for (const item of items) {
    const price = Number(item.price);
    const mrp = Number(item.mrp);
    const discount = Number(item.discount);

    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }

    if (!Number.isFinite(discount)) {
      continue;
    }

    let threshold = 70;

    if (typeof minDiscount === 'object' && minDiscount !== null) {
      threshold = item.dealType === 'essential'
        ? (minDiscount.essentials || 70)
        : (minDiscount.nonEssentials || 70);
    } else if (typeof minDiscount === 'number') {
      threshold = minDiscount;
    }

    const isOneRupeeDeal = price <= 1;
    const isPotentialGlitch = discount >= 90;
    const isMajorDiscount = discount >= 80;

    // Special deals bypass the normal discount threshold.
    if (
      !isOneRupeeDeal &&
      !isPotentialGlitch &&
      !isMajorDiscount &&
      discount < threshold
    ) {
      continue;
    }

    let specialType = null;

    if (isOneRupeeDeal) {
      specialType = 'ONE_RUPEE_DEAL';
    } else if (isPotentialGlitch) {
      specialType = 'POTENTIAL_PRICE_GLITCH';
    } else if (isMajorDiscount) {
      specialType = 'MAJOR_DISCOUNT';
    }

    const itemKey = getCanonicalItemKey(item);

    if (!itemKey) {
      continue;
    }

    // Avoid duplicate product variants in the same batch.
    if (seenInCurrentRun.has(itemKey)) {
      const existingAlert = seenInCurrentRun.get(itemKey);

      if (price < existingAlert.price) {
        existingAlert.price = price;
        existingAlert.mrp = Number.isFinite(mrp) ? mrp : existingAlert.mrp;
        existingAlert.discount = discount;
        existingAlert.name = item.name;
        existingAlert.searchLink = item.searchLink;

        if (cache.items[itemKey]) {
          cache.items[itemKey].price = price;
          cache.items[itemKey].discount = discount;

          if (existingAlert.alertType) {
            cache.items[itemKey].lastAlertedPrice = price;
            cache.items[itemKey].lastAlertedDiscount = discount;
          }
        }
      }

      continue;
    }

    const isItemWeekly =
      (weeklyCategories && weeklyCategories.includes(item.category)) ||
      refreshCycle === 'weekly';

    const itemCycle = isItemWeekly ? 'weekly' : 'daily';
    const itemCycleId = isItemWeekly ? weeklyCycleId : dailyCycleId;
    const isFirstRunOfItemCycle = isItemWeekly
      ? isWeeklyFirstRun
      : isDailyFirstRun;

    const prev = cache.items[itemKey];

    const prevAlertedDisc = prev
      ? (prev.lastAlertedDiscount !== undefined
          ? prev.lastAlertedDiscount
          : prev.discount)
      : null;

    const prevAlertedPrice = prev
      ? (prev.lastAlertedPrice !== undefined
          ? prev.lastAlertedPrice
          : prev.price)
      : null;

    const isDiscountChange =
      prev &&
      prevAlertedDisc !== null &&
      discount !== prevAlertedDisc;

    const isPriceDrop = isDiscountChange && discount > prevAlertedDisc;

    const alreadyAlertedInCycle = prev && (
      (prev.lastAlertedCycle &&
        prev.lastAlertedCycle === itemCycleId) ||
      (!prev.lastAlertedCycle &&
        itemCycle === 'daily' &&
        prev.lastAlertedDate === dateStr)
    );

    let shouldAlert = false;
    let alertType = 'NEW_DEAL';

    if (isFirstRunOfItemCycle) {
      shouldAlert = true;
      alertType = prev
        ? (itemCycle === 'weekly' ? 'WEEKLY_REFRESH' : 'DAILY_DROP')
        : 'NEW_DEAL';
    } else if (!prev || !alreadyAlertedInCycle) {
      shouldAlert = true;
      alertType = 'NEW_DEAL';
    } else if (isDiscountChange) {
      shouldAlert = true;
      alertType = isPriceDrop ? 'PRICE_DROP' : 'DISCOUNT_CHANGE';
    }

    // Give special deals a distinct Telegram alert type.
    // The special label takes precedence over ordinary cycle labels.
    if (shouldAlert && specialType) {
      alertType = specialType;
    }

    if (shouldAlert) {
      const alertObj = {
        ...item,
        price,
        mrp: Number.isFinite(mrp) ? mrp : item.mrp,
        discount,
        alertType,
        prevPrice: prevAlertedPrice,
        prevDiscount: prev ? prevAlertedDisc : null,
        campaignKey,
        dealType: item.dealType || campaignKey,
        searchQuery: item.searchQuery || ''
      };

      alertList.push(alertObj);
      seenInCurrentRun.set(itemKey, alertObj);

      cache.items[itemKey] = {
        name: item.name,
        category: item.category || '',
        skuId: item.skuId || null,
        parentProductId: item.parentProductId || null,
        price,
        mrp: Number.isFinite(mrp) ? mrp : item.mrp,
        discount,
        lastAlertedPrice: price,
        lastAlertedDiscount: discount,
        lastAlertedDate: dateStr,
        lastAlertedHour: hour,
        lastAlertedCycle: itemCycleId,
        lastSeenRunId: runId,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now
      };
    } else {
      seenInCurrentRun.set(itemKey, { price });

      if (!cache.items[itemKey]) {
        cache.items[itemKey] = {
          name: item.name,
          category: item.category || '',
          skuId: item.skuId || null,
          parentProductId: item.parentProductId || null,
          price,
          mrp: Number.isFinite(mrp) ? mrp : item.mrp,
          discount,
          lastAlertedPrice: null,
          lastAlertedDiscount: null,
          lastAlertedDate: null,
          lastAlertedHour: null,
          lastAlertedCycle: null,
          lastSeenRunId: runId,
          firstSeen: now,
          lastSeen: now
        };
      } else {
        cache.items[itemKey].lastSeenRunId = runId;
        cache.items[itemKey].price = price;
        cache.items[itemKey].mrp = Number.isFinite(mrp)
          ? mrp
          : cache.items[itemKey].mrp;
        cache.items[itemKey].discount = discount;
        cache.items[itemKey].lastSeen = now;
      }
    }
  }

  // Highest discounts first; special deal types are handled by notifier.js.
  alertList.sort((a, b) => {
    const specialPriority = {
      ONE_RUPEE_DEAL: 3,
      POTENTIAL_PRICE_GLITCH: 2,
      MAJOR_DISCOUNT: 1
    };

    const priorityA = specialPriority[a.alertType] || 0;
    const priorityB = specialPriority[b.alertType] || 0;

    if (priorityA !== priorityB) {
      return priorityB - priorityA;
    }

    return b.discount - a.discount;
  });

  const totalMetCriteria = items.filter((item) => {
    const discount = Number(item.discount);
    const price = Number(item.price);

    return (
      (Number.isFinite(price) && price > 0 && price <= 1) ||
      (Number.isFinite(discount) &&
        (discount >= thresholdForSummary(minDiscount) ||
          discount >= 80))
    );
  }).length;

  const suppressedCount = Math.max(0, totalMetCriteria - alertList.length);

  console.log(
    `[DealTracker:${campaignKey}] Total Scanned: ${items.length} | ` +
    `Meets Criteria: ${totalMetCriteria} | Alerts Sent: ${alertList.length} | ` +
    `Suppressed Duplicates: ${suppressedCount} (Cycle: ${refreshCycle}/${cycleId})`
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
    totalItems: items.length,
    alertsFound: alertList.length,
    suppressedCount
  };

  saveCache(cache, campaignKey);

  return alertList;
}

function thresholdForSummary(minDiscount) {
  if (typeof minDiscount === 'number') {
    return minDiscount;
  }

  return 70;
}

function getCachedDeals(campaignKey = 'default', minDiscount = 0) {
  const cache = loadCache(campaignKey);
  const result = [];

  for (const [, val] of Object.entries(cache.items || {})) {
    if (val.discount >= minDiscount) {
      result.push(val);
    }
  }

  result.sort((a, b) => b.discount - a.discount);
  return result;
}

module.exports = {
  loadCache,
  saveCache,
  findAlertWorthyDeals,
  getCachedDeals,
  getIstContext
};
