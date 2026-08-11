const crypto = require('crypto');

const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const Transaction = require('../transaction/transaction.model');
const Checkout = require('../checkout/checkout.model');

const {
  createCustomer,
} = require('../customer/customer.service');

const {
  assignVirtualAccount,
  releaseVirtualAccount,
} = require('../virtualAccount/virtualAccount.service');


function validateRedirectUrl(redirectUrl) {
  if (!redirectUrl) {
    return null;
  }

  let url;

  try {
    url = new URL(redirectUrl);
  } catch {
    throw new Error('invalid_redirect_url');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('invalid_redirect_url');
  }

  if (
    process.env.NODE_ENV === 'production' &&
    url.protocol !== 'https:'
  ) {
    throw new Error('redirect_url_must_be_https');
  }

  return url.toString();
}


async function initializePayment({
  merchantId,
  amount,
  customer,
  tx_ref,
  redirect_url,
  baseUrl,
}) {
  if (
    amount === undefined ||
    amount === null ||
    isNaN(amount) ||
    Number(amount) <= 0
  ) {
    throw new Error('amount_required');
  }

  if (!customer?.email) {
    throw new Error('customer_email_required');
  }

  const redirectUrl = validateRedirectUrl(redirect_url);

  // Merchant's own reference.
  // This stays server-side and is NOT used in the checkout URL.
  const reference =
    tx_ref ||
    `rxp_${Date.now()}_${crypto
      .randomBytes(8)
      .toString('hex')}`;

  const customerDoc = await createCustomer({
    merchantId,
    fullName: customer.name || customer.email,
    email: customer.email,
    phone: customer.phone || null,
  });

  const amountMinor = Math.round(Number(amount) * 100);

  let assigned;

  try {
    assigned = await assignVirtualAccount({
      merchantId,
      customerId: customerDoc._id,
      amount: amountMinor,
      reference,
    });

    const {
      account,
      checkoutToken,
    } = assigned;

    // Checkout session lives independently from the virtual account.
    // This is important because the virtual account may be released
    // back to the pool after payment.
    await Checkout.create({
      token: checkoutToken,
      merchant: merchantId,
      customer: customerDoc._id,
      virtualAccount: account._id,

      txRef: reference,

      accountNumber: account.accountNumber,

      bankName:
        account.bank?.name ||
        null,

      amountExpected: amountMinor,

      redirectUrl,

      // Checkout remains valid for 30 minutes.
      expiresAt: new Date(
        Date.now() + 30 * 60 * 1000
      ),
    });

    // IMPORTANT:
    // The only thing exposed in this URL is the random checkout token.
    const link =
      `${baseUrl}/pay/${checkoutToken}`;

    return {
      link,

      // This is returned to the merchant's server/dashboard,
      // NOT placed inside the customer URL.
      tx_ref: reference,

      accountNumber: account.accountNumber,
    };
  } catch (err) {
    // If checkout creation fails after assigning the account,
    // return that account to the pool.
    if (assigned?.account?._id) {
      await releaseVirtualAccount(
        assigned.account._id
      ).catch(() => {});
    }

    throw err;
  }
}


async function verifyPayment({
  merchantId,
  tx_ref,
}) {
  const account = await VirtualAccount.findOne({
    merchant: merchantId,
    reference: tx_ref,
  });

  // Because successful accounts can be released back into the pool,
  // also search the transaction directly.
  let transaction = null;

  if (account) {
    transaction = await Transaction.findOne({
      virtualAccount: account._id,
    }).sort({
      createdAt: -1,
    });
  } else {
    transaction = await Transaction.findOne({
      merchant: merchantId,
      reference: tx_ref,
    }).sort({
      createdAt: -1,
    });
  }

  if (!account && !transaction) {
    throw new Error('transaction_not_found');
  }

  return {
    tx_ref,

    status:
      transaction?.status ||
      'pending',

    amountExpected:
      account?.amountExpected ??
      transaction?.amountExpected ??
      null,

    amountReceived:
      transaction?.amountReceived ??
      null,

    accountNumber:
      account?.accountNumber ??
      null,
  };
}


module.exports = {
  initializePayment,
  verifyPayment,
};
