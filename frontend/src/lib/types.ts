// Hand-written mirrors of backend/models/*.py — keep in sync with the Pydantic models.

// ---------- models/auth.py ----------
export type Role = "admin" | "staff" | "accountant" | "bookkeeper";
export interface Me {
  currency: string; timezone: string; locale: string;
  user_id: string;
  name: string;
  email: string;
  role: Role;
  tenant_id: string;
  tenant_name: string;
  permissions: string[];
  inventory_enabled: boolean;
  ai_enabled: boolean;
  access: "demo" | "paid" | "none";
  entitlements: Record<string, boolean>;
}
export interface PasswordResetRequestIn { email: string }
export interface PasswordResetConfirmIn { token: string; password: string }
export interface OkOut { ok: boolean; message: string }
export interface SignupIn { currency?: string; timezone?: string; locale?: string; company_name: string; name: string; email: string; password: string }
export interface LoginIn { email: string; password: string }
export interface GoogleSessionIn { session_id: string }
export interface TeamMember { id: string; name: string; email: string; role: Role; commission_rate: number; created_at: string }
export interface TeamMemberCreate { name: string; email: string; password: string; role: Role; commission_rate: number }
export interface TeamMemberUpdate { commission_rate: number; role: Role }

// ---------- models/inventory.py ----------
export type ProductType = "retail" | "supply";
export type TrackingMode = "none" | "lot" | "serial";
export type StockStatus = "in_stock" | "low" | "out";
export type MovementType = "restock" | "sale" | "use" | "adjustment" | "return";
export type AdjustReason = "damaged" | "expired" | "count_correction" | "theft_loss" | "other";
export type SerialStatus = "in_stock" | "sold" | "used" | "damaged" | "returned";
export type LotStatus = "ok" | "expiring" | "expired" | "empty";
export type POStatus = "draft" | "ordered" | "partial" | "received" | "cancelled";
export type Urgency = "critical" | "high" | "medium";

export interface ProductIn {
  name: string;
  type: ProductType;
  category: string;
  brand: string;
  sku: string | null;
  barcode: string | null;
  sell_price: number;
  unit: string;
  tracking_mode: TrackingMode;
  reorder_point: number;
  reorder_qty: number | null;
  supplier_id: string | null;
  image: string | null;
  description: string;
}
export interface ProductCreate extends ProductIn {
  opening_qty: number;
  opening_unit_cost: number;
  opening_lot_number: string | null;
  opening_expiry_date: string | null;
  opening_serials: string[];
}
export interface ProductUpdate extends ProductIn { active: boolean }
export interface Product extends ProductIn {
  id: string;
  unit_cost: number;
  quantity_on_hand: number;
  location_id: string;
  active: boolean;
  status: StockStatus;
  stock_value: number;
  supplier_name: string | null;
  expiring_lots: number;
  created_at: string;
  updated_at: string;
}
export interface Lot {
  id: string;
  product_id: string;
  location_id: string;
  lot_number: string;
  expiry_date: string | null;
  received_date: string;
  unit_cost: number;
  quantity_on_hand: number;
  status: LotStatus;
}
export interface SerialUnit {
  id: string;
  product_id: string;
  location_id: string;
  serial_number: string;
  status: SerialStatus;
  unit_cost: number;
  received_date: string;
  sold_date: string | null;
  warranty_until: string | null;
  linked_movement_ids: string[];
}
export interface ProductDetail { product: Product; lots: Lot[]; serials: SerialUnit[]; suggested_lot_id: string | null }
export interface BarcodeLookup { found: boolean; product: Product | null }

