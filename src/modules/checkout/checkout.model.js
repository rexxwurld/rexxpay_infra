const mongoose = require('mongoose');

const checkoutSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', required: true },

    txRef: { type: String, required: true },
    accountNumber: { type: String, required: true },
    bankName: { type: String, default: null },
    amountExpected: { type: Number, default: null },
    redirectUrl: { type: String, default: null },

    // Copied from the virtual account at creation time - lets the
    // checkout page/dashboard clearly mark this as a test transaction.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },

    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Checkout', checkoutSchema);
