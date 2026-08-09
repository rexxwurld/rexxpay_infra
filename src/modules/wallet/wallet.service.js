// src/modules/wallet/wallet.service.js
const Wallet = require('./wallet.model');

async function getOrCreateWallet(merchantId, currency = 'NGN') {
  let wallet = await Wallet.findOne({ merchant: merchantId });
  if (!wallet) {
    wallet = await Wallet.create({ merchant: merchantId, balance: 0, currency });
  }
  return wallet;
}

// Atomic increment so concurrent webhook deliveries can't race each other
// and lose an update (classic "read balance, add, write balance" bug).
async function creditWallet(merchantId, amountMinorUnits) {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_credit_amount');
  }
  await getOrCreateWallet(merchantId);
  return Wallet.findOneAndUpdate(
    { merchant: merchantId },
    { $inc: { balance: amountMinorUnits } },
    { new: true }
  );
}

async function debitWallet(merchantId, amountMinorUnits) {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_debit_amount');
  }
  // Only debit if sufficient balance exists (prevents negative balances)
  const wallet = await Wallet.findOneAndUpdate(
    { merchant: merchantId, balance: { $gte: amountMinorUnits } },
    { $inc: { balance: -amountMinorUnits } },
    { new: true }
  );
  if (!wallet) throw new Error('insufficient_balance');
  return wallet;
}

module.exports = { getOrCreateWallet, creditWallet, debitWallet };
