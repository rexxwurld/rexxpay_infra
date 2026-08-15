# SwiftPay 

A Paystack-style payment infrastructure: merchants integrate, onboard customers,
get assigned dedicated virtual accounts, and receive verified webhook-driven
wallet credits when customers pay via bank transfer.

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose
- JWT (merchant dashboard auth) + API key auth (merchant integration auth)
- HMAC-signed webhooks

## Architecture

```
Merchant  --(secret key)-->  RexxPay API  --(pool assignment)-->  Bank Partner
                                   ^                                     |
                                   |                                     v
                          verified webhook  <----------------  customer transfers money
                                   |
                                   v
                        Transaction recorded + Wallet credited
```

The "Bank Partner" above is one of two things depending on environment:

- **Mock bank partner** (`bankPartner` module + `/api/mock-bank/simulate-transfer`,
  dev-only) — generates fake pool accounts locally and fires a self-signed
  webhook, so the full loop can be tested without any external dependency.
- **RexxPay Bank** (real) — `bankPartner.service.js` can also provision real
  pool accounts from an external RexxPay Bank instance over HTTP, authenticated
  with `REXXPAY_BANK_ADMIN_KEY` against `REXXPAY_BANK_BASE_URL`. This is the
  non-mock path and is what a production deployment would use.

### Modules

| Module | Responsibility |
|---|---|
| `auth` | Merchant registration/login, JWT dashboard sessions, API key issuance |
| `merchant` | Merchant profile, webhook URL configuration |
| `customer` | Merchant's end-customers |
| `bankPartner` | Bank partner records; provisions pooled account numbers (mock locally, or real via RexxPay Bank) |
| `virtualAccount` | Assigns pooled accounts to customers (never mints new ones) |
| `payment` | Hosted checkout: creates the customer, assigns a virtual account, and returns a payment link (`pay.html`) a merchant can redirect to; `verify` polls the resulting transaction status |
| `wallet` | Merchant settlement balance, atomic credit/debit |
| `transaction` | Ledger of every payment event, idempotent recording |
| `payout` | Outbound transfers to merchants' real bank accounts |
| `webhook` | Verifies bank partner signatures; the ONLY path that can mark a payment successful |
| `admin` | Operator-only endpoints (behind `INFRA_ADMIN_KEY`) to provision the account pool and check pool health |

### Key design decisions (and why)

- **Accounts are pooled, not generated on demand.** A `VirtualAccount` pool is
  pre-provisioned per bank partner. Assignment just links an `available`
  account to a customer — matching how Paystack's real dedicated virtual
  accounts work.
- **Only the signed webhook can mark a transaction successful.** No public
  endpoint lets a client or merchant directly set a transaction to
  `success` — that would let anyone credit their own wallet for free.
- **Idempotency everywhere.** Webhook processing keys off the bank's own
  transaction reference so retried/duplicate webhooks don't double-credit.
- **Wallet updates are atomic (`$inc`)**, not read-then-write, to avoid race
  conditions when multiple webhooks land close together.

## What's been added beyond the original mock

This started as an architecturally-correct mock of a Paystack-style
processor. The pieces below move it closer to how a real payment company
is actually built — but read the "Still not real" section too, since some
of this is a real control and some is a stub showing where a real control
must go.

| Module | What it does |
|---|---|
| `ledger` | Double-entry bookkeeping (`LedgerEntry`). Every wallet credit/debit also posts a balanced debit+credit pair. `wallet.balance` is now a cache; the ledger is the source of truth and can rebuild any balance from history. |
| `audit` | Append-only `AuditLog` — every webhook signature failure, flagged transaction, payout, and login writes a record. |
| `webhook` (reworked) | The HTTP handler now only verifies the signature, persists the raw event (`WebhookEvent`), and acks. Actual processing happens async in `webhook.processor.js`, with retry/backoff and a `redriveStuckEvents()` call on startup for anything left mid-flight after a crash. This is the seam to swap in a real queue (SQS/BullMQ). |
| `payout` | The outbound half of the system — merchants can request a payout to a real bank account. Debits the wallet, posts ledger entries, and calls a stubbed `sendToRealBank()` — swap that one function for a real disbursement provider and the rest (atomicity, limits, reversal-on-failure) is real. |
| `payment` | Hosted checkout on top of the existing virtual-account primitive — `initialize` creates the customer + account and hands back a link; `verify` reads back the transaction status by `tx_ref`. |
| `admin` | HTTP-based operator tooling (`provision-pool`, `pool-status`) so the account pool can be managed without shell access, guarded by `INFRA_ADMIN_KEY`. |
| `config/limits.js` + risk checks in `transaction.service.js` | Per-transaction, daily, and velocity limits. Transactions that exceed them land as `status: 'flagged'` instead of auto-crediting, for manual review. |
| `utils/sanctionsCheck.js` | **Stub only** — shows where real AML/sanctions screening (OFAC/UN/NFIU lists via a licensed provider) must run, with a dev-only denylist for testing the flagging path. |
| `scripts/reconcile.js` | Compares our transaction records against a bank settlement export (JSON) and reports mismatches in both directions — money we think we have that the bank doesn't confirm, and money the bank settled that we never recorded. |
| Idempotency | `Transaction.reference` and `Payout.reference` both have unique DB indexes, so even a race between two concurrent webhook deliveries fails safely at the database level, not just in application logic. |

