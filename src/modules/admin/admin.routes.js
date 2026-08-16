// src/modules/admin/admin.routes.js
//
// Lets you (the operator) provision the account pool and check its status
// via a plain HTTP call instead of running a script over SSH/Shell/Termux.
// Guarded by INFRA_ADMIN_KEY - never exposed to merchants.

const express = require('express');
const router = express.Router();
const requireAdminKey = require('../../middleware/adminKey.middleware');
const { ensureDefaultBankPartners, provisionAccountPool } = require('../bankPartner/bankPartner.service');
const VirtualAccount = require('../virtualAccount/virtualAccount.model');
const BankPartner = require('../bankPartner/bankPartner.model');
const Merchant = require('../merchant/merchant.model');

// GET so it's genuinely "visit a URL" - no curl/Postman needed. A GET that
// changes state is unconventional REST, but this is an internal operator
// tool behind a secret key, not a public API - convenience wins here.
//
// Visit:
//   https://checkout-rexxpay.onrender.com/api/admin/provision-pool?bankSlug=rexxpay-bank&count=100&adminKey=YOUR_KEY
//
// Prefer sending the key as a header (x-admin-key) over a browser URL bar
// when you can - URLs get logged in browser history and server access
// logs. The query param exists purely for "paste a link and go" convenience.
router.get('/provision-pool', requireAdminKey, async (req, res) => {
  try {
    const bankSlug = req.query.bankSlug || 'rexxpay-bank';
    const count = Math.min(parseInt(req.query.count, 10) || 20, 500); // hard cap per call
    const mode = req.query.mode === 'live' ? 'live' : 'test'; // must opt into live explicitly

    await ensureDefaultBankPartners();
    await provisionAccountPool(bankSlug, count, mode);

    const available = await VirtualAccount.countDocuments({ status: 'available' });
    const assigned = await VirtualAccount.countDocuments({ status: 'assigned' });

    res.json({
      status: true,
      message: `Provisioned ${count} account(s) from ${bankSlug}.`,
      poolTotals: { available, assigned },
    });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

// Quick pool health check - visit this any time to see if you're running low.
//   https://checkout-rexxpay.onrender.com/api/admin/pool-status?adminKey=YOUR_KEY
router.get('/pool-status', requireAdminKey, async (req, res) => {
  try {
    const banks = await BankPartner.find();
    const byBank = await Promise.all(
      banks.map(async (bank) => ({
        bank: bank.slug,
        available: await VirtualAccount.countDocuments({ bank: bank._id, status: 'available' }),
        assigned: await VirtualAccount.countDocuments({ bank: bank._id, status: 'assigned' }),
      }))
    );
    res.json({ status: true, data: byBank });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// Set (or clear) a per-merchant platform fee override. Any field left out
// of the body clears back to the global default (src/config/fees.js).
// Never merchant-settable - deliberately admin-key-only.
//
//   PATCH /api/admin/merchants/:id/fees
//   { "percentageBps": 100, "fixedMinor": 5000, "capMinor": 150000 }
router.patch('/merchants/:id/fees', requireAdminKey, async (req, res) => {
  try {
    const { percentageBps, fixedMinor, capMinor } = req.body;
    const fees = {};
    if (percentageBps != null) fees.percentageBps = Number(percentageBps);
    if (fixedMinor != null) fees.fixedMinor = Number(fixedMinor);
    if (capMinor != null) fees.capMinor = Number(capMinor);

    const merchant = await Merchant.findByIdAndUpdate(
      req.params.id,
      { $set: { fees } },
      { new: true }
    ).select('businessName fees');

    if (!merchant) {
      return res.status(404).json({ status: false, message: 'merchant_not_found' });
    }

    res.json({ status: true, data: merchant });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

module.exports = router;
