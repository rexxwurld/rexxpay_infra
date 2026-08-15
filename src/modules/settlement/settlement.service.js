// src/modules/settlement/settlement.service.js
//
// The piece that was missing entirely: nothing previously moved a
// transaction (or the wallet money behind it) out of
// pendingSettlementBalance. Money was available for payout the instant
// a webhook credited it. This service is meant to run on a schedule
// (see scripts/run-settlement.js) and performs both phases of the
// pipeline:
//
//   pending_settlement --(past SETTLEMENT_CUTOFF_MINUTES)--> settled
//   settled            --(past SETTLEMENT_AVAILABILITY_DELAY_MINUTES)--> available
//                            (this is the phase that actually moves
//                             wallet money into the payable balance)

const crypto = require('crypto');
const mongoose = require('mongoose');
const Transaction = require('../transaction/transaction.model');
const SettlementBatch = require('./settlement.model');
const { moveToAvailable, getOrCreateWallet } = require('../wallet/wallet.service');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');

function newBatchReference() {
  return `stlbatch_${crypto.randomBytes(10).toString('hex')}`;
}

/**
 * Phase 1: pending_settlement -> settled.
 * No wallet balance movement here - this phase only marks eligibility.
 * Separated from phase 2 so a business rule change to "hold settled
 * funds an extra day before they're payable" doesn't require touching
 * this phase at all.
 */
async function runSettlePhase({ currency = 'NGN', now = new Date() } = {}) {
  const cutoffTime = new Date(now.getTime() - limits.SETTLEMENT_CUTOFF_MINUTES * 60 * 1000);

  const batch = await SettlementBatch.create({
    batchReference: newBatchReference(),
    phase: 'settle',
    currency,
    cutoffTime,
    status: 'processing',
  });

  const eligible = await Transaction.find({
    currency,
    settlementStatus: 'pending_settlement',
    createdAt: { $lte: cutoffTime },
  })
    .limit(limits.SETTLEMENT_BATCH_SIZE)
    .lean();

  let totalAmount = 0;
  const failedIds = [];

  for (const txn of eligible) {
    try {
      const updated = await Transaction.findOneAndUpdate(
        { _id: txn._id, settlementStatus: 'pending_settlement' },
        { $set: { settlementStatus: 'settled', settledAt: now, settlementBatch: batch._id } },
        { new: true }
      );
      if (updated) totalAmount += updated.netAmount;
    } catch (err) {
      failedIds.push(txn._id);
    }
  }

  batch.status = failedIds.length && failedIds.length === eligible.length ? 'failed' : 'completed';
  batch.transactionCount = eligible.length - failedIds.length;
  batch.totalAmount = totalAmount;
  batch.failedTransactionIds = failedIds;
  batch.completedAt = new Date();
  await batch.save();

  await auditLog.record({
    actorType: 'system',
    actorRef: 'settlement_service',
    action: 'settlement.batch_settled',
    entityType: 'SettlementBatch',
    entityRef: batch._id.toString(),
    metadata: {
      currency,
      transactionCount: batch.transactionCount,
      totalAmount,
      failedCount: failedIds.length,
    },
  });

  return batch;
}

/**
 * Phase 2: settled -> available. This is the phase that actually moves
 * money in Wallet.pendingSettlementBalance into Wallet.balance (payable).
 * Each transaction is processed in its own DB transaction so one
 * malformed record can't roll back the whole batch - same pattern as
 * payout.service.js's requestBulkPayout.
 */
async function runMakeAvailablePhase({ currency = 'NGN', now = new Date() } = {}) {
  const cutoffTime = new Date(now.getTime() - limits.SETTLEMENT_AVAILABILITY_DELAY_MINUTES * 60 * 1000);

  const batch = await SettlementBatch.create({
    batchReference: newBatchReference(),
    phase: 'make_available',
    currency,
    cutoffTime,
    status: 'processing',
  });

  const eligible = await Transaction.find({
    currency,
    settlementStatus: 'settled',
    settledAt: { $lte: cutoffTime },
  })
    .limit(limits.SETTLEMENT_BATCH_SIZE)
    .lean();

  let totalAmount = 0;
  const failedIds = [];

  for (const txn of eligible) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const wallet = await getOrCreateWallet(txn.merchant, txn.currency, session);
      await moveToAvailable(wallet._id, txn.netAmount, session);

      await Transaction.updateOne(
        { _id: txn._id, settlementStatus: 'settled' },
        { $set: { settlementStatus: 'available', availableAt: now, settlementBatch: batch._id } },
        { session }
      );

      await session.commitTransaction();
      session.endSession();
      totalAmount += txn.netAmount;
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      failedIds.push(txn._id);
      // A transaction stuck here (e.g. insufficient_pending_settlement_balance)
      // means the wallet's bucket totals have drifted from what the
      // Transaction collection expects - that's a data integrity issue,
      // not a transient failure, so it's worth its own critical log
      // beyond the batch-level summary below.
      await auditLog.record({
        actorType: 'system',
        actorRef: 'settlement_service',
        action: 'settlement.make_available_failed',
        entityType: 'Transaction',
        entityRef: txn._id.toString(),
        severity: 'critical',
        metadata: { error: err.message, merchant: txn.merchant.toString(), amount: txn.netAmount },
      });
    }
  }

  batch.status = failedIds.length && failedIds.length === eligible.length ? 'failed' : 'completed';
  batch.transactionCount = eligible.length - failedIds.length;
  batch.totalAmount = totalAmount;
  batch.failedTransactionIds = failedIds;
  batch.completedAt = new Date();
  await batch.save();

  await auditLog.record({
    actorType: 'system',
    actorRef: 'settlement_service',
    action: 'settlement.batch_made_available',
    entityType: 'SettlementBatch',
    entityRef: batch._id.toString(),
    metadata: {
      currency,
      transactionCount: batch.transactionCount,
      totalAmount,
      failedCount: failedIds.length,
    },
  });

  return batch;
}

/**
 * Runs both phases back to back for a currency. This is what the cron
 * entrypoint (scripts/run-settlement.js) calls.
 */
async function runSettlementCycle({ currency = 'NGN' } = {}) {
  const now = new Date();
  const settleBatch = await runSettlePhase({ currency, now });
  const availableBatch = await runMakeAvailablePhase({ currency, now });
  return { settleBatch, availableBatch };
}

async function listBatches({ currency, phase, limit = 50 } = {}) {
  const query = {};
  if (currency) query.currency = currency;
  if (phase) query.phase = phase;
  return SettlementBatch.find(query).sort({ createdAt: -1 }).limit(limit);
}

module.exports = {
  runSettlePhase,
  runMakeAvailablePhase,
  runSettlementCycle,
  listBatches,
};
