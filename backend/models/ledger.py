from typing import Literal

from pydantic import BaseModel, Field

DateStr = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


# ---------- Billing (routers/billing.py) ----------
class BillingStatus(BaseModel):
    access: Literal["demo", "paid", "none"]
    status: str  # none | active | trialing | past_due | canceled | unpaid | incomplete ...
    entitlements: dict[str, bool]
    current_period_end: str | None = None
    cancel_at_period_end: bool = False
    price: float
    test_mode: bool
    last_event_type: str | None = None


class BillingCheckoutIn(BaseModel):
    origin_url: str = Field(min_length=8, max_length=300)


class BillingCheckoutOut(BaseModel):
    checkout_url: str
    session_id: str


class BillingSyncIn(BaseModel):
    session_id: str = Field(min_length=5, max_length=300)


# ---------- Cash close (routers/cash.py) ----------
class DrawerMove(BaseModel):
    kind: Literal["paid_in", "paid_out"]
    amount: float = Field(gt=0, le=100000)
    reason: str = Field(min_length=1, max_length=200)


class CashCloseIn(BaseModel):
    date: str = DateStr
    opening_float: float = Field(ge=0, le=100000)
    counted_cash: float = Field(ge=0, le=1000000)
    drawer_moves: list[DrawerMove] = []
    explanation: str = Field(default="", max_length=1000)


class CashClosePreview(BaseModel):
    date: str
    suggested_opening_float: float
    cash_sales: float
    cash_refunds: float
    cash_expenses: float
    cash_txn_count: int
    existing: "CashClose | None" = None


class CashClose(BaseModel):
    id: str
    date: str
    opening_float: float
    cash_sales: float
    cash_refunds: float
    cash_expenses: float
    paid_in: float
    paid_out: float
    drawer_moves: list[DrawerMove]
    expected_cash: float
    counted_cash: float
    discrepancy: float
    explanation: str
    status: Literal["submitted", "approved", "flagged"]
    submitted_by_name: str
    submitted_at: str
    reviewed_by_name: str | None = None
    reviewed_at: str | None = None
    review_note: str = ""
    revision: int = 1


class CashReviewIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=500)


# ---------- Audit / corrections / ops (routers/ledger.py) ----------
class AuditEntry(BaseModel):
    id: str
    actor_name: str
    actor_role: str | None = None
    action: str
    entity: str
    entity_id: str | None = None
    details: dict = {}
    created_at: str


class ReverseIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class RecoverResult(BaseModel):
    rolled_forward: int
    rolled_back: int
    failed: int


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    db: bool
    pending_ops: int
    env: str


CashClosePreview.model_rebuild()
