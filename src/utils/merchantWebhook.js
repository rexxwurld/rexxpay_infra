// src/utils/merchantWebhook.js
const crypto = require('crypto');
const axios = require('axios');
const auditLog = require('../modules/audit/auditLog.service');

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 8000;

function signPayload(rawBody, secret) {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

async function dispatchMerchantWebhook(merchant, event, attempt = 1) {
  if (!merchant?.webhookUrl) return;
  if (!merchant?.webhookSecret) {
    console.warn(`[merchantWebhook] merchant ${merchant._id} has webhookUrl but no webhookSecret - skipping`);
    return;
  }

  const rawBody = JSON.stringify({
    event: event.type,
    data: event.data,
    sentAt: new Date().toISOString(),
  });
  const signature = signPayload(rawBody, merchant.webhookSecret);

  try {
    await axios.post(merchant.webhookUrl, rawBody, {
      headers: { 'Content-Type': 'application/json', 'X-SwiftPay-Signature': signature },
      timeout: TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) {
      await auditLog.record({
        actorType: 'system',
        actorRef: 'merchant_webhook_dispatcher',
        action: 'merchant_webhook.delivery_failed_permanently',
        severity: 'critical',
        metadata: { merchantId: merchant._id.toString(), url: merchant.webhookUrl, eventType: event.type, error: err.message },
      });
      return;
    }
    const backoffMs = 2000 * attempt;
    setTimeout(() => { dispatchMerchantWebhook(merchant, event, attempt + 1).catch(() => {}); }, backoffMs);
  }
}

module.exports = { dispatchMerchantWebhook, signPayload };
