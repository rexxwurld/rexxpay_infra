const crypto = require('crypto');

const VirtualAccount = require('./virtualAccount.model');
const BankPartner = require('../bankPartner/bankPartner.model');
const Customer = require('../customer/customer.model');
const { provisionAccountPool } = require('../bankPartner/bankPartner.service');
const { findActiveByCodeForMerchant } = require('../subaccount/subaccount.service');

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
|
| How long a successfully used account stays deactivated before it can
| return to the available pool.
|
| Change this later according to your bank/provider's actual rules.
|
*/
const ACCOUNT_COOLDOWN_MINUTES = 60;

function generateCheckoutToken() {
  return crypto.randomBytes(32).toString('hex');
}

/*
|--------------------------------------------------------------------------
| ASSIGN VIRTUAL ACCOUNT
|--------------------------------------------------------------------------
|
| Only accounts with status = "available" can be assigned.
|
| Deactivated accounts are NEVER eligible here, even if their cooldown
| has expired. They must first pass through reactivateExpiredAccounts().
|
*/
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
    throw new Error(
      'amount_must_be_a_positive_integer_in_minor_units'
    );
  }

  let splitSubaccount = null;
  let resolvedSplitPercentage = null;

  if (subaccountCode) {
    const subaccount = await findActiveByCodeForMerchant(
      merchantId,
      subaccountCode
    );

    if (!subaccount) {
      throw new Error('unknown_or_inactive_subaccount');
    }

    resolvedSplitPercentage =
      splitPercentage ?? subaccount.defaultSplitPercentage;

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

    bankFilter = {
      bank: bank._id,
    };
  }

  const checkoutToken = generateCheckoutToken();

  const assignment = {
    status: 'assigned',
    merchant: merchantId,
    customer: customerId,
    assignedAt: new Date(),

    // Clear any old lifecycle information.
    deactivatedAt: null,
    cooldownUntil: null,

    amountExpected: amount ?? null,
    reference: reference ?? null,

    splitSubaccount,
    splitPercentage: resolvedSplitPercentage,
  };

  /*
  |--------------------------------------------------------------------------
  | FIRST ATTEMPT
  |--------------------------------------------------------------------------
  */

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

  /*
  |--------------------------------------------------------------------------
  | POOL RAN DRY
  |--------------------------------------------------------------------------
  */

  if (!account) {
    const bankSlug = preferredBankSlug || 'rexxpay-bank';

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

  /*
  |--------------------------------------------------------------------------
  | LINK CUSTOMER TO ACCOUNT
  |--------------------------------------------------------------------------
  */

  customer.virtualAccount = account._id;
  await customer.save();

  return {
    account,
    checkoutToken,
  };
}

/*
|--------------------------------------------------------------------------
| DEACTIVATE AFTER SUCCESSFUL PAYMENT
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| This is NOT the same as immediately releasing the account.
|
| The account becomes:
|
| assigned → deactivated
|
| It stays unavailable during the cooldown.
|
*/
async function releaseVirtualAccount(accountId) {
  const account = await VirtualAccount.findById(accountId);

  if (!account) {
    return null;
  }

  /*
  |--------------------------------------------------------------------------
  | ONLY ASSIGNED ACCOUNTS CAN BE CONSUMED
  |--------------------------------------------------------------------------
  */

  if (account.status !== 'assigned') {
    return account;
  }

  const now = new Date();

  const cooldownUntil = new Date(
    now.getTime() +
      ACCOUNT_COOLDOWN_MINUTES * 60 * 1000
  );

  /*
  |--------------------------------------------------------------------------
  | DEACTIVATE ACCOUNT
  |--------------------------------------------------------------------------
  */

  account.status = 'deactivated';

  account.deactivatedAt = now;
  account.cooldownUntil = cooldownUntil;

  /*
  |--------------------------------------------------------------------------
  | CLEAR PAYMENT ASSIGNMENT DATA
  |--------------------------------------------------------------------------
  |
  | The account is no longer attached to the completed order.
  |
  */

  account.merchant = null;
  account.customer = null;
  account.assignedAt = null;
  account.amountExpected = null;
  account.reference = null;
  account.splitSubaccount = null;
  account.splitPercentage = null;

  await account.save();

  /*
  |--------------------------------------------------------------------------
  | REMOVE CUSTOMER'S ACTIVE VIRTUAL ACCOUNT LINK
  |--------------------------------------------------------------------------
  */

  await Customer.updateOne(
    {
      virtualAccount: account._id,
    },
    {
      virtualAccount: null,
    }
  );

  /*
  |--------------------------------------------------------------------------
  | IMPORTANT
  |--------------------------------------------------------------------------
  |
  | We DO NOT set:
  |
  | account.status = 'available'
  |
  | here.
  |
  | The account remains deactivated until the cooldown worker reactivates
  | it.
  |
  */

  return account;
}

