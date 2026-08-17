// scripts/fetch-and-reconcile.js
//
// Automates what used to be a manual two-step process:
//   1. Fetch RexxPay Bank's confirmed-deposit export for a date range
//      (GET /api/v1/admin/settlement-export?from=&to=)
//   2. Write it to a temp file and run it through the existing
//      reconcile.js logic unchanged.
//
// This is the missing piece referenced in the README's "Known gaps"
// section - reconcile.js alone still expects a file on disk; this script
// is what actually produces that file automatically instead of someone
// requesting a settlement file from RexxPay Bank by hand.
//
// Usage:
//   node scripts/fetch-and-reconcile.js                # last 24 hours
//   node scripts/fetch-and-reconcile.js 2026-08-16 2026-08-17

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { rexxPayBankBaseUrl, rexxPayBankAdminKey } = require('../src/config/env');

async function fetchSettlementExport(from, to) {
  if (!rexxPayBankBaseUrl || !rexxPayBankAdminKey) {
    throw new Error(
      'REXXPAY_BANK_BASE_URL and REXXPAY_BANK_ADMIN_KEY must be set to fetch the settlement export'
    );
  }

  const res = await axios.get(`${rexxPayBankBaseUrl}/api/v1/admin/settlement-export`, {
    headers: { 'x-admin-key': rexxPayBankAdminKey },
    params: { from, to },
    timeout: 30000,
  });

  if (!res.data || res.data.status !== true) {
    throw new Error(`unexpected response from settlement-export: ${JSON.stringify(res.data)}`);
  }

  return res.data.data; // array already shaped for reconcile.js
}

async function main() {
  const [, , fromArg, toArg] = process.argv;

  const to = toArg ? new Date(toArg) : new Date();
  const from = fromArg ? new Date(fromArg) : new Date(to.getTime() - 24 * 60 * 60 * 1000);

  console.log(`[fetch-and-reconcile] pulling settlement export from ${from.toISOString()} to ${to.toISOString()}...`);

  const rows = await fetchSettlementExport(from.toISOString(), to.toISOString());
  console.log(`[fetch-and-reconcile] received ${rows.length} settled deposit(s) from RexxPay Bank`);

  const tmpFile = path.join(os.tmpdir(), `rexxpay-settlement-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(rows, null, 2));

  try {
    // Reuse the existing reconcile.js exactly as-is - no duplicated logic.
    // Note: reconcile.js exits with code 1 when it FINDS discrepancies -
    // that's an expected, meaningful result, not a crash. Only treat it
    // as a genuine failure if the process couldn't run at all.
    execFileSync('node', [path.join(__dirname, 'reconcile.js'), tmpFile], {
      stdio: 'inherit',
    });
  } catch (err) {
    if (typeof err.status === 'number') {
      // reconcile.js ran to completion and reported discrepancies via its
      // own exit code - just propagate that, don't log it as a crash.
      process.exitCode = err.status;
    } else {
      throw err;
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

main().catch((err) => {
  console.error('[fetch-and-reconcile] failed:', err.message);
  process.exit(1);
});
