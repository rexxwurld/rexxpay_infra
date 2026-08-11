// src/modules/recipient/recipient.service.js
const { nanoid } = require('nanoid');
const Recipient = require('./recipient.model');

async function createRecipient({ merchantId, label, bankCode, accountNumber, accountName }) {
  if (!label || !bankCode || !accountNumber || !accountName) {
    throw new Error('missing_required_fields');
  }

  return Recipient.create({
    merchant: merchantId,
    recipientCode: `rcp_${nanoid(16)}`,
    label,
    bankCode,
    accountNumber,
    accountName,
  });
}

async function listForMerchant(merchantId) {
  return Recipient.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, recipientId) {
  const recipient = await Recipient.findOne({ _id: recipientId, merchant: merchantId });
  if (!recipient) throw new Error('recipient_not_found');
  return recipient;
}

async function findActiveByCodeForMerchant(merchantId, recipientCode) {
  return Recipient.findOne({ recipientCode, merchant: merchantId, active: true });
}

// Soft delete - payouts already made keep their own snapshot of the bank
// details, so deactivating never affects payout history, only future use.
async function deactivateRecipient(merchantId, recipientId) {
  const recipient = await getForMerchant(merchantId, recipientId);
  recipient.active = false;
  await recipient.save();
  return recipient;
}

module.exports = {
  createRecipient,
  listForMerchant,
  getForMerchant,
  findActiveByCodeForMerchant,
  deactivateRecipient,
};
