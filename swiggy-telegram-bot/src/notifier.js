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

async function sendOneDeal(bot, chatId, deal, index = null) {
  const caption = formatCompactItem(deal, index);
  const options = {
    parse_mode: 'HTML',
    reply_markup: getInlineKeyboard(deal),
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

async function sendBatchAlerts(bot, chatId, deals, options = {}) {
  if (!bot || !chatId || !Array.isArray(deals) || deals.length === 0) {
    return;
  }

  const workerInfo = options.workerInfo || 'INSTAMART DEALS';
  const timeString = options.timeString || '';

  const header = [
    `✨ <b>${escapeHtml(workerInfo)}</b>`,
    timeString ? `🕒 ${escapeHtml(timeString)}` : '',
    `<i>Handpicked deals for you</i>`,
  ].filter(Boolean).join('\n');

  try {
    await bot.sendMessage(chatId, header, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.error('[Notifier] Header send failed:', error.message);
  }

  for (let i = 0; i < deals.length; i++) {
    try {
      await sendOneDeal(bot, chatId, deals[i], i + 1);
    } catch (error) {
      console.error(
        `[Notifier] Failed to send deal ${i + 1}:`,
        error.message
      );
    }

    if (i < deals.length - 1) {
      await sleep(700);
    }
  }
}

module.exports = {
  formatCompactItem,
  formatDealMessage,
  sendDealAlert,
  sendBatchAlerts,
};
