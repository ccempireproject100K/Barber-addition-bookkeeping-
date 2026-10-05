from typing import Literal

from pydantic import BaseModel, Field

ProductType = Literal["retail", "supply"]
TrackingMode = Literal["none", "lot", "serial"]
StockStatus = Literal["in_stock", "low", "out"]
MovementType = Literal["restock", "sale", "use", "adjustment", "return"]
AdjustReason = Literal["damaged", "expired", "count_correction", "theft_loss", "other"]
SerialStatus = Literal["in_stock", "sold", "used", "damaged", "returned"]
LotStatus = Literal["ok", "expiring", "expired", "empty"]
POStatus = Literal["draft", "ordered", "partial", "received", "cancelled"]
Urgency = Literal["critical", "high", "medium"]


# ---------- Products ----------
class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: ProductType = "retail"
    category: str = Field(default="", max_length=80)
    brand: str = Field(default="", max_length=80)
    sku: str | None = Field(default=None, max_length=64)
    barcode: str | None = Field(default=None, max_length=128)
    sell_price: float = Field(default=0, ge=0)
    unit: str = Field(default="each", max_length=20)
    tracking_mode: TrackingMode = "none"
    reorder_point: int = Field(default=5, ge=0)
    reorder_qty: int | None = Field(default=None, ge=0)
    supplier_id: str | None = None
    image: str | None = Field(default=None, max_length=400_000)  # small data-URL thumbnail
    description: str = Field(default="", max_length=2000)


class ProductCreate(ProductIn):
    opening_qty: int = Field(default=0, ge=0)
    opening_unit_cost: float = Field(default=0, ge=0)
    opening_lot_number: str | None = None
    opening_expiry_date: str | None = None
    opening_serials: list[str] = []


class ProductUpdate(ProductIn):
    active: bool = True


class Product(ProductIn):
    id: str
    unit_cost: float
    quantity_on_hand: int
    location_id: str
    active: bool
    status: StockStatus
    stock_value: float
    supplier_name: str | None = None
    expiring_lots: int = 0
    created_at: str
    updated_at: str


class Lot(BaseModel):
    id: str
    product_id: str
    location_id: str
    lot_number: str
    expiry_date: str | None
    received_date: str
    unit_cost: float
    quantity_on_hand: int
    status: LotStatus


class SerialUnit(BaseModel):
    id: str
    product_id: str
    location_id: str
    serial_number: str
    status: SerialStatus
    unit_cost: float
    received_date: str
    sold_date: str | None = None
    warranty_until: str | None = None
    linked_movement_ids: list[str] = []


class ProductDetail(BaseModel):
    product: Product
    lots: list[Lot]
    serials: list[SerialUnit]
    suggested_lot_id: str | None


class BarcodeLookup(BaseModel):
    found: bool
    product: Product | None = None


# ---------- Movements ----------
class Movement(BaseModel):
    id: str
    product_id: str
    product_name: str
    product_sku: str | None
    product_type: ProductType
    location_id: str
    type: MovementType
    quantity: int
    unit_cost: float | None = None
    unit_price: float | None = None
    cogs: float = 0
    lot_id: str | None = None
    lot_number: str | None = None
    serial_unit_ids: list[str] = []
    serial_numbers: list[str] = []
    reason: str = ""
    note: str = ""
    supplier_name: str = ""
    linked_transaction_id: str | None = None
    linked_invoice_id: str | None = None
    performed_by: str
    performed_by_name: str
    barber_id: str | None = None
    barber_name: str | None = None
    created_at: str


class RestockIn(BaseModel):
    product_id: str
    quantity: int = Field(ge=1)
    unit_cost: float = Field(ge=0)
    supplier_name: str = Field(default="", max_length=160)
    lot_id: str | None = None
    lot_number: str | None = None
    expiry_date: str | None = None
    serial_numbers: list[str] = []
    warranty_until: str | None = None
    record_expense: bool = True
    note: str = Field(default="", max_length=500)


