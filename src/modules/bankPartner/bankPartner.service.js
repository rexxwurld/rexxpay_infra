// src/modules/bankPartner/bankPartner.service.js
const axios = require('axios');
const BankPartner = require('./bankPartner.model');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const generateAccountNumber = require('../../utils/generateAccountNumber');
const { rexxPayBankBaseUrl, rexxPayBankAdminKey } = require('../../config/env');
const limits = require('../../config/limits');

async function ensureDefaultBankPartners() {
  const defaults = [{ name: 'RexxPay Bank', slug: 'rexxpay-bank' }];
  for (const bank of defaults) {
    await BankPartner.findOneAndUpdate({ slug: bank.slug }, bank, { upsert: true });
  }
}

// mode = 'test' NEVER calls the real RexxPay Bank API, no matter which
// bankSlug is requested. This is the structural guarantee that a
// test-key checkout can never reach the real bank: it's not just
// "gated at the controller", it's physically impossible to get a real
// account number out of this function in test mode.
async function provisionAccountPool(bankSlug, count = 20, mode = 'test') {
  const bank = await BankPartner.findOne({ slug: bankSlug });
  if (!bank) throw new Error(`Unknown bank partner: ${bankSlug}`);

  if (mode !== 'live') {
    const accounts = [];
    for (let i = 0; i < count; i++) {
      accounts.push({
        accountNumber: generateAccountNumber(),
        bank: bank._id,
        status: 'available',
        mode: 'test',
      });
    }
    await VirtualAccount.insertMany(accounts, { ordered: false }).catch(() => {});
    return bank;
  }

  if (bankSlug === 'rexxpay-bank') {
    return provisionRealAccountsFromBank(bank, count);
  }

  const accounts = [];
  for (let i = 0; i < count; i++) {
    accounts.push({
      accountNumber: generateAccountNumber(),
      bank: bank._id,
      status: 'available',
      mode: 'live',
    });
  }
  await VirtualAccount.insertMany(accounts, { ordered: false }).catch(() => {});
  return bank;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;
const DELAY_BETWEEN_REQUESTS_MS = 300;

async function createPoolAccountWithRetry(label) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post(
        `${rexxPayBankBaseUrl}/api/v1/admin/pool-accounts`,
        { label },
        {
          headers: { 'x-admin-key': rexxPayBankAdminKey, 'Content-Type': 'application/json' },
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
    throw new Error('REXXPAY_BANK_ADMIN_KEY is not set - cannot provision real accounts from RexxPay Bank.');
  }

  const created = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      const { accountNumber } = await createPoolAccountWithRetry(`RexxPay Infra pool account #${i + 1}`);
      created.push({ accountNumber, bank: bank._id, status: 'available', mode: 'live' });
    } catch (err) {
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
    throw new Error(errors[0]);
  }

  if (errors.length) {
    console.error(`[provisionRealAccountsFromBank] provisioned ${created.length}/${count} before failing: ${errors[0]}`);
  }

  return bank;
}

// Only tops up the REAL (live) pool - test-mode accounts are cheap to
// generate on demand inside assignVirtualAccount and never need
// pre-warming, since they never touch the network.
async function maintainAccountPools({
  threshold = limits.POOL_MIN_THRESHOLD,
  topUpCount = limits.POOL_TOPUP_COUNT,
} = {}) {
  const banks = await BankPartner.find();
  const results = [];

  for (const bank of banks) {
    const available = await VirtualAccount.countDocuments({ bank: bank._id, status: 'available', mode: 'live' });

    if (available > threshold) {
      results.push({ bank: bank.slug, availableBefore: available, threshold, action: 'none' });
      continue;
    }

    try {
      await provisionAccountPool(bank.slug, topUpCount, 'live');

      const availableAfter = await VirtualAccount.countDocuments({ bank: bank._id, status: 'available', mode: 'live' });

      results.push({
        bank: bank.slug,
        availableBefore: available,
        availableAfter,
        threshold,
        provisioned: topUpCount,
        action: 'provisioned',
      });
    } catch (err) {
      results.push({ bank: bank.slug, availableBefore: available, threshold, action: 'failed', error: err.message });
    }
  }

  return results;
}

async function syncBankAccountStatus(accountNumber, action) {
  try {
    await axios.patch(
      `${rexxPayBankBaseUrl}/api/v1/admin/pool-accounts/${accountNumber}/${action}`,
      {},
      { headers: { 'x-admin-key': rexxPayBankAdminKey }, timeout: 15000 }
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
const deactivateBankPoolAccount = (accountNumber) => syncBankAccountStatus(accountNumber, 'deactivate');

module.exports = {
  ensureDefaultBankPartners,
  provisionAccountPool,
  maintainAccountPools,
  assignBankPoolAccount,
  releaseBankPoolAccount,
  deactivateBankPoolAccount,
};
