// src/modules/bankPartner/bankPartner.service.js
const axios = require('axios');
const BankPartner = require('./bankPartner.model');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const generateAccountNumber = require('../../utils/generateAccountNumber');
const { rexxPayBankBaseUrl, rexxPayBankAdminKey } = require('../../config/env');
const limits = require('../../config/limits');

// Seeds the default partner bank if it doesn't already exist.
// 'rexxpay-bank' is the REAL bank (rexxpay.onrender.com) - accounts under
// it are real wallets that can actually receive transfers and fire
// webhooks. This is now the ONLY bank partner - single-bank setup.
async function ensureDefaultBankPartners() {
  const defaults = [
    { name: 'RexxPay Bank', slug: 'rexxpay-bank' },
  ];
  for (const bank of defaults) {
    await BankPartner.findOneAndUpdate({ slug: bank.slug }, bank, { upsert: true });
  }
}

// Provisions N unassigned account numbers into the pool for a given bank
// partner. For 'rexxpay-bank', this calls the REAL RexxPay Bank API to
// create real wallets with real account numbers. For any other (mock)
// bank partner, it keeps the old locally-generated fake numbers - useful
// for testing this service without touching the real bank at all.
async function provisionAccountPool(bankSlug, count = 20) {
  const bank = await BankPartner.findOne({ slug: bankSlug });
  if (!bank) throw new Error(`Unknown bank partner: ${bankSlug}`);

  if (bankSlug === 'rexxpay-bank') {
    return provisionRealAccountsFromBank(bank, count);
  }

  const accounts = [];
  for (let i = 0; i < count; i++) {
    accounts.push({
      accountNumber: generateAccountNumber(),
      bank: bank._id,
      status: 'available',
    });
  }
  // Ignore duplicate account numbers if any collide (rare with 10 digits)
  await VirtualAccount.insertMany(accounts, { ordered: false }).catch(() => {});
  return bank;
}

async function provisionRealAccountsFromBank(bank, count) {
  if (!rexxPayBankAdminKey) {
    throw new Error(
      'REXXPAY_BANK_ADMIN_KEY is not set - cannot provision real accounts from RexxPay Bank.'
    );
  }

  const created = [];

  for (let i = 0; i < count; i++) {
    try {
      const response = await axios.post(
        `${rexxPayBankBaseUrl}/api/v1/admin/pool-accounts`,
        { label: `RexxPay Infra pool account #${i + 1}` },
        {
          headers: {
            'x-admin-key': rexxPayBankAdminKey,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const { accountNumber } = response.data.data;

      created.push({
        accountNumber,
        bank: bank._id,
        status: 'available',
      });
    } catch (err) {
      // Stop on first failure rather than silently provisioning a partial,
      // possibly-broken pool - surface the real error to whoever called this.
      const message = err.response?.data?.message || err.message;
      throw new Error(`Failed to provision real account from RexxPay Bank: ${message}`);
    }
  }

  if (created.length) {
    await VirtualAccount.insertMany(created, { ordered: false }).catch(() => {});
  }

  return bank;
}

/*
|--------------------------------------------------------------------------
| AUTOMATIC POOL MANAGER
|--------------------------------------------------------------------------
|
| Checks every bank partner's available-account count and tops it up if
| it's at or below limits.POOL_MIN_THRESHOLD. Meant to be called on a
| schedule (see scripts/auto-provision-pool.js) so customers never have
| to wait on a manual admin action - the admin dashboard/route stays
| available for exceptions and manual intervention.
|
| Returns a per-bank report so callers (script/log/future dashboard) can
| show what happened.
*/
async function maintainAccountPools({
  threshold = limits.POOL_MIN_THRESHOLD,
  topUpCount = limits.POOL_TOPUP_COUNT,
} = {}) {
  const banks = await BankPartner.find();
  const results = [];

  for (const bank of banks) {
    const available = await VirtualAccount.countDocuments({
      bank: bank._id,
      status: 'available',
    });

    if (available > threshold) {
      results.push({
        bank: bank.slug,
        availableBefore: available,
        threshold,
        action: 'none',
      });
      continue;
    }

    try {
      await provisionAccountPool(bank.slug, topUpCount);

      const availableAfter = await VirtualAccount.countDocuments({
        bank: bank._id,
        status: 'available',
      });

      results.push({
        bank: bank.slug,
        availableBefore: available,
        availableAfter,
        threshold,
        provisioned: topUpCount,
        action: 'provisioned',
      });
    } catch (err) {
      // Don't let one bank's failure (e.g. missing admin key, provider
      // outage) stop the others from being checked/topped up.
      results.push({
        bank: bank.slug,
        availableBefore: available,
        threshold,
        action: 'failed',
        error: err.message,
      });
    }
  }

  return results;
}

module.exports = {
  ensureDefaultBankPartners,
  provisionAccountPool,
  maintainAccountPools,
};
