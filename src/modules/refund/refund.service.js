// src/modules/refund/refund.service.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const Refund = require('./refund.model');
const Transaction = require('../transaction/transaction.model');
const { debitWallet, creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const auditLog = require('../audit/auditLog.service');

async function sendRefundToBank(refund) {
  return { success: true, providerRef: `sim_${refund.reference}` };
}

async function requestRefund({
  merchantId,
  transactionId,
  amount,
  reason,
  destinationBankCode,
  destinationAccountNumber,
  destinationAccountName,
}) {
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) throw new Error('transaction_not_found');
  if (transaction.merchant.toString() !== merchantId.toString()) {
    throw new Error('transaction_not_found');
  }
  if (!['success', 'partial', 'over'].includes(transaction.status)) {
    throw new Error('transaction_not_refundable');
  }
  if (!destinationBankCode || !destinationAccountNumber || !destinationAccountName) {
    throw new Error('destination_account_required');
  }

  const mode = transaction.mode || 'live';

  const priorRefunds = await Refund.find({
    transaction: transactionId,
    status: { $in: ['pending', 'processing', 'successful'] },
  });
  const alreadyRefunded = priorRefunds.reduce((sum, r) => sum + r.amount, 0);
  const refundable = transaction.amountReceived - alreadyRefunded;

  const refundAmount = amount == null ? refundable : amount;
  if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
    throw new Error('invalid_refund_amount');
  }
  if (refundAmount > refundable) {
    throw new Error('refund_exceeds_refundable_amount');
  }

  const reference = `rf_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let refund;
  try {
    session.startTransaction();

    await debitWallet(merchantId, refundAmount, session, transaction.currency, mode);

    const [created] = await Refund.create(
      [
        {
          merchant: merchantId,
          transaction: transactionId,
          reference,
          amount: refundAmount,
          currency: transaction.currency,
          mode,
          reason: reason || null,
          destinationBankCode,
          destinationAccountNumber,
          destinationAccountName,
          status: 'processing',
        },
      ],
      { session, ordered: true }
    );
    refund = created;

    await postDoubleEntry({
      entryGroup: `refund_${refund._id}`,
      amount: refundAmount,
      currency: transaction.currency,
      sourceType: 'refund',
      sourceRef: refund._id.toString(),
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Refund issued' },
      credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Funds moved to clearing pending bank confirmation' },
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
    action: 'refund.requested',
    entityType: 'Refund',
    entityRef: refund._id.toString(),
    metadata: { transactionId, amount: refundAmount, mode },
  });

  try {
    const result = await sendRefundToBank(refund);
    refund.status = result.success ? 'successful' : 'failed';
    refund.providerRef = result.providerRef || null;
    if (!result.success) refund.failureReason = result.reason || 'provider_declined';
    await refund.save();

    if (!result.success) {
      await reverseRefund(refund);
    }
  } catch (err) {
    refund.failureReason = `provider_call_error: ${err.message}`;
    await refund.save();
  }

  return refund;
}

async function reverseRefund(refund) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await creditWallet(refund.merchant, refund.amount, session, refund.currency, refund.mode || 'live');
    await postDoubleEntry({
      entryGroup: `refund_reversal_${refund._id}`,
      amount: refund.amount,
      currency: refund.currency,
      sourceType: 'reversal',
      sourceRef: refund._id.toString(),
      debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Refund reversal' },
      credit: { accountType: 'merchant_wallet', accountRef: refund.merchant.toString(), description: 'Refund reversal - funds returned' },
      session,
    });
    refund.status = 'reversed';
    await refund.save({ session });
    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function listForMerchant(merchantId) {
  return Refund.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, refundId) {
  const refund = await Refund.findOne({ _id: refundId, merchant: merchantId });
  if (!refund) throw new Error('refund_not_found');
  return refund;
}

module.exports = { requestRefund, listForMerchant, getForMerchant };
