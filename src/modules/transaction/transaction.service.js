// src/modules/transaction/transaction.service.js

const mongoose = require('mongoose');

const Transaction = require('./transaction.model');
const Customer = require('../customer/customer.model');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');

const { creditWallet } = require('../wallet/wallet.service');
const { postDoubleEntry } = require('../ledger/ledger.service');

const { screenName } = require('../../utils/sanctionsCheck');
const { computeFee } = require('../../utils/feeCalculator');

const Merchant = require('../merchant/merchant.model');
const auditLog = require('../audit/auditLog.service');
const limits = require('../../config/limits');


// Called only from the verified webhook processor.
// This is the single place that turns:
// "money arrived at the bank"
// into:
// "transaction recorded + merchant wallet credited".
//
// Never expose this as a public API a client could call directly
// to fake a payment.

async function recordIncomingPayment({
  reference,
  merchantId,
  customerId,
  virtualAccountId,
  amountReceived,
  amountExpected,
  currency,
  bankReference,
}) {

  /*
  |--------------------------------------------------------------------------
  | IDEMPOTENCY - LAYER 1
  |--------------------------------------------------------------------------
  */

  const existing = await Transaction.findOne({ reference });

  if (existing) {
    return {
      transaction: existing,
      duplicate: true,
    };
  }


  /*
  |--------------------------------------------------------------------------
  | FRAUD / RISK CHECKS
  |--------------------------------------------------------------------------
  |
  | These checks happen BEFORE money moves.
  |
  */

  let flagReason = null;


  /*
  |--------------------------------------------------------------------------
  | MAX SINGLE PAYMENT
  |--------------------------------------------------------------------------
  */

  if (amountReceived > limits.MAX_SINGLE_PAYMENT_MINOR) {
    flagReason = 'exceeds_max_single_payment';
  }


  /*
  |--------------------------------------------------------------------------
  | VELOCITY LIMIT
  |--------------------------------------------------------------------------
  */

  if (!flagReason) {

    const windowStart = new Date(
      Date.now() -
      limits.VELOCITY_WINDOW_MINUTES * 60 * 1000
    );

    const recentCount = await Transaction.countDocuments({
      virtualAccount: virtualAccountId,
      createdAt: {
        $gte: windowStart,
      },
    });

    if (recentCount >= limits.VELOCITY_MAX_COUNT) {
      flagReason = 'velocity_limit_exceeded';
    }
  }


  /*
  |--------------------------------------------------------------------------
  | DAILY INBOUND LIMIT
  |--------------------------------------------------------------------------
  */

  if (!flagReason) {

    const dayStart = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    );

    const [dailyAgg] = await Transaction.aggregate([
      {
        $match: {
          merchant: merchantId,
          createdAt: {
            $gte: dayStart,
          },
          status: {
            $in: [
              'success',
              'partial',
              'over',
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: '$amountReceived',
          },
        },
      },
    ]);

    const dailyTotal =
      (dailyAgg?.total || 0) +
      amountReceived;

    if (
      dailyTotal >
      limits.MAX_DAILY_INBOUND_MINOR
    ) {
      flagReason =
        'exceeds_daily_inbound_limit';
    }
  }


  /*
  |--------------------------------------------------------------------------
  | SANCTIONS SCREENING
  |--------------------------------------------------------------------------
  */

  if (!flagReason) {

    const customer =
      await Customer.findById(customerId);

    if (customer) {

      const screening =
        screenName(customer.fullName);

      if (screening.hit) {
        flagReason =
          `sanctions_screen:${screening.reason}`;
      }
    }
  }


  /*
  |--------------------------------------------------------------------------
  | DETERMINE SETTLEMENT STATUS
  |--------------------------------------------------------------------------
  */

  let status;

  if (flagReason) {

    status = 'flagged';

  } else if (
    amountExpected != null &&
    amountReceived < amountExpected
  ) {

    status = 'partial';

  } else if (
    amountExpected != null &&
    amountReceived > amountExpected
  ) {

    status = 'over';

  } else {

    status = 'success';
  }


  /*
  |--------------------------------------------------------------------------
  | LOAD VIRTUAL ACCOUNT
  |--------------------------------------------------------------------------
  */

  const virtualAccount =
    await VirtualAccount.findById(
      virtualAccountId
    );

  if (!virtualAccount) {
    throw new Error('virtual_account_not_found');
  }


  /*
  |--------------------------------------------------------------------------
  | SPLIT CONFIGURATION
  |--------------------------------------------------------------------------
  */

  const hasSplit =
    !!(
      virtualAccount.splitSubaccount &&
      virtualAccount.splitPercentage
    );

  const splitAmount =
    hasSplit
      ? Math.floor(
          (
            amountReceived *
            virtualAccount.splitPercentage
          ) / 100
        )
      : 0;

  const merchantAmount =
    amountReceived - splitAmount;


  /*
  |--------------------------------------------------------------------------
  | PLATFORM FEE
  |--------------------------------------------------------------------------
  */

  let platformFee = 0;
  let netAmount = merchantAmount;

  if (
    status !== 'flagged' &&
    status !== 'failed' &&
    merchantAmount > 0
  ) {

    const merchant =
      await Merchant.findById(merchantId);

    ({
      feeAmount: platformFee,
      netAmount,
    } = computeFee(
      merchantAmount,
      merchant
    ));
  }


  /*
  |--------------------------------------------------------------------------
  | ATOMIC TRANSACTION
  |--------------------------------------------------------------------------
  */

  const session =
    await mongoose.startSession();

  try {

    session.startTransaction();


    /*
    |--------------------------------------------------------------------------
    | CREATE TRANSACTION
    |--------------------------------------------------------------------------
    */

    const [transaction] =
      await Transaction.create(
        [
          {
            reference,

            merchant: merchantId,

            customer: customerId,

            virtualAccount:
              virtualAccountId,

            amountExpected:
              amountExpected ?? null,

            amountReceived,

            currency,

            status,

            flagReason,

            bankReference,

            splitSubaccount:
              hasSplit
                ? virtualAccount.splitSubaccount
                : null,

            splitAmount,

            platformFee,

            netAmount,
          },
        ],
        {
          session,
          ordered: true,
        }
      );


    /*
    |--------------------------------------------------------------------------
    | MONEY MOVEMENT
    |--------------------------------------------------------------------------
    */

    if (
      status !== 'flagged' &&
      status !== 'failed'
    ) {


      /*
      |--------------------------------------------------------------------------
      | SPLIT PAYMENT
      |--------------------------------------------------------------------------
      */

      if (hasSplit) {

        /*
        |--------------------------------------------------------------------------
        | MERCHANT SHARE
        |--------------------------------------------------------------------------
        */

        if (netAmount > 0) {

          await creditWallet(
            merchantId,
            netAmount,
            session,
            currency
          );

          await postDoubleEntry({

            entryGroup:
              `txn_${transaction._id}`,

            amount:
              netAmount,

            currency,

            sourceType:
              'incoming_payment',

            sourceRef:
              `${transaction._id.toString()}:merchant`,

            debit: {
              accountType:
                'payout_clearing',

              accountRef:
                'platform_clearing',

              description:
                'Inbound customer payment received',
            },

            credit: {
              accountType:
                'merchant_wallet',

              accountRef:
                merchantId.toString(),

              description:
                'Wallet credited for inbound payment (net of split and platform fee)',
            },

            session,
          });
        }


        /*
        |--------------------------------------------------------------------------
        | PLATFORM FEE
        |--------------------------------------------------------------------------
        */

        if (platformFee > 0) {

          await postDoubleEntry({

            entryGroup:
              `txn_${transaction._id}`,

            amount:
              platformFee,

            currency,

            sourceType:
              'incoming_payment',

            sourceRef:
              `${transaction._id.toString()}:fee`,

            debit: {
              accountType:
                'payout_clearing',

              accountRef:
                'platform_clearing',

              description:
                'Platform fee taken from inbound payment',
            },

            credit: {
              accountType:
                'platform_revenue',

              accountRef:
                'platform_revenue',

              description:
                'Platform fee revenue',
            },

            session,
          });
        }


        /*
        |--------------------------------------------------------------------------
        | SUBACCOUNT SPLIT
        |--------------------------------------------------------------------------
        */

        if (splitAmount > 0) {

          await postDoubleEntry({

            entryGroup:
              `txn_${transaction._id}`,

            amount:
              splitAmount,

            currency,

            sourceType:
              'incoming_payment',

            sourceRef:
              `${transaction._id.toString()}:split`,

            debit: {
              accountType:
                'payout_clearing',

              accountRef:
                'platform_clearing',

              description:
                'Inbound customer payment received (split portion)',
            },

            credit: {
              accountType:
                'subaccount_settlement',

              accountRef:
                virtualAccount
                  .splitSubaccount
                  .toString(),

              description:
                'Subaccount split credited',
            },

            session,
          });
        }

      } else {

        /*
        |--------------------------------------------------------------------------
        | NORMAL PAYMENT
        |--------------------------------------------------------------------------
        */

        if (netAmount > 0) {

          await creditWallet(
            merchantId,
            netAmount,
            session,
            currency
          );

          await postDoubleEntry({

            entryGroup:
              `txn_${transaction._id}`,

            amount:
              netAmount,

            currency,

            sourceType:
              'incoming_payment',

            sourceRef:
              transaction._id.toString(),

            debit: {
              accountType:
                'payout_clearing',

              accountRef:
                'platform_clearing',

              description:
                'Inbound customer payment received',
            },

            credit: {
              accountType:
                'merchant_wallet',

              accountRef:
                merchantId.toString(),

              description:
                'Wallet credited for inbound payment (net of platform fee)',
            },

            session,
          });
        }


        /*
        |--------------------------------------------------------------------------
        | PLATFORM FEE
        |--------------------------------------------------------------------------
        */

        if (platformFee > 0) {

          await postDoubleEntry({

            entryGroup:
              `txn_${transaction._id}`,

            amount:
              platformFee,

            currency,

            sourceType:
              'incoming_payment',

            sourceRef:
              `${transaction._id.toString()}:fee`,

            debit: {
              accountType:
                'payout_clearing',

              accountRef:
                'platform_clearing',

              description:
                'Platform fee taken from inbound payment',
            },

            credit: {
              accountType:
                'platform_revenue',

              accountRef:
                'platform_revenue',

              description:
                'Platform fee revenue',
            },

            session,
          });
        }
      }
    }


    /*
    |--------------------------------------------------------------------------
    | COMMIT
    |--------------------------------------------------------------------------
    */

    await session.commitTransaction();
    session.endSession();


    /*
    |--------------------------------------------------------------------------
    | AUDIT LOG
    |--------------------------------------------------------------------------
    */

    await auditLog.record({

      actorType:
        'system',

      actorRef:
        'webhook_processor',

      action:
        status === 'flagged'
          ? 'transaction.flagged'
          : 'transaction.recorded',

      entityType:
        'Transaction',

      entityRef:
        transaction._id.toString(),

      severity:
        status === 'flagged'
          ? 'critical'
          : 'info',

      metadata: {
        status,
        flagReason,
        amountReceived,
        merchantId:
          merchantId.toString(),
      },
    });


    /*
    |--------------------------------------------------------------------------
    | IMPORTANT:
    | DO NOT RELEASE THE VIRTUAL ACCOUNT HERE.
    |--------------------------------------------------------------------------
    |
    | Previously this file did:
    |
    | success/over
    |      ↓
    | releaseVirtualAccount()
    |      ↓
    | available
    |
    | That allowed the same account number to immediately be assigned
    | to another checkout.
    |
    | The account is now deactivated by webhook.processor.js after the
    | payment has been successfully recorded.
    |
    | The cooldown/reactivation process will later return it to the pool.
    |
    */


    return {
      transaction,
      duplicate: false,
    };


  } catch (err) {

    await session.abortTransaction();
    session.endSession();


    /*
    |--------------------------------------------------------------------------
    | IDEMPOTENCY - LAYER 2
    |--------------------------------------------------------------------------
    |
    | The unique index on `reference` protects against concurrent webhook
    | deliveries racing through the first findOne() check.
    |
    */

    if (err.code === 11000) {

      const existingRace =
        await Transaction.findOne({
          reference,
        });

      if (existingRace) {

        return {
          transaction:
            existingRace,

          duplicate: true,
        };
      }
    }

    throw err;
  }
}


/*
|--------------------------------------------------------------------------
| LIST MERCHANT TRANSACTIONS
|--------------------------------------------------------------------------
*/

async function listForMerchant(merchantId) {

  return Transaction
    .find({
      merchant: merchantId,
    })
    .sort({
      createdAt: -1,
    });
}


module.exports = {
  recordIncomingPayment,
  listForMerchant,
};
