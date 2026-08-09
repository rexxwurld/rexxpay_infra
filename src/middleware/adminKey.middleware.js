// src/middleware/adminKey.middleware.js
// Guards routes that should only be callable by you (the operator) -
// never by a merchant, even an authenticated one. Same pattern as
// RexxPay Bank's own admin key guard.

module.exports = function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;

  if (!process.env.INFRA_ADMIN_KEY) {
    // Fail closed: if no admin key is configured, nobody gets in.
    return res.status(500).json({ status: false, message: 'admin_key_not_configured' });
  }

  if (!key || key !== process.env.INFRA_ADMIN_KEY) {
    return res.status(401).json({ status: false, message: 'unauthorized' });
  }

  next();
};
