// src/server.js
const app = require('./app');
const connectDB = require('./config/db');
const { port } = require('./config/env');
const { ensureDefaultBankPartners, provisionAccountPool } = require('./modules/bankPartner/bankPartner.service');

async function start() {
  await connectDB();

  // Make sure the mock bank partners exist and have some accounts ready
  // in the pool, so /virtual-accounts assignment works out of the box.
  await ensureDefaultBankPartners();
  await provisionAccountPool('wema-bank', 20);
  await provisionAccountPool('titan-trust-bank', 20);

  // NOTE: 'rexxpay-bank' (the REAL bank) is deliberately NOT
  // auto-provisioned here. Provisioning it calls the real RexxPay Bank
  // API and creates real wallets - doing that on every server restart
  // (which happens often on Render's free tier when the app sleeps/wakes)
  // would spam real accounts you don't need. Provision it once manually,
  // e.g. via a one-off script or an authenticated admin route, and only
  // top it up again when the pool actually runs low.

  app.listen(port, () => {
    console.log(`[server] RexxPay listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
