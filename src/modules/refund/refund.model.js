// src/modules/refund/refund.model.js
//
// A refund reverses money the merchant already received for a specific
// transaction, sending it back out to the customer's bank account. This
// system doesn't capture the customer's originating account from the
// inbound webhook payload (only the bank partner's own transaction
// reference), so - same as payouts - the merchant supplies the
// destination bank details explicitly when requesting a refund.

const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    reference: { type: String, required: true, unique: true }, // idempotency key

    amount: { type: Number, required: true }, // minor units
    currency: { type: String, required: true, default: 'NGN' },
    reason: { type: String, default: null },

    destinationBankCode: { type: String, required: true },
    destinationAccountNumber: { type: String, required: true },
    destinationAccountName: { type: String, required: true },

    status: {
      type: String,
      enum: ['pending', 'processing', 'successful', 'failed', 'reversed'],
      default: 'pending',
    },
    failureReason: { type: String },

    // Set once a real disbursement provider is wired up, mirroring
    // Payout.providerRef.
    providerRef: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Refund', refundSchema);
