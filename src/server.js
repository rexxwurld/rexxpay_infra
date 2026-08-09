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

  app.listen(port, () => {
    console.log(`[server] RexxPay listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
