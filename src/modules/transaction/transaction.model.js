// src/modules/transaction/transaction.model.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true }, // idempotency key
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', required: true },

    amountExpected: { type: Number, default: null }, // null if this account has no fixed expected amount (wallet top-up style)
    amountReceived: { type: Number, required: true }, // minor units
    currency: { type: String, required: true, default: 'NGN' },

    status: {
      type: String,
      // 'flagged' = money landed and is logged, but held from crediting the
      // merchant wallet pending manual review (limit exceeded / sanctions hit).
      enum: ['pending', 'success', 'partial', 'over', 'failed', 'flagged'],
      default: 'pending',
    },
    flagReason: { type: String, default: null },

    channel: { type: String, default: 'dedicated_virtual_account' },
    bankReference: { type: String }, // the bank partner's own transaction ID, for reconciliation
  },
  { timestamps: true }
);

module.exports = mongoose.model('Transaction', transactionSchema);
