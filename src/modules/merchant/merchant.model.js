// src/modules/merchant/merchant.model.js
const mongoose = require('mongoose');

const merchantSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },

    // Self-reported at signup; does not itself gate features or fees -
    // that's still controlled by the `fees` override below and any
    // future plan-enforcement logic.
    plan: { type: String, enum: ['starter', 'growth', 'enterprise'], default: 'starter' },
    webhookUrl: { type: String },
    webhookSecret: { type: String },

    // Test and live keypairs both exist simultaneously (Paystack-style).
    // Which one is "active" for a request is determined by the key
    // prefix the caller sends, not by a merchant-level toggle - so
    // switching modes never invalidates the other pair.
    testPublicKey: { type: String, required: true, unique: true },
    testSecretKeyHash: { type: String, required: true },
    livePublicKey: { type: String, required: true, unique: true },
    liveSecretKeyHash: { type: String, required: true },

    isVerified: { type: Boolean, default: false },

    // Per-merchant platform fee override. Any field left unset falls
    // back to the global default in src/config/fees.js. Set via the
    // admin-key-protected /api/admin/merchants/:id/fees endpoint - never
    // client-settable, since a merchant setting its own fee to zero
    // would defeat the whole point.
    fees: {
      percentageBps: { type: Number, min: 0, max: 10000 },
      fixedMinor: { type: Number, min: 0 },
      capMinor: { type: Number, min: 0 },
    },

    defaultCurrency: { type: String, default: 'NGN' },

    twoFactor: {
      enabled: { type: Boolean, default: false },
      secret: { type: String }, // set once enabled=true
      pendingSecret: { type: String }, // set during setup, before confirmation
      backupCodeHashes: { type: [String], default: [] },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Merchant', merchantSchema);
