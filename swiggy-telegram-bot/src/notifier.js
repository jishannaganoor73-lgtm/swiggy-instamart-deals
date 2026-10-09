const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    case 'MAJOR_DISCOUNT':
      return '📉 <b>MAJOR DISCOUNT</b>';

    case 'PRICE_DROP':
      return '💰 <b>PRICE DROP</b>';

    default:
      return '🛍️ <b>DEAL</b>';
  }
}

/**
 * Format one deal with its alert category.
 */
function formatCompactItem(deal, index = null) {
  const directUrl = deal.searchLink ||
    `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(deal.name || '')}`;

  // Escape HTML-sensitive characters in the URL as well.
  const safeUrl = escapeHtml(directUrl);
  const num = index !== null ? `${index}. ` : '• ';
  const price = Number(deal.price);
  const mrp = Number(deal.mrp);
  const discount = Number(deal.discount);

  const priceText = Number.isFinite(price) ? price.toFixed(2).replace(/\.00$/, '') : 'N/A';
  const mrpText = Number.isFinite(mrp) ? mrp.toFixed(2).replace(/\.00$/, '') : 'N/A';
  const discountText = Number.isFinite(discount) ? `${discount}% OFF` : 'Discount unavailable';

  return (
    `${num}${getAlertLabel(deal)}\n` +
    `<b>${escapeHtml(deal.name || 'Unknown product')}</b>\n` +
    `MRP: ₹${mrpText} | Price: ₹${priceText} | <b>${discountText}</b>\n` +
    `<a href="${safeUrl}">View product</a>`
  );
}

function formatDealMessage(deal) {
  return formatCompactItem(deal);
}

async function sendDealAlert(bot, chatId, deal) {
  const text = formatCompactItem(deal);

  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return true;
  } catch (err) {
    console.error('[Notifier] Failed to send alert for:', deal.name, err.message);
    return false;
  }
}

/**
 * Send consolidated deal alerts, respecting Telegram's message length limit.
 */
async function sendBatchAlerts(bot, chatId, deals, options = {}) {
  if (!deals || !deals.length) return;

  console.log(
    `[Notifier] Sending ${deals.length} deals in consolidated message(s) to chat ${chatId}…`
  );

  const timeTag = options.timeString
    ? ` • ${escapeHtml(options.timeString)}`
    : '';

  const headerTag = options.workerInfo
    ? `<b>[${escapeHtml(options.workerInfo)} • ${deals.length} Found${timeTag}]</b>\n\n`
    : `<b>[Instamart Deals • ${deals.length} Found${timeTag}]</b>\n\n`;

  const messages = [];
  let currentMsg = headerTag;

  for (let i = 0; i < deals.length; i++) {
    const itemText = formatCompactItem(deals[i], i + 1) + '\n\n';

    if ((currentMsg + itemText).length > 3800) {
      if (currentMsg.trim()) {
        messages.push(currentMsg.trim());
      }
      currentMsg = itemText;
    } else {
      currentMsg += itemText;
    }
  }

  if (currentMsg.trim()) {
    messages.push(currentMsg.trim());
  }

  for (let i = 0; i < messages.length; i++) {
    try {
      await bot.sendMessage(chatId, messages[i], {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (err) {
      console.error('[Notifier] Failed to send batch message:', err.message);
    }

    if (i < messages.length - 1) {
      await sleep(1000);
    }
  }
}

module.exports = {
  formatCompactItem,
  formatDealMessage,
  sendDealAlert,
  sendBatchAlerts
};
