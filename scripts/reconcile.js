// scripts/reconcile.js
//
// Real payment processors don't just trust their own webhook-driven state
// forever - the bank/BaaS partner sends a periodic (usually daily)
// settlement file listing everything that ACTUALLY cleared on their side.
// This script compares that file against our own Transaction records and
// surfaces mismatches: things we think succeeded that the bank doesn't
// have, and things the bank settled that we never recorded. Both are bugs
// (or fraud) waiting to be found before a customer or auditor finds them
// for you.
//
// Usage:
//   node scripts/reconcile.js path/to/bank-settlement-file.json
//
// Expected settlement file format (this is what a real BaaS partner's
// export would look like, simplified):
//   [
//     { "bankReference": "bnk_abc123", "accountNumber": "9012345678", "amount": 500000, "settledAt": "2026-08-08T10:00:00Z" },
//     ...
//   ]

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { mongoUri } = require('../src/config/env');
const Transaction = require('../src/modules/transaction/transaction.model');

async function reconcile(settlementFilePath) {
  const raw = fs.readFileSync(settlementFilePath, 'utf-8');
  const settledRecords = JSON.parse(raw);

  await mongoose.connect(mongoUri);

  const settledRefs = new Set(settledRecords.map((r) => r.bankReference));
  const settledByRef = new Map(settledRecords.map((r) => [r.bankReference, r]));

  const ourTransactions = await Transaction.find({
    status: { $in: ['success', 'partial', 'over'] },
  }).lean();
  const ourRefs = new Set(ourTransactions.map((t) => t.bankReference));

  // In our records but the bank has no matching settlement -> we may have
  // credited a wallet for money that never actually cleared. Urgent.
  const inOursNotInBank = ourTransactions.filter((t) => !settledRefs.has(t.bankReference));

  // Bank settled it but we have no record -> we may owe a merchant money
  // we haven't credited them for yet (a missed/failed webhook).
  const inBankNotInOurs = settledRecords.filter((r) => !ourRefs.has(r.bankReference));

  // Both sides have it, but the amount disagrees -> partial/over/under
  // credit somewhere.
  const amountMismatches = ourTransactions
    .filter((t) => settledByRef.has(t.bankReference))
    .map((t) => ({ ours: t, bank: settledByRef.get(t.bankReference) }))
    .filter(({ ours, bank }) => ours.amountReceived !== bank.amount);

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      ourTransactions: ourTransactions.length,
      bankSettlements: settledRecords.length,
      matched: ourTransactions.length - inOursNotInBank.length,
    },
    // These need human eyes, not an automatic fix - see README for the
    // recommended next step (hold flagged transactions, alert finance/ops).
    inOursNotInBank: inOursNotInBank.map((t) => ({ reference: t.reference, bankReference: t.bankReference, amountReceived: t.amountReceived })),
    inBankNotInOurs,
    amountMismatches: amountMismatches.map(({ ours, bank }) => ({
      bankReference: ours.bankReference,
      ourAmount: ours.amountReceived,
      bankAmount: bank.amount,
    })),
  };

  console.log(JSON.stringify(report, null, 2));

  if (inOursNotInBank.length || inBankNotInOurs.length || amountMismatches.length) {
    console.error(
      `\n[reconcile] ${inOursNotInBank.length + inBankNotInOurs.length + amountMismatches.length} discrepancy(ies) found - needs manual review.`
    );
    process.exitCode = 1;
  } else {
    console.log('\n[reconcile] clean - no discrepancies.');
  }

  await mongoose.disconnect();
}

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/reconcile.js <settlement-file.json>');
  process.exit(1);
}

reconcile(filePath).catch((err) => {
  console.error('[reconcile] failed:', err);
  process.exit(1);
});
