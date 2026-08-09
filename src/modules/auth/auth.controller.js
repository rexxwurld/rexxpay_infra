// src/modules/auth/auth.controller.js
const { registerMerchant, loginMerchant } = require('./auth.service');

async function register(req, res) {
  try {
    const { businessName, email, password } = req.body;
    const { merchant, secretKey } = await registerMerchant({ businessName, email, password });
    res.status(201).json({
      status: true,
      message: 'Merchant registered. Store your secret key now - it will not be shown again.',
      data: {
        merchantId: merchant._id,
        businessName: merchant.businessName,
        email: merchant.email,
        publicKey: merchant.publicKey,
        secretKey,
      },
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    const { merchant, token } = await loginMerchant({ email, password });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
    res.json({
      status: true,
      data: { merchantId: merchant._id, businessName: merchant.businessName, email: merchant.email },
      token,
    });
  } catch (err) {
    res.status(401).json({ status: false, message: err.message });
  }
}

function logout(req, res) {
  res.clearCookie('token');
  res.json({ status: true, message: 'Logged out' });
}

module.exports = { register, login, logout };
