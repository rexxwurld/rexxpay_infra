// src/modules/merchant/merchant.controller.js
const { getProfile, updateWebhookUrl, regenerateSecretKey } = require('./merchant.service');

async function profile(req, res) {
  const merchant = await getProfile(req.merchant.id);
  res.json({ status: true, data: merchant });
}

async function updateWebhook(req, res) {
  try {
    const { webhookUrl } = req.body;
    const merchant = await updateWebhookUrl(req.merchant.id, webhookUrl);
    res.json({ status: true, data: merchant });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function regenerateKey(req, res) {
  try {
    const { mode } = req.body;
    const result = await regenerateSecretKey(req.merchant.id, mode);
    res.json({
      status: true,
      message: `New ${mode} secret key generated. Store it now - it will not be shown again. Your old ${mode} key no longer works.`,
      data: result,
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

module.exports = { profile, updateWebhook, regenerateKey };
