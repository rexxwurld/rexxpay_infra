// src/modules/virtualAccount/virtualAccount.service.js
const VirtualAccount = require('./virtualAccount.model');
const BankPartner = require('../bankPartner/bankPartner.model');
const Customer = require('../customer/customer.model');
const { provisionAccountPool } = require('../bankPartner/bankPartner.service');

// Assigns an existing pooled + available account number to a customer.
// This mirrors how Paystack actually works: it does NOT mint a new account,
// it pulls one from the bank partner's pre-provisioned pool and links it.
async function assignVirtualAccount({ merchantId, customerId, preferredBankSlug }) {
  const customer = await Customer.findOne({ _id: customerId, merchant: merchantId });
  if (!customer) throw new Error('customer_not_found');

  // Idempotent: if this customer already has an active virtual account,
  // just return it instead of assigning a second one.
  if (customer.virtualAccount) {
    const existing = await VirtualAccount.findById(customer.virtualAccount).populate('bank');
    if (existing && existing.status === 'assigned') return existing;
  }

  let bankFilter = {};
  if (preferredBankSlug) {
    const bank = await BankPartner.findOne({ slug: preferredBankSlug });
    if (!bank) throw new Error('unknown_bank_partner');
    bankFilter = { bank: bank._id };
  }

  let account = await VirtualAccount.findOneAndUpdate(
    { status: 'available', ...bankFilter },
    {
      status: 'assigned',
      merchant: merchantId,
      customer: customerId,
      assignedAt: new Date(),
    },
    { new: true }
  ).populate('bank');

  // Pool ran dry - top it up from the (mock) bank partner and try again.
  if (!account) {
    const bankSlug = preferredBankSlug || 'wema-bank';
    await provisionAccountPool(bankSlug, 20);
    account = await VirtualAccount.findOneAndUpdate(
      { status: 'available', ...bankFilter },
      {
        status: 'assigned',
        merchant: merchantId,
        customer: customerId,
        assignedAt: new Date(),
      },
      { new: true }
    ).populate('bank');
  }

  if (!account) throw new Error('no_accounts_available');

  customer.virtualAccount = account._id;
  await customer.save();

  return account;
}

async function deactivateVirtualAccount({ merchantId, accountNumber }) {
  const account = await VirtualAccount.findOne({ accountNumber, merchant: merchantId });
  if (!account) throw new Error('account_not_found');

  account.status = 'deactivated';
  await account.save();

  await Customer.updateOne({ virtualAccount: account._id }, { virtualAccount: null });
  return account;
}

async function findByAccountNumber(accountNumber) {
  return VirtualAccount.findOne({ accountNumber }).populate('bank merchant customer');
}

module.exports = { assignVirtualAccount, deactivateVirtualAccount, findByAccountNumber };