class SellIn(BaseModel):
    product_id: str
    quantity: int = Field(ge=1)
    unit_price: float = Field(ge=0)
    lot_id: str | None = None
    serial_unit_ids: list[str] = []
    barber_id: str | None = None
    link: Literal["new", "invoice"] = "new"
    invoice_id: str | None = None
    note: str = Field(default="", max_length=500)


class UseIn(BaseModel):
    product_id: str
    quantity: int = Field(ge=1)
    lot_id: str | None = None
    serial_unit_ids: list[str] = []
    barber_id: str | None = None
    note: str = Field(default="", max_length=500)


class AdjustIn(BaseModel):
    product_id: str
    quantity: int  # signed change, never zero
    reason: AdjustReason
    note: str = Field(default="", max_length=500)
    lot_id: str | None = None
    serial_unit_ids: list[str] = []
    serial_numbers: list[str] = []
    unit_cost: float | None = Field(default=None, ge=0)


class ReturnIn(BaseModel):
    product_id: str
    quantity: int = Field(ge=1)
    lot_id: str | None = None
    serial_unit_ids: list[str] = []
    refund_amount: float = Field(default=0, ge=0)
    refund_method: Literal["cash", "card", "other"] = "cash"
    barber_id: str | None = None
    note: str = Field(default="", max_length=500)


class CheckoutLine(BaseModel):
    product_id: str
    quantity: int = Field(ge=1)
    unit_price: float = Field(ge=0)
    serial_unit_ids: list[str] = []


class CheckoutIn(BaseModel):
    lines: list[CheckoutLine] = Field(min_length=1)
    barber_id: str | None = None
    invoice_id: str | None = None
    client_id: str | None = None
    discount_code: str | None = None
    payment_method: Literal["cash", "card"] = "cash"


class CheckoutResult(BaseModel):
    movements: list[Movement]
    total: float
    transaction_id: str | None
    invoice_id: str | None


class ImportRowError(BaseModel):
    row: int
    error: str


class ImportResult(BaseModel):
    imported: int
    errors: list[ImportRowError]


# ---------- Suppliers ----------
class SupplierIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    contact_name: str = Field(default="", max_length=120)
    email: str = Field(default="", max_length=160)
    phone: str = Field(default="", max_length=60)
    lead_time_days: int = Field(default=7, ge=0, le=365)
    notes: str = Field(default="", max_length=2000)


class Supplier(SupplierIn):
    id: str
    product_count: int = 0
    open_po_count: int = 0
    created_at: str


# ---------- Purchase orders ----------
class POLineIn(BaseModel):
    product_id: str
    quantity: int = Field(ge=1)
    unit_cost: float = Field(ge=0)


class POCreate(BaseModel):
    supplier_id: str
    lines: list[POLineIn] = Field(min_length=1)
    expected_date: str | None = None
    notes: str = Field(default="", max_length=2000)


class POLine(BaseModel):
    product_id: str
    sku: str | None
    name: str
    quantity: int
    unit_cost: float
    received_qty: int = 0


class ReceiveLine(BaseModel):
    product_id: str
    quantity: int = Field(ge=0)
    unit_cost: float | None = Field(default=None, ge=0)  # actual invoiced cost if it differs


class ReceiveIn(BaseModel):
    lines: list[ReceiveLine] = Field(min_length=1)
    close_backorder: bool = False  # true: whatever is still missing is cancelled


class SwitchSupplierIn(BaseModel):
    supplier_name: str = Field(min_length=1, max_length=120)


class POApprovalIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=500)


class SupplierScorecard(BaseModel):
    supplier_id: str
    name: str
    orders_received: int
    on_time_rate: float | None  # % of received orders that arrived by the expected date
    avg_lead_days: float | None  # actual ordered -> first delivery
    promised_lead_days: int
    short_shipment_rate: float | None  # % of received orders that came in short
    fill_rate: float | None  # % of ordered units actually delivered
    price_change_pct: float | None  # avg change from first to latest price paid, across products
    price_increases: int
    total_spend: float
    open_orders: int
    grade: str  # A..D, or "—" when not enough history


