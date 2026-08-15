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
    reference: { type: String, required: true, unique: true }, // our own internally-generated reference

    // The CALLER's idempotency key (e.g. sent as `Idempotency-Key` or in
    // the request body by the merchant's integration). Distinct from
    // `reference` above: `reference` is always fresh per Payout row;
    // `idempotencyKey`, when supplied, is what a RETRY of the same logical
    // request will send again, so it's what dedup actually needs to key
    // on. Sparse so payouts made without one (legacy callers) don't
    // collide with each other on `null`.
    idempotencyKey: { type: String, default: null },

    amount: { type: Number, required: true }, // minor units
    currency: { type: String, required: true, default: 'NGN' },

    destinationBankCode: { type: String, required: true },
    destinationAccountNumber: { type: String, required: true },
    destinationAccountName: { type: String, required: true },

    status: {
      type: String,
      // 'reserved': funds moved out of available balance into
      // reservedBalance, RexxPay Bank not yet called (or the call is
      // in flight). 'ambiguous': RexxPay Bank was called but the
      // response is unknown (timeout/network error) - funds stay
      // reserved (NOT reversed) until a reconciliation job confirms
      // the real outcome. Reversing on ambiguous failure risks
      // double-paying a merchant if the bank actually sent the money.
      enum: ['pending', 'reserved', 'processing', 'successful', 'failed', 'ambiguous', 'reversed'],
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

// Sparse: only enforces uniqueness among documents that actually have an
// idempotencyKey, so legacy/no-key payouts aren't affected.
payoutSchema.index({ merchant: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Payout', payoutSchema);