## Still not real (and why it's hard)

- **`sendToRealBank()` in `payout.service.js`** always "succeeds." Wiring a
  real disbursement provider means handling their actual async
  success/pending/failure states, not just a boolean.
- **`sanctionsCheck.js`** is exact-string-match against an env var — real
  screening needs fuzzy name matching against maintained watchlists via a
  licensed provider.
- **The webhook queue is in-process** (`setImmediate` + `setTimeout`
  backoff), not a durable broker — it won't survive the process being
  killed mid-retry the way SQS/BullMQ would.
- **No license.** None of the above makes this legally allowed to hold or
  move other people's money — that still requires a CBN license or a
  partnership with an already-licensed bank/PSB/MFB.

## Frontend

`public/` is a small static site served directly by Express (no build step):

| Page | What it's for |
|---|---|
| `index.html` | Marketing/landing page |
| `onboarding.html` | Merchant register/login (`?tab=login` or `?tab=register`) |
| `dashboard.html` | Logged-in merchant dashboard — wallet balance, transactions, API keys |
| `pay.html` | Customer-facing checkout page rendered by the `payment.initialize` link; polls `GET /api/virtual-accounts/:accountNumber/public-status` |

## Getting Started

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `MONGO_URI`, `JWT_SECRET` — required to run at all
   - `BANK_WEBHOOK_SECRET` — must match whatever bank partner is signing webhooks
   - `REXXPAY_BANK_BASE_URL`, `REXXPAY_BANK_ADMIN_KEY` — only needed if
     provisioning real accounts from an external RexxPay Bank instance rather
     than using the local mock bank
   - `INFRA_ADMIN_KEY` — required to call the `/api/admin` routes
   - `SANCTIONS_DENYLIST_DEV` — optional, comma-separated names to exercise
     the flagging path locally (see `utils/sanctionsCheck.js`)
   - `MAX_SINGLE_PAYMENT_MINOR`, `MAX_DAILY_INBOUND_MINOR`,
     `VELOCITY_WINDOW_MINUTES`, `VELOCITY_MAX_COUNT`,
     `MAX_SINGLE_PAYOUT_MINOR`, `VIRTUAL_ACCOUNT_EXPIRY_MINUTES`,
     `DISPUTE_EVIDENCE_WINDOW_DAYS` — optional, override the defaults in
     `config/limits.js`
   - `POOL_MIN_THRESHOLD`, `POOL_TOPUP_COUNT` — optional, override the
     defaults in `config/limits.js` that control when
     `scripts/auto-provision-pool.js` tops up a bank's account pool
   - `PLATFORM_FEE_BPS`, `PLATFORM_FEE_FIXED_MINOR`, `PLATFORM_FEE_CAP_MINOR`
     — optional, override the default platform fee charged per transaction
     in `config/fees.js`
3. `npm run dev`

## Scripts

Operational scripts, run manually or on a schedule (all read `.env` the same
way the server does):

| Command | What it does |
|---|---|
| `npm run provision-bank-pool [count]` | One-time (or top-up) provisioning of real pool accounts from RexxPay Bank. Requires `REXXPAY_BANK_ADMIN_KEY`. Default count: 10. |
| `npm run auto-provision-pool` | Checks each bank partner's available-account count and tops it up by `POOL_TOPUP_COUNT` whenever it drops to or below `POOL_MIN_THRESHOLD`. Intended to run on a cron. |
| `npm run release-stale-accounts` | Releases virtual accounts stuck in `assigned` past `VIRTUAL_ACCOUNT_EXPIRY_MINUTES` with no payment, back to the available pool. Intended to run on a cron every 5–15 minutes. |
| `npm run reactivate-expired-accounts` | Companion to the release job — moves `deactivated` accounts whose `cooldownUntil` has passed back to `available` so they can be reassigned. |
| `npm run generate-invoices` | Sweeps subscriptions with a due `nextBillingDate`, creates the `Invoice` + a virtual account for the customer to pay it into. Intended to run on a cron. |
| `npm run reconcile -- path/to/settlement-file.json` | Compares local `Transaction` records against a bank settlement export and reports mismatches in both directions. |

`webhook.processor.js` also self-heals on server startup: any webhook event
left mid-processing after a crash is picked up by `redriveStuckEvents()`
automatically — no manual step needed for that one.

## Testing the full flow locally