class SupplierPrice(BaseModel):
    supplier_name: str
    last_cost: float
    last_date: str
    min_cost: float
    purchases: int
    is_current_supplier: bool
    source: Literal["paid", "list"] = "paid"  # paid = from restocks; list = uploaded supplier price list


class PriceListIn(BaseModel):
    csv: str = Field(min_length=1, max_length=2_000_000)


class PriceListResult(BaseModel):
    matched: int
    unmatched: list[ImportRowError]


class ProductPrices(BaseModel):
    product_id: str
    name: str
    current_supplier: str | None
    current_cost: float | None
    best_supplier: str | None
    best_cost: float | None
    saving_per_unit: float
    prices: list[SupplierPrice]


class POStatusUpdate(BaseModel):
    status: POStatus


class PurchaseOrder(BaseModel):
    id: str
    number: str
    supplier_id: str
    supplier_name: str
    status: POStatus
    lines: list[POLine]
    total: float
    expected_date: str | None = None
    notes: str
    created_by: str
    created_at: str
    ordered_at: str | None = None
    received_at: str | None = None
    emailed_at: str | None = None
    first_received_at: str | None = None
    approved_by: str | None = None
    approved_at: str | None = None
    awaiting_approval: bool = False


# ---------- Insights / reports ----------
class ReorderSuggestion(BaseModel):
    product_id: str
    sku: str | None
    name: str
    type: ProductType
    quantity_on_hand: int
    reorder_point: int
    incoming: int
    daily_velocity: float
    days_of_cover: float | None
    lead_time_days: int
    suggested_qty: int
    urgency: Urgency
    supplier_id: str | None
    supplier_name: str | None
    unit_cost: float
    estimated_cost: float


class ReorderCreateIn(BaseModel):
    product_ids: list[str] = Field(min_length=1)


class StockRow(BaseModel):
    product_id: str
    name: str
    type: ProductType
    quantity_on_hand: int
    unit_cost: float
    value: float
    reorder_point: int
    status: StockStatus


class ExpiringLot(BaseModel):
    lot_id: str
    product_id: str
    product_name: str
    lot_number: str
    expiry_date: str
    quantity_on_hand: int
    days_left: int


class ProductPerf(BaseModel):
    product_id: str
    name: str
    units: int
    revenue: float
    cogs: float
    profit: float
    margin: float


class BarberPerf(BaseModel):
    barber_id: str | None
    name: str
    units: int
    revenue: float
    cogs: float
    profit: float
    commission_rate: float
    commission: float


class UsageRow(BaseModel):
    product_id: str
    name: str
    units: int
    cost: float


class InventoryReport(BaseModel):
    start: str
    end: str
    stock: list[StockRow]
    total_value: float
    retail_value: float
    low_stock: list[StockRow]
    expiring_lots: list[ExpiringLot]
    best_sellers: list[ProductPerf]
    profit_by_product: list[ProductPerf]
    profit_by_barber: list[BarberPerf]
    supply_usage: list[UsageRow]
    totals: dict[str, float]


class Alerts(BaseModel):
    low_stock_count: int
    out_of_stock_count: int
    expiring_count: int
    expired_count: int
    pending_approvals: int = 0  # only counted for users who can approve
    badge: int


class OutboxEmail(BaseModel):
    id: str
    to: str
    subject: str
    body: str
    status: Literal["sent", "logged", "failed"]
    error: str = ""
    created_at: str


# ---------- Stock count ----------
class CountLine(BaseModel):
    product_id: str
    counted: int = Field(ge=0)


class CountIn(BaseModel):
    lines: list[CountLine] = Field(min_length=1)
    note: str = Field(default="", max_length=500)


class CountSkip(BaseModel):
    product_id: str
    name: str
    reason: str


class CountResult(BaseModel):
    adjusted: list[Movement]
    unchanged: int
    skipped: list[CountSkip]


# ---------- Labels / PO email ----------
class AssignBarcodesIn(BaseModel):
    product_ids: list[str] = Field(min_length=1)


class POEmailIn(BaseModel):
    mark_ordered: bool = True
    message: str = Field(default="", max_length=2000)
