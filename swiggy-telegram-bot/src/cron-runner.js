require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config.json');
const { fetchEssentialAisleDeals, fetchNoiceDeals, getLastScrapeStats } = require('./swiggyApi');
const { findAlertWorthyDeals } = require('./dealTracker');
const { sendBatchAlerts } = require('./notifier');
const { recordPriceObservations } = require('./priceHistory');
const { validateItems, filterAlerts } = require('./validator');
const { recordRun, notifyHealth } = require('./health');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const minDiscount = parseInt(process.env.MIN_DISCOUNT_PERCENT, 10) || config.minDiscount || 70;

const storeConfig = {
  sid: process.env.SWIGGY_STORE_ID || config.store?.sid || '',
  pid: process.env.SWIGGY_PRIMARY_STORE_ID || config.store?.pid || '',
  secid: process.env.SWIGGY_SECONDARY_STORE_ID || config.store?.secid || ''
};

if (!storeConfig.sid) {
  console.error('❌ FATAL: SWIGGY_STORE_ID is missing or empty!');
  console.error('   Please configure SWIGGY_STORE_ID in your GitHub Repository Secrets:');
  console.error('   👉 Settings → Secrets and variables → Actions → New repository secret');
  console.error('   • SWIGGY_STORE_ID = <your_dark_store_id>');
  console.error('   • SWIGGY_PRIMARY_STORE_ID = <your_dark_store_id>');
  console.error('   • SWIGGY_SECONDARY_STORE_ID = <secondary_id_or_same>');
  process.exit(1);
}

const args = process.argv.slice(2);
let mode = 'auto';
let skipSync = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--skip-sync') {
    skipSync = true;
  } else if (!arg.startsWith('--')) {
    mode = arg.toLowerCase();
  }
}

async function syncToHourMark(skip = false, targetBufferSecs = 30) {
  if (skip) {
    console.log('[Sync] Synchronization skipped via --skip-sync.');
    return;
  }

  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + istOffsetMs);
  const mins = istNow.getUTCMinutes();
  const secs = istNow.getUTCSeconds();
  const ms = istNow.getUTCMilliseconds();
  const isGitHubScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';

  if (isGitHubScheduled) {
    const delayMins = mins >= 30 ? mins - 30 : mins;
    if (delayMins > 15) {
      console.warn(`[Sync] ⚠️ GitHub Actions runner queue was delayed by ~${delayMins}m past the target slot (:01/:31).`);
      console.warn(`[Sync] Current time is ${String(istNow.getUTCHours()).padStart(2, '0')}:${String(mins).padStart(2, '0')} IST.`);
      console.warn('[Sync] Aborting stale scheduled run to avoid sending outdated deals.');
      process.exit(0);
    }
  }

  if (mins >= 55 && mins <= 59) {
    const minsLeft = 60 - mins;
    const msToWait = (minsLeft * 60000) - (secs * 1000) - ms + (targetBufferSecs * 1000);
    if (msToWait > 0 && msToWait <= 6 * 60 * 1000) {
      console.log(`[Sync] Runner woke up early at ${mins}:${String(secs).padStart(2, '0')} IST.`);
      console.log(`[Sync] Waiting ${(msToWait / 1000).toFixed(1)}s until :00:${String(targetBufferSecs).padStart(2, '0')} IST for fresh Swiggy hourly deals...`);
      await sleep(msToWait);
    }
  } else if (mins >= 25 && mins <= 29) {
    const minsLeft = 30 - mins;
    const msToWait = (minsLeft * 60000) - (secs * 1000) - ms + (targetBufferSecs * 1000);
    if (msToWait > 0 && msToWait <= 6 * 60 * 1000) {
      console.log(`[Sync] Runner woke up early at ${mins}:${String(secs).padStart(2, '0')} IST.`);
      console.log(`[Sync] Waiting ${(msToWait / 1000).toFixed(1)}s until :30:${String(targetBufferSecs).padStart(2, '0')} IST for fresh Swiggy deals...`);
      await sleep(msToWait);
    }
  } else {
    console.log(`[Sync] Running immediately at ${String(istNow.getUTCHours()).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')} IST.`);
  }
}

