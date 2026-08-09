// src/utils/apiKeys.js
const crypto = require('crypto');

// Paystack-style key pairs: a public key (safe on frontend) and a secret
// key (server-side only, used to authenticate API calls + sign requests).
function generateKeyPair(mode = 'test') {
  const publicKey = `pk_${mode}_${crypto.randomBytes(20).toString('hex')}`;
  const secretKey = `sk_${mode}_${crypto.randomBytes(20).toString('hex')}`;
  return { publicKey, secretKey };
}

function hashSecretKey(secretKey) {
  return crypto.createHash('sha256').update(secretKey).digest('hex');
}

module.exports = { generateKeyPair, hashSecretKey };
