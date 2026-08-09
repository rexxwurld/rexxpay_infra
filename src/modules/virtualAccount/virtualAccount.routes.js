// src/modules/virtualAccount/virtualAccount.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { assign, deactivate, fetchOne } = require('./virtualAccount.controller');

router.post('/', requireApiKey, assign);
router.get('/:accountNumber', requireApiKey, fetchOne);
router.post('/:accountNumber/deactivate', requireApiKey, deactivate);

module.exports = router;
