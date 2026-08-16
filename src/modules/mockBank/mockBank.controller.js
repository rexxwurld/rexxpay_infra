// src/modules/mockBank/mockBank.controller.js
const { simulateBankTransfer } = require('./mockBank.service');

async function simulateTransfer(req, res) {
  try {
    const { accountNumber, amount } = req.body;

    if (!accountNumber) {
      return res.status(400).json({ status: false, message: 'account_number_required' });
    }

    // Requires a TEST secret key specifically - a live key (or a plain
    // dashboard session, which has mode:null) can't be used to fabricate
    // a payment, even accidentally.
    if (req.merchant.mode !== 'test') {
      return res.status(401).json({
        status: false,
        message: 'a_test_secret_key_sk_test_xxx_is_required_for_this_endpoint',
      });
    }

    let amountMinor = null;
    if (amount !== undefined && amount !== null && amount !== '') {
      amountMinor = Math.round(Number(amount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
        return res.status(400).json({ status: false, message: 'invalid_amount' });
      }
    }

    const result = await simulateBankTransfer({
      accountNumber,
      amount: amountMinor,
      merchantId: req.merchant.id,
    });

    res.json({
      status: true,
      data: {
        bankReference: result.bankReference,
        eventStatus: result.event?.status || 'queued',
        transactionStatus: result.transaction?.status || 'pending',
        amountReceived: result.transaction?.amountReceived ?? null,
      },
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { simulateTransfer };
