function getHistoricalPriceSignal(item) {
  const currentPrice = Number(item && item.price);
  const currentMrp = Number(item && item.mrp);

  // Only consider genuine discounts against a valid MRP.
  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 1 ||
    !Number.isFinite(currentMrp) ||
    currentMrp <= 0 ||
    currentPrice >= currentMrp
  ) {
    return null;
  }

  const history = loadPriceHistory();
  const key = getProductKey(item);

  if (!key) return null;

  const product = history.products[key];

  if (!product || !Array.isArray(product.observations)) {
    return null;
  }

  const now = Date.now();
  const cutoff =
    now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Keep only valid, recent historical observations.
  const validObservations = product.observations.filter(
    (observation) => {
      const timestamp = getValidTimestamp(
        observation && observation.observedAt
      );

      const price = Number(observation && observation.price);
      const mrp = Number(observation && observation.mrp);

      if (
        timestamp === null ||
        timestamp >= now ||
        timestamp < cutoff ||
        !Number.isFinite(price) ||
        price <= 1
      ) {
        return false;
      }

      // Reject historical prices above their own valid MRP.
      if (
        Number.isFinite(mrp) &&
        mrp > 0 &&
        price > mrp
      ) {
        return false;
      }

      return true;
    }
  );

  // Require at least three distinct historical observations.
  const observations =
    deduplicateObservations(validObservations);

  if (observations.length < 3) return null;

  const prices = observations
    .map((entry) => Number(entry.price))
    .filter(
      (price) => Number.isFinite(price) && price > 1
    )
    .sort((a, b) => a - b);

  if (prices.length < 3) return null;

  function medianOf(values) {
    const middle = Math.floor(values.length / 2);

    return values.length % 2 === 0
      ? (values[middle - 1] + values[middle]) / 2
      : values[middle];
  }

  const rawMedian = medianOf(prices);

  if (!Number.isFinite(rawMedian) || rawMedian <= 0) {
    return null;
  }

  // Exclude extreme prices that can distort the historical median.
  const crediblePrices = prices.filter(
    (price) =>
      price >= rawMedian * 0.5 &&
      price <= rawMedian * 1.5
  );

  if (crediblePrices.length < 3) return null;

  const median = medianOf(crediblePrices);

  // Reject inconsistent historical prices.
  if (
    !Number.isFinite(median) ||
    median <= currentPrice ||
    median > currentMrp
  ) {
    return null;
  }

  const dropAmount = median - currentPrice;
  const dropPercent = (dropAmount / median) * 100;

  // Require a 70% price drop and at least ₹50 savings.
  if (dropPercent >= 70 && dropAmount >= 50) {
    return {
      alertType: 'HISTORICAL_PRICE_DROP',
      historicalMedian: median,
      historicalLowest: crediblePrices[0],
      historicalObservations: crediblePrices.length,
      historicalDropPercent: Math.round(dropPercent),
    };
  }

  return null;
}
