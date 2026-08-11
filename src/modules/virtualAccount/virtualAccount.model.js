const mongoose = require('mongoose');

const virtualAccountSchema = new mongoose.Schema(
  {
    accountNumber: { type: String, required: true, unique: true },
    bank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BankPartner',
      required: true,
    },

    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      default: null,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },

    status: {
      type: String,
      enum: ['available', 'assigned', 'deactivated'],
      default: 'available',
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    // Fixed amount expected for this checkout.
    // Stored in minor units (kobo).
    amountExpected: {
      type: Number,
      default: null,
    },

    // Merchant's own transaction/order reference.
    // This stays server-side and is NOT used in the checkout URL.
    reference: {
      type: String,
      default: null,
    },

    // Optional split payment config for this checkout - cleared on
    // release, same as amountExpected/reference, since the account gets
    // reused for a completely different order once returned to the pool.
    splitSubaccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subaccount',
      default: null,
    },
    splitPercentage: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('VirtualAccount', virtualAccountSchema);
