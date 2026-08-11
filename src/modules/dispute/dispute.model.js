// src/modules/dispute/dispute.model.js
//
// A dispute (chargeback) is a customer's bank contesting a payment after
// it already settled to the merchant. Unlike a refund, the merchant
// didn't initiate this - it arrives as a claim from outside, so opening
// one is an admin/ops action (see dispute.routes.js), not something a
// merchant calls via their API key. The merchant's job is to see it and
// submit evidence; RexxPay ops resolves it.

const mongoose = require('mongoose');
const { nanoid } = require('nanoid');

const evidenceSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    url: { type: String }, // link to uploaded proof (delivery confirmation, receipt, etc.)
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    disputeCode: { type: String, required: true, unique: true, default: () => `dp_${nanoid(12)}` },

    amount: { type: Number, required: true }, // minor units, frozen from the merchant's wallet
    currency: { type: String, required: true, default: 'NGN' },

    reason: {
      type: String,
      enum: ['fraudulent', 'duplicate', 'product_not_received', 'product_unacceptable', 'unrecognized', 'other'],
      default: 'other',
    },
    reasonDetail: { type: String },

    status: {
      type: String,
      // open            - funds just frozen, evidence window open
      // under_review    - merchant has submitted evidence, awaiting resolution
      // won             - merchant kept the funds, frozen amount returned to wallet
      // lost            - customer's claim upheld, funds leave the platform permanently
      enum: ['open', 'under_review', 'won', 'lost'],
      default: 'open',
    },

    evidence: { type: [evidenceSchema], default: [] },
    evidenceDueBy: { type: Date, required: true },

    resolution: { type: String }, // free-text note from whoever resolves it
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

disputeSchema.index({ merchant: 1, status: 1 });

module.exports = mongoose.model('Dispute', disputeSchema);
