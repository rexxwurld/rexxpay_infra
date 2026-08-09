// src/modules/webhook/webhook.processor.js
//
// Separated from the HTTP controller on purpose: the controller's only job
// is to verify + persist + ack fast. This file does the actual work, and
// is the seam where you'd swap "process right after persisting" for
// "a real worker pulls WebhookEvent rows off a queue" (BullMQ/SQS/etc.)
// without touching the HTTP layer at all.

const WebhookEvent = require('./webhookEvent.model');
const { findByAccountNumber } = require('../virtualAccount/virtualAccount.service');
const { recordIncomingPayment } = require('../transaction/transaction.service');
const auditLog = require('../audit/auditLog.service');

const MAX_ATTEMPTS = 5;

async function enqueue({ rawBody, signature }) {
  const event = await WebhookEvent.create({ rawBody, signature, status: 'queued' });
  // Fire-and-forget in-process "worker". This is a stand-in for a real
  // queue consumer - swap this line for pushing `event._id` onto
  // SQS/BullMQ and having a separate worker process call processEvent().
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
      // Money landed on an account we don't recognize as actively assigned.
      // This needs manual reconciliation - not a silent drop.
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

    await recordIncomingPayment({
      reference: bankReference, // bank's own ID doubles as our idempotency key
      merchantId: account.merchant,
      customerId: account.customer,
      virtualAccountId: account._id,
      amountReceived,
      amountExpected: null,
      currency: currency || 'NGN',
      bankReference,
    });

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
      // Simple retry with backoff. A real queue gives you this for free;
      // here we just re-schedule ourselves after a short delay.
      const backoffMs = 2000 * event.attempts;
      setTimeout(() => processEvent(event._id).catch(() => {}), backoffMs);
    }
  }
}

/** Re-drives any events stuck in 'queued' or 'processing' - call from a
 * cron/startup task in case the process restarted mid-processing. */
async function redriveStuckEvents() {
  const stuck = await WebhookEvent.find({ status: { $in: ['queued', 'processing'] } });
  for (const event of stuck) {
    processEvent(event._id).catch(() => {});
  }
  return stuck.length;
}

module.exports = { enqueue, processEvent, redriveStuckEvents };
