# Barber's Ledger — PRD & Progress

## Original problem statement
Continue the existing **Barber's Ledger** app (handoff ZIP). Prioritize bookkeeping and inventory
integration while preserving existing screens, branding, working features, and customer data.
Budget target ~150 credits (reserve ~30 for testing). Do not enable live payments, add paid feeds,
payroll, tax filing, paid OCR, or new subscriptions.

## Stack / architecture
- Frontend: Vite + React 19 + TypeScript (served on :3000 via `yarn start` → vite). Relative `/api` calls route through k8s ingress to backend.
- Backend: FastAPI (:8001, `/api` prefix) + MongoDB (`test_database`). Auth = httpOnly JWT cookie.
- Tenant isolation: `lib/repo.Scoped` injects `tenant_id` on every query; RBAC via `lib/auth.require(perm)`.

## What was already in the handoff (reused, not rebuilt)
Products/stock/lots/serials, movements ledger, suppliers, purchase orders, Quick sell, Stripe
QuickSell checkout (claimable sandbox, exactly-once fulfil + `stripe_events` dedup), cash-basis
Money & P&L (`transactions`), invoices (basic), cash close, audit log, roles/entitlements,
idempotency + op recovery, Decimal money helpers.

## What was built this iteration (double-entry bookkeeping layer) — 2026-10-05
- **Chart of accounts + balanced journal** (`lib/bookkeeping.py`, `models/bookkeeping.py`,
  `routers/bookkeeping.py`): integer-cents, `post_entry()` enforces debits==credits and is
  exactly-once via a unique `(tenant_id, ref)` index; `reverse_entry()` (immutable corrections).
- **Event wiring (choke points):** `create_txn` → `mirror_txn` (manual + inventory cash events);
  `post_movement` → `mirror_cogs` (COGS/supplies on outflows) + `mirror_inventory_inflow`
  (DR Inventory / CR Opening Balance Equity for opening stock, unpaid restocks, positive adjustments).
- **Enhanced invoices** (`routers/money.py`): service + product lines, invoice-level discount, tax
  rate, tip; **partial payments** with outstanding balance; processing fees booked separately from
  gross revenue. Issue → accrual AR recognition + product fulfilment (stock out + COGS). Payment →
  DR Cash/Bank + DR Fees, CR AR. Refund → contra-revenue (Refunds & Returns) + cash out. Void →
  reverses issue + returns stock. Services never touch inventory.
- **Expenses + vendors** (`routers/expenses.py`): operating expenses with category, payment method,
  vendor, receipt attachment; separate from capitalized inventory purchases.
- **Reports** (all reconcile, date filters, CSV export): Trial balance, Balance sheet, Income
  statement (accrual), General ledger, A/R aging, Inventory valuation, Sales/tips/tax summary, Journal.
- **Frontend:** new `pages/Books.tsx` (9 report tabs + CSV + reconcile badges), `pages/Expenses.tsx`
  (vendors + expenses + receipts), rewritten `pages/Invoices.tsx` (lines, tax/tip/discount, record
  payment, refund, balance due). Nav + routes added; branding/existing screens untouched.

## Verification (2026-10-05)
- Custom suite `backend/tests/test_bookkeeping_flow.py`: **15/15 pass**.
- End-to-end reconciliation verified: trial balance debits==credits; balance sheet assets==L+E;
  A/R aging == AR account; inventory valuation == Inventory account across opening/paid/unpaid
  restock/positive-adjustment/sale paths; refund reduces net income with no phantom AR; void clears
  AR; cross-tenant access → 404; unbalanced manual entry rejected.
- Pre-existing suites: inventory-acceptance all pass except 1 Stripe-placeholder card test;
  `test_phase1`/`test_international_wiring` fail only because their fixtures log in with seed account
  `demo@example.invalid` (no seed in handoff; `.invalid` TLD now rejected by email-validator) — not
  caused by this work.

## Known limitations / owner actions
- **Stripe**: `STRIPE_SECRET_KEY=sk_test_emergent` is a PLACEHOLDER. Real sandbox charges cannot be
  made; the webhook/fulfil boundary is implemented (exactly-once + dedup) but exercised only in
  SIMULATED mode. Live payments stay disabled (`BILLING_ALLOW_LIVE=false`). Owner must add real
  Stripe test keys to run a true sandbox payment.
- Unpaid restocks/opening stock credit **Opening Balance Equity (3900)** rather than Accounts
  Payable (no vendor-bill/GRNI workflow yet).
- Books income statement is accrual for invoices + cash for direct sales; legacy Money & P&L remains
  the cash-basis view. Both reconcile and are documented in-report.

## Backlog (deferred, budget-bound)
P1: estimates→invoice, recurring invoice drafts, payment reminders (owner-approved), CSV bank import
+ reconciliation, accrual Accounts Payable for purchases, accountant period-close/export.
P2: low-stock reorder automation already exists; chair/booth-rent reporting breakdown; backup/restore wiring.
