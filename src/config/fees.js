// src/config/fees.js
//
// Platform revenue model. Every successful inbound payment (net of any
// subaccount split) has a fee deducted before the merchant's wallet is
// credited. The fee itself is credited to a fixed 'platform_revenue'
// ledger account - the same accountType the ledger schema already
// reserved for this and never previously posted to.
//
// Defaults are Paystack-ballpark for Nigerian bank transfer rails.
// Override globally via env, or per-merchant via merchant.fees.

const DEFAULT_FEE = {
  percentageBps: parseInt(process.env.PLATFORM_FEE_BPS || '150', 10), // 150 bps = 1.5%
  fixedMinor: parseInt(process.env.PLATFORM_FEE_FIXED_MINOR || '10000', 10), // e.g. NGN 100.00
  capMinor: parseInt(process.env.PLATFORM_FEE_CAP_MINOR || '200000', 10), // e.g. NGN 2,000.00 cap
};

module.exports = { DEFAULT_FEE };
