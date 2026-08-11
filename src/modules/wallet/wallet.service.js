// src/modules/wallet/wallet.service.js
const Wallet = require('./wallet.model');
const { normalizeCurrency } = require('../../config/currencies');

async function getOrCreateWallet(merchantId, currency = 'NGN', session = null) {
  const cur = normalizeCurrency(currency);
  let wallet = await Wallet.findOne({ merchant: merchantId, currency: cur }).session(session);
  if (!wallet) {
    const created = await Wallet.create([{ merchant: merchantId, balance: 0, currency: cur }], { session });
    wallet = created[0];
  }
  return wallet;
}

async function listWallets(merchantId) {
  return Wallet.find({ merchant: merchantId }).sort({ currency: 1 });
}

// Atomic increment so concurrent webhook deliveries can't race each other
// and lose an update (classic "read balance, add, write balance" bug).
// `balance` here is a fast-read CACHE - the LedgerEntry rows in the ledger
// module are the source of truth. Callers that move money should write
// both in the same session (see transaction.service / payout.service).
//
// `currency` now actually determines WHICH wallet is touched - previously
// this argument was accepted but ignored, and every credit landed on the
// merchant's single NGN wallet regardless of what currency was passed in.
async function creditWallet(merchantId, amountMinorUnits, session = null, currency = 'NGN') {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_credit_amount');
  }
  const cur = normalizeCurrency(currency);
  await getOrCreateWallet(merchantId, cur, session);
  return Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur },
    { $inc: { balance: amountMinorUnits } },
    { new: true, session }
  );
}

async function debitWallet(merchantId, amountMinorUnits, session = null, currency = 'NGN') {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_debit_amount');
  }
  const cur = normalizeCurrency(currency);
  // Only debit if sufficient balance exists (prevents negative balances)
  const wallet = await Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur, balance: { $gte: amountMinorUnits } },
    { $inc: { balance: -amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('insufficient_balance');
  return wallet;
}

module.exports = { getOrCreateWallet, listWallets, creditWallet, debitWallet };
