const express = require('express');

const router = express.Router();

const {
  getStatus,
  complete,
} = require('./checkout.controller');

// Public checkout endpoints.
// No merchant API key is required because the customer is not
// supposed to possess the merchant's secret key.

router.get(
  '/:token/status',
  getStatus
);

router.get(
  '/:token/complete',
  complete
);

module.exports = router;
