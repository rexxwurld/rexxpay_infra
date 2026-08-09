// src/modules/bankPartner/bankPartner.service.js
const BankPartner = require('./bankPartner.model');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const generateAccountNumber = require('../../utils/generateAccountNumber');

// Seeds the two default partner banks if they don't already exist.
async function ensureDefaultBankPartners() {
  const defaults = [
    { name: 'Wema Bank', slug: 'wema-bank' },
    { name: 'Titan Trust Bank', slug: 'titan-trust-bank' },
  ];
  for (const bank of defaults) {
    await BankPartner.findOneAndUpdate({ slug: bank.slug }, bank, { upsert: true });
  }
}

// Simulates the bank partner provisioning N unassigned account numbers into
// the pool. In real life this happens on the bank's side; you'd just call
// their API to "request" one. Here we pre-generate a batch to draw from.
async function provisionAccountPool(bankSlug, count = 20) {
  const bank = await BankPartner.findOne({ slug: bankSlug });
  if (!bank) throw new Error(`Unknown bank partner: ${bankSlug}`);

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

module.exports = { ensureDefaultBankPartners, provisionAccountPool };