/*
|--------------------------------------------------------------------------
| RELEASE STALE ASSIGNED ACCOUNTS
|--------------------------------------------------------------------------
|
| This is for payments/checkouts that were assigned an account but never
| completed.
|
| These accounts can safely return to the pool according to the existing
| stale-assignment policy.
|
*/
async function releaseStaleAssignedAccounts(maxAgeMinutes) {
  const cutoff = new Date(
    Date.now() - maxAgeMinutes * 60 * 1000
  );

  const stale = await VirtualAccount.find({
    status: 'assigned',
    assignedAt: {
      $lte: cutoff,
    },
  });

  let released = 0;

  for (const account of stale) {
    /*
     * These were never successfully paid, so they can return directly
     * to the available pool.
     */
    account.status = 'available';

    account.merchant = null;
    account.customer = null;
    account.assignedAt = null;

    account.deactivatedAt = null;
    account.cooldownUntil = null;

    account.amountExpected = null;
    account.reference = null;

    account.splitSubaccount = null;
    account.splitPercentage = null;

    await account.save();

    await Customer.updateOne(
      {
        virtualAccount: account._id,
      },
      {
        virtualAccount: null,
      }
    );

    released += 1;
  }

  return released;
}

/*
|--------------------------------------------------------------------------
| REACTIVATE EXPIRED COOLDOWN ACCOUNTS
|--------------------------------------------------------------------------
|
| Finds accounts whose cooldown has expired and returns them to the pool.
|
| deactivated → available
|
| This function should be called by a scheduled worker/cron.
|
*/
async function reactivateExpiredAccounts() {
  const now = new Date();

  const accounts = await VirtualAccount.find({
    status: 'deactivated',
    cooldownUntil: {
      $ne: null,
      $lte: now,
    },
  });

  let reactivated = 0;

  for (const account of accounts) {
    /*
    |--------------------------------------------------------------------------
    | EXTRA SAFETY
    |--------------------------------------------------------------------------
    |
    | Only reactivate an account that is actually in the expected state.
    |
    */

    if (
      account.status !== 'deactivated' ||
      !account.cooldownUntil ||
      account.cooldownUntil > now
    ) {
      continue;
    }

    account.status = 'available';

    account.deactivatedAt = null;
    account.cooldownUntil = null;

    account.merchant = null;
    account.customer = null;
    account.assignedAt = null;
    account.amountExpected = null;
    account.reference = null;
    account.splitSubaccount = null;
    account.splitPercentage = null;

    await account.save();

    reactivated += 1;
  }

  return reactivated;
}

/*
|--------------------------------------------------------------------------
| MANUAL / PROVIDER DEACTIVATION
|--------------------------------------------------------------------------
|
| Keeps your existing explicit deactivation functionality.
|
| This does NOT start a cooldown because this function is an administrative
| operation, not the successful-payment lifecycle.
|
*/
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

  /*
   * Manual deactivation does not automatically make it available later.
   * A separate admin/provider action can reactivate it.
   */
  account.deactivatedAt = new Date();
  account.cooldownUntil = null;

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

/*
|--------------------------------------------------------------------------
| FIND BY ACCOUNT NUMBER
|--------------------------------------------------------------------------
*/

async function findByAccountNumber(accountNumber) {
  return VirtualAccount.findOne({
    accountNumber,
  }).populate('bank merchant customer');
}

/*
|--------------------------------------------------------------------------
| FIND BY REFERENCE
|--------------------------------------------------------------------------
*/

async function findByReference(reference) {
  return VirtualAccount.findOne({
    reference,
  }).populate('bank merchant customer');
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
  assignVirtualAccount,
  deactivateVirtualAccount,
  findByAccountNumber,
  findByReference,
  releaseVirtualAccount,
  releaseStaleAssignedAccounts,
  reactivateExpiredAccounts,
};
