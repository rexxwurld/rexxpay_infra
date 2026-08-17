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
Merchant  --(secret key)-->  SwiftPay API  --(pool assignment)-->  Bank Partner
                                   ^                                     |
                                   |                                     v
                          verified webhook  <----------------  customer transfers money
                                   |
                                   v
                        Transaction recorded + Wallet credited
```

The "Bank Partner" above is one of two things depending on environment:

- **Mock bank partner** (`bankPartner` module + a test-mode checkout's
  `POST /checkout/:token/simulate`, dev-only) — generates fake pool accounts
  locally and fires a self-signed webhook, so the full loop can be tested
  without any external dependency.
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
| `demo` | Backs the public `/demo` page — a no-signup, test-mode-only checkout run against one dedicated, auto-provisioned demo merchant, so a visitor can try the flow without ever touching a real merchant's data |

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
| `webhook` (reworked) | The HTTP handler now only verifies the signature, persists the raw event (`WebhookEvent`), and acks. Actual processing happens async via a durable, Redis-backed BullMQ queue (`src/queue/webhookQueue.js` + `webhookWorker.js`), with retry/backoff owned by BullMQ and a `redriveStuckEvents()` call on startup that re-enqueues anything left mid-flight after a crash. |
| `payout` | The outbound half of the system — merchants can request a payout to a real bank account. Debits the wallet, posts ledger entries, and calls `rexxPayBankClient.sendPayoutInstruction()`, which makes a real signed HTTP call to the RexxPay Bank instance (retries with backoff, and flags ambiguous outcomes so a network failure isn't silently treated as success or failure). Test-mode payouts instead hit `simulatePayoutInstruction()`, which makes no network call at all. |
| `payment` | Hosted checkout on top of the existing virtual-account primitive — `initialize` creates the customer + account and hands back a link; `verify` reads back the transaction status by `tx_ref`. |
| `admin` | HTTP-based operator tooling (`provision-pool`, `pool-status`) so the account pool can be managed without shell access, guarded by `INFRA_ADMIN_KEY`. |
| `config/limits.js` + risk checks in `transaction.service.js` | Per-transaction, daily, and velocity limits. Transactions that exceed them land as `status: 'flagged'` instead of auto-crediting, for manual review. |
| `utils/sanctionsCheck.js` | **Stub only** — shows where real AML/sanctions screening (OFAC/UN/NFIU lists via a licensed provider) must run, with a dev-only denylist for testing the flagging path. |
| `scripts/reconcile.js` | Compares our transaction records against a bank settlement export (JSON) and reports mismatches in both directions — money we think we have that the bank doesn't confirm, and money the bank settled that we never recorded. |
| Idempotency | `Transaction.reference` and `Payout.reference` both have unique DB indexes, so even a race between two concurrent webhook deliveries fails safely at the database level, not just in application logic. |
| `settlement` | Moves a successful transaction through `pending_settlement → settled → available` on a schedule (`scripts/run-settlement.js`), recording one `SettlementBatch` per cycle per phase so any transaction's settlement history is traceable, not just an invisible cron side effect. |
| `refund` | Full or partial refunds against a settled transaction; posts the reversing ledger entries and drives its own `pending → processing → successful/failed/reversed` status. |
| `subaccount` | Paystack-style split payments — routes a percentage of an incoming payment to a sub-merchant's ledger balance (no login/wallet of its own) at checkout time, and lets the parent merchant settle that balance out to the subaccount's bank account on demand. |
| `recipient` | Saved payout destinations (`rcp_xxxxx`) a merchant can reuse across `payout`/`payout/bulk` calls instead of re-typing bank details each time. |
| `subscription` | Recurring billing: merchants define `Plan`s, customers `Subscription` to them, and `scripts/generate-invoices.js` sweeps due subscriptions to create `Invoice`s (each with its own pay-in virtual account) on a schedule. |
| `dispute` | Chargeback handling — ops opens a dispute against a transaction (freezing the disputed amount), the merchant submits evidence within `DISPUTE_EVIDENCE_WINDOW_DAYS`, and ops resolves it `won`/`lost`. |

## Still not real (and why it's hard)

- **`sanctionsCheck.js`** is exact-string-match against an env var — real
  screening needs fuzzy name matching against maintained watchlists via a
  licensed provider.
- **No license.** None of the above makes this legally allowed to hold or
  move other people's money — that still requires a CBN license or a
  partnership with an already-licensed bank/PSB/MFB.

## Frontend

`public/` is a small static site served directly by Express (no build step):

| Page | What it's for |
|---|---|
| `index.html` | Marketing/landing page |
| `onboarding.html` | Merchant register/login (`?tab=login` or `?tab=register`) |
| `dashboard.html` | Logged-in merchant dashboard — see "Merchant dashboard" below |
| `pay.html` | Customer-facing checkout page rendered by the `payment.initialize` link; polls `GET /api/v1/checkout/:token/status`, and for test-mode checkouts offers a "simulate transfer" button that calls `POST /api/v1/checkout/:token/simulate` |
| `demo.html` | Public, no-signup demo of the checkout flow, served at `/demo`; talks only to `POST /api/v1/demo/checkout` |
| `admin.html` | Operator dashboard (pool status + manual provisioning), served at `/admin`; authenticates client-side against the `INFRA_ADMIN_KEY`-protected `/api/v1/admin/*` routes |
| `folder/*.html` | Marketing site pages — `products.html`, `pricing.html`, `developers.html`, `company.html`, `viewdocs.html`, and legal pages (`terms_of_service.html`, `privacy_policy.html`, `cookie_policy.html`) |

### Merchant dashboard (`dashboard.html`)

Single-page, tab-based dashboard styled after Paystack/Flutterwave's merchant
consoles. All data loads client-side from the session-authenticated
`/api/*` endpoints (`public/js/dashboard.js` + `public/js/api.js`):

| Tab | What it shows |
|---|---|
| Overview | Wallet balance, volume received, flagged count, paid-out total, a 14-day revenue bar chart, quick payment-link generator, recent transactions |
| Analytics | 30-day bar chart (received vs. paid out), a candlestick chart of daily transaction open/high/low/close, and computed business insights (average transaction value, success rate, busiest day, refund rate, open disputes, active subscriptions) |
| Transactions | Full transaction ledger with status filters and search |
| Customers | Merchant's end-customers |
| Refunds | Request a refund against a settled transaction; refund history |
| Disputes | Open disputes and evidence submission |
| Subscriptions | Plans, subscribing customers, and generated invoices |
| Settlements | Settlement schedule and status |
| Payouts | Request a payout; payout history |
| Settings | Business profile, API secret key regeneration, webhook URL |

Charts are rendered with [Chart.js](https://www.chartjs.org/) plus the
`chartjs-chart-financial` plugin (loaded from CDN in `dashboard.html`); all
chart data is computed client-side from the same `transactions`/`payouts`
arrays the rest of the dashboard already loads — no new backend endpoints
were needed. If the CDN is unreachable the dashboard degrades gracefully
(charts simply don't render; every other panel still works).

### Marketing site

Every marketing/legal page under `public/` and `public/folder/` carries a
floating "Try Live Demo" button (bottom-right) that links straight to
`demo.html`, so a visitor can try a real checkout without signing up. Every
"Documentation" link across the site points at `folder/viewdocs.html`,
which in turn links out to the live interactive API explorer
(`/api/docs`, generated from `docs/openapi.yaml`).

## Getting Started

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `MONGO_URI`, `JWT_SECRET` — required to run at all
   - `BANK_WEBHOOK_SECRET` — must match whatever bank partner is signing webhooks
   - `REXXPAY_BANK_BASE_URL`, `REXXPAY_BANK_ADMIN_KEY` — only needed if
     provisioning real accounts from an external RexxPay Bank instance rather
     than using the local mock bank
   - `REXXPAY_BANK_PAYOUT_SECRET` — signs outgoing payout instructions to
     RexxPay Bank; defaults to `BANK_WEBHOOK_SECRET` if unset
   - `LINKED_SERVICE_NAME` — how this service identifies itself in payout
     instructions; must match the `linkedService` value on the RexxPay Bank side
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
   - `SETTLEMENT_CUTOFF_MINUTES`, `SETTLEMENT_AVAILABILITY_DELAY_MINUTES`,
     `SETTLEMENT_BATCH_SIZE` — optional, control how long a confirmed
     payment sits before it's eligible to settle, the extra hold before
     it's payable, and the max transactions processed per batch (see
     `npm run run-settlement`)
3. `npm run dev` — starts the API server
4. `npm run worker:dev` — starts the BullMQ webhook worker (separate process; without
   it, webhook events are persisted and queued but never processed)

## Scripts

Operational scripts, run manually or on a schedule (all read `.env` the same
way the server does):

| Command | What it does |
|---|---|
| `npm run provision-bank-pool [count]` | One-time (or top-up) provisioning of real pool accounts from RexxPay Bank. Requires `REXXPAY_BANK_ADMIN_KEY`. Default count: 10. |
| `npm run auto-provision-pool` | Checks each bank partner's available-account count and tops it up by `POOL_TOPUP_COUNT` whenever it drops to or below `POOL_MIN_THRESHOLD`. Intended to run on a cron. |
| `npm run release-stale-accounts` | Releases virtual accounts stuck in `assigned` past `VIRTUAL_ACCOUNT_EXPIRY_MINUTES` with no payment, back to the available pool. Intended to run on a cron every 5–15 minutes. |
| `npm run reactivate-expired-accounts` | Companion to the release job — moves `deactivated` accounts whose `cooldownUntil` has passed back to `available` so they can be reassigned. |
| `npm run generate-invoices` | Sweeps subscriptions with a due `nextBillingDate`, creates the `Invoice` + a virtual account for the customer to pay it into. Intended to run on a cron. Currently a no-op until at least one merchant creates a `Plan` and subscribes a customer to it — safe to leave running either way. |
| `npm run reconcile -- path/to/settlement-file.json` | Compares local `Transaction` records against a bank settlement export and reports mismatches in both directions. **Not yet automatable** — RexxPay Bank doesn't currently expose an endpoint or export that supplies this file automatically, so it's still a manual step: get the settlement file from RexxPay Bank, then run this by hand. See "Known gaps" below. |
| `npm run run-settlement` | Runs one settlement cycle now: moves eligible transactions `pending_settlement → settled → available` and writes a `SettlementBatch` record for each phase. Intended to run on a cron; can also be triggered ad hoc via `POST /api/v1/admin/settlement/run`. |

`webhook.processor.js` also self-heals on server startup: any webhook event
left mid-processing after a crash is picked up by `redriveStuckEvents()`
automatically — no manual step needed for that one.

## Production Setup (Render + Hostinger cron)

Current live deployment: `checkout-swiftpay` web service on Render
(`https://checkout-rexxpay.onrender.com`), Free instance type.

### Redis (required — webhook processing silently does nothing without it)

The durable webhook queue (`src/queue/webhookQueue.js` + `webhookWorker.js`)
requires Redis. Without `REDIS_URL` set, it falls back to
`redis://127.0.0.1:6379`, which doesn't exist in this deployment — every
webhook then gets persisted to Mongo (`WebhookEvent`, `status: 'queued'`)
but **never processed**: no transaction gets recorded, no merchant webhook
fires, and the failure is silent (only logged, never surfaced anywhere).

Fixed by provisioning a Render **Key Value** instance (Redis-compatible),
Free tier, same region (Oregon) as the web service, and setting
`REDIS_URL` to its **Internal** connection string on the `checkout-swiftpay`
environment. `redriveStuckEvents()` (runs on every server boot) then
sweeps up anything that got stuck before the fix and re-processes it
automatically.

Free-tier Redis has no persistence (`Off`) and can restart (Render
maintenance, OOM at 25 MB, etc.) — this is an accepted trade-off, not a
bug: the durable copy of every webhook event lives in Mongo first, so a
Redis restart only loses the "go process this" notification, not the
underlying data. `redriveStuckEvents()` on the next SwiftPay server
restart re-sends that notification. The gap: if Redis restarts but
SwiftPay's own server doesn't restart for a while after, an event can sit
stalled (silently) until SwiftPay's next deploy/restart triggers the sweep.

### Cron (scheduled jobs, run externally via Hostinger)

Render Cron Jobs cost money (no free tier for the service type itself —
~$1/mo minimum per job, so ~$5–6/mo total for 5 jobs). Instead, the same
scripts above are triggered via plain `GET` requests to admin-key-guarded
routes on the running web service (`src/modules/admin/admin.routes.js`,
`/cron/*`), called externally by cron jobs on existing Hostinger hosting
(same pattern already used to keep RexxPay Bank's `/health` warm).

| Route | Mirrors | Schedule |
|---|---|---|
| `GET /api/admin/cron/release-stale-accounts` | `scripts/release-stale-accounts.js` | every 10 min |
| `GET /api/admin/cron/reactivate-expired-accounts` | `scripts/reactivate-expired-accounts.js` | every 10 min |
| `GET /api/admin/cron/auto-provision-pool` | `scripts/auto-provision-pool.js` | every 15 min |
| `GET /api/admin/cron/run-settlement` | `scripts/run-settlement.js` | daily, `10 0 * * *` |
| `GET /api/admin/cron/generate-invoices` | `scripts/generate-invoices.js` | daily, `0 0 * * *` |

All guarded by the same `requireAdminKey` middleware as the rest of
`/api/admin`. Hostinger cron command format (needs `curl`, not a bare URL —
cron doesn't know what to do with a URL on its own):
```
curl "https://checkout-rexxpay.onrender.com/api/admin/cron/<route>?adminKey=YOUR_INFRA_ADMIN_KEY"
```

`scripts/reconcile.js` is deliberately **not** in this list — see "Known
gaps" below.

## Known gaps (found during Aug 2026 ops session, not yet fixed)

- **`deactivateVirtualAccount()` doesn't tell RexxPay Bank.** In
  `virtualAccount.service.js`, the function called right after a
  successful payment (`webhook.processor.js`) only flips `status` in
  SwiftPay's own Mongo doc — unlike its siblings (`releaseVirtualAccount`,
  `releaseStaleAssignedAccounts`, `reactivateExpiredAccounts`), it never
  calls `deactivateBankPoolAccount(accountNumber)`. Net effect: RexxPay
  Bank still considers the account open after a completed payment, so a
  second transfer to the same account number is silently accepted by the
  bank instead of failing the way "beneficiary not found" does on
  Paystack-style flows. **Fix**: add the same
  `if (isLive(account)) { await deactivateBankPoolAccount(account.accountNumber); }`
  block the other three functions already have.
- **That same call 404s in production even where it exists.**
  `[bankPartner] failed to deactivate account 1074337293 on RexxPay Bank:
  Request failed with status code 404` was observed live. Root cause not
  yet confirmed — needs checking RexxPay Bank's own
  `pool-accounts/:accountNumber/deactivate` route (does it 404 because
  RexxPay Bank already auto-deactivates on deposit and the account no
  longer matches whatever status the route filters on, or is it an
  account-number/routing mismatch).
- **Amounts aren't enforced by the bank.** `assignVirtualAccount()` stores
  `amountExpected` only in SwiftPay's own DB; RexxPay Bank's
  account-provisioning API has no `expectedAmount` field, so it can never
  reject a mismatched transfer at the banking layer the way some real BaaS
  partners (Providus, Wema, etc.) do. SwiftPay's `partial`/`over` status
  logic in `transaction.service.js` is therefore the *only* safeguard —
  correct as a fallback, but not a substitute for bank-level enforcement
  if that's ever wanted.
- **`reconcile.js` has no automated input.** It expects a settlement JSON
  file on disk; nothing currently fetches that from RexxPay Bank
  automatically. Needs RexxPay Bank to expose either an endpoint SwiftPay
  can pull from, or a scheduled export SwiftPay can fetch — until then
  this stays a manual, ad hoc script run.
- **Invoices have no push notification.** `markInvoicePaidByTransaction()`
  and `generateDueInvoices()`/`markOverdueInvoices()` update `Invoice`
  records silently — unlike `transaction.success`, there's no
  `dispatchMerchantWebhook()` call for `invoice.created`/`invoice.paid`/
  `invoice.overdue`. Merchants currently only see invoice state by
  checking the dashboard (`dashboard.js` → `GET
  /api/subscriptions/invoices`) or polling the API themselves.

## Testing the full flow locally

```bash
# 1. Register a merchant (save the secretKey from the response)
curl -X POST localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"businessName":"Test Store","email":"a@b.com","password":"pass1234"}'

# 2. Create a customer
curl -X POST localhost:5000/api/v1/customers \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"fullName":"Jane Doe","email":"jane@example.com"}'

# 3. Assign a virtual account to that customer
curl -X POST localhost:5000/api/v1/virtual-accounts \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"customerId":"<customer_id_from_step_2>"}'

# 4. To simulate a transfer without a real bank, use the hosted checkout
# flow below instead — creating a virtual account directly (step 3) has no
# standalone simulate shortcut anymore; only a real signed bank webhook
# (POST /api/v1/webhooks/bank) can complete it.

# 5. Check the wallet balance
curl localhost:5000/api/v1/wallet -H "Authorization: Bearer sk_test_xxx"
```

### Hosted checkout flow (alternative to steps 2–3 above)

```bash
# Creates the customer + assigns a virtual account in one call, returns a
# checkout link (pay.html) you can redirect the end customer to.
curl -X POST localhost:5000/api/v1/payments/initialize \
  -H "Authorization: Bearer sk_test_xxx" -H "Content-Type: application/json" \
  -d '{"amount":5000,"customer":{"email":"jane@example.com","name":"Jane Doe"},"redirect_url":"https://example.com/thanks"}'

# Poll for status by tx_ref once the customer has paid
curl localhost:5000/api/v1/payments/verify/<tx_ref> \
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
- GET  /pay/:checkoutToken  (serves the hosted `pay.html` page)
- GET  /api/v1/checkout/:token/status
- POST /api/v1/checkout/:token/simulate  (test-mode only — stands in for a real bank transfer; powers `pay.html`'s "simulate transfer" button)
- GET  /api/v1/checkout/:token/complete

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
- POST  /api/v1/admin/settlement/run  (`?currency=`, forces a settlement cycle now — the scheduled trigger is `npm run run-settlement`)
- GET   /api/v1/admin/settlement/batches  (`?currency=&phase=&limit=`, inspect recent settlement batches)
- GET   /api/v1/admin/cron/release-stale-accounts  (`?adminKey=`; mirrors `scripts/release-stale-accounts.js`, meant to be hit by an external scheduler — see "Production Setup")
- GET   /api/v1/admin/cron/reactivate-expired-accounts  (`?adminKey=`; mirrors `scripts/reactivate-expired-accounts.js`)
- GET   /api/v1/admin/cron/auto-provision-pool  (`?adminKey=&threshold=&topUpCount=`; mirrors `scripts/auto-provision-pool.js`)
- GET   /api/v1/admin/cron/run-settlement  (`?adminKey=&currencies=NGN,USD`; mirrors `scripts/run-settlement.js`)
- GET   /api/v1/admin/cron/generate-invoices  (`?adminKey=`; mirrors `scripts/generate-invoices.js`)

### Demo (public — no signup, no API key)
- POST /api/v1/demo/checkout  (runs a full test-mode checkout — virtual account → simulated bank transfer → success — against one dedicated demo merchant; rate-limited, capped at `DEMO_MAX_AMOUNT_MINOR`)

## Author

Built by Rexxwurld
