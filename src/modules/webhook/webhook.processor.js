// src/modules/webhook/webhook.processor.js

const WebhookEvent = require('./webhookEvent.model');

const {
  findByAccountNumber,
  deactivateVirtualAccount,
} = require('../virtualAccount/virtualAccount.service');

const {
  recordIncomingPayment,
} = require('../transaction/transaction.service');

const Merchant = require('../merchant/merchant.model');

const {
  dispatchMerchantWebhook,
} = require('../../utils/merchantWebhook');

const {
  markInvoicePaidByTransaction,
} = require('../subscription/subscription.service');

const auditLog = require('../audit/auditLog.service');
const logger = require('../../utils/logger');
const { enqueueWebhookEvent } = require('../../queue/webhookQueue');

const MAX_ATTEMPTS = 5;

/*
|--------------------------------------------------------------------------
| ENQUEUE WEBHOOK
|--------------------------------------------------------------------------
|
| Persists the event, then hands it to the durable (Redis-backed)
| BullMQ queue instead of firing an in-process setImmediate. If this
| process crashes right after this call returns, the job survives in
| Redis and a worker (any worker, on any instance) will still pick it
| up - the old setImmediate-based approach lost the event entirely in
| that scenario, recoverable only by the next server restart's
| redriveStuckEvents() sweep.
|
*/

async function enqueue({ rawBody, signature }) {
  const event = await WebhookEvent.create({
    rawBody,
    signature,
    status: 'queued',
  });

  try {
    await enqueueWebhookEvent(event._id);
  } catch (err) {
    // If Redis itself is unreachable, fall back to redriveStuckEvents()
    // picking this up on next boot rather than losing it silently -
    // the event is already durably persisted in Mongo either way.
    logger.error({ err, eventId: event._id.toString() }, '[webhook.processor] failed to enqueue event onto durable queue');
  }

  return event;
}

/*
|--------------------------------------------------------------------------
| PROCESS WEBHOOK EVENT
|--------------------------------------------------------------------------
*/