async function runSubcategoryCampaign(campaignKey, campaignCfg, options = {}) {
  const { bot, chatId, storeConfig, threshold, timeString } = options;
  const name = campaignCfg.name || campaignKey;
  const tag = campaignCfg.tag || '';
  const headerName = tag ? `${tag} ${name}` : name;
  const subcategories = campaignCfg.subcategories || [];

  console.log(`\n--- Running ${name} (${subcategories.length} Subcategories) ---`);

  let items = [];
  let attempts = 0;
  let lastError = null;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      console.log(`[${campaignKey}] Fetching deals for ${subcategories.length} aisles (attempt ${attempts}/${maxAttempts})...`);
      items = await fetchEssentialAisleDeals(storeConfig, {
        subcategories,
        campaignName: name,
        dealType: campaignKey
      });
      if (items && items.length > 0) {
        console.log(`[${campaignKey}] Scraped ${items.length} items across ${subcategories.length} aisles.`);
        break;
      } else {
        console.warn(`[${campaignKey}] Attempt ${attempts}/${maxAttempts}: Swiggy returned 0 items (server may be busy).`);
      }
    } catch (e) {
      lastError = e.message;
      console.error(`[${campaignKey}] Attempt ${attempts}/${maxAttempts} error:`, e.message);
    }
    if (attempts < maxAttempts) {
      const waitSecs = 75;
      console.log(`[${campaignKey}] ⏳ Swiggy busy/failed. Waiting ${waitSecs}s before retry ${attempts + 1}/${maxAttempts}...`);
      await sleep(waitSecs * 1000);
    }
  }

  // Health monitoring: record how this scan went (and alert if it keeps failing).
  try {
    const healthEvents = recordRun(campaignKey, {
      itemCount: (items || []).length,
      error: lastError,
      stats: getLastScrapeStats()
    });
    await notifyHealth(bot, healthEvents, chatId);
  } catch (error) {
    console.error(`[${campaignKey}] Health check failed:`, error.message);
  }

  // Drop invalid listings (bad MRP, price above MRP, zero price...) before anything else.
  items = validateItems(items, campaignKey);

  if (items.length > 0) {
    try {
      recordPriceObservations(items, campaignKey);
    } catch (error) {
      console.error(`[${campaignKey}] Price history recording failed:`, error.message);
    }

    const refreshCycle = campaignCfg.refreshCycle || 'daily';
    const weeklyResetDay = campaignCfg.weeklyResetDay !== undefined ? campaignCfg.weeklyResetDay : 1;
    const weeklyCategories = campaignCfg.weeklyCategories || config.weeklyCategories || ['Electronics and Appliances'];
    const alerts = filterAlerts(findAlertWorthyDeals(items, threshold, campaignKey, {
      refreshCycle,
      weeklyResetDay,
      weeklyCategories
    }), campaignKey);
    console.log(`[${campaignKey}] Found ${alerts.length} alert-worthy deals (Discount ≥ ${threshold}% | Cycle: ${refreshCycle}).`);
    if (bot && chatId && alerts.length > 0) {
      await sendBatchAlerts(bot, chatId, alerts, { timeString, workerInfo: headerName });
    } else if (!alerts.length) {
      console.log(`[${campaignKey}] No items met the minimum discount threshold (${threshold}%) this run.`);
    }
  } else {
    console.error(`[${campaignKey}] All retry attempts failed or returned 0 items.`);
  }
}

