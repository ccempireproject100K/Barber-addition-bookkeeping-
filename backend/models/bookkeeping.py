"""Double-entry bookkeeping models: chart of accounts, journal entries and accountant reports.

All monetary amounts in journal entries are stored as INTEGER CENTS to avoid float drift.
Reports convert back to float (2dp) only at the API boundary.
"""

from typing import Literal

from pydantic import BaseModel, Field

AccountType = Literal["asset", "liability", "equity", "income", "expense"]
Normal = Literal["debit", "credit"]
DateStr = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class Account(BaseModel):
    code: str
    name: str
    type: AccountType
    normal: Normal
    is_system: bool = True
    active: bool = True


class JournalLineView(BaseModel):
    account: str
    account_name: str
    debit: float = 0
    credit: float = 0
    memo: str = ""


class JournalEntryView(BaseModel):
    id: str
    date: str
    memo: str
    source: str
    ref: str
    lines: list[JournalLineView]
    total: float
    reversal_of: str | None = None
    reversed_by: str | None = None
    created_by_name: str | None = None
    created_at: str


class ManualLineIn(BaseModel):
    account: str = Field(min_length=3, max_length=12)
    debit: float = Field(default=0, ge=0)
    credit: float = Field(default=0, ge=0)
    memo: str = Field(default="", max_length=200)


class ManualEntryIn(BaseModel):
    date: str = DateStr
    memo: str = Field(min_length=1, max_length=300)
    lines: list[ManualLineIn] = Field(min_length=2)


class ReverseEntryIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


# ---------- Reports ----------
class TrialBalanceRow(BaseModel):
    code: str
    name: str
    type: AccountType
    debit: float
    credit: float


class TrialBalance(BaseModel):
    as_of: str
    rows: list[TrialBalanceRow]
    total_debit: float
    total_credit: float
    balanced: bool


class BalanceSheetLine(BaseModel):
    code: str
    name: str
    balance: float


class BalanceSheet(BaseModel):
    as_of: str
    assets: list[BalanceSheetLine]
    liabilities: list[BalanceSheetLine]
    equity: list[BalanceSheetLine]
    total_assets: float
    total_liabilities: float
    total_equity: float
    net_income: float
    balanced: bool


class IncomeStatementLine(BaseModel):
    code: str
    name: str
    amount: float


class IncomeStatement(BaseModel):
    start: str
    end: str
    income: list[IncomeStatementLine]
    expenses: list[IncomeStatementLine]
    total_income: float
    total_expenses: float
    net_income: float


class GLRow(BaseModel):
    date: str
    entry_id: str
    ref: str
    memo: str
    debit: float
    credit: float
    balance: float


class GeneralLedger(BaseModel):
    account: str
    account_name: str
    start: str
    end: str
    opening_balance: float
    rows: list[GLRow]
    closing_balance: float


class AgingRow(BaseModel):
    invoice_id: str
    number: str
    client_name: str
    date: str
    due_date: str | None
    total: float
    balance_due: float
    days_overdue: int
    bucket: str


class ARAging(BaseModel):
    as_of: str
    rows: list[AgingRow]
    buckets: dict[str, float]
    total_outstanding: float
    ar_account_balance: float
    reconciled: bool


class InvValuationRow(BaseModel):
    product_id: str
    name: str
    quantity_on_hand: int
    unit_cost: float
    value: float


class InventoryValuation(BaseModel):
    as_of: str
    rows: list[InvValuationRow]
    total_value: float
    inventory_account_balance: float
    reconciled: bool


class SalesSummary(BaseModel):
    start: str
    end: str
    service_revenue: float
    product_revenue: float
    discounts: float
    net_sales: float
    tax_collected: float
    tips_collected: float
    processing_fees: float
    cogs: float
    gross_profit: float


# ---------- Expenses / vendors (routers/expenses.py) ----------
class VendorIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    contact_name: str = Field(default="", max_length=120)
    email: str = Field(default="", max_length=160)
    phone: str = Field(default="", max_length=60)
    notes: str = Field(default="", max_length=1000)


class Vendor(VendorIn):
    id: str
    created_at: str


EXPENSE_CATEGORIES = [
    "Rent", "Chair / booth rent", "Utilities", "Supplies", "Equipment",
    "Marketing", "Insurance", "Software & subscriptions", "Bank & card fees",
    "Professional services", "Travel", "Office", "Other",
]


class ExpenseIn(BaseModel):
    date: str = DateStr
    category: str = Field(min_length=1, max_length=80)
    amount: float = Field(gt=0)
    description: str = Field(default="", max_length=300)
    vendor_id: str | None = None
    payment_method: Literal["cash", "card", "bank", "other"] = "cash"
    receipt_url: str | None = Field(default=None, max_length=500_000)  # small data-URL / link
    receipt_name: str = Field(default="", max_length=200)
