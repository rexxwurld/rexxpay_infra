const mongoose = require('mongoose');

const virtualAccountSchema = new mongoose.Schema(
  {
    accountNumber: {
      type: String,
      required: true,
      unique: true,
    },

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

    /*
    |--------------------------------------------------------------------------
    | ACCOUNT LIFECYCLE
    |--------------------------------------------------------------------------
    |
    | available:
    |   Account is in the pool and can be assigned.
    |
    | assigned:
    |   Account is currently assigned to an active payment.
    |
    | deactivated:
    |   Payment has completed. Account is temporarily disabled and cannot
    |   be assigned again until cooldownUntil expires.
    |
    */
    status: {
      type: String,
      enum: ['available', 'assigned', 'deactivated'],
      default: 'available',
      index: true,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    /*
    |--------------------------------------------------------------------------
    | COOLDOWN
    |--------------------------------------------------------------------------
    |
    | After a successful payment, the account enters `deactivated` state.
    | This timestamp determines when it can safely return to the pool.
    |
    */
    deactivatedAt: {
      type: Date,
      default: null,
    },

    cooldownUntil: {
      type: Date,
      default: null,
      index: true,
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

    // Optional split payment configuration for this checkout.
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
