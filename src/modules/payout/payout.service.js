// src/modules/payout/payout.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const Payout = require('./payout.model');
const { reserveFunds, finalizeReservedDebit, releaseReservedFunds, getOrCreateWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { findActiveByCodeForMerchant } = require('../recipient/recipient.service');
const { sendPayoutInstruction } = require('../bankPartner/rexxPayBankClient');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

const MAX_BULK_PAYOUT_ITEMS = 100;

// RexxPay Bank wallets are denominated in major units (naira); SwiftPay
// tracks everything internally in minor units (kobo). This is the one
// place that conversion needs to happen, symmetric to how
// rexxpay-main's deposit.service.js does `Math.round(amount * 100)` when
// notifying SwiftPay of a deposit in the other direction.
function toMajorUnits(amountMinorUnits) {
  return amountMinorUnits / 100;
}

async function requestPayout({
  merchantId,
  amount,
  currency = 'NGN',
  idempotencyKey = null,
  recipientCode,
  destinationBankCode,
  destinationAccountNumber,
  destinationAccountName,
}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('invalid_payout_amount');
  }
  if (amount > limits.MAX_SINGLE_PAYOUT_MINOR) {
    throw new Error('payout_exceeds_max_single_payout_limit');
  }

  // IDEMPOTENCY - if the caller supplied a key and we've already seen
  // it for this merchant, return the existing payout instead of
  // reserving/sending money a second time. This is the check the
  // original version of this function didn't have at all - every call
  // generated a fresh internal reference regardless of whether it was
  // really a brand new payout or a client retrying a request whose
  // response it never received.
  if (idempotencyKey) {
    const existing = await Payout.findOne({ merchant: merchantId, idempotencyKey });
    if (existing) {
      return existing;
    }
  }

  // A saved recipient takes precedence over raw destination fields if
  // both are somehow supplied - it's the source of truth once it exists.
  if (recipientCode) {
    const recipient = await findActiveByCodeForMerchant(merchantId, recipientCode);
    if (!recipient) throw new Error('unknown_or_inactive_recipient');
    destinationBankCode = recipient.bankCode;
    destinationAccountNumber = recipient.accountNumber;
    destinationAccountName = recipient.accountName;
  }

  if (!destinationBankCode || !destinationAccountNumber || !destinationAccountName) {
    throw new Error('destination_account_required');
  }

  const reference = `po_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let payout;
  try {
    session.startTransaction();

    // Reserve first, inside the same transaction as the Payout record
    // and the ledger entries - if any step fails, the whole thing rolls
    // back and the merchant's wallet is never left silently debited.
    // Reserving (rather than debiting `balance` straight to zero) means
    // the money is provably committed to THIS payout without yet
    // claiming it definitely left - see finalizeReservedDebit /
    // releaseReservedFunds below for how the reservation resolves.
    const wallet = await reserveFunds(merchantId, amount, session, currency);

    const [created] = await Payout.create(
      [
        {
          merchant: merchantId,
          reference,
          idempotencyKey,
          amount,
          currency,
          destinationBankCode,
          destinationAccountNumber,
          destinationAccountName,
          status: 'reserved',
        },
      ],
      { session, ordered: true }
    );
    payout = created;

    await postDoubleEntry({
      entryGroup: `payout_${payout._id}`,
      amount,
      currency,
      sourceType: 'payout',
      sourceRef: payout._id.toString(),
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Payout requested - funds reserved' },
      credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Funds moved to payout clearing pending bank confirmation' },
      session,
    });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    if (err.code === 11000 && idempotencyKey) {
      const raced = await Payout.findOne({ merchant: merchantId, idempotencyKey });
      if (raced) return raced;
    }
    throw err;
  }

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'payout.requested',
    entityType: 'Payout',
    entityRef: payout._id.toString(),
    metadata: { amount, destinationAccountNumber },
  });

  // Bank call happens AFTER the DB transaction commits - never call an
  // external payment provider from inside a DB transaction, or a
  // slow/failed external call can hold locks and block unrelated writes.
  payout.status = 'processing';
  await payout.save();

  try {
    const result = await sendPayoutInstruction({
      idempotencyKey: payout.reference, // what RexxPay Bank dedupes on
      amountMajorUnits: toMajorUnits(amount),
      destinationAccountNumber,
      destinationBank: destinationBankCode,
      destinationAccountName,
    });

    if (result.success) {
      await finalizePayoutSuccess(payout, result.payout?.providerReference || null);
    } else {
      // A well-formed "the bank declined/failed this payout" response -
      // the reservation genuinely never left, safe to release.
      await reversePayout(payout, result.payout?.failureReason || 'bank_declined');
    }
  } catch (err) {
    if (err.ambiguousOutcome) {
      // We don't know if RexxPay Bank actually processed this before
      // the connection died. DO NOT release the reservation and DO NOT
      // mark it successful - leave it reserved/ambiguous for a
      // reconciliation job to resolve against RexxPay Bank's own
      // records (RexxPay's idempotencyKey dedup means safely re-sending
      // the same instruction later is fine even if it did go through).
      payout.status = 'ambiguous';
      payout.failureReason = `bank_call_ambiguous: ${err.message}`;
      await payout.save();

      await auditLog.record({
        actorType: 'system',
        actorRef: 'payout_service',
        action: 'payout.ambiguous_outcome',
        entityType: 'Payout',
        entityRef: payout._id.toString(),
        severity: 'critical',
        metadata: { error: err.message },
      });
    } else {
      await reversePayout(payout, err.message);
    }
  }

  return payout;
}

async function finalizePayoutSuccess(payout, providerReference) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const wallet = await getOrCreateWallet(payout.merchant, payout.currency, session);
    await finalizeReservedDebit(wallet._id, payout.amount, session);

    payout.status = 'successful';
    payout.providerRef = providerReference;
    await payout.save({ session });

    await session.commitTransaction();
    session.endSession();

    await auditLog.record({
      actorType: 'system',
      actorRef: 'payout_service',
      action: 'payout.successful',
      entityType: 'Payout',
      entityRef: payout._id.toString(),
      metadata: { amount: payout.amount, providerReference },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function reversePayout(payout, reason) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const wallet = await getOrCreateWallet(payout.merchant, payout.currency, session);
    await releaseReservedFunds(wallet._id, payout.amount, session);

    await postDoubleEntry({
      entryGroup: `payout_reversal_${payout._id}`,
      amount: payout.amount,
      currency: payout.currency,
      sourceType: 'reversal',
      sourceRef: payout._id.toString(),
      debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Payout reversal' },
      credit: { accountType: 'merchant_wallet', accountRef: payout.merchant.toString(), description: 'Payout reversal - funds returned' },
      session,
    });
    payout.status = 'failed';
    payout.failureReason = reason;
    await payout.save({ session });
    await session.commitTransaction();
    session.endSession();

    await auditLog.record({
      actorType: 'system',
      actorRef: 'payout_service',
      action: 'payout.reversed',
      entityType: 'Payout',
      entityRef: payout._id.toString(),
      severity: 'warning',
      metadata: { reason },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function listForMerchant(merchantId) {
  return Payout.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

// Each item is processed as its own independent, fully atomic payout
// (same as calling requestPayout in a loop) - one bad/insufficient-funds
// item never rolls back or blocks the others. The caller gets a
// per-item result so it can tell exactly which ones went through.
async function requestBulkPayout({ merchantId, currency = 'NGN', items }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items_required');
  }
  if (items.length > MAX_BULK_PAYOUT_ITEMS) {
    throw new Error(`bulk_payout_exceeds_max_items:${MAX_BULK_PAYOUT_ITEMS}`);
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const payout = await requestPayout({
        merchantId,
        amount: item.amount,
        currency: item.currency || currency,
        idempotencyKey: item.idempotencyKey || null,
        recipientCode: item.recipientCode,
        destinationBankCode: item.destinationBankCode,
        destinationAccountNumber: item.destinationAccountNumber,
        destinationAccountName: item.destinationAccountName,
      });
      results.push({ index: i, success: true, payout });
    } catch (err) {
      results.push({ index: i, success: false, error: err.message });
    }
  }

  const successCount = results.filter((r) => r.success).length;

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'payout.bulk_requested',
    entityType: 'Payout',
    entityRef: `bulk_${Date.now()}`,
    metadata: { totalItems: items.length, successCount, failureCount: items.length - successCount },
  });

  return { results, successCount, failureCount: items.length - successCount };
}

module.exports = { requestPayout, requestBulkPayout, listForMerchant };
