// src/modules/merchant/merchant.model.js
const mongoose = require('mongoose');

const merchantSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    webhookUrl: { type: String },
    publicKey: { type: String, required: true, unique: true },
    secretKeyHash: { type: String, required: true }, // never store the raw secret key
    mode: { type: String, enum: ['test', 'live'], default: 'test' },
    isVerified: { type: Boolean, default: false }, // KYC / go-live status
  },
  { timestamps: true }
);

module.exports = mongoose.model('Merchant', merchantSchema);
