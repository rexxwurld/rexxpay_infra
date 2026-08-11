// src/middleware/rateLimit.middleware.js
const rateLimit = require('express-rate-limit');

// General API traffic — generous, just to blunt abuse/scraping.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: 'too_many_requests',
  },
});

// Auth endpoints (login/register/etc) — tight, since this is the
// classic brute-force / credential-stuffing target.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: 'too_many_auth_attempts',
  },
});

// Webhook receivers — bank/provider callbacks are usually low volume
// per source, but this endpoint is public and unauthenticated up until
// signature verification runs, so cap it well above legitimate traffic
// to absorb flood/replay abuse without needing to trust the caller first.
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: 'too_many_webhook_requests',
  },
});

module.exports = {
  generalLimiter,
  authLimiter,
  webhookLimiter,
};
