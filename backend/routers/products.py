import csv
import io
import random
import uuid
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError

from lib.auth import Principal, require
from lib.dates import now_iso, today_iso
from lib.repo import Scoped
from lib.stock import default_location, fefo_lot, load_product, lot_status, post_movement, stock_status
from models.inventory import (AssignBarcodesIn, BarcodeLookup, ImportResult, ImportRowError, Lot, Product, ProductCreate,
                              ProductDetail, ProductUpdate, SerialUnit)

router = APIRouter()


def _clean(v: str | None) -> str | None:
    v = (v or "").strip()
    return v or None


def to_product(doc: dict, suppliers: dict[str, str], expiring: dict[str, int]) -> Product:
    return Product(
        **{k: v for k, v in doc.items() if k not in ("tenant_id",)},
        status=stock_status(doc["quantity_on_hand"], doc["reorder_point"]),
        stock_value=round(max(doc["quantity_on_hand"], 0) * doc["unit_cost"], 2),
        supplier_name=suppliers.get(doc.get("supplier_id") or ""),
        expiring_lots=expiring.get(doc["id"], 0),
    )


async def product_context(p: Principal) -> tuple[dict[str, str], dict[str, int]]:
    suppliers = {s["id"]: s["name"] for s in await Scoped("suppliers", p).find()}
    warn = p.settings["expiry_warning_days"]
    expiring: dict[str, int] = defaultdict(int)
    today = today_iso(p.settings.get("timezone"))
    for lot in await Scoped("lots", p).find({"quantity_on_hand": {"$gt": 0}, "expiry_date": {"$ne": None}}):
        if lot_status(lot, warn, today) in ("expiring", "expired"):
            expiring[lot["product_id"]] += 1
    return suppliers, expiring


async def _check_refs(p: Principal, body: ProductCreate | ProductUpdate) -> None:
    if body.supplier_id and not await Scoped("suppliers", p).find_one({"id": body.supplier_id}):
        raise HTTPException(400, "Supplier not found")


def _dup_error(e: DuplicateKeyError) -> HTTPException:
    key = "barcode" if "barcode" in str(e) else "SKU"
    return HTTPException(409, f"That {key} is already used by another product in this workspace")


@router.get("/products", response_model=list[Product])
async def list_products(q: str = "", type: str = "", status: str = "", category: str = "", expiring: bool = False,
                        archived: bool = False, p: Principal = Depends(require("product:read"))):
    suppliers, exp = await product_context(p)
    docs = await Scoped("products", p).find({"active": not archived}, sort=[("name", 1)])
    items = [to_product(d, suppliers, exp) for d in docs]
    if q:
        ql = q.lower()
        items = [i for i in items if ql in i.name.lower() or ql in (i.sku or "").lower() or ql in (i.barcode or "")
                 or ql in i.brand.lower() or ql in i.category.lower()]
    if type:
        items = [i for i in items if i.type == type]
    if status == "low":
        items = [i for i in items if i.status in ("low", "out")]
    elif status:
        items = [i for i in items if i.status == status]
    if category:
        items = [i for i in items if i.category == category]
    if expiring:
        items = [i for i in items if i.expiring_lots > 0]
    return items


@router.get("/products/export.csv")
async def export_products(p: Principal = Depends(require("product:read"))):
    docs = await Scoped("products", p).find({"active": True}, sort=[("name", 1)])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["name", "type", "category", "brand", "sku", "barcode", "sell_price", "unit_cost", "quantity",
                "reorder_point", "tracking_mode", "stock_value"])
    for d in docs:
        w.writerow([d["name"], d["type"], d["category"], d["brand"], d.get("sku") or "", d.get("barcode") or "",
                    d["sell_price"], d["unit_cost"], d["quantity_on_hand"], d["reorder_point"], d["tracking_mode"],
                    round(max(d["quantity_on_hand"], 0) * d["unit_cost"], 2)])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="products.csv"'})


class ImportIn(BaseModel):
    csv: str


