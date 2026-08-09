// src/middleware/auth.middleware.js
const Merchant = require('../modules/merchant/merchant.model');
const { hashSecretKey } = require('../utils/apiKeys');

// Every merchant-facing API call (create customer, assign account, etc.)
// must be authenticated with the merchant's own secret key, exactly like
// Paystack's "Authorization: Bearer sk_test_xxx" pattern.
async function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const [, key] = header.split('Bearer ');

  if (!key) {
    return res.status(401).json({ status: false, message: 'missing_api_key' });
  }

  const merchant = await Merchant.findOne({ secretKeyHash: hashSecretKey(key) });
  if (!merchant) {
    return res.status(401).json({ status: false, message: 'invalid_api_key' });
  }

  req.merchant = { id: merchant._id, businessName: merchant.businessName };
  next();
}

module.exports = { requireApiKey };