async function processEvent(eventId) {
  const event = await WebhookEvent.findById(eventId);

  if (!event || event.status === 'processed') {
    return;
  }

  event.status = 'processing';
  event.attempts += 1;

  await event.save();

  try {
    const {
      accountNumber,
      amountReceived,
      currency,
      bankReference,
    } = event.rawBody;

    /*
    |--------------------------------------------------------------------------
    | VALIDATE BANK EVENT
    |--------------------------------------------------------------------------
    */

    if (
      !accountNumber ||
      !Number.isInteger(amountReceived) ||
      amountReceived <= 0
    ) {
      throw new Error('invalid_payload');
    }

    /*
    |--------------------------------------------------------------------------
    | FIND VIRTUAL ACCOUNT
    |--------------------------------------------------------------------------
    */

    const account = await findByAccountNumber(accountNumber);

    /*
    |--------------------------------------------------------------------------
    | ACCOUNT MUST STILL BE ASSIGNED
    |--------------------------------------------------------------------------
    |
    | If the account is already deactivated, available, or otherwise no
    | longer assigned, we MUST NOT credit another payment to it.
    |
    */

    if (!account || account.status !== 'assigned') {
      await auditLog.record({
        actorType: 'system',
        actorRef: 'webhook_processor',
        action: 'webhook.unrecognized_account',
        severity: 'critical',
        metadata: {
          accountNumber,
          bankReference,
          accountStatus: account?.status || 'not_found',
        },
      });

      event.status = 'failed';
      event.lastError = 'unrecognized_or_inactive_account';

      await event.save();

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | SAVE IMPORTANT ASSIGNMENT VALUES BEFORE PAYMENT PROCESSING
    |--------------------------------------------------------------------------
    |
    | We capture these now because the account will be deactivated after
    | successful settlement.
    |
    */

    const merchantId = account.merchant;
    const customerId = account.customer;
    const virtualAccountId = account._id;
    const amountExpected = account.amountExpected ?? null;
    const merchantReference = account.reference;

    /*
    |--------------------------------------------------------------------------
    | RECORD INCOMING PAYMENT
    |--------------------------------------------------------------------------
    */

    const {
      transaction,
      duplicate,
    } = await recordIncomingPayment({
      reference: bankReference,
      merchantId,
      customerId,
      virtualAccountId,
      amountReceived,
      amountExpected,
      currency: currency || 'NGN',
      bankReference,
    });

    /*
    |--------------------------------------------------------------------------
    | PAYMENT SUCCESS
    |--------------------------------------------------------------------------
    */

    if (
  !duplicate &&
  (
    transaction.status === 'success' ||
    transaction.status === 'over'
  )
) {
      /*
      |--------------------------------------------------------------------------
      | DEACTIVATE ACCOUNT
      |--------------------------------------------------------------------------
      |
      | IMPORTANT:
      |
      | Do NOT release this account back to "available" here.
      |
      | Once this payment has been successfully processed, the account is
      | consumed and becomes "deactivated".
      |
      | A separate cooldown/reactivation process will later move it back
      | to the available pool.
      |
      */

      try {
        await deactivateVirtualAccount({
          merchantId: merchantId._id || merchantId,
          accountNumber,
        });

        logger.info({ accountNumber }, '[webhook.processor] virtual account deactivated after payment');
      } catch (deactivateError) {
        /*
        |--------------------------------------------------------------------------
        | IMPORTANT
        |--------------------------------------------------------------------------
        |
        | The transaction has already been recorded.
        |
        | We therefore DO NOT throw here and cause the bank webhook to be
        | processed again, because that could create confusion around an
        | already-recorded transaction.
        |
        | Instead, log it as a critical operational issue.
        |
        */

        logger.error({ accountNumber, err: deactivateError }, '[webhook.processor] FAILED TO DEACTIVATE ACCOUNT');

        await auditLog.record({
          actorType: 'system',
          actorRef: 'webhook_processor',
          action: 'virtual_account.deactivation_failed',
          severity: 'critical',
          metadata: {
            accountNumber,
            transactionId: transaction._id.toString(),
            bankReference,
            error: deactivateError.message,
          },
        });
      }

      /*
      |--------------------------------------------------------------------------
      | MERCHANT WEBHOOK
      |--------------------------------------------------------------------------
      */

      const merchant = await Merchant.findById(merchantId);

      if (merchant) {
        dispatchMerchantWebhook(merchant, {
          type: 'transaction.success',

          /*
           * tx_ref is the merchant's own reference created during
           * /payments/initialize.
           *
           * This allows the merchant to match the payment to its order.
           */
          data: {
            ...transaction.toObject(),
            tx_ref: merchantReference,
          },
        }).catch((err) => {
          logger.error({ err }, '[webhook.processor] merchant webhook dispatch failed');
        });
      }

      /*
      |--------------------------------------------------------------------------
      | INVOICE RECONCILIATION
      |--------------------------------------------------------------------------
      */

      markInvoicePaidByTransaction(transaction).catch((err) => {
        logger.error({ err, transactionId: transaction._id.toString() }, '[webhook.processor] failed to reconcile invoice for transaction');
      });
    }

    /*
    |--------------------------------------------------------------------------
    | WEBHOOK EVENT COMPLETE
    |--------------------------------------------------------------------------
    */

    event.status = 'processed';
    event.processedAt = new Date();

    await event.save();

  } catch (err) {
    /*
    |--------------------------------------------------------------------------
    | RETRY HANDLING
    |--------------------------------------------------------------------------
    |
    | Retry scheduling itself is now owned by BullMQ (see
    | queue/webhookQueue.js's defaultJobOptions: 5 attempts, exponential
    | backoff) - this function no longer schedules its own setTimeout.
    | We still record status/lastError on the Mongo doc for
    | visibility/audit, and we re-throw so BullMQ knows the job failed
    | and should be retried (or moved to the failed set once its own
    | attempts are exhausted).
    |
    */

    event.lastError = err.message;

    event.status =
      event.attempts >= MAX_ATTEMPTS
        ? 'failed'
        : 'queued';

    await event.save();

    if (event.status === 'failed') {
      await auditLog.record({
        actorType: 'system',
        actorRef: 'webhook_processor',
        action: 'webhook.processing_failed_permanently',
        severity: 'critical',
        metadata: {
          eventId: event._id.toString(),
          error: err.message,
        },
      });
    }

    // Re-throw so the BullMQ worker marks this job attempt as failed
    // and applies its own backoff/attempts policy.
    throw err;
  }
}

/*
|--------------------------------------------------------------------------
| REDRIVE STUCK EVENTS
|--------------------------------------------------------------------------
*/

async function redriveStuckEvents() {
  const stuck = await WebhookEvent.find({
    status: {
      $in: ['queued', 'processing'],
    },
  });

  // Route redriven events back through the durable queue rather than
  // calling processEvent directly in-process, so they get the same
  // BullMQ-managed attempts/backoff as any other event instead of a
  // single unmanaged retry.
  for (const event of stuck) {
    await enqueueWebhookEvent(event._id).catch((err) => {
      logger.error({ err, eventId: event._id.toString() }, '[webhook.processor] failed to redrive stuck event onto durable queue');
    });
  }

  return stuck.length;
}

module.exports = {
  enqueue,
  processEvent,
  redriveStuckEvents,
};
