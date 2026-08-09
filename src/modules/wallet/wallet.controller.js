// src/modules/wallet/wallet.controller.js
const { getOrCreateWallet } = require('./wallet.service');

async function getWallet(req, res) {
  const wallet = await getOrCreateWallet(req.merchant.id);
  res.json({ status: true, data: wallet });
}

module.exports = { getWallet };
