const crypto = require('crypto');

const VirtualAccount = require('./virtualAccount.model');
const BankPartner = require('../bankPartner/bankPartner.model');
const Customer = require('../customer/customer.model');
const { provisionAccountPool } = require('../bankPartner/bankPartner.service');
const { findActiveByCodeForMerchant } = require('../subaccount/subaccount.service');

function generateCheckoutToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Assigns a fresh pooled account to a customer/payment.
// The checkout token is generated here and returned separately.
// It is NEVER the merchant tx_ref.
async function assignVirtualAccount({
  merchantId,
  customerId,
  preferredBankSlug,
  amount,
  reference,
  subaccountCode,
  splitPercentage,
}) {
  const customer = await Customer.findOne({
    _id: customerId,
    merchant: merchantId,
  });

  if (!customer) {
    throw new Error('customer_not_found');
  }

  if (amount != null && (!Number.isInteger(amount) || amount <= 0)) {
    throw new Error('amount_must_be_a_positive_integer_in_minor_units');
  }

  let splitSubaccount = null;
  let resolvedSplitPercentage = null;

  if (subaccountCode) {
    const subaccount = await findActiveByCodeForMerchant(merchantId, subaccountCode);
    if (!subaccount) {
      throw new Error('unknown_or_inactive_subaccount');
    }

    resolvedSplitPercentage = splitPercentage ?? subaccount.defaultSplitPercentage;
    if (
      !Number.isFinite(resolvedSplitPercentage) ||
      resolvedSplitPercentage <= 0 ||
      resolvedSplitPercentage > 100
    ) {
      throw new Error('invalid_split_percentage');
    }

    splitSubaccount = subaccount._id;
  }

  let bankFilter = {};

  if (preferredBankSlug) {
    const bank = await BankPartner.findOne({
      slug: preferredBankSlug,
    });

    if (!bank) {
      throw new Error('unknown_bank_partner');
    }

    bankFilter = { bank: bank._id };
  }

  // 256-bit random secret used ONLY for the hosted checkout URL.
  const checkoutToken = generateCheckoutToken();

  const assignment = {
    status: 'assigned',
    merchant: merchantId,
    customer: customerId,
    assignedAt: new Date(),
    amountExpected: amount ?? null,
    reference: reference ?? null,
    splitSubaccount,
    splitPercentage: resolvedSplitPercentage,
  };

  let account = await VirtualAccount.findOneAndUpdate(
    {
      status: 'available',
      ...bankFilter,
    },
    assignment,
    {
      new: true,
    }
  ).populate('bank');

  // Pool ran dry.
  if (!account) {
    const bankSlug = preferredBankSlug || 'wema-bank';

    await provisionAccountPool(bankSlug, 20);

    account = await VirtualAccount.findOneAndUpdate(
      {
        status: 'available',
        ...bankFilter,
      },
      assignment,
      {
        new: true,
      }
    ).populate('bank');
  }

  if (!account) {
    throw new Error('no_accounts_available');
  }

  customer.virtualAccount = account._id;
  await customer.save();

  return {
    account,
    checkoutToken,
  };
}


// Returns a fully-paid account to the pool.
async function releaseVirtualAccount(accountId) {
  const account = await VirtualAccount.findById(accountId);

  if (!account || account.status !== 'assigned') {
    return account;
  }

  account.status = 'available';
  account.merchant = null;
  account.customer = null;
  account.assignedAt = null;
  account.amountExpected = null;
  account.reference = null;
  account.splitSubaccount = null;
  account.splitPercentage = null;

  await account.save();

  await Customer.updateOne(
    { virtualAccount: account._id },
    {
      virtualAccount: null,
    }
  );

  return account;
}


async function releaseStaleAssignedAccounts(maxAgeMinutes) {
  const cutoff = new Date(
    Date.now() - maxAgeMinutes * 60 * 1000
  );

  const stale = await VirtualAccount.find({
    status: 'assigned',
    assignedAt: { $lte: cutoff },
  });

  let released = 0;

  for (const account of stale) {
    await releaseVirtualAccount(account._id);
    released += 1;
  }

  return released;
}


async function deactivateVirtualAccount({
  merchantId,
  accountNumber,
}) {
  const account = await VirtualAccount.findOne({
    accountNumber,
    merchant: merchantId,
  });

  if (!account) {
    throw new Error('account_not_found');
  }

  account.status = 'deactivated';
  await account.save();

  await Customer.updateOne(
    {
      virtualAccount: account._id,
    },
    {
      virtualAccount: null,
    }
  );

  return account;
}


async function findByAccountNumber(accountNumber) {
  return VirtualAccount.findOne({
    accountNumber,
  }).populate('bank merchant customer');
}


async function findByReference(reference) {
  return VirtualAccount.findOne({
    reference,
  }).populate('bank merchant customer');
}


module.exports = {
  assignVirtualAccount,
  deactivateVirtualAccount,
  findByAccountNumber,
  findByReference,
  releaseVirtualAccount,
  releaseStaleAssignedAccounts,
};