async function main() {
  console.log(`[CronRunner] Mode: ${mode.toUpperCase()} | Store: ${storeConfig.sid}`);
  await syncToHourMark(skipSync);

  let bot = null;
  if (token && token !== 'your_bot_token_here') {
    bot = new TelegramBot(token, { polling: false });
  } else {
    console.warn('[CronRunner] No TELEGRAM_BOT_TOKEN configured. Will scrape and cache without sending Telegram alerts.');
  }

  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  const istDay = istDate.getUTCDay();
  const istHours = istDate.getUTCHours();
  const istMinutes = istDate.getUTCMinutes();

  console.log(`[CronRunner] Active IST Time: ${istDate.toUTCString()} (Day: ${istDay}, Hour: ${istHours}:${String(istMinutes).padStart(2, '0')})`);

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const timeString = timeFormatter.format(new Date()) + ' IST';
  const isWithinHours = (istHours >= 9 && istHours <= 23) || (istHours === 0 && istMinutes <= 15);
  const isGitHubScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';

  if (isGitHubScheduled && !isWithinHours) {
    console.log(`[CronRunner] Outside active operating window (9:01 AM - 12:01 AM IST). Current time: ${istHours}:${String(istMinutes).padStart(2, '0')} IST. Exiting.`);
    process.exit(0);
  }

  let runFresh = false, runGrocery = false, runTreats = false;
  let runMunchies = false, runBeverages = false, runPersonal = false;
  let runLifestyle = false, runNoice = false;

  if (mode === 'fresh' || mode === 'produce') runFresh = true;
  else if (mode === 'grocery' || mode === 'staples') runGrocery = true;
  else if (mode === 'essentials' || mode === 'keywords' || mode === 'aisles') {
    runFresh = true; runGrocery = true;
  } else if (mode === 'treats' || mode === 'sweets') runTreats = true;
  else if (mode === 'munchies' || mode === 'snacks') runMunchies = true;
  else if (mode === 'lifestyle' || mode === 'home' || mode === 'electronics' || mode === 'baby') runLifestyle = true;
  else if (mode === 'beverages' || mode === 'drinks' || mode === 'juices') runBeverages = true;
  else if (mode === 'personal' || mode === 'personalcare') runPersonal = true;
  else if (mode === 'noice') runNoice = true;
  else if (mode === 'all' || mode === 'glitch') {
    // Full sweep: every category/aisle + NOICE store, ignoring the operating-hours window.
    runFresh = true; runGrocery = true; runTreats = true; runMunchies = true;
    runBeverages = true; runPersonal = true; runLifestyle = true; runNoice = true;
  } else if (isWithinHours) {
    runFresh = true; runGrocery = true; runTreats = true; runMunchies = true;
    runBeverages = true; runPersonal = true; runLifestyle = true;
  }

  const campaigns = config.campaigns || {};
  const glitchSweep = mode === 'glitch';
  const glitchThreshold = parseInt(process.env.GLITCH_MIN_DISCOUNT, 10) || 90;
  if (glitchSweep) {
    console.log(`[CronRunner] GLITCH sweep: all categories, alerting on ₹1 deals and >= ${glitchThreshold}% OFF.`);
  }

  if (runFresh) {
    const cfg = campaigns.fresh || campaigns.essentials || {};
    const threshold = glitchSweep ? glitchThreshold : parseInt(process.env.FRESH_MIN_DISCOUNT || process.env.ESSENTIALS_MIN_DISCOUNT, 10) || cfg.minDiscount || 60;
    await runSubcategoryCampaign('fresh', cfg, { bot, chatId, storeConfig, threshold, timeString });
  }
  if (runGrocery) {
    const cfg = campaigns.grocery || campaigns.essentials || {};
    const threshold = glitchSweep ? glitchThreshold : parseInt(process.env.GROCERY_MIN_DISCOUNT || process.env.ESSENTIALS_MIN_DISCOUNT, 10) || cfg.minDiscount || 60;
    await runSubcategoryCampaign('grocery', cfg, { bot, chatId, storeConfig, threshold, timeString });
  }
  if (runTreats) {
    const cfg = campaigns.treats || {};
    const threshold = glitchSweep ? glitchThreshold : parseInt(process.env.TREATS_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runSubcategoryCampaign('treats', cfg, { bot, chatId, storeConfig, threshold, timeString });
  }
  if (runMunchies) {
    const cfg = campaigns.munchies || campaigns.treats || {};
    const threshold = glitchSweep ? glitchThreshold : parseInt(process.env.MUNCHIES_MIN_DISCOUNT || process.env.TREATS_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runSubcategoryCampaign('munchies', cfg, { bot, chatId, storeConfig, threshold, timeString });
  }
  if (runBeverages) {
    const cfg = campaigns.beverages || {};
    const threshold = glitchSweep ? glitchThreshold : parseInt(process.env.BEVERAGES_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runSubcategoryCampaign('beverages', cfg, { bot, chatId, storeConfig, threshold, timeString });
  }
  if (runPersonal) {
    const cfg = campaigns.personalCare || campaigns.personal || {};
    const threshold = glitchSweep ? glitchThreshold : parseInt(process.env.PERSONAL_MIN_DISCOUNT, 10) || cfg.minDiscount || 70;
    await runSubcategoryCampaign('personalCare', cfg, { bot, chatId, storeConfig, threshold, timeString });
  }
  if (runLifestyle) {
    const cfg = campaigns.lifestyle || {};
    const threshold = glitchSweep ? glitchThreshold : parseInt(process.env.LIFESTYLE_MIN_DISCOUNT, 10) || cfg.minDiscount || 85;
    await runSubcategoryCampaign('lifestyle', cfg, { bot, chatId, storeConfig, threshold, timeString });
  }

  if (runNoice) {
    console.log('\n--- Running The NOICE Store Scan ---');
    const cfg = campaigns.noice || {};
    const noiceThreshold = glitchSweep ? glitchThreshold : parseInt(process.env.NOICE_MIN_DISCOUNT, 10) || cfg.minDiscount || minDiscount || 50;
    let noiceError = null;
    try {
      let items = [];
      try {
        items = await fetchNoiceDeals(storeConfig);
      } catch (e) {
        noiceError = e.message;
        console.error('[NOICE] Fetch error:', e.message);
      }
      console.log(`[NOICE] Scraped ${items.length} items.`);

      const noiceHealth = recordRun('noice', {
        itemCount: items.length,
        error: noiceError,
        stats: getLastScrapeStats()
      });
      await notifyHealth(bot, noiceHealth, chatId);

      items = validateItems(items, 'noice');
      try {
        recordPriceObservations(items, 'noice');
      } catch (error) {
        console.error('[NOICE] Price history recording failed:', error.message);
      }
      const alerts = filterAlerts(findAlertWorthyDeals(items, noiceThreshold, 'noice', {
        refreshCycle: cfg.refreshCycle || 'weekly',
        weeklyResetDay: cfg.weeklyResetDay !== undefined ? cfg.weeklyResetDay : 1
      }), 'noice');
      console.log(`[NOICE] Found ${alerts.length} new/improved deals >= ${noiceThreshold}%.`);
      if (bot && chatId && alerts.length > 0) {
        await sendBatchAlerts(bot, chatId, alerts, { timeString, workerInfo: '✨ The NOICE Store' });
      }
    } catch (e) {
      console.error('[NOICE] Error:', e.message);
    }
  }

  console.log('\n[CronRunner] Execution finished successfully.');
}

main().catch((err) => {
  console.error('[CronRunner] Fatal error:', err);
  process.exit(1);
});