export interface Movement {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string | null;
  product_type: ProductType;
  location_id: string;
  type: MovementType;
  quantity: number;
  unit_cost: number | null;
  unit_price: number | null;
  cogs: number;
  lot_id: string | null;
  lot_number: string | null;
  serial_unit_ids: string[];
  serial_numbers: string[];
  reason: string;
  note: string;
  supplier_name: string;
  linked_transaction_id: string | null;
  linked_invoice_id: string | null;
  performed_by: string;
  performed_by_name: string;
  barber_id: string | null;
  barber_name: string | null;
  created_at: string;
}
export interface RestockIn {
  product_id: string; quantity: number; unit_cost: number; supplier_name: string; lot_id: string | null;
  lot_number: string | null; expiry_date: string | null; serial_numbers: string[]; warranty_until: string | null;
  record_expense: boolean; note: string;
}
export interface SellIn {
  product_id: string; quantity: number; unit_price: number; lot_id: string | null; serial_unit_ids: string[];
  barber_id: string | null; link: "new" | "invoice"; invoice_id: string | null; note: string;
}
export interface UseIn { product_id: string; quantity: number; lot_id: string | null; serial_unit_ids: string[]; barber_id: string | null; note: string }
export interface AdjustIn {
  product_id: string; quantity: number; reason: AdjustReason; note: string; lot_id: string | null;
  serial_unit_ids: string[]; serial_numbers: string[]; unit_cost: number | null;
}
export interface ReturnIn {
  product_id: string; quantity: number; lot_id: string | null; serial_unit_ids: string[]; refund_amount: number;
  barber_id: string | null; note: string;
}
export interface CheckoutLine { product_id: string; quantity: number; unit_price: number; serial_unit_ids: string[] }
export interface CheckoutIn { lines: CheckoutLine[]; barber_id: string | null; invoice_id: string | null; client_id: string | null; discount_code: string | null; payment_method: "cash" | "card" }
export interface CheckoutResult { movements: Movement[]; total: number; transaction_id: string | null; invoice_id: string | null }
export interface ImportRowError { row: number; error: string }
export interface ImportResult { imported: number; errors: ImportRowError[] }

export interface SupplierIn { name: string; contact_name: string; email: string; phone: string; lead_time_days: number; notes: string }
export interface Supplier extends SupplierIn { id: string; product_count: number; open_po_count: number; created_at: string }

export interface POLineIn { product_id: string; quantity: number; unit_cost: number }
export interface POCreate { supplier_id: string; lines: POLineIn[]; expected_date: string | null; notes: string }
export interface POLine { product_id: string; sku: string | null; name: string; quantity: number; unit_cost: number; received_qty: number }
export interface ReceiveLine { product_id: string; quantity: number; unit_cost: number | null }
export interface ReceiveIn { lines: ReceiveLine[]; close_backorder: boolean }
export interface SupplierPrice { supplier_name: string; last_cost: number; last_date: string; min_cost: number; purchases: number; is_current_supplier: boolean; source: "paid" | "list" }
export interface PriceListIn { csv: string }
export interface PriceListResult { matched: number; unmatched: ImportRowError[] }
export interface ProductPrices {
  product_id: string; name: string; current_supplier: string | null; current_cost: number | null; best_supplier: string | null;
  best_cost: number | null; saving_per_unit: number; prices: SupplierPrice[];
}
export interface POStatusUpdate { status: POStatus }
export interface PurchaseOrder {
  id: string; number: string; supplier_id: string; supplier_name: string; status: POStatus; lines: POLine[]; total: number;
  expected_date: string | null; notes: string; created_by: string; created_at: string; ordered_at: string | null; received_at: string | null; emailed_at: string | null;
  first_received_at: string | null; approved_by: string | null; approved_at: string | null; awaiting_approval: boolean;
}

export interface ReorderSuggestion {
  product_id: string; sku: string | null; name: string; type: ProductType; quantity_on_hand: number; reorder_point: number;
  incoming: number; daily_velocity: number; days_of_cover: number | null; lead_time_days: number; suggested_qty: number;
  urgency: Urgency; supplier_id: string | null; supplier_name: string | null; unit_cost: number; estimated_cost: number;
}
export interface ReorderCreateIn { product_ids: string[] }

export interface StockRow { product_id: string; name: string; type: ProductType; quantity_on_hand: number; unit_cost: number; value: number; reorder_point: number; status: StockStatus }
export interface ExpiringLot { lot_id: string; product_id: string; product_name: string; lot_number: string; expiry_date: string; quantity_on_hand: number; days_left: number }
export interface ProductPerf { product_id: string; name: string; units: number; revenue: number; cogs: number; profit: number; margin: number }
export interface BarberPerf { barber_id: string | null; name: string; units: number; revenue: number; cogs: number; profit: number; commission_rate: number; commission: number }
export interface UsageRow { product_id: string; name: string; units: number; cost: number }
export interface InventoryReport {
  start: string; end: string; stock: StockRow[]; total_value: number; retail_value: number; low_stock: StockRow[];
  expiring_lots: ExpiringLot[]; best_sellers: ProductPerf[]; profit_by_product: ProductPerf[]; profit_by_barber: BarberPerf[];
  supply_usage: UsageRow[]; totals: Record<string, number>;
}
export interface Alerts { low_stock_count: number; out_of_stock_count: number; expiring_count: number; expired_count: number; pending_approvals: number; badge: number }
export interface OutboxEmail { id: string; to: string; subject: string; body: string; status: "sent" | "logged" | "failed"; error: string; created_at: string }

