// src/modules/wallet/wallet.controller.js
const { getOrCreateWallet, listWallets } = require('./wallet.service');
const { normalizeCurrency } = require('../../config/currencies');

// GET /api/wallet             -> NGN wallet (back-compat, single-object shape)
// GET /api/wallet?currency=USD -> that currency's wallet
async function getWallet(req, res) {
  try {
    const currency = normalizeCurrency(req.query.currency || 'NGN');
    const wallet = await getOrCreateWallet(req.merchant.id, currency);
    res.json({ status: true, data: wallet });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

// GET /api/wallet/all -> every currency wallet the merchant holds
async function getAllWallets(req, res) {
  const wallets = await listWallets(req.merchant.id);
  res.json({ status: true, data: wallets });
}

module.exports = { getWallet, getAllWallets };
