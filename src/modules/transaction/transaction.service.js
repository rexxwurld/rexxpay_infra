// src/modules/transaction/transaction.service.js
const mongoose = require('mongoose');
const Transaction = require('./transaction.model');
const Customer = require('../customer/customer.model');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const { creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');
const { releaseVirtualAccount } = require('../virtualAccount/virtualAccount.service');
const { screenName } = require('../../utils/sanctionsCheck');
const { computeFee } = require('../../utils/feeCalculator');
const Merchant = require('../merchant/merchant.model');
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

  // --- Determine split (if the virtual account this payment landed on
  // has one configured) ------------------------------------------------
  const virtualAccount = await VirtualAccount.findById(virtualAccountId);
  const hasSplit = !!(virtualAccount?.splitSubaccount && virtualAccount?.splitPercentage);
  const splitAmount = hasSplit ? Math.floor((amountReceived * virtualAccount.splitPercentage) / 100) : 0;
  const merchantAmount = amountReceived - splitAmount;

  // --- Platform fee. Charged against the merchant's own share only -
  // never against a subaccount's split, since that money was never the
  // platform's counterparty to begin with. Skipped entirely for
  // flagged/failed transactions, computed below alongside them.
  let platformFee = 0;
  let netAmount = merchantAmount;
  if (status !== 'flagged' && status !== 'failed' && merchantAmount > 0) {
    const merchant = await Merchant.findById(merchantId);
    ({ feeAmount: platformFee, netAmount } = computeFee(merchantAmount, merchant));
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
          splitSubaccount: hasSplit ? virtualAccount.splitSubaccount : null,
          splitAmount,
          platformFee,
          netAmount,
        },
      ],
      { session, ordered: true }
    );

    if (status !== 'flagged' && status !== 'failed') {
      if (hasSplit) {
        // Merchant is credited its share only - never the full amount
        // received. Distinct sourceRef suffixes keep both entries
        // covered by the ledger's own (sourceType, sourceRef,
        // accountRef, direction) uniqueness guard.
        if (netAmount > 0) {
          await creditWallet(merchantId, netAmount, session, currency);
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: netAmount,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:merchant`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Inbound customer payment received' },
            credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Wallet credited for inbound payment (net of split and platform fee)' },
            session,
          });
        }

        if (platformFee > 0) {
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: platformFee,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:fee`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Platform fee taken from inbound payment' },
            credit: { accountType: 'platform_revenue', accountRef: 'platform_revenue', description: 'Platform fee revenue' },
            session,
          });
        }

        if (splitAmount > 0) {
          // Split share accrues to the subaccount's ledger balance -
          // settled out to its bank account separately via
          // subaccountService.settleSubaccount, not credited instantly.
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: splitAmount,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:split`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Inbound customer payment received (split portion)' },
            credit: { accountType: 'subaccount_settlement', accountRef: virtualAccount.splitSubaccount.toString(), description: 'Subaccount split credited' },
            session,
          });
        }
      } else {
        // Credit the merchant's wallet with what was received, net of the
        // platform fee - never with the expected amount, and never before
        // the bank confirmed it.
        if (netAmount > 0) {
          await creditWallet(merchantId, netAmount, session, currency);

          // Ledger: money leaves the platform's clearing account and becomes
          // owed to the merchant. Source-tied idempotency keys mean replaying
          // this function for the same transaction._id can never double-post.
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: netAmount,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: transaction._id.toString(),
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Inbound customer payment received' },
            credit: { accountType: 'merchant_wallet', accountRef: merchantId.toString(), description: 'Wallet credited for inbound payment (net of platform fee)' },
            session,
          });
        }

        if (platformFee > 0) {
          await postDoubleEntry({
            entryGroup: `txn_${transaction._id}`,
            amount: platformFee,
            currency,
            sourceType: 'incoming_payment',
            sourceRef: `${transaction._id.toString()}:fee`,
            debit: { accountType: 'payout_clearing', accountRef: 'platform_clearing', description: 'Platform fee taken from inbound payment' },
            credit: { accountType: 'platform_revenue', accountRef: 'platform_revenue', description: 'Platform fee revenue' },
            session,
          });
        }
      }
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

    // This account's job for this order/request is done - hand it back to
    // the pool so a future order/deposit gets a different account number.
    // 'partial' is deliberately excluded: the account may still be
    // waiting on the remainder of the same payment.
    if (status === 'success' || status === 'over') {
      await releaseVirtualAccount(virtualAccountId).catch((err) => {
        console.error('[transaction] failed to release virtual account after payment:', err.message);
      });
    }

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