export interface CountLine { product_id: string; counted: number }
export interface CountIn { lines: CountLine[]; note: string }
export interface CountSkip { product_id: string; name: string; reason: string }
export interface CountResult { adjusted: Movement[]; unchanged: number; skipped: CountSkip[] }
export interface AssignBarcodesIn { product_ids: string[] }
export interface POEmailIn { mark_ordered: boolean; message: string }

// ---------- models/money.py ----------
export type TxnKind = "income" | "expense";
export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
export type PayMethod = "cash" | "card" | "bank" | "other";
export interface TransactionIn { kind: TxnKind; category: string; amount: number; date: string; description: string; barber_id: string | null; payment_method: PayMethod }
export interface Transaction {
  id: string; kind: TxnKind; category: string; amount: number; date: string; description: string; barber_id: string | null;
  barber_name: string | null; source: "manual" | "inventory" | "invoice"; linked_movement_ids: string[]; linked_invoice_id: string | null;
  payment_method: string; processor: "recorded" | "stripe"; capitalized: boolean; reversal_of: string | null; reversed_by: string | null; created_at: string;
}
export interface InvoiceLineIn { description: string; quantity: number; unit_price: number; kind?: "service" | "product"; product_id?: string | null }
export interface InvoiceLine extends InvoiceLineIn { kind: "service" | "product"; product_id: string | null; movement_id: string | null; unit_cost: number }
export interface InvoiceIn { client_name: string; date: string; due_date: string | null; lines: InvoiceLineIn[]; barber_id: string | null; notes: string; discount_amount?: number; tax_rate?: number; tip_amount?: number }
export interface Payment { id: string; date: string; amount: number; method: PayMethod; processor: "recorded" | "stripe"; fee: number; note: string; kind: "payment" | "refund"; created_at: string }
export interface PaymentIn { amount: number; method: PayMethod; processor?: "recorded" | "stripe"; fee?: number; date?: string; note?: string }
export interface RefundIn { amount: number; method: PayMethod; reason: string }
export interface Invoice {
  id: string; number: string; client_name: string; date: string; due_date: string | null; status: InvoiceStatus; lines: InvoiceLine[];
  subtotal: number; discount_amount: number; tax_rate: number; tax_amount: number; tip_amount: number; total: number;
  amount_paid: number; balance_due: number; refunded?: number; payments: Payment[];
  barber_id: string | null; barber_name: string | null; notes: string; issued_at: string | null; paid_at: string | null; created_at: string;
}
export interface InvoiceStatusIn { status: InvoiceStatus }
export interface CategoryAmount { category: string; amount: number }
export interface RetailPnl { retail_sales: number; retail_cogs: number; retail_gross_profit: number; supply_usage_cost: number }
export interface Pnl {
  start: string; end: string; income: CategoryAmount[]; expenses: CategoryAmount[]; total_income: number; total_expenses: number;
  net_profit: number; retail: RetailPnl | null;
  basis: "cash" | "accrual"; cogs_deducted: number; inventory_purchases_excluded: number; notes: string[];
}
export interface DayMoney { date: string; income: number; expenses: number }
export interface InventoryWidget { low_stock_count: number; expiring_count: number; retail_sales_month: number; retail_profit_month: number; stock_value: number }
export interface Dashboard {
  month_start: string; income_month: number; expenses_month: number; net_month: number; outstanding_invoices: number;
  trend: DayMoney[]; recent_transactions: Transaction[]; inventory: InventoryWidget | null;
}
export interface WorkspaceSettings {
  currency: string; timezone: string; locale: string;
  name: string; inventory_enabled: boolean; low_stock_email: boolean; expiry_warning_days: number;
  expense_category_retail: string; expense_category_supply: string; allow_negative_stock: boolean; ai_enabled: boolean; po_approval_limit: number; weekly_ai_email: boolean;
}

