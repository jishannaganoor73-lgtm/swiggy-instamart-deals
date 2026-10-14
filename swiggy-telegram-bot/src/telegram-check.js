// Usage: node src/telegram-check.js   -> sends a real test message and prints the exact Telegram error if any.
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { verifyTelegram, describeError } = require('./notifier');

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const bot = token && token !== 'your_bot_token_here' ? new TelegramBot(token, { polling: false }) : null;
  const res = await verifyTelegram(bot, [chatId, process.env.PRIORITY_CHAT_ID, process.env.HEALTH_CHAT_ID]);
  res.problems.forEach((p) => console.error('❌', p));
  if (!res.ok) process.exit(1);
  try {
    await bot.sendMessage(chatId, '✅ Swiggy Deal Hunter: Telegram connection test OK.');
    console.log('✅ Test message sent.');
  } catch (e) {
    console.error('❌ sendMessage failed:', describeError(e));
    process.exit(1);
  }
})();
