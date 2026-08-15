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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// RexxPay Bank is a Render free-tier instance: it spins down when idle
// and can take 30-60s to cold-start, returning 502s (or just hanging)
// on the request that wakes it up. It can also 429 if we hit it with a
// burst of requests back-to-back. Both are transient - retry with
// backoff rather than failing the whole pool top-up on the first blip.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;
// Between successive accounts, not just retries, to avoid tripping the
// bank's rate limiter in the first place.
const DELAY_BETWEEN_REQUESTS_MS = 300;

async function createPoolAccountWithRetry(label) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post(
        `${rexxPayBankBaseUrl}/api/v1/admin/pool-accounts`,
        { label },
        {
          headers: {
            'x-admin-key': rexxPayBankAdminKey,
            'Content-Type': 'application/json',
          },
          // Generous enough to survive a Render cold start.
          timeout: 45000,
        }
      );

      return response.data.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const isRetryable = RETRYABLE_STATUS.has(status) || err.code === 'ECONNABORTED';

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        break;
      }

      // Respect Retry-After if the bank sends one (common on 429s),
      // otherwise exponential backoff with a little jitter.
      const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
      const backoff = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 500;

      await sleep(backoff);
    }
  }

  const message = lastErr.response?.data?.message || lastErr.message;
  const status = lastErr.response?.status;
  const err = new Error(
    `Failed to provision real account from RexxPay Bank after ${MAX_ATTEMPTS} attempts` +
      `${status ? ` (last status ${status})` : ''}: ${message}`
  );
  err.cause = lastErr;
  throw err;
}

async function provisionRealAccountsFromBank(bank, count) {
  if (!rexxPayBankAdminKey) {
    throw new Error(
      'REXXPAY_BANK_ADMIN_KEY is not set - cannot provision real accounts from RexxPay Bank.'
    );
  }

  const created = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      const { accountNumber } = await createPoolAccountWithRetry(
        `RexxPay Infra pool account #${i + 1}`
      );

      created.push({
        accountNumber,
        bank: bank._id,
        status: 'available',
      });
    } catch (err) {
      // Don't let one persistently-failing account (after retries) wipe
      // out the accounts we already successfully provisioned this pass.
      errors.push(err.message);
      break;
    }

    if (i < count - 1) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  if (created.length) {
    await VirtualAccount.insertMany(created, { ordered: false }).catch(() => {});
  }

  if (errors.length && created.length === 0) {
    // Nothing got through at all - surface the real error.
    throw new Error(errors[0]);
  }

  if (errors.length) {
    // Partial success - log but don't blow up the whole request, since
    // some accounts did make it into the pool.
    console.error(
      `[provisionRealAccountsFromBank] provisioned ${created.length}/${count} before failing: ${errors[0]}`
    );
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

// Pushes SwiftPay's assign/release lifecycle to RexxPay Bank so the
// bank's own wallet.status field (used by deposit.service.js's
// assigned-only check) actually reflects reality. Failures are logged,
// not thrown - a temporarily-down/cold-starting bank shouldn't block a
// checkout from being created locally, but it does mean a deposit could
// land on an account the bank still thinks is "available" until this
// eventually succeeds (e.g. via a retry from a reconciliation job).
async function syncBankAccountStatus(accountNumber, action) {
  try {
    await axios.patch(
      `${rexxPayBankBaseUrl}/api/v1/admin/pool-accounts/${accountNumber}/${action}`,
      {},
      {
        headers: { 'x-admin-key': rexxPayBankAdminKey },
        timeout: 15000,
      }
    );
  } catch (err) {
    console.error(
      `[bankPartner] failed to ${action} account ${accountNumber} on RexxPay Bank:`,
      err.response?.data?.message || err.message
    );
  }
}

const assignBankPoolAccount = (accountNumber) => syncBankAccountStatus(accountNumber, 'assign');
const releaseBankPoolAccount = (accountNumber) => syncBankAccountStatus(accountNumber, 'release');

module.exports = {
  ensureDefaultBankPartners,
  provisionAccountPool,
  maintainAccountPools,
  assignBankPoolAccount,
  releaseBankPoolAccount,
};