// ---------- models/ai.py ----------
export interface AiMessage { id: string; role: "user" | "assistant"; content: string; created_at: string }
export interface AiChatIn { message: string }
export interface AiInsights { date: string; text: string; model: string; created_at: string }
export interface ReorderPlanLine { product_id: string; name: string; supplier_id: string; supplier_name: string; quantity: number; unit_cost: number; reason: string }
export interface ReorderPlan { summary: string; lines: ReorderPlanLine[]; model: string }
export interface SwitchSupplierIn { supplier_name: string }
export interface POApprovalIn { approve: boolean; note: string }
export interface SupplierScorecard {
  supplier_id: string; name: string; orders_received: number; on_time_rate: number | null; avg_lead_days: number | null; promised_lead_days: number;
  short_shipment_rate: number | null; fill_rate: number | null; price_change_pct: number | null; price_increases: number; total_spend: number;
  open_orders: number; grade: string;
}

// ---------- routers/clients.py, payments.py, game.py ----------
export interface ClientIn { name: string; phone: string; email: string; notes: string }
export interface Client extends ClientIn { id: string; total_spent: number; visits: number; last_visit: string | null; created_at: string }
export interface ClientPurchase { movement_id: string; product_id: string; product_name: string; quantity: number; unit_price: number; date: string; barber_name: string | null }
export interface Suggestion { product_id: string; name: string; sell_price: number; in_stock: boolean; kind: "rebuy" | "pairs" | "popular"; reason: string }
export interface ClientProfile { client: Client; purchases: ClientPurchase[]; favorites: string[]; suggestions: Suggestion[] }
export interface DiscountCheck { code: string; pct: number; valid: boolean; reason: string }
export interface CardCheckoutIn extends CheckoutIn { origin_url: string }
export interface CardCheckoutOut { checkout_url: string; session_id: string }
export interface PaymentStatus { currency: string; session_id: string; status: string; payment_status: string; fulfilled: boolean; error: string; total: number }
export interface ScoreIn { name: string; score: number; duration_ms: number }
export interface ScoreRow { name: string; score: number }
export interface GameInfo { shop: string; week: string; target: number; reward_pct: number; top_reward_pct: number; leaderboard: ScoreRow[] }
export interface ScoreOut { rank: number; best: boolean; code: string | null; pct: number; message: string }

// ---------- models/ledger.py ----------
export interface BillingStatus {
  access: "demo" | "paid" | "none"; status: string; entitlements: Record<string, boolean>; current_period_end: string | null;
  cancel_at_period_end: boolean; price: number; test_mode: boolean; last_event_type: string | null;
}
export interface BillingCheckoutIn { origin_url: string }
export interface BillingCheckoutOut { checkout_url: string; session_id: string }
export interface BillingSyncIn { session_id: string }
export interface DrawerMove { kind: "paid_in" | "paid_out"; amount: number; reason: string }
export interface CashCloseIn { date: string; opening_float: number; counted_cash: number; drawer_moves: DrawerMove[]; explanation: string }
export interface CashClose {
  id: string; date: string; opening_float: number; cash_sales: number; cash_refunds: number; cash_expenses: number; paid_in: number; paid_out: number;
  drawer_moves: DrawerMove[]; expected_cash: number; counted_cash: number; discrepancy: number; explanation: string;
  status: "submitted" | "approved" | "flagged"; submitted_by_name: string; submitted_at: string; reviewed_by_name: string | null;
  reviewed_at: string | null; review_note: string; revision: number;
}
export interface CashClosePreview {
  date: string; suggested_opening_float: number; cash_sales: number; cash_refunds: number; cash_expenses: number; cash_txn_count: number; existing: CashClose | null;
}
export interface CashReviewIn { approve: boolean; note: string }
export interface AuditEntry { id: string; actor_name: string; actor_role: string | null; action: string; entity: string; entity_id: string | null; details: Record<string, unknown>; created_at: string }
export interface ReverseIn { reason: string }
export interface RecoverResult { rolled_forward: number; rolled_back: number; failed: number }
export interface Health { status: "ok" | "degraded"; db: boolean; pending_ops: number; env: string }

