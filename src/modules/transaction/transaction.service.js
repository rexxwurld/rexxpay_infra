// src/modules/transaction/transaction.service.js
const mongoose = require('mongoose');
const Transaction = require('./transaction.model');
const Customer = require('../customer/customer.model');
const { creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { screenName } = require('../../utils/sanctionsCheck');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

// Called only from the verified webhook processor - this is the single place
// that turns "money arrived at the bank" into "transaction recorded +
// merchant wallet credited". Never expose this as a public API a client
// could call directly to fake a payment.
async function recordIncomingPayment({
  reference,
  merchantId,
  customerId,
  virtualAccountId,
  amountReceived,
  amountExpected,
  currency,
  bankReference,
}) {
  // Idempotency, layer 1: fast-path check before doing any work.
  const existing = await Transaction.findOne({ reference });
  if (existing) return { transaction: existing, duplicate: true };

  // --- Fraud / risk checks (run BEFORE money moves) -----------------
  let flagReason = null;

  if (amountReceived > limits.MAX_SINGLE_PAYMENT_MINOR) {
    flagReason = 'exceeds_max_single_payment';
  }

  if (!flagReason) {
    const windowStart = new Date(Date.now() - limits.VELOCITY_WINDOW_MINUTES * 60 * 1000);
    const recentCount = await Transaction.countDocuments({
      virtualAccount: virtualAccountId,
      createdAt: { $gte: windowStart },
    });
    if (recentCount >= limits.VELOCITY_MAX_COUNT) {
      flagReason = 'velocity_limit_exceeded';
    }
  }

  if (!flagReason) {
    const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [dailyAgg] = await Transaction.aggregate([
      { $match: { merchant: merchantId, createdAt: { $gte: dayStart }, status: { $in: ['success', 'partial', 'over'] } } },
      { $group: { _id: null, total: { $sum: '$amountReceived' } } },
    ]);
    const dailyTotal = (dailyAgg?.total || 0) + amountReceived;
    if (dailyTotal > limits.MAX_DAILY_INBOUND_MINOR) {
      flagReason = 'exceeds_daily_inbound_limit';
    }
  }

  if (!flagReason) {
    const customer = await Customer.findById(customerId);
    if (customer) {
      const screening = screenName(customer.fullName);
      if (screening.hit) flagReason = `sanctions_screen:${screening.reason}`;
    }
  }

  // --- Determine settlement status -----------------------------------
  let status;
  if (flagReason) {
    status = 'flagged';
  } else if (amountExpected != null && amountReceived < amountExpected) {
    status = 'partial';
  } else if (amountExpected != null && amountReceived > amountExpected) {
    status = 'over';
  } else {
    status = 'success';
  }

  // --- Persist transaction, wallet credit, and ledger entries atomically
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const [transaction] = await Transaction.create(
      [
        {
          reference,
          merchant: merchantId,
          customer: customerId,
          virtualAccount: virtualAccountId,
          amountExpected: amountExpected ?? null,
          amountReceived,
          currency,
          status,
          flagReason,
          bankReference,
        },
      ],
      { session, ordered: true }
    );

    if (status !== 'flagged' && status !== 'failed') {
      // Credit the merchant's wallet with exactly what was received - never
      // with the expected amount, and never before the bank confirmed it.
      await creditWallet(merchantId, amountReceived, session);

      // Ledger: money leaves the platform's clearing account and becomes
      // owed to the merchant. Source-tied idempotency keys mean replaying
      // this function for the same transaction._id can never double-post.
      await postDoubleEntry({
        entryGroup: `txn_${transaction._id}`,
        amount: amountReceived,
        currency,
        sourceType: 'incoming_payment',
        sourceRef: transaction._id.toString(),
        debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Inbound customer payment received' },
        credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Wallet credited for inbound payment' },
        session,
      });
    }

    await session.commitTransaction();
    session.endSession();

    await auditLog.record({
      actorType: 'system',
      actorRef: 'webhook_processor',
      action: status === 'flagged' ? 'transaction.flagged' : 'transaction.recorded',
      entityType: 'Transaction',
      entityRef: transaction._id.toString(),
      severity: status === 'flagged' ? 'critical' : 'info',
      metadata: { status, flagReason, amountReceived, merchantId: merchantId.toString() },
    });

    return { transaction, duplicate: false };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    // Idempotency, layer 2: the unique index on `reference` is the real
    // guarantee under concurrency - if two webhook deliveries raced past
    // the findOne check above, one of these inserts loses and lands here.
    if (err.code === 11000) {
      const existingRace = await Transaction.findOne({ reference });
      if (existingRace) return { transaction: existingRace, duplicate: true };
    }
    throw err;
  }
}

async function listForMerchant(merchantId) {
  return Transaction.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

module.exports = { recordIncomingPayment, listForMerchant };
