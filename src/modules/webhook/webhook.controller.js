// src/modules/webhook/webhook.controller.js
const { verifySignature } = require('../../utils/webhookSignature');
const { findByAccountNumber } = require('../virtualAccount/virtualAccount.service');
const { recordIncomingPayment } = require('../transaction/transaction.service');

// This is the endpoint the (mock) bank partner calls when money lands on
// one of the pooled account numbers. It is the ONLY trusted source of
// "payment succeeded" - nothing else in this codebase is allowed to mark
// a transaction as successful or credit a wallet.
async function receiveBankWebhook(req, res) {
  const signature = req.headers['x-bank-signature'];

  if (!verifySignature(req.body, signature)) {
    // Do not process. Do not credit. Log for fraud review in a real system.
    return res.status(401).json({ status: false, message: 'invalid_signature' });
  }

  const { accountNumber, amountReceived, currency, bankReference } = req.body;

  if (!accountNumber || !Number.isInteger(amountReceived) || amountReceived <= 0) {
    return res.status(400).json({ status: false, message: 'invalid_payload' });
  }

  const account = await findByAccountNumber(accountNumber);
  if (!account || account.status !== 'assigned') {
    // Money landed on an account we don't recognize as actively assigned -
    // this needs manual reconciliation, not an automatic credit.
    return res.status(404).json({ status: false, message: 'unrecognized_or_inactive_account' });
  }

  const { transaction, duplicate } = await recordIncomingPayment({
    reference: bankReference, // bank's own ID doubles as our idempotency key
    merchantId: account.merchant,
    customerId: account.customer,
    virtualAccountId: account._id,
    amountReceived,
    amountExpected: null, // dedicated virtual accounts are reusable, no fixed expected amount
    currency: currency || 'NGN',
    bankReference,
  });

  return res.status(200).json({ status: true, duplicate, data: transaction });
}

module.exports = { receiveBankWebhook };
