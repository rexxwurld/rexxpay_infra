# RexxPay

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
Merchant  --(secret key)-->  RexxPay API  --(pool assignment)-->  Bank Partner (mocked)
                                   ^                                     |
                                   |                                     v
                          verified webhook  <----------------  customer transfers money
                                   |
                                   v
                        Transaction recorded + Wallet credited
```

### Modules

| Module | Responsibility |
|---|---|
| `auth` | Merchant registration/login, JWT dashboard sessions, API key issuance |
| `merchant` | Merchant profile, API keys |
| `customer` | Merchant's end-customers |
| `bankPartner` | Simulated partner bank; provisions pooled account numbers |
| `virtualAccount` | Assigns pooled accounts to customers (never mints new ones) |
| `wallet` | Merchant settlement balance, atomic credit/debit |
| `transaction` | Ledger of every payment event, idempotent recording |
| `webhook` | Verifies bank partner signatures; the ONLY path that can mark a payment successful |

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

## Getting Started

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `MONGO_URI`, `JWT_SECRET`,
   `BANK_WEBHOOK_SECRET`
3. `npm run dev`

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

## API Endpoints

### Auth
- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/logout

### Customers
- POST /api/customers
- GET  /api/customers

### Virtual Accounts
- POST /api/virtual-accounts
- GET  /api/virtual-accounts/:accountNumber
- POST /api/virtual-accounts/:accountNumber/deactivate

### Wallet
- GET /api/wallet

### Transactions
- GET /api/transactions

### Webhooks
- POST /api/webhooks/bank  (bank-partner-only, HMAC signature required)

### Dev-only
- POST /api/mock-bank/simulate-transfer  (simulates a customer paying — disabled when NODE_ENV=production)

## Author

Built by Rexxwurld
