// src/modules/wallet/wallet.model.js
const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, unique: true },
    balance: { type: Number, required: true, default: 0 }, // stored in minor units (kobo/cents)
    currency: { type: String, required: true, default: 'NGN' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Wallet', walletSchema);
