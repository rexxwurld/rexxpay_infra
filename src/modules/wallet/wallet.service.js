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
// `balance` here is a fast-read CACHE of the AVAILABLE balance - the
// LedgerEntry rows in the ledger module are the source of truth. Callers
// that move money should write both in the same session (see
// transaction.service / payout.service).
//
// NOTE: this credits the AVAILABLE balance directly and bypasses
// settlement. Only use it for movements that are available immediately
// by definition (e.g. a payout reversal giving money straight back).
// Money from an inbound customer payment should go through
// creditPendingSettlement instead - see settlement/settlement.service.js.
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

/*
|--------------------------------------------------------------------------
| SETTLEMENT-STATE-AWARE MOVEMENTS
|--------------------------------------------------------------------------
|
| These four functions are the only supported ways money should move
| between the three balance buckets on a wallet:
|
|   pendingSettlementBalance --(settle)--> balance (available)
|   balance (available) --(reserve)--> reservedBalance --(finalize)--> gone
|                                       reservedBalance --(release)--> balance
|
| Every one of them requires a session and is a single atomic
| findOneAndUpdate with a guard condition, so two concurrent calls can
| never both succeed against the same insufficient bucket.
*/

// Inbound payment confirmed, but not yet past the settlement cutoff.
// This is what transaction.service should call instead of creditWallet
// when a payment is first recorded.
async function creditPendingSettlement(merchantId, amountMinorUnits, session, currency = 'NGN') {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_credit_amount');
  }
  const cur = normalizeCurrency(currency);
  await getOrCreateWallet(merchantId, cur, session);
  return Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur },
    { $inc: { pendingSettlementBalance: amountMinorUnits } },
    { new: true, session }
  );
}

// Moves money that has cleared the settlement cutoff out of
// pendingSettlementBalance and into the available balance. Called by
// settlement.service, never directly by payment/payout code.
async function moveToAvailable(walletId, amountMinorUnits, session) {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_settlement_amount');
  }
  const wallet = await Wallet.findOneAndUpdate(
    { _id: walletId, pendingSettlementBalance: { $gte: amountMinorUnits } },
    { $inc: { pendingSettlementBalance: -amountMinorUnits, balance: amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('insufficient_pending_settlement_balance');
  return wallet;
}

// Earmarks funds for an in-flight payout: moves them out of the
// available balance into reservedBalance. Only allowed from AVAILABLE
// balance, never from pendingSettlementBalance - unsettled money can't
// be paid out, which is the entire point of having settlement states.
async function reserveFunds(merchantId, amountMinorUnits, session, currency = 'NGN') {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_reserve_amount');
  }
  const cur = normalizeCurrency(currency);
  const wallet = await Wallet.findOneAndUpdate(
    { merchant: merchantId, currency: cur, balance: { $gte: amountMinorUnits } },
    { $inc: { balance: -amountMinorUnits, reservedBalance: amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('insufficient_balance');
  return wallet;
}

// Payout confirmed sent by the bank - the reservation is consumed for
// real; the money has actually left.
async function finalizeReservedDebit(walletId, amountMinorUnits, session) {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_finalize_amount');
  }
  const wallet = await Wallet.findOneAndUpdate(
    { _id: walletId, reservedBalance: { $gte: amountMinorUnits } },
    { $inc: { reservedBalance: -amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('reserved_balance_mismatch');
  return wallet;
}

// Payout failed/reversed - give the reservation back to the available
// balance so the merchant can spend or retry with it.
async function releaseReservedFunds(walletId, amountMinorUnits, session) {
  if (!session) throw new Error('wallet_requires_session');
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error('invalid_release_amount');
  }
  const wallet = await Wallet.findOneAndUpdate(
    { _id: walletId, reservedBalance: { $gte: amountMinorUnits } },
    { $inc: { reservedBalance: -amountMinorUnits, balance: amountMinorUnits } },
    { new: true, session }
  );
  if (!wallet) throw new Error('reserved_balance_mismatch');
  return wallet;
}

module.exports = {
  getOrCreateWallet,
  listWallets,
  creditWallet,
  debitWallet,
  creditPendingSettlement,
  moveToAvailable,
  reserveFunds,
  finalizeReservedDebit,
  releaseReservedFunds,
};
