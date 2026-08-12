// src/server.js
const app = require('./app');
const connectDB = require('./config/db');
const { port } = require('./config/env');
const { ensureDefaultBankPartners } = require('./modules/bankPartner/bankPartner.service');
const { redriveStuckEvents } = require('./modules/webhook/webhook.processor');

async function start() {
  await connectDB();

  // Make sure the single bank partner (RexxPay Bank) exists.
  await ensureDefaultBankPartners();

  // NOTE: 'rexxpay-bank' (the REAL bank) is deliberately NOT
  // auto-provisioned here. Provisioning it calls the real RexxPay Bank
  // API and creates real wallets - doing that on every server restart
  // (which happens often on Render's free tier when the app sleeps/wakes)
  // would spam real accounts you don't need. Provision it once manually,
  // e.g. via a one-off script or an authenticated admin route, and only
  // top it up again when the pool actually runs low.

  // If the process crashed/restarted mid-webhook-processing, pick those
  // events back up instead of leaving them stuck in 'queued'/'processing'
  // forever. A real queue (SQS/BullMQ) gives you this for free via
  // visibility timeouts; this is the equivalent for the in-process stand-in.
  const redriven = await redriveStuckEvents();
  if (redriven > 0) console.log(`[server] redriving ${redriven} stuck webhook event(s)`);

  app.listen(port, () => {
    console.log(`[server] RexxPay listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
