// src/modules/subaccount/subaccount.routes.js
const express = require('express');
const router = express.Router();
const { requireApiKey } = require('../../middleware/auth.middleware');
const { create, list, getOne, settle } = require('./subaccount.controller');

router.post('/', requireApiKey, create);
router.get('/', requireApiKey, list);
router.get('/:id', requireApiKey, getOne);
router.post('/:id/settle', requireApiKey, settle);

module.exports = router;
