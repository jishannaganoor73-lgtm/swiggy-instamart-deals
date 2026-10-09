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

function getAlertLabel(deal) {
  switch (deal.alertType) {
    case 'ONE_RUPEE_DEAL':
      return '🔥 <b>₹1 DEAL</b>';

    case 'POTENTIAL_PRICE_GLITCH':
      return '🚨 <b>PRICE GLITCH</b>';

    case 'HISTORICAL_PRICE_DROP':
      return '📉 <b>HISTORICAL PRICE DROP</b>';

    case 'MAJOR_DISCOUNT':
      return '🏷️ <b>MAJOR DISCOUNT</b>';

    case 'PRICE_DROP':
      return '💰 <b>PRICE DROP</b>';

    default:
      return '🛍️ <b>DEAL ALERT</b>';
  }
}

function getProductUrl(deal) {
  const directUrl = deal.searchLink ||
    `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(
      deal.name || ''
    )}`;

  // Only allow HTTP(S) links in Telegram messages.
  try {
    const parsed = new URL(directUrl);

    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // Use the safe fallback below.
  }

  return `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(
    deal.name || ''
  )}`;
}

function formatCompactItem(deal, index = null) {
  const name = escapeHtml(deal.name || 'Unknown product');
  const url = escapeHtml(getProductUrl(deal));

  const price = Number(deal.price);
  const mrp = Number(deal.mrp);
  const discount = Number(deal.discount);

  const priceText = formatPrice(price);
  const mrpText = formatPrice(mrp);

  const discountText = Number.isFinite(discount)
    ? `${Math.round(discount)}% OFF`
    : 'Discount unavailable';

  const savings =
    Number.isFinite(mrp) &&
    Number.isFinite(price) &&
    mrp > price
      ? mrp - price
      : null;

  const savingsText =
    savings !== null
      ? `💸 You save <b>₹${formatPrice(savings)}</b>`
      : '';

  const numberPrefix =
    index !== null ? `<b>${String(index).padStart(2, '0')}.</b> ` : '';

  let historicalText = '';

  if (
    deal.alertType === 'HISTORICAL_PRICE_DROP' &&
    Number.isFinite(Number(deal.historicalMedian))
  ) {
    historicalText =
      `\n📊 Historical median: ₹${formatPrice(deal.historicalMedian)}` +
      `\n📉 Below median by: ${Math.round(
        Number(deal.historicalDropPercent) || 0
      )}%`;
  }

  const priceLine = Number.isFinite(mrp) && mrp > 0
    ? `MRP: <s>₹${mrpText}</s>\n`
    : '';

  return (
    `${numberPrefix}${getAlertLabel(deal)}\n\n` +
    `🛍️ <b>${name}</b>\n\n` +
    `${priceLine}` +
    `💰 <b>₹${priceText}</b>  ·  <b>${discountText}</b>\n` +
    (savingsText ? `${savingsText}\n` : '') +
    `${historicalText}\n` +
    `\n<a href="${url}">🛒 View Deal</a>`
  ).trim();
}

function formatDealMessage(deal) {
  return (
    `━━━━━━━━━━━━━━━━━━\n` +
    `${formatCompactItem(deal)}\n` +
    `━━━━━━━━━━━━━━━━━━`
  );
}

async function sendDealAlert(bot, chatId, deal) {
  const message = formatDealMessage(deal);

  return bot.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendBatchAlerts(bot, chatId, deals, options = {}) {
  if (
    !bot ||
    !chatId ||
    !Array.isArray(deals) ||
    deals.length === 0
  ) {
    return;
  }

  const workerInfo = options.workerInfo || 'INSTAMART DEALS';
  const timeString = options.timeString || '';

  const header =
    `✨ <b>${escapeHtml(workerInfo)}</b>\n` +
    (timeString ? `🕒 ${escapeHtml(timeString)}\n` : '') +
    `<i>Handpicked deals for you</i>\n\n`;

  const chunks = [];
  let current = header;
  let dealNumber = 0;

  for (const deal of deals) {
    dealNumber++;

    const itemText = `${formatCompactItem(deal, dealNumber)}\n\n`;

    // Keep messages safely below Telegram's message-size limit.
    if (current.length + itemText.length > 3500 && current !== header) {
      chunks.push(current.trim());
      current = header;
      dealNumber = 1;
    }

    current += `${formatCompactItem(deal, dealNumber)}\n\n`;
  }

  if (current.trim() !== header.trim()) {
    chunks.push(current.trim());
  }

  for (let i = 0; i < chunks.length; i++) {
    try {
      await bot.sendMessage(chatId, chunks[i], {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      console.error(
        '[Notifier] Telegram send failed:',
        error.message
      );
    }

    if (i < chunks.length - 1) {
      await sleep(1000);
    }
  }
}

module.exports = {
  formatCompactItem,
  formatDealMessage,
  sendDealAlert,
  sendBatchAlerts,
};
