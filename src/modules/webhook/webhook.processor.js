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

const MAX_ATTEMPTS = 5;

/*
|--------------------------------------------------------------------------
| ENQUEUE WEBHOOK
|--------------------------------------------------------------------------
*/

async function enqueue({ rawBody, signature }) {
  const event = await WebhookEvent.create({
    rawBody,
    signature,
    status: 'queued',
  });

  setImmediate(() =>
    processEvent(event._id).catch((err) => {
      console.error(
        '[webhook.processor] unhandled error processing event',
        event._id.toString(),
        err.message
      );
    })
  );

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

    if (!duplicate && transaction.status !== 'flagged') {
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

        console.log(
          `[webhook.processor] virtual account ${accountNumber} deactivated after payment`
        );
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

        console.error(
          '[webhook.processor] FAILED TO DEACTIVATE ACCOUNT',
          accountNumber,
          deactivateError.message
        );

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
          console.error(
            '[webhook.processor] merchant webhook dispatch failed:',
            err.message
          );
        });
      }

      /*
      |--------------------------------------------------------------------------
      | INVOICE RECONCILIATION
      |--------------------------------------------------------------------------
      */

      markInvoicePaidByTransaction(transaction).catch((err) => {
        console.error(
          '[webhook.processor] failed to reconcile invoice for transaction',
          transaction._id.toString(),
          err.message
        );
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
    */

    event.lastError = err.message;

    event.status =
      event.attempts >= MAX_ATTEMPTS
        ? 'failed'
        : 'queued';

    await event.save();

    /*
    |--------------------------------------------------------------------------
    | PERMANENT FAILURE
    |--------------------------------------------------------------------------
    */

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

      return;
    }

    /*
    |--------------------------------------------------------------------------
    | RETRY WITH BACKOFF
    |--------------------------------------------------------------------------
    */

    const backoffMs = 2000 * event.attempts;

    setTimeout(() => {
      processEvent(event._id).catch(() => {});
    }, backoffMs);
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

  for (const event of stuck) {
    processEvent(event._id).catch(() => {});
  }

  return stuck.length;
}

module.exports = {
  enqueue,
  processEvent,
  redriveStuckEvents,
};
