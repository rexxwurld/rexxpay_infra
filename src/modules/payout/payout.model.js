// src/modules/payout/payout.model.js
//
// The other half of a payment processor: getting money OUT to merchants'
// real bank accounts, not just collecting it in. Every field here mirrors
// what you'd send to a real disbursement API (Paystack Transfers, NIBSS
// NIP outbound, a BaaS partner's payout endpoint, etc.) - `providerRef` is
// where that real provider's transaction ID would be recorded once wired up.

const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    reference: { type: String, required: true, unique: true }, // our idempotency key

    amount: { type: Number, required: true }, // minor units
    currency: { type: String, required: true, default: 'NGN' },

    destinationBankCode: { type: String, required: true },
    destinationAccountNumber: { type: String, required: true },
    destinationAccountName: { type: String, required: true },

    status: {
      type: String,
      enum: ['pending', 'processing', 'successful', 'failed', 'reversed'],
      default: 'pending',
    },
    failureReason: { type: String },

    // Set once a real disbursement provider is wired up - the provider's
    // own transaction reference, used to reconcile against their settlement
    // reports the same way inbound bankReference is used.
    providerRef: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payout', payoutSchema);
