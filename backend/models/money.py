from typing import Literal
from lib.international import InternationalSettings

from pydantic import BaseModel, Field

TxnKind = Literal["income", "expense"]
PayMethod = Literal["cash", "card", "bank", "other"]
InvoiceStatus = Literal["draft", "sent", "paid", "void"]


class TransactionIn(BaseModel):
    kind: TxnKind
    category: str = Field(min_length=1, max_length=80)
    amount: float = Field(gt=0)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    description: str = Field(default="", max_length=300)
    barber_id: str | None = None
    payment_method: PayMethod = "other"


class Transaction(BaseModel):
    currency: str = "USD"
    id: str
    kind: TxnKind
    category: str
    amount: float
    date: str
    description: str
    barber_id: str | None = None
    barber_name: str | None = None
    source: Literal["manual", "inventory", "invoice"] = "manual"
    linked_movement_ids: list[str] = []
    linked_invoice_id: str | None = None
    payment_method: str = "other"
    processor: Literal["recorded", "stripe"] = "recorded"  # recorded = entered by staff; stripe = confirmed by processor
    capitalized: bool = False  # inventory purchase (asset); accrual P&L uses COGS instead
    reversal_of: str | None = None
    reversed_by: str | None = None
    created_at: str


class InvoiceLineIn(BaseModel):
    description: str = Field(min_length=1, max_length=200)
    quantity: float = Field(gt=0)
    unit_price: float = Field(ge=0)
    kind: Literal["service", "product"] = "service"
    product_id: str | None = None


class InvoiceLine(InvoiceLineIn):
    movement_id: str | None = None
    unit_cost: float = 0


class InvoiceIn(BaseModel):
    client_name: str = Field(min_length=1, max_length=160)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    due_date: str | None = None
    lines: list[InvoiceLineIn] = []
    barber_id: str | None = None
    notes: str = Field(default="", max_length=1000)
    discount_amount: float = Field(default=0, ge=0)
    tax_rate: float = Field(default=0, ge=0, le=100)
    tip_amount: float = Field(default=0, ge=0)


EstimateStatus = Literal["draft", "sent", "accepted", "declined", "converted"]


class Estimate(BaseModel):
    currency: str = "USD"
    id: str
    number: str
    client_name: str
    date: str
    valid_until: str | None = None
    status: EstimateStatus
    lines: list[InvoiceLine]
    subtotal: float = 0
    discount_amount: float = 0
    tax_rate: float = 0
    tax_amount: float = 0
    tip_amount: float = 0
    total: float = 0
    barber_id: str | None = None
    barber_name: str | None = None
    notes: str = ""
    converted_invoice_id: str | None = None
    converted_invoice_number: str | None = None
    created_at: str


class EstimateStatusIn(BaseModel):
    status: EstimateStatus


class Payment(BaseModel):
    id: str
    date: str
    amount: float
    method: PayMethod = "cash"
    processor: Literal["recorded", "stripe"] = "recorded"
    fee: float = 0
    note: str = ""
    kind: Literal["payment", "refund"] = "payment"
    created_at: str


class PaymentIn(BaseModel):
    amount: float = Field(gt=0)
    method: PayMethod = "cash"
    processor: Literal["recorded", "stripe"] = "recorded"
    fee: float = Field(default=0, ge=0)
    date: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    note: str = Field(default="", max_length=300)


class RefundIn(BaseModel):
    amount: float = Field(gt=0)
    method: PayMethod = "cash"
    reason: str = Field(default="", max_length=300)


class Invoice(BaseModel):
    currency: str = "USD"
    id: str
    number: str
    client_name: str
    date: str
    due_date: str | None
    status: InvoiceStatus
    lines: list[InvoiceLine]
    subtotal: float = 0
    discount_amount: float = 0
    tax_rate: float = 0
    tax_amount: float = 0
    tip_amount: float = 0
    total: float
    amount_paid: float = 0
    balance_due: float = 0
    refunded: float = 0
    payments: list[Payment] = []
    barber_id: str | None = None
    barber_name: str | None = None
    notes: str = ""
    issued_at: str | None = None
    paid_at: str | None = None
    created_at: str


class InvoiceStatusIn(BaseModel):
    status: InvoiceStatus


class CategoryAmount(BaseModel):
    category: str
    amount: float


class RetailPnl(BaseModel):
    retail_sales: float
    retail_cogs: float
    retail_gross_profit: float
    supply_usage_cost: float


class Pnl(BaseModel):
    start: str
    end: str
    income: list[CategoryAmount]
    expenses: list[CategoryAmount]
    total_income: float
    total_expenses: float
    net_profit: float
    retail: RetailPnl | None
    basis: Literal["cash", "accrual"] = "cash"
    cogs_deducted: float = 0
    inventory_purchases_excluded: float = 0
    notes: list[str] = []


class DayMoney(BaseModel):
    date: str
    income: float
    expenses: float


class InventoryWidget(BaseModel):
    low_stock_count: int
    expiring_count: int
    retail_sales_month: float
    retail_profit_month: float
    stock_value: float


class Dashboard(BaseModel):
    month_start: str
    income_month: float
    expenses_month: float
    net_month: float
    outstanding_invoices: float
    trend: list[DayMoney]
    recent_transactions: list[Transaction]
    inventory: InventoryWidget | None


class WorkspaceSettings(InternationalSettings):  # inventory_enabled / ai_enabled are effective values (masked by paid entitlement)
    name: str = Field(min_length=1, max_length=120)
    inventory_enabled: bool
    low_stock_email: bool
    expiry_warning_days: int = Field(ge=1, le=365)
    expense_category_retail: str = Field(min_length=1, max_length=80)
    expense_category_supply: str = Field(min_length=1, max_length=80)
    allow_negative_stock: bool
    ai_enabled: bool = False
    po_approval_limit: float = Field(default=0, ge=0)  # 0 = off
    weekly_ai_email: bool = True
