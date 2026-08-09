// src/modules/transaction/transaction.controller.js
const { listForMerchant } = require('./transaction.service');

async function list(req, res) {
  const transactions = await listForMerchant(req.merchant.id);
  res.json({ status: true, data: transactions });
}

module.exports = { list };
