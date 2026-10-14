/**
 * Health monitoring for the deal hunter.
 *
 * Tracks every campaign run and sends Telegram alerts when:
 *   - a worker keeps returning 0 items / erroring (FAILURE)
 *   - the Swiggy cookie looks expired or blocked (AUTH, alerted immediately)
 *   - Swiggy is rate limiting us (RATE_LIMIT)
 *   - scan coverage suddenly collapses (COVERAGE_DROP)
 *   - a previously failing worker works again (RECOVERED)
 *
 * State lives in data/health.json (inside the cached data directory).
 */

const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, '..', 'data', 'health.json');
const MAX_RECENT_COUNTS = 12;

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.workers) return parsed;
  } catch {
    // first run or unreadable file
  }
  return { workers: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    const tmp = `${HEALTH_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, HEALTH_FILE);
  } catch (error) {
    console.error('[Health] Could not save health state:', error.message);
  }
}

/**
 * Works out WHY a scan failed from the HTTP status counts of the scrape.
 */
function diagnose({ itemCount, error, stats }) {
  if (itemCount > 0) return null;

  if (stats && stats.total > 0) {
    const auth = (stats[401] || 0) + (stats[403] || 0);
    const rate = stats[429] || 0;
    const server = (stats[500] || 0) + (stats[502] || 0) + (stats[503] || 0) + (stats[504] || 0);
    const network = stats[0] || 0;
    const notFound = (stats[404] || 0) + (stats[410] || 0);

    if (notFound >= stats.total * 0.5) {
      return {
        code: 'ENDPOINT',
        text: 'The request URL returns 404/410 - the site changed its API. Re-import a fresh cURL request.'
      };
    }
    if (auth >= stats.total * 0.5) {
      return {
        code: 'AUTH',
        text: 'The site is rejecting requests (HTTP 401/403 or a bot-protection challenge). Your cookie has probably expired or this IP is blocked.'
      };
    }
    if (rate >= stats.total * 0.3) {
      return { code: 'RATE_LIMIT', text: 'The site is rate limiting requests (HTTP 429).' };
    }
    if (server >= stats.total * 0.5) {
      return { code: 'SERVER', text: 'The site is returning 5xx errors (busy or down).' };
    }
    if (network >= stats.total * 0.5) {
      return { code: 'NETWORK', text: 'Network errors while calling the site.' };
    }
  }

  if (error) return { code: 'ERROR', text: `Scraper error: ${error}` };

  return { code: 'EMPTY', text: 'Scan returned 0 products (store ID, cookie, endpoint or response format may have changed).' };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Records one campaign run. Returns the list of notifications to send.
 */
function recordRun(campaignKey, { itemCount = 0, error = null, stats = null, now = Date.now() } = {}) {
  const failThreshold = envInt('HEALTH_FAIL_THRESHOLD', 2);
  const cooldownMs = envInt('HEALTH_COOLDOWN_HOURS', 6) * 3600 * 1000;
  const dropRatio = (envInt('HEALTH_COVERAGE_DROP_PERCENT', 40)) / 100;

  const state = loadState();
  const w = state.workers[campaignKey] || {
    consecutiveFailures: 0,
    recentCounts: [],
    notifiedAt: 0,
    notifiedCode: null
  };

  const events = [];
  const reason = diagnose({ itemCount, error, stats });

  if (reason) {
    w.consecutiveFailures += 1;
    w.lastReason = reason.code;
    w.lastError = reason.text;

    const immediate = reason.code === 'AUTH';
    const dueByCount = w.consecutiveFailures >= failThreshold;
    const cooledDown = now - (w.notifiedAt || 0) >= cooldownMs;
    const codeChanged = w.notifiedCode !== reason.code;

    if ((immediate || dueByCount) && (cooledDown || codeChanged)) {
      events.push({
        type: 'FAILURE',
        code: reason.code,
        campaignKey,
        failures: w.consecutiveFailures,
        text: reason.text
      });
      w.notifiedAt = now;
      w.notifiedCode = reason.code;
    }
  } else {
    if (w.notifiedAt) {
      events.push({
        type: 'RECOVERED',
        campaignKey,
        text: `Scanning works again (${itemCount} products).`,
        failures: w.consecutiveFailures
      });
    }

    // coverage drop: fewer products than usual, but not zero
    const history = (w.recentCounts || []).filter((n) => n > 0);
    if (history.length >= 5) {
      const usual = median(history);
      if (usual > 0 && itemCount < usual * dropRatio) {
        const cooled = now - (w.coverageNotifiedAt || 0) >= cooldownMs;
        if (cooled) {
          events.push({
            type: 'COVERAGE_DROP',
            campaignKey,
            text: `Only ${itemCount} products scanned vs ~${Math.round(usual)} usual. Some aisles may be failing.`
          });
          w.coverageNotifiedAt = now;
        }
      }
    }

    w.consecutiveFailures = 0;
    w.lastReason = null;
    w.lastError = null;
    w.notifiedAt = 0;
    w.notifiedCode = null;
    w.lastSuccessAt = now;
  }

  w.lastRunAt = now;
  w.lastItemCount = itemCount;
  w.recentCounts = [...(w.recentCounts || []), itemCount].slice(-MAX_RECENT_COUNTS);

  state.workers[campaignKey] = w;
  saveState(state);

  return events;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatEvent(event) {
  const worker = escapeHtml(event.campaignKey);

  switch (event.type) {
    case 'FAILURE': {
      const isPlatform = ['blinkit', 'zepto', 'flipkart'].includes(event.campaignKey);
      const keyUpper = escapeHtml(String(event.campaignKey).toUpperCase());
      let hint = '';

      if (event.code === 'AUTH') {
        hint = isPlatform
          ? `\n\n👉 Cookies expired or the site blocks this IP. Re-run <code>npm run platform:import</code> with a fresh cURL and update the <code>${keyUpper}_EXTRA_HEADERS</code> secret. Datacenter IPs (GitHub Actions) are often blocked: set <code>${keyUpper}_PROXY</code> to a residential proxy.`
          : '\n\n👉 Refresh the <code>SWIGGY_COOKIE</code> secret (copy the Cookie header from swiggy.com/instamart in your browser).';
      } else if (event.code === 'ENDPOINT' || event.code === 'EMPTY') {
        hint = isPlatform
          ? '\n\n👉 Re-import a fresh cURL (<code>npm run platform:import</code>) and run <code>npm run probe</code> to check it parses.'
          : '';
      }
      return (
        `🛑 <b>Deal Hunter problem: ${worker}</b>\n` +
        `${escapeHtml(event.text)}\n` +
        `Failed runs in a row: <b>${event.failures}</b>${hint}`
      );
    }
    case 'COVERAGE_DROP':
      return `⚠️ <b>Low coverage: ${worker}</b>\n${escapeHtml(event.text)}`;
    case 'RECOVERED':
      return `✅ <b>Recovered: ${worker}</b>\n${escapeHtml(event.text)}`;
    default:
      return `ℹ️ ${worker}: ${escapeHtml(event.text)}`;
  }
}

async function notifyHealth(bot, events, fallbackChatId) {
  if (!bot || !events || events.length === 0) return;

  const chatId = process.env.HEALTH_CHAT_ID || fallbackChatId;
  if (!chatId) return;

  for (const event of events) {
    try {
      await bot.sendMessage(chatId, formatEvent(event), {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (error) {
      console.error('[Health] Failed to send health notification:', error.message);
    }
  }
}

module.exports = { recordRun, notifyHealth, diagnose, formatEvent };
