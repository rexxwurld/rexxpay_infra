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
};
