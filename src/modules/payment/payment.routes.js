// src/modules/payment/payment.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { initialize, verify } = require('./payment.controller');

router.post('/initialize', requireApiKey, initialize);
router.get('/verify/:tx_ref', requireApiKey, verify);

module.exports = router;
