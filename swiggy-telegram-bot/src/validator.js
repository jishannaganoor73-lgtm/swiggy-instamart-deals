/**
 * Deal validation and confidence scoring.
 *
 * 1. validateItems()  - drops structurally invalid listings BEFORE tracking
 *                       (bad MRP, price above MRP, zero price, out of stock...).
 * 2. scoreAlert()     - gives every alert a confidence score + human flags and
 *                       decides whether it is junk (sample sachets, tiny-MRP Rs 1 items...).
 */

const SAMPLE_RE =
  /\b(samples?|sachets?|trial|tester|testing|not for sale|free gift|gift card|coupon|voucher|dummy|test product)\b/i;

const TINY_PACK_RE = /^\s*\d{1,2}(\.\d+)?\s?(g|gm|gms|ml)\s*$/i;

const SPECIAL_TYPES = new Set(['ONE_RUPEE_DEAL', 'POTENTIAL_PRICE_GLITCH']);

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' ? n : fallback;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
}

function validateItem(item) {
  if (!item || typeof item !== 'object') return { valid: false, reason: 'not-an-item' };

  const price = Number(item.price);
  const mrp = Number(item.mrp);
  const maxMrp = envNumber('MAX_SANE_MRP', 200000);

  if (item.inStock === false) return { valid: false, reason: 'out-of-stock' };
  if (!item.name || String(item.name).trim().length < 3) return { valid: false, reason: 'no-name' };
  if (!Number.isFinite(price) || price < 0) return { valid: false, reason: 'bad-price' };
  if (price === 0 && !envBool('ALLOW_ZERO_PRICE', false)) return { valid: false, reason: 'zero-price' };
  if (!Number.isFinite(mrp) || mrp <= 0) return { valid: false, reason: 'bad-mrp' };
  if (mrp > maxMrp) return { valid: false, reason: 'insane-mrp' };
  if (price > mrp) return { valid: false, reason: 'price-above-mrp' };

  return { valid: true };
}

function validateItems(items, label = '') {
  const kept = [];
  const dropped = {};

  for (const item of items || []) {
    const result = validateItem(item);

    if (result.valid) kept.push(item);
    else dropped[result.reason] = (dropped[result.reason] || 0) + 1;
  }

  const droppedTotal = (items || []).length - kept.length;

  if (droppedTotal > 0) {
    console.log(
      `[Validator${label ? ':' + label : ''}] Dropped ${droppedTotal} invalid listings: ` +
      Object.entries(dropped).map(([k, v]) => `${k}=${v}`).join(', ')
    );
  }

  return kept;
}

function levelFor(confidence) {
  if (confidence >= 75) return 'High';
  if (confidence >= 50) return 'Medium';
  return 'Low';
}

function scoreAlert(deal) {
  const flags = [];
  let confidence = 50;
  let exclude = false;
  let excludeReason = '';

  const price = Number(deal.price);
  const mrp = Number(deal.mrp);
  const discount = Number(deal.discount);
  const isSpecial = SPECIAL_TYPES.has(deal.alertType);

  const minGlitchMrp = envNumber('MIN_GLITCH_MRP', 30);
  const minConfidence = envNumber('MIN_CONFIDENCE', 30);
  const allowSamples = envBool('ALLOW_SAMPLE_DEALS', false);

  // --- value signals ---
  if (discount >= 90) confidence += 10;
  if (discount >= 95) confidence += 5;

  if (mrp >= 100) confidence += 15;
  if (mrp >= 300) confidence += 5;

  if (mrp < 30) {
    confidence -= 20;
    flags.push('Very low MRP');
  }

  if (Number.isFinite(Number(deal.historicalDropPercent))) {
    const drop = Number(deal.historicalDropPercent);
    if (drop >= 50) confidence += 20;
    else if (drop >= 30) confidence += 10;
  }

  if (Number(deal.ratingCount) >= 10) confidence += 5;

  // --- junk signals ---
  const text = `${deal.name || ''} ${deal.pack || ''}`;

  if (SAMPLE_RE.test(text)) {
    confidence -= 30;
    flags.push('Possible sample/sachet pack');

    if (isSpecial && !allowSamples) {
      exclude = true;
      excludeReason = 'sample-pack';
    }
  }

  if (TINY_PACK_RE.test(String(deal.pack || ''))) {
    confidence -= 15;
    flags.push('Tiny pack size');
  }

  if (isSpecial && Number.isFinite(mrp) && mrp < minGlitchMrp) {
    exclude = true;
    excludeReason = excludeReason || 'low-value-glitch';
  }

  if (isSpecial && Number.isFinite(price) && price <= 1 && mrp >= 100) {
    flags.push('Possible genuine glitch - act fast');
  }

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  if (confidence < minConfidence) {
    exclude = true;
    excludeReason = excludeReason || 'low-confidence';
  }

  return {
    confidence,
    confidenceLevel: levelFor(confidence),
    flags,
    exclude,
    excludeReason
  };
}

/**
 * Annotates alerts with confidence/flags and removes junk.
 */
function filterAlerts(alerts, label = '') {
  const kept = [];
  const dropped = {};

  for (const deal of alerts || []) {
    const scored = scoreAlert(deal);

    if (scored.exclude) {
      dropped[scored.excludeReason] = (dropped[scored.excludeReason] || 0) + 1;
      continue;
    }

    kept.push({
      ...deal,
      confidence: scored.confidence,
      confidenceLevel: scored.confidenceLevel,
      flags: scored.flags
    });
  }

  const droppedTotal = (alerts || []).length - kept.length;

  if (droppedTotal > 0) {
    console.log(
      `[Validator${label ? ':' + label : ''}] Filtered ${droppedTotal} junk alerts: ` +
      Object.entries(dropped).map(([k, v]) => `${k}=${v}`).join(', ')
    );
  }

  return kept;
}

module.exports = {
  SPECIAL_TYPES,
  validateItem,
  validateItems,
  scoreAlert,
  filterAlerts,
  envBool,
  envNumber
};