@router.post("/products/import", response_model=ImportResult)
async def import_products(body: ImportIn, p: Principal = Depends(require("product:write"))):
    """All-or-nothing: every row is validated first; if any row is bad nothing is imported."""
    reader = csv.DictReader(io.StringIO(body.csv.strip()))
    cols = {c.strip().lower() for c in (reader.fieldnames or [])}
    if "name" not in cols:
        raise HTTPException(400, "CSV must have a header row with at least a 'name' column")
    existing = await Scoped("products", p).find()
    skus = {d["sku"].lower() for d in existing if d.get("sku")}
    barcodes = {d["barcode"] for d in existing if d.get("barcode")}
    rows, errors = [], []
    for i, raw in enumerate(reader, start=2):
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
        try:
            name = r.get("name", "")
            if not name:
                raise ValueError("name is required")
            ptype = (r.get("type") or "retail").lower()
            if ptype not in ("retail", "supply"):
                raise ValueError("type must be 'retail' or 'supply'")
            num = lambda k, d=0.0: float(r[k]) if r.get(k) else d  # noqa: E731
            price, cost = num("price", num("sell_price")), num("cost", num("unit_cost"))
            qty, rp = int(num("quantity")), int(num("reorder_point", 5))
            if min(price, cost, qty, rp) < 0:
                raise ValueError("numbers cannot be negative")
            sku, bc = _clean(r.get("sku")), _clean(r.get("barcode"))
            if sku and sku.lower() in skus:
                raise ValueError(f"SKU '{sku}' already exists")
            if bc and bc in barcodes:
                raise ValueError(f"barcode '{bc}' already exists")
            if sku:
                skus.add(sku.lower())
            if bc:
                barcodes.add(bc)
            rows.append(dict(name=name, type=ptype, category=r.get("category", ""), brand=r.get("brand", ""), sku=sku,
                             barcode=bc, sell_price=price if ptype == "retail" else 0, cost=cost, qty=qty, rp=rp))
        except ValueError as e:
            msg = str(e)
            errors.append(ImportRowError(row=i, error=msg if "could not convert" not in msg else "invalid number"))
    if errors:
        return ImportResult(imported=0, errors=errors)
    if not rows:
        raise HTTPException(400, "CSV has no data rows")
    loc = await default_location(p)
    now = now_iso()
    for r in rows:
        doc = await Scoped("products", p).insert({
            "id": str(uuid.uuid4()), "name": r["name"], "type": r["type"], "category": r["category"], "brand": r["brand"],
            "sku": r["sku"], "barcode": r["barcode"], "sell_price": r["sell_price"], "unit": "each", "tracking_mode": "none",
            "reorder_point": r["rp"], "reorder_qty": None, "supplier_id": None, "image": None, "description": "",
            "unit_cost": r["cost"], "quantity_on_hand": 0, "location_id": loc, "active": True, "created_at": now, "updated_at": now,
        })
        if r["qty"] > 0:
            await post_movement(p, doc, "restock", r["qty"], unit_cost=r["cost"], note="Opening stock (CSV import)")
    return ImportResult(imported=len(rows), errors=[])


@router.get("/products/barcode/{code}", response_model=BarcodeLookup)
async def lookup_barcode(code: str, p: Principal = Depends(require("product:read"))):
    code = code.strip()
    doc = await Scoped("products", p).find_one({"$or": [{"barcode": code}, {"sku": code}]})
    if not doc:
        return BarcodeLookup(found=False)
    suppliers, exp = await product_context(p)
    return BarcodeLookup(found=True, product=to_product(doc, suppliers, exp))


def _ean13(body12: str) -> str:
    s = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(body12))
    return body12 + str((10 - s % 10) % 10)


@router.post("/products/assign-barcodes", response_model=list[Product])
async def assign_barcodes(body: AssignBarcodesIn, p: Principal = Depends(require("product:write"))):
    """Give products without a barcode an in-store EAN-13 (prefix 2xx, reserved for internal use) so they can be labelled."""
    products = Scoped("products", p)
    used = {d["barcode"] for d in await products.find({"barcode": {"$type": "string"}}) if d.get("barcode")}
    out = []
    for pid in dict.fromkeys(body.product_ids):
        doc = await load_product(p, pid)
        if not doc.get("barcode"):
            while True:
                code = _ean13("2" + "".join(random.choices("0123456789", k=11)))
                if code not in used:
                    break
            used.add(code)
            try:
                doc = await products.update({"id": pid, "barcode": None}, {"$set": {"barcode": code, "updated_at": now_iso()}}) or await load_product(p, pid)
            except DuplicateKeyError:
                raise HTTPException(409, "Barcode collision, please retry")
        out.append(doc)
    suppliers, exp = await product_context(p)
    return [to_product(d, suppliers, exp) for d in out]


