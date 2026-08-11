const mongoose = require('mongoose');

const checkoutSchema = new mongoose.Schema(
  {
    // This is the ONLY identifier exposed in the hosted checkout URL.
    // It is a 256-bit random value and is not the merchant tx_ref.
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: true,
      index: true,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },

    virtualAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VirtualAccount',
      required: true,
    },

    // Merchant's private transaction reference.
    txRef: {
      type: String,
      required: true,
    },

    // Information needed to display the checkout.
    accountNumber: {
      type: String,
      required: true,
    },

    bankName: {
      type: String,
      default: null,
    },

    amountExpected: {
      type: Number,
      default: null,
    },

    // Stored server-side.
    // NEVER returned from the public checkout status endpoint.
    redirectUrl: {
      type: String,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Checkout', checkoutSchema);
