// src/modules/wallet/wallet.model.js
const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },

    // `balance` is the AVAILABLE balance - money that has cleared
    // settlement and can be paid out right now. This is what every
    // existing caller (payout debit, dashboard, admin routes) already
    // reads, so its meaning is unchanged; it just no longer gets
    // credited the instant a payment comes in.
    balance: { type: Number, required: true, default: 0 }, // stored in minor units (kobo/cents)

    // Money from confirmed inbound payments that hasn't cleared the
    // settlement cutoff yet. Lives here from the moment a transaction is
    // recorded until settlement.service moves it into `balance`.
    pendingSettlementBalance: { type: Number, required: true, default: 0 },

    // Money that's been earmarked for an in-flight payout (reserved at
    // request time) but hasn't been confirmed as actually sent yet.
    // Neither spendable again nor still "available" - exists so a
    // second payout request can't double-spend money that's already
    // committed to a first one still waiting on the bank.
    reservedBalance: { type: Number, required: true, default: 0 },

    currency: { type: String, required: true, default: 'NGN' },
  },
  { timestamps: true }
);

// A merchant has ONE wallet PER CURRENCY, never one wallet total. Before
// this index, `merchant` alone was unique, which meant a merchant could
// only ever have a single (NGN) wallet - any credit/debit call made with
// a different currency silently landed in that same NGN balance.
walletSchema.index({ merchant: 1, currency: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);
