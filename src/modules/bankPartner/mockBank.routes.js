// src/modules/bankPartner/mockBank.routes.js
//
// DEVELOPMENT ONLY.
//
// This route simulates a customer using their real bank app to transfer
// money into a virtual account issued by RexxPay.
//
// IMPORTANT:
// SwiftPay is the merchant/integration.
// RexxPay is the payment processor.
//
// Therefore this simulator MUST NOT call SwiftPay's own /api/webhooks/bank.
// It sends the simulated transfer to RexxPay's mock-bank endpoint.
//
// Flow:
//
// SwiftPay simulator
//      ↓
// RexxPay /api/v1/mock-bank/simulate-transfer
//      ↓
// RexxPay /api/v1/webhooks/bank
//      ↓
// RexxPay webhook processor
//      ↓
// RexxPay transaction
//      ↓
// RexxPay pending settlement
//      ↓
// settlement
//      ↓
// RexxPay available balance
//
// Delete/disable this route before production.

const express = require('express');
const router = express.Router();
const axios = require('axios');


// -----------------------------------------------------------------------------
// RexxPay configuration
// -----------------------------------------------------------------------------

const REXXPAY_BASE_URL =
  process.env.REXXPAY_BASE_URL ||
  'https://rexxpay.onrender.com';


// -----------------------------------------------------------------------------
// SIMULATE BANK TRANSFER
// -----------------------------------------------------------------------------
//
// This endpoint belongs to SwiftPay, but the simulated transfer itself is
// processed by RexxPay.
//
// SwiftPay does NOT:
//
// - generate the bank signature
// - create the bank reference
// - call RexxPay's webhook directly
// - create a transaction
// - credit a wallet
//
// RexxPay's mock-bank endpoint does all of that.
//
// -----------------------------------------------------------------------------

router.post('/simulate-transfer', async (req, res) => {
  const {
    accountNumber,
    amount,
    currency = 'NGN',
  } = req.body;

  /*
  |--------------------------------------------------------------------------
  | VALIDATION
  |--------------------------------------------------------------------------
  */

  if (
    !accountNumber ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    return res.status(400).json({
      status: false,
      message:
        'accountNumber and integer amount (minor units) are required',
    });
  }

  /*
  |--------------------------------------------------------------------------
  | SEND SIMULATED TRANSFER TO REXXPAY
  |--------------------------------------------------------------------------
  |
  | IMPORTANT:
  |
  | The amount is already in minor units.
  |
  | Example:
  |
  | ₦200,000
  |      ↓
  | 20,000,000 kobo
  |
  */

  try {
    const response = await axios.post(
      `${REXXPAY_BASE_URL}/api/v1/mock-bank/simulate-transfer`,
      {
        accountNumber,
        amount,
        currency,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },

        // The mock-bank endpoint should normally respond quickly because
        // RexxPay only queues the webhook before returning 202.
        timeout: 15000,
      }
    );

    /*
    |--------------------------------------------------------------------------
    | RETURN REXXPAY'S RESPONSE
    |--------------------------------------------------------------------------
    */

    return res.json({
      status: true,
      message: 'simulated transfer sent to RexxPay',
      rexpayResponse: response.data,
    });

  } catch (error) {

    /*
    |--------------------------------------------------------------------------
    | REXXPAY ERROR
    |--------------------------------------------------------------------------
    */

    console.error(
      '[SwiftPay mock-bank] RexxPay simulation request failed:',
      error.response?.data || error.message
    );

    return res.status(
      error.response?.status || 502
    ).json({
      status: false,
      message: 'Unable to send simulated transfer to RexxPay',
      rexpayResponse: error.response?.data || null,
    });
  }
});


// -----------------------------------------------------------------------------
// SIMULATE TRANSFER STATUS
// -----------------------------------------------------------------------------
//
// The event ID is created by RexxPay.
//
// Therefore SwiftPay asks RexxPay for the processing result instead of looking
// inside SwiftPay's own WebhookEvent/Transaction collections.
//
// -----------------------------------------------------------------------------

router.get(
  '/simulate-transfer/:eventId/status',
  async (req, res) => {

    const { eventId } = req.params;

    if (!eventId) {
      return res.status(400).json({
        status: false,
        message: 'eventId is required',
      });
    }

    try {

      /*
      |--------------------------------------------------------------------------
      | ASK REXXPAY FOR THE WEBHOOK RESULT
      |--------------------------------------------------------------------------
      */

      const response = await axios.get(
        `${REXXPAY_BASE_URL}/api/v1/mock-bank/simulate-transfer/${eventId}/status`,
        {
          timeout: 10000,
        }
      );

      return res.json({
        status: true,
        data: response.data?.data || null,
      });

    } catch (error) {

      console.error(
        '[SwiftPay mock-bank] RexxPay status request failed:',
        error.response?.data || error.message
      );

      return res.status(
        error.response?.status || 502
      ).json({
        status: false,
        message: 'Unable to retrieve transfer status from RexxPay',
        rexpayResponse: error.response?.data || null,
      });
    }
  }
);


module.exports = router;
