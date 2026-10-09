const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getAlertLabel(deal) {
  switch (deal.alertType) {
    case 'ONE_RUPEE_DEAL':
      return '🔥 <b>₹1 DEAL ALERT</b>';
    case 'POTENTIAL_PRICE_GLITCH':
      return '🚨 <b>POTENTIAL PRICE GLITCH</b>';
    case 'HISTORICAL_PRICE_DROP':
      return '📉 <b>UNUSUAL HISTORICAL PRICE DROP</b>';
    case 'MAJOR_DISCOUNT':
      return '📉 <b>MAJOR DISCOUNT</b>';
    case 'PRICE_DROP':
      return '💰 <b>PRICE DROP</b>';
    default:
      return '🛍️ <b>DEAL</b>';
  }
}

function formatCompactItem(deal, index = null) {
  const directUrl = deal.searchLink ||
    `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(deal.name || '')}`;
  const safeUrl = escapeHtml(directUrl);
  const num = index !== null ? `${index}. ` : '• ';
  const price = Number(deal.price);
  const mrp = Number(deal.mrp);
  const discount = Number(deal.discount);
  const priceText = Number.isFinite(price) ? price.toFixed(2).replace(/\.00$/, '') : 'N/A';
  const mrpText = Number.isFinite(mrp) ? mrp.toFixed(2).replace(/\.00$/, '') : 'N/A';
  const discountText = Number.isFinite(discount) ? `${discount}% OFF` : 'Discount unavailable';

  let historicalText = '';
  if (deal.alertType === 'HISTORICAL_PRICE_DROP' &&
      Number.isFinite(Number(deal.historicalMedian))) {
    historicalText =
      `\nHistorical median: ₹${Number(deal.historicalMedian).toFixed(2).replace(/\.00$/, '')}` +
      ` | Drop: ${Number(deal.historicalDropPercent) || 0}%`;
  }

  return `${num}${getAlertLabel(deal)}\n<b>${escapeHtml(deal.name || 'Unknown product')}</b>\nMRP: ₹${mrpText} | Price: ₹${priceText} | <b>${discountText}</b>${historicalText}\n<a href="${safeUrl}">View product</a>`;
}

function formatDealMessage(deal) {
  return formatCompactItem(deal);
}

async function sendDealAlert(bot, chatId, deal) {
  const message = formatDealMessage(deal);
  return bot.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

async function sendBatchAlerts(bot, chatId, deals, options = {}) {
  if (!bot || !chatId || !Array.isArray(deals) || deals.length === 0) return;

  const workerInfo = options.workerInfo || 'Instamart Deals';
  const timeString = options.timeString || '';
  const header = `<b>${escapeHtml(workerInfo)}</b>${timeString ? `\n${escapeHtml(timeString)}` : ''}\n\n`;
  const chunks = [];
  let current = header;

  for (const deal of deals) {
    const itemText = `${formatCompactItem(deal)}\n\n`;
    if (current.length + itemText.length > 3800 && current !== header) {
      chunks.push(current.trim());
      current = header;
    }
    current += itemText;
  }
  if (current.trim() !== header.trim()) chunks.push(current.trim());

  for (let i = 0; i < chunks.length; i++) {
    try {
      await bot.sendMessage(chatId, chunks[i], {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (error) {
      console.error('[Notifier] Telegram send failed:', error.message);
    }
    if (i < chunks.length - 1) await sleep(1000);
  }
}

module.exports = {
  formatCompactItem,
  formatDealMessage,
  sendDealAlert,
  sendBatchAlerts
};
