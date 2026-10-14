const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return 'N/A';

  return number.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function getProductUrl(deal) {
  const fallback =
    `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(deal.name || '')}`;

  try {
    const parsed = new URL(deal.searchLink || deal.itemLink || fallback);

    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // Use the fallback if the supplied URL is invalid.
  }

  return fallback;
}

function getAlertLabel(deal) {
  switch (deal.alertType) {
    case 'ONE_RUPEE_DEAL':
      return '🔥 <b>₹1 DEAL</b>';

    case 'POTENTIAL_PRICE_GLITCH':
      return '🚨 <b>POTENTIAL PRICE GLITCH</b>';

    case 'HISTORICAL_PRICE_DROP':
      return '📉 <b>HISTORICAL PRICE DROP</b>';

    case 'MAJOR_DISCOUNT':
      return '🏷️ <b>MAJOR DISCOUNT</b>';

    case 'PRICE_DROP':
      return '💰 <b>PRICE DROP</b>';

    default:
      return '✨ <b>INSTAMART DEAL</b>';
  }
}

function formatCompactItem(deal, index = null) {
  const name = escapeHtml(deal.name || 'Unknown product');
  const price = Number(deal.price);
  const mrp = Number(deal.mrp);
  const discount = Number(deal.discount);

  const priceText = formatPrice(price);
  const hasMrp = Number.isFinite(mrp) && mrp > 0;
  const hasDiscount = Number.isFinite(discount);

  const savings =
    hasMrp && Number.isFinite(price) && mrp > price
      ? mrp - price
      : null;

  const prefix =
    index !== null
      ? `<b>${String(index).padStart(2, '0')}.</b> `
      : '';

  const lines = [
    `${prefix}${getAlertLabel(deal)}`,
    '',
    `🛍️ <b>${name}</b>`,
    '',
  ];

  if (hasMrp) {
    lines.push(`MRP: <s>₹${formatPrice(mrp)}</s>`);
  }

  lines.push(
    `💰 <b>₹${priceText}</b>${hasDiscount ? `  ·  ${Math.round(discount)}% OFF` : ''}`
  );

  if (savings !== null) {
    lines.push(`💸 You save <b>₹${formatPrice(savings)}</b>`);
  }

  if (
    deal.alertType === 'HISTORICAL_PRICE_DROP' &&
    Number.isFinite(Number(deal.historicalMedian))
  ) {
    lines.push(
      '',
      `📊 Historical median: ₹${formatPrice(deal.historicalMedian)}`,
      `📉 Below median by: ${Math.round(Number(deal.historicalDropPercent) || 0)}%`
    );
  }

  if (deal.platformLabel) {
    lines.push('', `🏬 <b>${escapeHtml(deal.platformLabel)}</b>`);
  }

  if (Number.isFinite(Number(deal.confidence))) {
    lines.push('', `🎯 Confidence: <b>${escapeHtml(deal.confidenceLevel || '')}</b> (${Math.round(deal.confidence)}%)`);
  }

  if (Array.isArray(deal.flags) && deal.flags.length > 0) {
    lines.push(`⚠️ ${deal.flags.map(escapeHtml).join(' · ')}`);
  }

  return lines.join('\n');
}

function formatDealMessage(deal) {
  return formatCompactItem(deal);
}

function getInlineKeyboard(deal) {
  return {
    inline_keyboard: [[
      {
        text: '🛒 View Deal',
        url: getProductUrl(deal),
      },
    ]],
  };
}

async function sendOneDeal(bot, chatId, deal, index = null, extra = {}) {
  const caption = formatCompactItem(deal, index);
  const options = {
    parse_mode: 'HTML',
    reply_markup: getInlineKeyboard(deal),
    ...extra,
  };

  if (deal.imageUrl) {
    try {
      return await bot.sendPhoto(chatId, deal.imageUrl, {
        ...options,
        caption,
      });
    } catch (error) {
      console.warn(
        '[Notifier] Photo send failed; using text fallback:',
        error.message
      );
    }
  }

  return bot.sendMessage(chatId, caption, {
    ...options,
    disable_web_page_preview: true,
  });
}

async function sendDealAlert(bot, chatId, deal) {
  if (!bot || !chatId || !deal) return;

  try {
    return await sendOneDeal(bot, chatId, deal);
  } catch (error) {
    console.error('[Notifier] Alert send failed:', error.message);
  }
}

const PRIORITY_TYPES = new Set(['ONE_RUPEE_DEAL', 'POTENTIAL_PRICE_GLITCH']);

function envFlag(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
}

function threadExtra(threadId) {
  const n = Number(threadId);
  return Number.isFinite(n) && n > 0 ? { message_thread_id: n } : {};
}

function isPriorityDeal(deal) {
  const minConfidence = Number(process.env.PRIORITY_MIN_CONFIDENCE) || 50;
  const confidence = Number.isFinite(Number(deal.confidence)) ? Number(deal.confidence) : 100;

  return PRIORITY_TYPES.has(deal.alertType) && confidence >= minConfidence;
}

function describeError(error) {
  const status = error?.response?.statusCode;
  const body = error?.response?.body;
  const desc = body && (body.description || (typeof body === 'string' ? body : JSON.stringify(body)));
  return [status ? `HTTP ${status}` : null, desc || error?.message || String(error)]
    .filter(Boolean)
    .join(' - ');
}

