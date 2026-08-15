// src/modules/bankPartner/rexxPayBankClient.js
//
// This is the piece payout.service.js was missing entirely: an actual
// call to RexxPay Bank's payout endpoint. Previously `sendToRealBank()`
// in payout.service.js was a hardcoded stub that always returned
// success without any network call - RexxPay Bank's own payout.service.js
// (POST /api/v1/payouts, see verifySwiftpaySignature.js) has been sitting
// there ready to receive real instructions this whole time.
//
// Signing: RexxPay Bank verifies incoming payout instructions with the
// same HMAC-SHA512-over-JSON-body scheme it uses to sign its own
// outgoing deposit webhooks (see rexxpay-main's utils/webhookSignature.js)
// - header `x-swiftpay-signature`, same shared secret both directions.

const crypto = require('crypto');
const axios = require('axios');
const { rexxPayBankBaseUrl, rexxPayBankPayoutSecret, linkedServiceName } = require('../../config/env');

function signPayload(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha512', rexxPayBankPayoutSecret).update(body).digest('hex');
}

// RexxPay Bank is a Render free-tier instance and can cold-start slowly
// or transiently 429/502/503/504 - same story as bankPartner.service.js's
// account provisioning calls, so the same retry treatment applies here.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a payout instruction to RexxPay Bank and returns its response.
 * Does NOT throw on a well-formed "payout failed" response from the
 * bank (status 402 per rexxpay's payout.controller.js) - that's a valid,
 * final outcome the caller needs to see and reverse against. It DOES
 * throw on network failure, timeout, or an unexpected/malformed
 * response, since those are ambiguous ("did the payout actually happen
 * or not?") and must NOT be treated as a definite failure - see the
 * caller in payout.service.js for how that ambiguity is handled.
 *
 * @param {Object} params
 * @param {string} params.idempotencyKey - SwiftPay's own payout reference. RexxPay
 *   dedupes on this - a retried call with the same key can never pay out twice.
 * @param {number} params.amountMajorUnits - RexxPay Bank wallets are denominated in
 *   major units (naira), NOT the minor units (kobo) SwiftPay uses internally -
 *   caller is responsible for converting before calling this.
 */
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
        headers: {
          'x-swiftpay-signature': signature,
          'Content-Type': 'application/json',
        },
        timeout: 45000,
        // 402 is a real, well-formed "payout failed on the bank side"
        // response for this endpoint (see rexxpay payout.controller.js)
        // - don't let axios throw on it, treat it as data like any 2xx.
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
  // Ambiguous outcome - the bank may or may not have actually processed
  // this before the connection died. Callers must NOT assume failure.
  err.ambiguousOutcome = true;
  throw err;
}

module.exports = { sendPayoutInstruction };
