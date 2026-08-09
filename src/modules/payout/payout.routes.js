// src/modules/payout/payout.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { create, list } = require('./payout.controller');

router.post('/', requireApiKey, create);
router.get('/', requireApiKey, list);

module.exports = router;
