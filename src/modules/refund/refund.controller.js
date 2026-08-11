// src/modules/refund/refund.controller.js
const { requestRefund, listForMerchant, getForMerchant } = require('./refund.service');

async function create(req, res) {
  try {
    const {
      transactionId,
      amount,
      reason,
      destinationBankCode,
      destinationAccountNumber,
      destinationAccountName,
    } = req.body;

    const refund = await requestRefund({
      merchantId: req.merchant.id,
      transactionId,
      amount,
      reason,
      destinationBankCode,
      destinationAccountNumber,
      destinationAccountName,
    });

    res.status(201).json({ status: true, data: refund });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function list(req, res) {
  const refunds = await listForMerchant(req.merchant.id);
  res.json({ status: true, data: refunds });
}

async function getOne(req, res) {
  try {
    const refund = await getForMerchant(req.merchant.id, req.params.id);
    res.json({ status: true, data: refund });
  } catch (err) {
    res.status(404).json({ status: false, message: err.message });
  }
}

module.exports = { create, list, getOne };
