// src/modules/bankPartner/rexxPayBankClient.js
const crypto = require('crypto');
const axios = require('axios');
const { rexxPayBankBaseUrl, rexxPayBankPayoutSecret, linkedServiceName } = require('../../config/env');

function signPayload(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha512', rexxPayBankPayoutSecret).update(body).digest('hex');
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendPayoutInstruction({
  idempotencyKey,
  amountMajorUnits,
  destinationAccountNumber,
  destinationBank,
  destinationAccountName,
}) {
  if (!rexxPayBankPayoutSecret) {
    throw new Error('rexxpay_bank_payout_secret_not_configured');
  }

  const payload = {
    idempotencyKey,
    linkedService: linkedServiceName,
    destinationAccountNumber,
    destinationBank,
    destinationAccountName,
    amount: amountMajorUnits,
  };

  const signature = signPayload(payload);
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post(`${rexxPayBankBaseUrl}/api/v1/payouts`, payload, {
        headers: { 'x-swiftpay-signature': signature, 'Content-Type': 'application/json' },
        timeout: 45000,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 402,
      });

      return {
        httpStatus: response.status,
        success: response.data?.status === true,
        duplicate: !!response.data?.duplicate,
        payout: response.data?.data || null,
      };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const isRetryable = RETRYABLE_STATUS.has(status) || err.code === 'ECONNABORTED' || !err.response;

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        break;
      }

      const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
      const backoff = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 300;

      await sleep(backoff);
    }
  }

  const message = lastErr.response?.data?.message || lastErr.message;
  const err = new Error(`rexxpay_bank_payout_call_failed: ${message}`);
  err.cause = lastErr;
  err.ambiguousOutcome = true;
  throw err;
}

// TEST MODE ONLY. Makes NO network call - no real bank, no real money,
// ever. Mirrors the real client's return shape exactly so payout.service.js
// doesn't need to know which one it's talking to. Convention (like
// Stripe/Paystack test cards): a destination account number ending in
// "0000" simulates a bank decline, so integrators can test their failure
// handling without needing a real failure from RexxPay Bank.
async function simulatePayoutInstruction({
  idempotencyKey,
  amountMajorUnits,
  destinationAccountNumber,
}) {
  await sleep(300 + Math.random() * 400); // feels like a real network round-trip

  const simulateDecline = String(destinationAccountNumber || '').endsWith('0000');

  if (simulateDecline) {
    return {
      httpStatus: 402,
      success: false,
      duplicate: false,
      payout: { failureReason: 'simulated_test_mode_decline' },
    };
  }

  return {
    httpStatus: 200,
    success: true,
    duplicate: false,
    payout: { providerReference: `test_${idempotencyKey}` },
  };
}

module.exports = { sendPayoutInstruction, simulatePayoutInstruction };
