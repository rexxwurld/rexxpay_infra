const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const {
  generalLimiter,
  authLimiter,
  webhookLimiter,
} = require('./middleware/rateLimit.middleware');

const authRoutes = require('./modules/auth/auth.routes');
const merchantRoutes = require('./modules/merchant/merchant.routes');
const customerRoutes = require('./modules/customer/customer.routes');
const virtualAccountRoutes = require('./modules/virtualAccount/virtualAccount.routes');
const walletRoutes = require('./modules/wallet/wallet.routes');
const transactionRoutes = require('./modules/transaction/transaction.routes');
const webhookRoutes = require('./modules/webhook/webhook.routes');
const payoutRoutes = require('./modules/payout/payout.routes');
const refundRoutes = require('./modules/refund/refund.routes');
const subaccountRoutes = require('./modules/subaccount/subaccount.routes');
const recipientRoutes = require('./modules/recipient/recipient.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const mockBankRoutes = require('./modules/bankPartner/mockBank.routes');
const paymentRoutes = require('./modules/payment/payment.routes');
const checkoutRoutes = require('./modules/checkout/checkout.routes');
const subscriptionRoutes = require('./modules/subscription/subscription.routes');
const disputeRoutes = require('./modules/dispute/dispute.routes');

const {
  notFound,
  errorHandler,
} = require('./middleware/error.middleware');

const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json());
app.use(generalLimiter);


// Hosted checkout.
// Example:
// https://rexxpay.com/pay/9d7f8c...
//
// The token is the ONLY thing in the URL.
app.get('/pay/:checkoutToken', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      '..',
      'public',
      'pay.html'
    )
  );
});


// Static frontend files.
app.use(
  express.static(
    path.join(
      __dirname,
      '..',
      'public'
    )
  )
);


// --- API versioning --------------------------------------------------
// All routes live on a versioned router (apiV1). It's mounted at both
// /api/v1 (the real, going-forward path) and /api (unversioned, kept so
// existing integrations - the hosted dashboard, pay.html, any merchant
// already wired to /api/... - don't break overnight). New integrations
// should be told to use /api/v1 explicitly; the bare /api alias is a
// deprecation runway, not a permanent second contract.
const apiV1 = express.Router();

apiV1.get('/', (req, res) => {
  res.json({
    status: true,
    message: 'RexxPay API is running',
    version: 'v1',
  });
});

apiV1.use('/auth', authLimiter, authRoutes);
apiV1.use('/merchant', merchantRoutes);
apiV1.use('/customers', customerRoutes);
apiV1.use('/virtual-accounts', virtualAccountRoutes);
apiV1.use('/checkout', checkoutRoutes);
apiV1.use('/wallet', walletRoutes);
apiV1.use('/transactions', transactionRoutes);
apiV1.use('/webhooks', webhookLimiter, webhookRoutes);
apiV1.use('/payouts', payoutRoutes);
apiV1.use('/refunds', refundRoutes);
apiV1.use('/subaccounts', subaccountRoutes);
apiV1.use('/recipients', recipientRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/payments', paymentRoutes);
apiV1.use('/subscriptions', subscriptionRoutes);
apiV1.use('/disputes', disputeRoutes);

// NOTE: left exactly as it was (still unconditionally mounted, guard
// still commented out below) at your request - not touched by this pass.
// if (process.env.NODE_ENV !== 'production') {
//   apiV1.use('/mock-bank', mockBankRoutes);
// }
apiV1.use('/mock-bank', mockBankRoutes);

app.use('/api/v1', apiV1);
app.use('/api', apiV1); // back-compat alias - see note above

// API docs (Swagger UI), served unversioned since it documents both paths.
try {
  const openapiDocument = YAML.load(path.join(__dirname, '..', 'docs', 'openapi.yaml'));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
} catch (err) {
  console.warn('[app] could not load OpenAPI spec for /api/docs:', err.message);
}

app.use(notFound);
app.use(errorHandler);

module.exports = app;
