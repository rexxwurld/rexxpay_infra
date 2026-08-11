// src/modules/recipient/recipient.model.js
const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    recipientCode: { type: String, required: true, unique: true }, // e.g. rcp_xxxxx, referenced at payout time

    label: { type: String, required: true }, // merchant's own name for this recipient, e.g. "Jane - Payroll"
    bankCode: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Recipient', recipientSchema);
