// src/config/limits.js
//
// Real payment processors tier these by KYC/merchant verification level
// (e.g. CBN's tiered KYC framework for Nigerian accounts). This is a
// simple flat version - enough to demonstrate the control exists, not a
// finished compliance policy. Wire real tiering in before production.

module.exports = {
  // Single incoming payment above this (in minor units, i.e. kobo) gets
  // flagged for manual review instead of auto-credited.
  MAX_SINGLE_PAYMENT_MINOR: Number(process.env.MAX_SINGLE_PAYMENT_MINOR || 500_000_00), // ₦500,000

  // Rolling 24h inbound volume per merchant above this gets flagged.
  MAX_DAILY_INBOUND_MINOR: Number(process.env.MAX_DAILY_INBOUND_MINOR || 5_000_000_00), // ₦5,000,000

  // Max number of distinct incoming payments to the same virtual account
  // within a short window - guards against rapid structuring/smurfing.
  VELOCITY_WINDOW_MINUTES: Number(process.env.VELOCITY_WINDOW_MINUTES || 10),
  VELOCITY_MAX_COUNT: Number(process.env.VELOCITY_MAX_COUNT || 5),

  // Payouts
  MAX_SINGLE_PAYOUT_MINOR: Number(process.env.MAX_SINGLE_PAYOUT_MINOR || 2_000_000_00), // ₦2,000,000
};
