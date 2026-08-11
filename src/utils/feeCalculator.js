// src/utils/feeCalculator.js
const { DEFAULT_FEE } = require('../config/fees');

/**
 * Computes the platform fee owed on an amount, in minor units.
 * Per-merchant overrides (merchant.fees) win over the global default -
 * this is what lets you negotiate a lower rate for a high-volume
 * merchant without touching code.
 *
 * @param {number} amountMinor - the amount the fee is calculated against
 *   (post-split, i.e. what's actually landing as the merchant's share).
 * @param {object|null} merchant - Merchant document, or null to force defaults.
 * @returns {{ feeAmount: number, netAmount: number }}
 */
function computeFee(amountMinor, merchant = null) {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error('invalid_fee_base_amount');
  }

  const override = merchant?.fees || {};
  const percentageBps = Number.isFinite(override.percentageBps) ? override.percentageBps : DEFAULT_FEE.percentageBps;
  const fixedMinor = Number.isFinite(override.fixedMinor) ? override.fixedMinor : DEFAULT_FEE.fixedMinor;
  const capMinor = Number.isFinite(override.capMinor) ? override.capMinor : DEFAULT_FEE.capMinor;

  let feeAmount = Math.floor((amountMinor * percentageBps) / 10000) + fixedMinor;

  if (capMinor > 0) {
    feeAmount = Math.min(feeAmount, capMinor);
  }

  // Never let a fee exceed (or zero out) the amount it's taken from.
  feeAmount = Math.max(0, Math.min(feeAmount, amountMinor));

  const netAmount = amountMinor - feeAmount;
  return { feeAmount, netAmount };
}

module.exports = { computeFee };
