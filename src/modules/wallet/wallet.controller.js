// src/modules/wallet/wallet.controller.js
const { getOrCreateWallet, listWallets } = require('./wallet.service');
const { normalizeCurrency } = require('../../config/currencies');

async function getWallet(req, res) {
  try {
    const currency = normalizeCurrency(req.query.currency || 'NGN');
    // Dashboard/session logins have no key-derived mode - default those
    // reads to 'live' since that's what a merchant expects to see when
    // just logged into their dashboard. API-key calls use whatever mode
    // the key itself was for.
    const mode = req.merchant.mode || 'live';
    const wallet = await getOrCreateWallet(req.merchant.id, currency, mode);
    res.json({ status: true, data: wallet });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function getAllWallets(req, res) {
  // null mode = return both test and live wallets, each tagged by its
  // own `mode` field, so the dashboard can group/toggle them.
  const wallets = await listWallets(req.merchant.id, req.merchant.mode || null);
  res.json({ status: true, data: wallets });
}

module.exports = { getWallet, getAllWallets };
