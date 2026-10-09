const { mergeObservationFiles } = require('./priceHistory');

try {
  mergeObservationFiles();
  console.log('[HistoryMerge] Completed successfully.');
} catch (error) {
  console.error('[HistoryMerge] Failed:', error);
  process.exit(1);
}
