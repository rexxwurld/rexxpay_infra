// src/app.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const authRoutes = require('./modules/auth/auth.routes');
const customerRoutes = require('./modules/customer/customer.routes');
const virtualAccountRoutes = require('./modules/virtualAccount/virtualAccount.routes');
const walletRoutes = require('./modules/wallet/wallet.routes');
const transactionRoutes = require('./modules/transaction/transaction.routes');
const webhookRoutes = require('./modules/webhook/webhook.routes');
const mockBankRoutes = require('./modules/bankPartner/mockBank.routes');

const { notFound, errorHandler } = require('./middleware/error.middleware');

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: true, message: 'RexxPay API is running' }));

app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/virtual-accounts', virtualAccountRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/webhooks', webhookRoutes);

// Local-only simulator for testing the full flow without a real bank.
// Mount this behind an env check in production (or delete the file).
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/mock-bank', mockBankRoutes);
}

app.use(notFound);
app.use(errorHandler);

module.exports = app;