```bash
# 1. Register a merchant (save the secretKey from the response)
curl -X POST localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"businessName":"Test Store","email":"a@b.com","password":"pass1234"}'

# 2. Create a customer
curl -X POST localhost:5000/api/customers \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"fullName":"Jane Doe","email":"jane@example.com"}'

# 3. Assign a virtual account to that customer
curl -X POST localhost:5000/api/virtual-accounts \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"customerId":"<customer_id_from_step_2>"}'

# 4. Simulate a customer paying into that account (dev-only route)
curl -X POST localhost:5000/api/mock-bank/simulate-transfer \
  -H "Content-Type: application/json" \
  -d '{"accountNumber":"<account_number_from_step_3>","amount":500000}'

# 5. Check the wallet balance
curl localhost:5000/api/wallet -H "Authorization: Bearer sk_test_xxx"
```

### Hosted checkout flow (alternative to steps 2–3 above)

```bash
# Creates the customer + assigns a virtual account in one call, returns a
# checkout link (pay.html) you can redirect the end customer to.
curl -X POST localhost:5000/api/payments/initialize \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"amount":5000,"customer":{"email":"jane@example.com","name":"Jane Doe"},"redirect_url":"https://example.com/thanks"}'

# Poll for status by tx_ref once the customer has paid
curl localhost:5000/api/payments/verify/<tx_ref> \
  -H "Authorization: Bearer sk_test_xxx"
```

## API Endpoints

All routes below live under `/api/v1` (current, use this for new integrations)
and are also mounted unversioned at `/api` (back-compat alias only — see the
note in `app.js`; not a permanent second contract).

### Auth
- POST /api/v1/auth/register
- POST /api/v1/auth/login
- POST /api/v1/auth/logout
- POST /api/v1/auth/2fa/verify  (second step of login when 2FA is enabled — takes the short-lived `tempToken` from `/login`)
- POST /api/v1/auth/2fa/setup  (requires an authenticated session)
- POST /api/v1/auth/2fa/enable
- POST /api/v1/auth/2fa/disable

### Merchant
- GET   /api/v1/merchant/me
- PATCH /api/v1/merchant/webhook-url
- POST  /api/v1/merchant/regenerate-key

### Customers
- POST /api/v1/customers
- GET  /api/v1/customers

### Virtual Accounts
- POST /api/v1/virtual-accounts
- GET  /api/v1/virtual-accounts/:accountNumber
- POST /api/v1/virtual-accounts/:accountNumber/deactivate

### Checkout (public — no merchant API key; the customer never holds your secret key)
- GET /pay/:checkoutToken  (serves the hosted `pay.html` page)
- GET /api/v1/checkout/:token/status
- GET /api/v1/checkout/:token/complete

### Payments (hosted checkout — server-to-server, requires merchant API key)
- POST /api/v1/payments/initialize
- GET  /api/v1/payments/verify/:tx_ref

### Wallet
- GET /api/v1/wallet
- GET /api/v1/wallet/all

### Transactions
- GET /api/v1/transactions

### Payouts
- POST /api/v1/payouts
- POST /api/v1/payouts/bulk
- GET  /api/v1/payouts

### Refunds
- POST /api/v1/refunds
- GET  /api/v1/refunds
- GET  /api/v1/refunds/:id

### Subaccounts
- POST /api/v1/subaccounts
- GET  /api/v1/subaccounts
- GET  /api/v1/subaccounts/:id
- POST /api/v1/subaccounts/:id/settle

### Recipients
- POST   /api/v1/recipients
- GET    /api/v1/recipients
- GET    /api/v1/recipients/:id
- DELETE /api/v1/recipients/:id

### Subscriptions
- POST /api/v1/subscriptions/plans
- GET  /api/v1/subscriptions/plans
- POST /api/v1/subscriptions
- GET  /api/v1/subscriptions
- POST /api/v1/subscriptions/:id/cancel
- GET  /api/v1/subscriptions/invoices

### Disputes
- GET  /api/v1/disputes  (merchant-visible: own disputes only)
- GET  /api/v1/disputes/:id
- POST /api/v1/disputes/:id/evidence
- POST /api/v1/disputes  (ops-only, requires `INFRA_ADMIN_KEY` — a chargeback notice arriving from outside)
- POST /api/v1/disputes/:id/resolve  (ops-only, requires `INFRA_ADMIN_KEY`)

### Webhooks
- POST /api/v1/webhooks/bank  (bank-partner-only, HMAC signature required)

### Admin (operator-only, requires `INFRA_ADMIN_KEY`)
- GET   /api/v1/admin/provision-pool  (`?bankSlug=&count=&adminKey=`, or `x-admin-key` header)
- GET   /api/v1/admin/pool-status  (`?adminKey=`, or `x-admin-key` header)
- PATCH /api/v1/admin/merchants/:id/fees  (per-merchant fee override; never merchant-settable)

### Dev-only
- POST /api/v1/mock-bank/simulate-transfer  (simulates a customer paying — the guard that disables this in production is currently commented out in `app.js`; the route itself is unauthenticated by design and its own header comment says to delete/disable it before production)
- GET  /api/v1/mock-bank/simulate-transfer/:eventId/status  (polls what happened to a simulated transfer's webhook)

## Author

Built by Rexxwurld