// Telegram rate limit (429) -> wait the requested time and retry once.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (error) {
    const wait = Number(error?.response?.body?.parameters?.retry_after);
    if (error?.response?.statusCode === 429 && Number.isFinite(wait) && wait > 0 && wait <= 60) {
      console.warn(`[Notifier] Rate limited by Telegram; retrying in ${wait}s...`);
      await sleep((wait + 1) * 1000);
      return fn();
    }
    throw error;
  }
}

/**
 * Sends one group of deals. Returns { sent: [deals], failed: [deals], headerError }.
 * Never throws, but NEVER hides failures either: callers decide what to do.
 */
async function sendGroup(bot, chatId, deals, { header, extra }) {
  const result = { sent: [], failed: [], headerError: null };
  if (deals.length === 0) return result;

  try {
    await withRetry(() => bot.sendMessage(chatId, header, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }));
  } catch (error) {
    result.headerError = describeError(error);
    console.error(`[Notifier] Header send to chat ${chatId} FAILED: ${result.headerError}`);
  }

  for (let i = 0; i < deals.length; i++) {
    try {
      await withRetry(() => sendOneDeal(bot, chatId, deals[i], i + 1, extra));
      result.sent.push(deals[i]);
    } catch (error) {
      result.failed.push(deals[i]);
      console.error(`[Notifier] Deal ${i + 1}/${deals.length} to chat ${chatId} FAILED: ${describeError(error)}`);
    }

    if (i < deals.length - 1) {
      await sleep(700);
    }
  }

  return result;
}

/**
 * Priority routing:
 *   - Rs 1 deals and price glitches (with enough confidence) go FIRST, with
 *     sound, to PRIORITY_CHAT_ID (+ optional PRIORITY_THREAD_ID topic).
 *   - Everything else goes to the normal chat, silently by default
 *     (QUIET_NORMAL_ALERTS=false to get sound for them too).
 */
async function sendBatchAlerts(bot, chatId, deals, options = {}) {
  const empty = { sent: [], failed: [] };
  if (!Array.isArray(deals) || deals.length === 0) return empty;
  if (!bot || !chatId) {
    console.error('[Notifier] Cannot send: Telegram bot/chat id not configured. Deals NOT delivered.');
    return { sent: [], failed: deals };
  }

  const workerInfo = options.workerInfo || 'INSTAMART DEALS';
  const timeString = options.timeString || '';

  const priorityChatId = options.priorityChatId || process.env.PRIORITY_CHAT_ID || chatId;
  const quiet = envFlag('QUIET_NORMAL_ALERTS', true);

  const priorityDeals = deals.filter(isPriorityDeal);
  const normalDeals = deals.filter((deal) => !isPriorityDeal(deal));

  const priorityHeader = [
    `🚨 <b>PRIORITY: ${escapeHtml(workerInfo)}</b>`,
    timeString ? `🕒 ${escapeHtml(timeString)}` : '',
    `<i>₹1 deals / price glitches — act fast!</i>`,
  ].filter(Boolean).join('\n');

  const normalHeader = [
    `✨ <b>${escapeHtml(workerInfo)}</b>`,
    timeString ? `🕒 ${escapeHtml(timeString)}` : '',
    `<i>Handpicked deals for you</i>`,
  ].filter(Boolean).join('\n');

  // Priority first, loud.
  const priorityResult = await sendGroup(bot, priorityChatId, priorityDeals, {
    header: priorityHeader,
    extra: {
      disable_notification: false,
      ...threadExtra(options.priorityThreadId || process.env.PRIORITY_THREAD_ID),
    },
  });

  // Then normal deals, quiet by default.
  const normalResult = await sendGroup(bot, chatId, normalDeals, {
    header: normalHeader,
    extra: {
      disable_notification: quiet,
      ...threadExtra(options.normalThreadId || process.env.NORMAL_THREAD_ID),
    },
  });

  const sent = [...priorityResult.sent, ...normalResult.sent];
  const failed = [...priorityResult.failed, ...normalResult.failed];
  console.log(`[Notifier] Delivered ${sent.length}/${deals.length} alerts to Telegram${failed.length ? ` (${failed.length} FAILED)` : ''}.`);

  return { sent, failed };
}

/**
 * Verifies the bot token and that the bot can post to the chat(s).
 * Returns { ok, problems: [string] }.
 */
async function verifyTelegram(bot, chatIds) {
  const problems = [];
  if (!bot) return { ok: false, problems: ['TELEGRAM_BOT_TOKEN is missing or still the placeholder.'] };

  try {
    const me = await bot.getMe();
    console.log(`[Telegram] Bot OK: @${me.username}`);
  } catch (error) {
    problems.push(`Bot token rejected by Telegram (getMe): ${describeError(error)}`);
    return { ok: false, problems };
  }

  const ids = [...new Set(chatIds.filter(Boolean).map(String))];
  if (ids.length === 0) problems.push('TELEGRAM_CHAT_ID is missing/empty.');

  for (const id of ids) {
    try {
      const chat = await bot.getChat(id);
      console.log(`[Telegram] Chat OK: ${id} (${chat.type}${chat.title ? ': ' + chat.title : ''})`);
    } catch (error) {
      problems.push(`Cannot reach chat ${id}: ${describeError(error)} (did you press START / add the bot to the group?)`);
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  formatCompactItem,
  formatDealMessage,
  sendDealAlert,
  sendBatchAlerts,
  verifyTelegram,
  describeError,
};
