// src/utils/feeCalculator.js
const { DEFAULT_FEE } = require('../config/fees');
const { getPlanConfig } = require('../config/plans');

/**
 * Computes the platform fee owed on an amount, in minor units.
 *
 * Resolution order (highest precedence last):
 *   1. Global DEFAULT_FEE (src/config/fees.js)
 *   2. The merchant's plan tier (src/config/plans.js) - this is new;
 *      previously merchant.plan was stored but never actually read here.
 *   3. merchant.fees - a per-merchant override, for a negotiated rate
 *      that doesn't fit neatly into a plan tier. Still wins over the
 *      plan default, same as before.
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

  const plan = getPlanConfig(merchant?.plan).fees;
  const override = merchant?.fees || {};

  const percentageBps = Number.isFinite(override.percentageBps)
    ? override.percentageBps
    : Number.isFinite(plan.percentageBps)
      ? plan.percentageBps
      : DEFAULT_FEE.percentageBps;

  const fixedMinor = Number.isFinite(override.fixedMinor)
    ? override.fixedMinor
    : Number.isFinite(plan.fixedMinor)
      ? plan.fixedMinor
      : DEFAULT_FEE.fixedMinor;

  const capMinor = Number.isFinite(override.capMinor)
    ? override.capMinor
    : Number.isFinite(plan.capMinor)
      ? plan.capMinor
      : DEFAULT_FEE.capMinor;

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
