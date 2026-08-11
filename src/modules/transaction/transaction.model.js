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

    // Set only if the virtual account this payment landed on had a split
    // configured. splitAmount already left amountReceived on its way to
    // the subaccount - the merchant's wallet was credited amountReceived
    // minus splitAmount, not the full amountReceived.
    splitSubaccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Subaccount', default: null },
    splitAmount: { type: Number, default: 0 },

    // Platform revenue taken on this transaction, deducted from the
    // merchant's share before their wallet is credited. Not deducted
    // from the subaccount split - the split partner is paid in full.
    platformFee: { type: Number, default: 0 },
    // What actually landed in the merchant's wallet after the split
    // portion (if any) and the platform fee are both removed.
    netAmount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Transaction', transactionSchema);
