const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    reference: { type: String, required: true, unique: true },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },
    reason: { type: String, default: null },

    // Copied from the original transaction. Needed at reversal time,
    // when only the Refund doc (not the Transaction) is loaded.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },

    destinationBankCode: { type: String, required: true },
    destinationAccountNumber: { type: String, required: true },
    destinationAccountName: { type: String, required: true },

    status: {
      type: String,
      enum: ['pending', 'processing', 'successful', 'failed', 'reversed'],
      default: 'pending',
    },
    failureReason: { type: String },
    providerRef: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Refund', refundSchema);
