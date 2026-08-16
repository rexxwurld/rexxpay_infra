// src/modules/mockBank/mockBank.routes.js
const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../../middleware/auth.middleware');
const { simulateTransfer } = require('./mockBank.controller');

// Dev/test tool (see README "Mock bank partner"). Gated by requireApiKey
// so a caller needs a real merchant's test secret key - simulate-transfer.html
// is the page that collects that key and calls this.
router.post('/simulate-transfer', requireApiKey, simulateTransfer);

module.exports = router;
