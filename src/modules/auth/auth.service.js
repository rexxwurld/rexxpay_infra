// src/modules/auth/auth.service.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Merchant = require('../merchant/merchant.model');
const { generateKeyPair, hashSecretKey } = require('../../utils/apiKeys');
const { jwtSecret, jwtExpiresIn } = require('../../config/env');

async function registerMerchant({ businessName, email, password }) {
  const existing = await Merchant.findOne({ email });
  if (existing) throw new Error('email_already_registered');

  const passwordHash = await bcrypt.hash(password, 10);
  const { publicKey, secretKey } = generateKeyPair('test');

  const merchant = await Merchant.create({
    businessName,
    email,
    passwordHash,
    publicKey,
    secretKeyHash: hashSecretKey(secretKey),
  });

  // The raw secret key is only ever shown once, at creation time - exactly
  // like Paystack/Stripe. If lost, the merchant must regenerate it.
  return { merchant, secretKey };
}

async function loginMerchant({ email, password }) {
  const merchant = await Merchant.findOne({ email });
  if (!merchant) throw new Error('invalid_credentials');

  const valid = await bcrypt.compare(password, merchant.passwordHash);
  if (!valid) throw new Error('invalid_credentials');

  const token = jwt.sign({ id: merchant._id }, jwtSecret, { expiresIn: jwtExpiresIn });
  return { merchant, token };
}

module.exports = { registerMerchant, loginMerchant };
