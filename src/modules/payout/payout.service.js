// src/modules/payout/payout.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const Payout = require('./payout.model');
const { debitWallet, creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { findActiveByCodeForMerchant } = require('../recipient/recipient.service');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

const MAX_BULK_PAYOUT_ITEMS = 100;

// NOTE: `sendToRealBank` is a stub. Wiring this to a real disbursement
// provider (Paystack Transfers, Flutterwave, a direct NIBSS NIP outbound
// integration, or your BaaS partner's payout API) is the single biggest
// piece of "real world" plumbing this repo is still missing - everything
// upstream of this line (limits, ledger, atomicity, idempotency) is real.
async function sendToRealBank(payout) {
  // Simulated success. A real implementation calls the provider here and
  // returns { success, providerRef } based on their actual response -
  // and must handle "pending"/"processing" responses, not just
  // success/fail, since real disbursement is rarely synchronous.
  return { success: true, providerRef: `sim_${payout.reference}` };
}

async function requestPayout({
  merchantId,
  amount,
  currency = 'NGN',
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

    // Debit first, inside the same transaction as the Payout record and
    // the ledger entries - if any step fails, the whole thing rolls back
    // and the merchant's wallet is never left silently debited.
    await debitWallet(merchantId, amount, session, currency);

    const [created] = await Payout.create(
      [
        {
          merchant: merchantId,
          reference,
          amount,
          currency,
          destinationBankCode,
          destinationAccountNumber,
          destinationAccountName,
          status: 'processing',
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
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Payout requested' },
      credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Funds moved to payout clearing pending bank confirmation' },
      session,
    });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
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

  // Disbursement call happens AFTER the DB transaction commits - never
  // call an external payment provider from inside a DB transaction, or a
  // slow/failed external call can hold locks and block unrelated writes.
  try {
    const result = await sendToRealBank(payout);
    payout.status = result.success ? 'successful' : 'failed';
    payout.providerRef = result.providerRef || null;
    if (!result.success) payout.failureReason = result.reason || 'provider_declined';
    await payout.save();

    if (!result.success) {
      // Reverse the debit - money never actually left, so give it back.
      await reversePayout(payout);
    }
  } catch (err) {
    // Provider call itself failed (timeout, 5xx, etc.) - status stays
    // 'processing'. A reconciliation job should later query the provider
    // for the real outcome rather than assuming failure and refunding
    // money that may actually have gone out.
    payout.failureReason = `provider_call_error: ${err.message}`;
    await payout.save();
  }

  return payout;
}

async function reversePayout(payout) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await creditWallet(payout.merchant, payout.amount, session, payout.currency);
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
    payout.status = 'reversed';
    await payout.save({ session });
    await session.commitTransaction();
    session.endSession();
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
