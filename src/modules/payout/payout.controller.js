// src/modules/payout/payout.controller.js
const { requestPayout, requestBulkPayout, listForMerchant } = require('./payout.service');

async function create(req, res) {
  try {
    const { amount, currency, recipientCode, destinationBankCode, destinationAccountNumber, destinationAccountName } = req.body;
    // Accept an idempotency key either as a header (conventional for
    // this kind of endpoint) or in the body, so existing integrations
    // that already send one in the body don't have to change anything.
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || null;

    const payout = await requestPayout({
      merchantId: req.merchant.id,
      amount,
      currency,
      idempotencyKey,
      recipientCode,
      destinationBankCode,
      destinationAccountNumber,
      destinationAccountName,
    });
    res.status(201).json({ status: true, data: payout });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function createBulk(req, res) {
  try {
    const { currency, items } = req.body;
    const result = await requestBulkPayout({
      merchantId: req.merchant.id,
      currency,
      items,
    });
    res.status(201).json({ status: true, data: result });
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

module.exports = { create, createBulk, list };
