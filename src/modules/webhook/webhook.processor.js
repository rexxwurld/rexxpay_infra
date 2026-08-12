// src/modules/webhook/webhook.processor.js
const WebhookEvent = require('./webhookEvent.model');
const { findByAccountNumber } = require('../virtualAccount/virtualAccount.service');
const { recordIncomingPayment } = require('../transaction/transaction.service');
const Merchant = require('../merchant/merchant.model');
const { dispatchMerchantWebhook } = require('../../utils/merchantWebhook');
const { markInvoicePaidByTransaction } = require('../subscription/subscription.service');
const auditLog = require('../audit/auditLog.service');

const MAX_ATTEMPTS = 5;

async function enqueue({ rawBody, signature }) {
  const event = await WebhookEvent.create({ rawBody, signature, status: 'queued' });
  setImmediate(() => processEvent(event._id).catch((err) => {
    console.error('[webhook.processor] unhandled error processing event', event._id.toString(), err.message);
  }));
  return event;
}

async function processEvent(eventId) {
  const event = await WebhookEvent.findById(eventId);
  if (!event || event.status === 'processed') return;

  event.status = 'processing';
  event.attempts += 1;
  await event.save();

  try {
    const { accountNumber, amountReceived, currency, bankReference } = event.rawBody;

    if (!accountNumber || !Number.isInteger(amountReceived) || amountReceived <= 0) {
      throw new Error('invalid_payload');
    }

    const account = await findByAccountNumber(accountNumber);
    if (!account || account.status !== 'assigned') {
      await auditLog.record({
        actorType: 'system',
        actorRef: 'webhook_processor',
        action: 'webhook.unrecognized_account',
        severity: 'critical',
        metadata: { accountNumber, bankReference },
      });
      event.status = 'failed';
      event.lastError = 'unrecognized_or_inactive_account';
      await event.save();
      return;
    }

    const { transaction, duplicate } = await recordIncomingPayment({
      reference: bankReference,
      merchantId: account.merchant,
      customerId: account.customer,
      virtualAccountId: account._id,
      amountReceived,
      amountExpected: account.amountExpected ?? null,
      currency: currency || 'NGN',
      bankReference,
    });

    if (!duplicate && transaction.status !== 'flagged') {
      const merchant = await Merchant.findById(account.merchant);
      dispatchMerchantWebhook(merchant, {
        type: 'transaction.success',
        // account.reference is the merchant's own tx_ref (set at
        // /payments/initialize time). The bare Transaction document only
        // carries the bank's reference/bankReference, so without this a
        // merchant's webhook receiver has no reliable way to match the
        // notification back to one of their orders.
        data: { ...transaction.toObject(), tx_ref: account.reference },
      }).catch(() => {});

      // If this payment landed on an invoice's virtual account, mark it
      // paid. A no-op (returns null) for ordinary one-off payments.
      markInvoicePaidByTransaction(transaction).catch((err) => {
        console.error('[webhook.processor] failed to reconcile invoice for transaction', transaction._id.toString(), err.message);
      });
    }

    event.status = 'processed';
    event.processedAt = new Date();
    await event.save();
  } catch (err) {
    event.lastError = err.message;
    event.status = event.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    await event.save();

    if (event.status === 'failed') {
      await auditLog.record({
        actorType: 'system',
        actorRef: 'webhook_processor',
        action: 'webhook.processing_failed_permanently',
        severity: 'critical',
        metadata: { eventId: event._id.toString(), error: err.message },
      });
    } else {
      const backoffMs = 2000 * event.attempts;
      setTimeout(() => processEvent(event._id).catch(() => {}), backoffMs);
    }
  }
}

async function redriveStuckEvents() {
  const stuck = await WebhookEvent.find({ status: { $in: ['queued', 'processing'] } });
  for (const event of stuck) {
    processEvent(event._id).catch(() => {});
  }
  return stuck.length;
}

module.exports = { enqueue, processEvent, redriveStuckEvents };
