// src/utils/webhookSignature.js
// Every webhook the mock bank partner sends is HMAC-signed so the receiver
// can prove it really came from the bank partner and wasn't forged/replayed
// by a third party pretending a payment succeeded.

const crypto = require('crypto');
const { bankWebhookSecret } = require('../config/env');

function signPayload(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha512', bankWebhookSecret).update(body).digest('hex');
}

function verifySignature(payload, signature) {
  const expected = signPayload(payload);
  // Constant-time compare to avoid timing attacks
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signPayload, verifySignature };
