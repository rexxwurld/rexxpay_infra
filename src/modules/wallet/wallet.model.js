// src/modules/wallet/wallet.model.js
const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    balance: { type: Number, required: true, default: 0 }, // stored in minor units (kobo/cents)
    currency: { type: String, required: true, default: 'NGN' },
  },
  { timestamps: true }
);

// A merchant has ONE wallet PER CURRENCY, never one wallet total. Before
// this index, `merchant` alone was unique, which meant a merchant could
// only ever have a single (NGN) wallet - any credit/debit call made with
// a different currency silently landed in that same NGN balance.
walletSchema.index({ merchant: 1, currency: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);
