// src/modules/dispute/dispute.service.js
const mongoose = require('mongoose');
const Dispute = require('./dispute.model');
const Transaction = require('../transaction/transaction.model');
const { debitWallet, creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

// Opens a dispute and immediately FREEZES the disputed amount out of the
// merchant's wallet into the 'suspense' ledger account - the ledger
// schema already reserved this accountType for exactly this case, it was
// just never posted to. Freezing on open (not on resolution) matches how
// real card-network chargebacks work: the money leaves the merchant the
// moment the claim is filed, not after it's decided.
async function openDispute({ merchantId, transactionId, amount, reason, reasonDetail }) {
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) throw new Error('transaction_not_found');
  if (transaction.merchant.toString() !== merchantId.toString()) {
    throw new Error('transaction_not_found');
  }
  if (!['success', 'partial', 'over'].includes(transaction.status)) {
    throw new Error('transaction_not_disputable');
  }

  const disputeAmount = amount == null ? transaction.amountReceived : amount;
  if (!Number.isInteger(disputeAmount) || disputeAmount <= 0) {
    throw new Error('invalid_dispute_amount');
  }

  const evidenceDueBy = new Date(Date.now() + limits.DISPUTE_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const session = await mongoose.startSession();
  let dispute;
  try {
    session.startTransaction();

    // Freeze first, inside the same DB transaction as the Dispute record
    // and ledger entries - same pattern as refunds/payouts. If the
    // merchant's wallet doesn't hold the funds, this throws and nothing
    // is created.
    await debitWallet(merchantId, disputeAmount, session, transaction.currency);

    const [created] = await Dispute.create(
      [
        {
          merchant: merchantId,
          transaction: transactionId,
          amount: disputeAmount,
          currency: transaction.currency,
          reason: reason || 'other',
          reasonDetail: reasonDetail || null,
          status: 'open',
          evidenceDueBy,
        },
      ],
      { session, ordered: true }
    );
    dispute = created;

    await postDoubleEntry({
      entryGroup: `dispute_${dispute._id}`,
      amount: disputeAmount,
      currency: transaction.currency,
      sourceType: 'adjustment',
      sourceRef: dispute._id.toString(),
      debit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Funds frozen pending dispute' },
      credit: { accountType: 'suspense', accountRef: `dispute_${dispute._id}`, description: 'Disputed funds held in suspense' },
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
    actorType: 'system',
    actorRef: 'dispute_intake',
    action: 'dispute.opened',
    entityType: 'Dispute',
    entityRef: dispute._id.toString(),
    severity: 'critical',
    metadata: { transactionId, amount: disputeAmount, reason },
  });

  return dispute;
}

async function submitEvidence({ merchantId, disputeId, description, url }) {
  const dispute = await Dispute.findOne({ _id: disputeId, merchant: merchantId });
  if (!dispute) throw new Error('dispute_not_found');
  if (!['open', 'under_review'].includes(dispute.status)) {
    throw new Error('dispute_already_resolved');
  }
  if (!description) throw new Error('evidence_description_required');

  dispute.evidence.push({ description, url: url || null, submittedAt: new Date() });
  dispute.status = 'under_review';
  await dispute.save();

  await auditLog.record({
    actorType: 'merchant',
    actorRef: merchantId.toString(),
    action: 'dispute.evidence_submitted',
    entityType: 'Dispute',
    entityRef: dispute._id.toString(),
  });

  return dispute;
}

// Admin-only resolution. 'won' releases the frozen funds back to the
// merchant's wallet. 'lost' leaves them out of the merchant's wallet
// permanently and moves them from suspense to platform_clearing, where
// a real integration would actually wire the funds back to the card
// network/customer's bank.
async function resolveDispute({ disputeId, outcome, resolution }) {
  if (!['won', 'lost'].includes(outcome)) throw new Error('invalid_outcome');

  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new Error('dispute_not_found');
  if (!['open', 'under_review'].includes(dispute.status)) {
    throw new Error('dispute_already_resolved');
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    if (outcome === 'won') {
      await creditWallet(dispute.merchant, dispute.amount, session, dispute.currency);
      await postDoubleEntry({
        entryGroup: `dispute_resolution_${dispute._id}`,
        amount: dispute.amount,
        currency: dispute.currency,
        sourceType: 'reversal',
        sourceRef: dispute._id.toString(),
        debit: { accountType: 'suspense', accountRef: `dispute_${dispute._id}`, description: 'Dispute won - releasing frozen funds' },
        credit: { accountType: 'merchant_wallet', accountRef: dispute.merchant.toString(), description: 'Dispute won - funds returned to wallet' },
        session,
      });
    } else {
      await postDoubleEntry({
        entryGroup: `dispute_resolution_${dispute._id}`,
        amount: dispute.amount,
        currency: dispute.currency,
        sourceType: 'adjustment',
        sourceRef: dispute._id.toString(),
        debit: { accountType: 'suspense', accountRef: `dispute_${dispute._id}`, description: 'Dispute lost - releasing suspense' },
        credit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Dispute lost - funds leaving platform to customer/card network' },
        session,
      });
    }

    dispute.status = outcome;
    dispute.resolution = resolution || null;
    dispute.resolvedAt = new Date();
    await dispute.save({ session });

    await session.commitTransaction();
    session.endSession();
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }

  await auditLog.record({
    actorType: 'system',
    actorRef: 'dispute_resolution',
    action: `dispute.${outcome}`,
    entityType: 'Dispute',
    entityRef: dispute._id.toString(),
    severity: 'critical',
    metadata: { resolution },
  });

  return dispute;
}

async function listForMerchant(merchantId) {
  return Dispute.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

async function getForMerchant(merchantId, disputeId) {
  const dispute = await Dispute.findOne({ _id: disputeId, merchant: merchantId });
  if (!dispute) throw new Error('dispute_not_found');
  return dispute;
}

module.exports = { openDispute, submitEvidence, resolveDispute, listForMerchant, getForMerchant };
