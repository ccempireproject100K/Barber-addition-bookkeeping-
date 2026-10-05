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

## Iteration 2 — owner-experience enhancements (2026-10-05)
All 10 proposed enhancements implemented and backend-verified (ledger stays balanced throughout):
- **Owner Overview dashboard** (`/books` first tab): cash on hand, net profit MTD, A/R, A/P, sales-tax owed, tips owed, top expenses, and a **books-health strip** (trial balance / inventory / A/R reconcile chips) with drill-downs. `GET /api/books/overview`.
- **Sales-tax center**: `GET /books/tax-summary`, `POST /books/tax/remit` (DR Sales Tax Payable, CR cash) — clears the liability.
- **Tips payout**: `GET /books/tips-summary`, `POST /books/tips/payout` (DR Tips Payable, CR cash).
- **Owner equity**: `POST /books/equity` (contribution: DR cash CR Owner's Equity; draw: reverse).
- **Month-end close/lock**: `POST /books/close` + `/reopen`; `lib/bookkeeping.assert_open` blocks dated postings in closed periods (tax/tips/equity/bills).
- **Bank CSV import + match + reconcile**: `POST /books/bank/import` (auto-match to same-date/amount journal lines, dedupe), `GET /books/bank`, `POST /books/bank/{id}/resolve` (ignore / book income / book expense).
- **Vendor bills / Accounts Payable** (`routers/bills.py`): `POST /bills` (DR expense or Inventory, CR A/P), `POST /bills/{id}/pay` (DR A/P CR cash), `GET /bills`, `/bills/ap-summary`.
- **Snap-a-receipt → AI expense prefill**: `POST /expenses/scan-receipt` (emergentintegrations vision, gpt-5-mini) — graceful 503 without EMERGENT_LLM_KEY. Frontend "Scan a receipt" input in the New Expense dialog.
- **Recurring expenses** (`routers/recurring.py`): monthly templates auto-posted by platform cron `POST /api/cron/recurring` (`.emergent/crons.yml`, daily 06:00 UTC) + "Post now" manual run.
- **Quick-add + Simple mode**: header **Quick add** (plain "Money in / Money out") posts income/expense that book straight to the journal — owner-friendly input that hides debits/credits.

Frontend: Books page gained Overview + Bank-import tabs and owner-action controls; Expenses page gained Receipt scan, Vendor bills (A/P) and Recurring sections; `components/QuickAdd.tsx` mounted in the header. TypeScript compiles clean, oxlint 0 errors, bookkeeping suite 15/15.

### Caveat
A vendor bill marked **is_inventory** debits the Inventory account; it should correspond to a stock receipt, otherwise the Inventory account will exceed product valuation (expected). Receipt-scan requires an AI key (add in settings) to function.
