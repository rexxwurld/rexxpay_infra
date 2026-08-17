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

  // amount == null means "refund whatever is still refundable". We don't
  // know that number for certain until we're inside the atomic guard
  // below (another request could be settling concurrently), so this is
  // just the best-effort amount used for the initial validation error
  // message - the real, race-proof check happens in the
  // findOneAndUpdate further down.
  const bestEffortRefundable = transaction.amountReceived - transaction.refundedAmount;
  const refundAmount = amount == null ? bestEffortRefundable : amount;
  if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
    throw new Error('invalid_refund_amount');
  }

  const reference = `rf_${crypto.randomBytes(12).toString('hex')}`;

  const session = await mongoose.startSession();
  let refund;
  try {
    session.startTransaction();

    // THE fix: atomically claim `refundAmount` of refundable headroom on
    // the transaction itself, in the same step as checking it's
    // available. This is a compare-and-increment on a single document -
    // like wallet.service.js's reserveFunds - so two concurrent refund
    // requests can never both succeed in claiming more than
    // amountReceived combined, regardless of what either request read
    // before starting its session. Previously, "amount already
    // refunded" was computed by summing prior Refund documents *before*
    // opening the session, which left a window where two concurrent
    // requests could both read the same total, both pass validation,
    // and together over-refund the transaction.
    const claimed = await Transaction.findOneAndUpdate(
      {
        _id: transactionId,
        $expr: {
          $gte: [
            { $subtract: ['$amountReceived', '$refundedAmount'] },
            refundAmount,
          ],
        },
      },
      { $inc: { refundedAmount: refundAmount } },
      { new: true, session }
    );

    if (!claimed) {
      throw new Error('refund_exceeds_refundable_amount');
    }

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

    // Give back the refundable headroom we atomically claimed in
    // requestRefund, so a reversed/failed refund doesn't permanently
    // eat into how much of this transaction can still be refunded.
    await Transaction.updateOne(
      { _id: refund.transaction },
      { $inc: { refundedAmount: -refund.amount } },
      { session }
    );

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
