// src/modules/merchant/merchant.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { profile, updateWebhook, regenerateKey } = require('./merchant.controller');

router.get('/me', requireApiKey, profile);
router.patch('/webhook-url', requireApiKey, updateWebhook);
router.post('/regenerate-key', requireApiKey, regenerateKey);

module.exports = router;
