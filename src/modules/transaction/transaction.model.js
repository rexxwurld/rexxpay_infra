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

    // Separate from `status` above. `status` answers "did the payment
    // clear ok" (a one-time fraud/amount check at the moment the money
    // arrived). `settlementStatus` answers "can this money be paid out
    // yet" and changes over time on its own schedule, independent of
    // `status`. A transaction can sit at status='success' /
    // settlementStatus='pending_settlement' for hours before becoming
    // settlementStatus='available'.
    //
    //   pending_settlement -> settled -> available
    //
    // Only transactions with status in ('success','partial','over') ever
    // get a settlementStatus at all - flagged/failed transactions never
    // had money credited to the merchant in the first place, so there's
    // nothing to settle.
    settlementStatus: {
      type: String,
      enum: ['pending_settlement', 'settled', 'available'],
      default: null,
    },
    settledAt: { type: Date, default: null },
    availableAt: { type: Date, default: null },
    // The SettlementBatch that moved this transaction from
    // pending_settlement to settled/available. Null until settlement
    // has actually run for it.
    settlementBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'SettlementBatch', default: null },

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

// settlement.service needs to efficiently find "everything still waiting
// to settle, oldest first" without a collection scan.
transactionSchema.index({ settlementStatus: 1, createdAt: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
