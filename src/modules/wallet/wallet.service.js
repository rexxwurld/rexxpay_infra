// src/modules/wallet/wallet.service.js
const Wallet = require('./wallet.model');

async function getOrCreateWallet(merchantId, currency = 'NGN', session = null) {
  let wallet = await Wallet.findOne({ merchant: merchantId }).session(session);
  if (!wallet) {
    const created = await Wallet.create([{ merchant: merchantId, balance: 0, currency }], { session });
    wallet = created[0];
  }
  return wallet;
}

// Atomic increment so concurrent webhook deliveries can't race each other
// and lose an update (classic "read balance, add, write balance" bug).
// `balance` here is a fast-read CACHE - the LedgerEntry rows in the ledger
// module are the source of truth. Callers that move money should write
// both in the same session (see transaction.service / payout.service).
async function creditWallet(merchantId, amountMinorUnits, session = null) {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_credit_amount');
  }
  await getOrCreateWallet(merchantId, 'NGN', session);
  return Wallet.findOneAndUpdate(
    { merchant: merchantId },
    { $inc: { balance: amountMinorUnits } },
    { new: true, session }
  );
}

async function debitWallet(merchantId, amountMinorUnits, session = null) {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_debit_amount');
  }
  // Only debit if sufficient balance exists (prevents negative balances)
  const wallet = await Wallet.findOneAndUpdate(
    { merchant: merchantId, balance: { $gte: amountMinorUnits } },
    { $inc: { balance: -amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('insufficient_balance');
  return wallet;
}

module.exports = { getOrCreateWallet, creditWallet, debitWallet };
