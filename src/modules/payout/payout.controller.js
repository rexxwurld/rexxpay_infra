// src/modules/payout/payout.controller.js
const { requestPayout, listForMerchant } = require('./payout.service');

async function create(req, res) {
  try {
    const { amount, currency, destinationBankCode, destinationAccountNumber, destinationAccountName } = req.body;
    const payout = await requestPayout({
      merchantId: req.merchant.id,
      amount,
      currency,
      destinationBankCode,
      destinationAccountNumber,
      destinationAccountName,
    });
    res.status(201).json({ status: true, data: payout });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function list(req, res) {
  try {
    const payouts = await listForMerchant(req.merchant.id);
    res.json({ status: true, data: payouts });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
}

module.exports = { create, list };
