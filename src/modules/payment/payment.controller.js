// src/modules/payment/payment.controller.js
const { initializePayment, verifyPayment } = require('./payment.service');

async function initialize(req, res) {
  try {
    const { amount, customer, tx_ref, redirect_url } = req.body;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    if (req.merchant.mode !== 'test' && req.merchant.mode !== 'live') {
      return res.status(401).json({ status: false, message: 'api_key_required_for_payments' });
    }

    const result = await initializePayment({
      merchantId: req.merchant.id,
      amount,
      customer,
      tx_ref,
      redirect_url,
      baseUrl,
      mode: req.merchant.mode,
    });
    res.status(201).json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function verify(req, res) {
  try {
    const result = await verifyPayment({ merchantId: req.merchant.id, tx_ref: req.params.tx_ref });
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { initialize, verify };
