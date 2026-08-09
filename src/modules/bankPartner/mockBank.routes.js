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

module.exports = router;