@router.get("/products/{id}", response_model=ProductDetail)
async def get_product(id: str, p: Principal = Depends(require("product:read"))):
    doc = await load_product(p, id)
    suppliers, exp = await product_context(p)
    warn, today = p.settings["expiry_warning_days"], today_iso(p.settings.get("timezone"))
    lots = await Scoped("lots", p).find({"product_id": id})
    lots.sort(key=lambda l: (l["quantity_on_hand"] <= 0, l.get("expiry_date") is None, l.get("expiry_date") or "", l["received_date"]))
    serials = await Scoped("serial_units", p).find({"product_id": id}, sort=[("serial_number", 1)])
    pick = await fefo_lot(p, id, 1) if doc["tracking_mode"] == "lot" else None
    return ProductDetail(
        product=to_product(doc, suppliers, exp),
        lots=[Lot(**{k: v for k, v in l.items() if k != "tenant_id"}, status=lot_status(l, warn, today)) for l in lots],
        serials=[SerialUnit(**{k: v for k, v in s.items() if k != "tenant_id"}) for s in serials],
        suggested_lot_id=pick["id"] if pick else None,
    )


@router.post("/products", response_model=Product)
async def create_product(body: ProductCreate, p: Principal = Depends(require("product:write"))):
    await _check_refs(p, body)
    data = body.model_dump(exclude={"opening_qty", "opening_unit_cost", "opening_lot_number", "opening_expiry_date", "opening_serials"})
    data["sku"], data["barcode"] = _clean(body.sku), _clean(body.barcode)
    if body.type == "supply":
        data["sell_price"] = 0
    if body.opening_qty > 0:  # validate tracking inputs before writing anything
        if body.tracking_mode == "lot" and not _clean(body.opening_lot_number):
            raise HTTPException(400, "Opening lot number is required for lot-tracked products")
        if body.tracking_mode == "serial" and len({s.strip() for s in body.opening_serials if s.strip()}) != body.opening_qty:
            raise HTTPException(400, f"Enter exactly {body.opening_qty} unique opening serial number(s)")
    now = now_iso()
    doc = {**data, "id": str(uuid.uuid4()), "unit_cost": body.opening_unit_cost, "quantity_on_hand": 0,
           "location_id": await default_location(p), "active": True, "created_at": now, "updated_at": now}
    try:
        doc = await Scoped("products", p).insert(doc)
    except DuplicateKeyError as e:
        raise _dup_error(e)
    if body.opening_qty > 0:
        await post_movement(p, doc, "restock", body.opening_qty, unit_cost=body.opening_unit_cost,
                            lot_number=body.opening_lot_number, expiry_date=body.opening_expiry_date,
                            serial_numbers=body.opening_serials, note="Opening stock")
        doc = await load_product(p, doc["id"])
    suppliers, exp = await product_context(p)
    return to_product(doc, suppliers, exp)


@router.put("/products/{id}", response_model=Product)
async def update_product(id: str, body: ProductUpdate, p: Principal = Depends(require("product:write"))):
    await _check_refs(p, body)
    cur = await load_product(p, id)
    data = body.model_dump()
    data["sku"], data["barcode"] = _clean(body.sku), _clean(body.barcode)
    if data["tracking_mode"] != cur["tracking_mode"] and cur["quantity_on_hand"] != 0:
        raise HTTPException(400, "Tracking mode can only change while on-hand quantity is zero")
    try:
        doc = await Scoped("products", p).update({"id": id}, {"$set": {**data, "updated_at": now_iso()}})
    except DuplicateKeyError as e:
        raise _dup_error(e)
    assert doc
    suppliers, exp = await product_context(p)
    return to_product(doc, suppliers, exp)


@router.delete("/products/{id}")
async def archive_product(id: str, p: Principal = Depends(require("product:delete"))):
    """Archive (never hard-delete) so the movement history stays intact."""
    if not await Scoped("products", p).update({"id": id}, {"$set": {"active": False, "updated_at": now_iso()}}):
        raise HTTPException(404, "Product not found")
    return {"ok": True}


@router.get("/serials/{id}", response_model=SerialUnit)
async def get_serial(id: str, p: Principal = Depends(require("product:read"))):
    doc = await Scoped("serial_units", p).find_one({"id": id})
    if not doc:
        raise HTTPException(404, "Serial not found")
    return SerialUnit(**{k: v for k, v in doc.items() if k != "tenant_id"})
