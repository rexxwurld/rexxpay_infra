// src/modules/dispute/dispute.model.js
const mongoose = require('mongoose');
const { nanoid } = require('nanoid');

const evidenceSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    url: { type: String },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const disputeSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    disputeCode: { type: String, required: true, unique: true, default: () => `dp_${nanoid(12)}` },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },

    // Copied from the original transaction. Needed at resolution time,
    // when only the Dispute doc (not the Transaction) is loaded.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },

    reason: {
      type: String,
      enum: ['fraudulent', 'duplicate', 'product_not_received', 'product_unacceptable', 'unrecognized', 'other'],
      default: 'other',
    },
    reasonDetail: { type: String },

    status: {
      type: String,
      enum: ['open', 'under_review', 'won', 'lost'],
      default: 'open',
    },

    evidence: { type: [evidenceSchema], default: [] },
    evidenceDueBy: { type: Date, required: true },

    resolution: { type: String },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

disputeSchema.index({ merchant: 1, status: 1 });

module.exports = mongoose.model('Dispute', disputeSchema);
