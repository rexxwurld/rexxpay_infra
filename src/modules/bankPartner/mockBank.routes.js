// src/modules/bankPartner/mockBank.routes.js
// This route stands in for "someone using their real bank app to transfer
// money." It is NOT part of the real payment infra - it exists so you can
// test the full loop locally: simulate a transfer -> mock bank signs and
// fires a webhook -> RexxPay verifies it -> wallet gets credited.
//
// Delete or disable this route entirely before going anywhere near
// production; a real bank partner would never let a client trigger its
// own "payment succeeded" event.

const express = require('express');
const router = express.Router();
const axios = require('axios'); // add "axios" to package.json if you wire this up
const { nanoid } = require('nanoid');
const { signPayload } = require('../../utils/webhookSignature');
const WebhookEvent = require('../webhook/webhookEvent.model');
const Transaction = require('../transaction/transaction.model');

router.post('/simulate-transfer', async (req, res) => {
  const { accountNumber, amount, currency = 'NGN' } = req.body;

  if (!accountNumber || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ status: false, message: 'accountNumber and integer amount (minor units) are required' });
  }

  const payload = {
    accountNumber,
    amountReceived: amount,
    currency,
    bankReference: `bank_${nanoid(16)}`,
  };
  const signature = signPayload(payload);

  // Fire the webhook to our own server, exactly like a real bank partner would.
  const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/bank`;
  const response = await axios.post(webhookUrl, payload, {
    headers: { 'x-bank-signature': signature, 'Content-Type': 'application/json' },
  });

  res.json({ status: true, message: 'simulated transfer sent to webhook', webhookResponse: response.data });
});

// Dev-only: lets simulate-transfer.html poll for what actually happened to
// the webhook it just fired, instead of the POST above's 202 ("queued for
// processing") being mistaken for "the payment succeeded". Not meant for
// merchant/production use - no auth on purpose, same as the rest of this
// mock-bank router.
router.get('/simulate-transfer/:eventId/status', async (req, res) => {
  const event = await WebhookEvent.findById(req.params.eventId).catch(() => null);
  if (!event) {
    return res.status(404).json({ status: false, message: 'event_not_found' });
  }

  const result = {
    eventStatus: event.status, // queued | processing | processed | failed
    lastError: event.lastError || null,
    attempts: event.attempts,
  };

  if (event.status === 'processed') {
    const bankReference = event.rawBody?.bankReference;
    const transaction = bankReference
      ? await Transaction.findOne({ reference: bankReference })
      : null;

    result.transactionStatus = transaction?.status || null; // success | partial | over | flagged | failed
    result.flagReason = transaction?.flagReason || null;
    result.amountReceived = transaction?.amountReceived ?? null;
  }

  res.json({ status: true, data: result });
});

module.exports = router;
