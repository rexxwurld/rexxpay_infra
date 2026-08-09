// src/modules/transaction/transaction.service.js
const Transaction = require('./transaction.model');
const { creditWallet } = require('../wallet/wallet.service');

// Called only from the verified webhook handler - this is the single place
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
  // Idempotency: if this exact bank reference/transaction reference was
  // already processed (e.g. the bank retried the webhook), don't double-credit.
  const existing = await Transaction.findOne({ reference });
  if (existing) return { transaction: existing, duplicate: true };

  let status = 'success';
  if (amountExpected != null) {
    if (amountReceived < amountExpected) status = 'partial';
    else if (amountReceived > amountExpected) status = 'over';
  }

  const transaction = await Transaction.create({
    reference,
    merchant: merchantId,
    customer: customerId,
    virtualAccount: virtualAccountId,
    amountExpected: amountExpected ?? null,
    amountReceived,
    currency,
    status,
    bankReference,
  });

  // Credit the merchant's wallet with exactly what was received - never
  // with the expected amount, and never before the bank confirmed it.
  await creditWallet(merchantId, amountReceived);

  return { transaction, duplicate: false };
}

async function listForMerchant(merchantId) {
  return Transaction.find({ merchant: merchantId }).sort({ createdAt: -1 });
}

module.exports = { recordIncomingPayment, listForMerchant };
