// src/config/env.js
require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // Must be IDENTICAL to BANK_WEBHOOK_SECRET set on RexxPay Bank -
  // this is what verifies incoming "payment succeeded" webhooks are real.
  bankWebhookSecret: process.env.BANK_WEBHOOK_SECRET,

  // RexxPay Bank (the real wallet system) - used to provision real pool
  // accounts instead of generating fake local account numbers.
  rexxPayBankBaseUrl: process.env.REXXPAY_BANK_BASE_URL || 'https://rexxpay.onrender.com',
  rexxPayBankAdminKey: process.env.REXXPAY_BANK_ADMIN_KEY,

  // Same shared secret as bankWebhookSecret above, reused to SIGN
  // outgoing payout instructions to RexxPay Bank (it verifies them with
  // its own SWIFTPAY_WEBHOOK_SECRET, which must be set to this same
  // value - see rexxpay-main's src/middleware/verifySwiftpaySignature.js).
  // Kept as its own name so the two directions can be rotated to
  // different secrets later without a confusing variable name.
  rexxPayBankPayoutSecret: process.env.REXXPAY_BANK_PAYOUT_SECRET || process.env.BANK_WEBHOOK_SECRET,

  // Identifies this service to RexxPay Bank in payout instructions - must
  // match the `linkedService` value RexxPay's Wallet/SettlementPool
  // records use ("swiftpay").
  linkedServiceName: process.env.LINKED_SERVICE_NAME || 'swiftpay',
};