// ---------- models/bookkeeping.py (routers/bookkeeping.py, expenses.py) ----------
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export interface Account { code: string; name: string; type: AccountType; normal: "debit" | "credit"; is_system: boolean; active: boolean }
export interface JournalLineView { account: string; account_name: string; debit: number; credit: number; memo: string }
export interface JournalEntryView { id: string; date: string; memo: string; source: string; ref: string; lines: JournalLineView[]; total: number; reversal_of: string | null; reversed_by: string | null; created_by_name: string | null; created_at: string }
export interface ManualLineIn { account: string; debit: number; credit: number; memo: string }
export interface ManualEntryIn { date: string; memo: string; lines: ManualLineIn[] }
export interface TrialBalanceRow { code: string; name: string; type: AccountType; debit: number; credit: number }
export interface TrialBalance { as_of: string; rows: TrialBalanceRow[]; total_debit: number; total_credit: number; balanced: boolean }
export interface BalanceSheetLine { code: string; name: string; balance: number }
export interface BalanceSheet { as_of: string; assets: BalanceSheetLine[]; liabilities: BalanceSheetLine[]; equity: BalanceSheetLine[]; total_assets: number; total_liabilities: number; total_equity: number; net_income: number; balanced: boolean }
export interface IncomeStatementLine { code: string; name: string; amount: number }
export interface IncomeStatement { start: string; end: string; income: IncomeStatementLine[]; expenses: IncomeStatementLine[]; total_income: number; total_expenses: number; net_income: number }
export interface GLRow { date: string; entry_id: string; ref: string; memo: string; debit: number; credit: number; balance: number }
export interface GeneralLedger { account: string; account_name: string; start: string; end: string; opening_balance: number; rows: GLRow[]; closing_balance: number }
export interface AgingRow { invoice_id: string; number: string; client_name: string; date: string; due_date: string | null; total: number; balance_due: number; days_overdue: number; bucket: string }
export interface ARAging { as_of: string; rows: AgingRow[]; buckets: Record<string, number>; total_outstanding: number; ar_account_balance: number; reconciled: boolean }
export interface InvValuationRow { product_id: string; name: string; quantity_on_hand: number; unit_cost: number; value: number }
export interface InventoryValuation { as_of: string; rows: InvValuationRow[]; total_value: number; inventory_account_balance: number; reconciled: boolean }
export interface SalesSummary { start: string; end: string; service_revenue: number; product_revenue: number; discounts: number; net_sales: number; tax_collected: number; tips_collected: number; processing_fees: number; cogs: number; gross_profit: number }
export interface Vendor { id: string; name: string; contact_name: string; email: string; phone: string; notes: string; created_at: string }
export interface VendorIn { name: string; contact_name: string; email: string; phone: string; notes: string }
export interface ExpenseIn { date: string; category: string; amount: number; description: string; vendor_id: string | null; payment_method: PayMethod; receipt_url: string | null; receipt_name: string }
export interface ExpenseRow { id: string; date: string; category: string; amount: number; description: string; payment_method: string; vendor_id: string | null; vendor_name: string | null; receipt_url: string | null; receipt_name: string; reversed_by?: string | null; reversal_of?: string | null }

// ---------- books_ops / bills / recurring ----------
export interface BooksOverview { currency: string; cash_on_hand: number; accounts_receivable: number; inventory_value: number; accounts_payable: number; tax_owed: number; tips_owed: number; income_mtd: number; expenses_mtd: number; net_profit_mtd: number; top_expenses: { name: string; amount: number }[]; closed_through: string | null; health: { trial_balanced: boolean; inventory_reconciled: boolean; ar_reconciled: boolean } }
export interface Bill { id: string; vendor_id: string | null; vendor_name: string | null; date: string; due_date: string | null; category: string; amount: number; amount_paid: number; balance: number; is_inventory: boolean; description: string; status: string; payments: { id: string; date: string; amount: number; method: string }[]; created_at: string }
export interface Recurring { id: string; name: string; category: string; amount: number; payment_method: PayMethod; vendor_id: string | null; day_of_month: number; active: boolean; last_run: string | null; created_at: string }
export interface BankTxn { id: string; account: string; date: string; description: string; amount: number; status: string; matched_entry: string | null; created_at: string }
export interface ReceiptScan { vendor: string; date: string; amount: number; tax: number; category: string; description: string }
