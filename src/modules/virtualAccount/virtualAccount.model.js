// src/modules/virtualAccount/virtualAccount.model.js
const mongoose = require('mongoose');

const virtualAccountSchema = new mongoose.Schema(
  {
    accountNumber: { type: String, required: true, unique: true },
    bank: { type: mongoose.Schema.Types.ObjectId, ref: 'BankPartner', required: true },

    // Null until assigned to a merchant + customer
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },

    status: {
      type: String,
      enum: ['available', 'assigned', 'deactivated'],
      default: 'available',
    },
    assignedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('VirtualAccount', virtualAccountSchema);
