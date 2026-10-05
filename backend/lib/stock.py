"""Stock ledger engine. Every quantity change goes through post_movement(); movements are append-only.

Concurrency: all decrements are atomic conditional updates ($gte guards on product / lot qty, status
guards on serial units) with compensating reverts, so two simultaneous sales of the last unit yield one
success and one 409.
"""

import uuid
from datetime import date

from fastapi import HTTPException

from lib.auth import Principal
from lib.dates import now_iso, today_iso
from lib.db import db
from lib.repo import Scoped


def _cents(x: float) -> float:
    from decimal import ROUND_HALF_UP, Decimal
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def stock_status(qoh: int, reorder_point: int) -> str:
    if qoh <= 0:
        return "out"
    if qoh <= reorder_point:
        return "low"
    return "in_stock"


def lot_status(lot: dict, warn_days: int, today: str | None = None) -> str:
    if lot["quantity_on_hand"] <= 0:
        return "empty"
    exp = lot.get("expiry_date")
    if not exp:
        return "ok"
    left = (date.fromisoformat(exp) - date.fromisoformat(today or today_iso())).days
    if left < 0:
        return "expired"
    return "expiring" if left <= warn_days else "ok"


async def default_location(p: Principal) -> str:
    locs = Scoped("locations", p)
    loc = await locs.find_one({"is_default": True})
    if not loc:
        loc = await locs.insert({"id": str(uuid.uuid4()), "name": "Main shop", "is_default": True, "created_at": now_iso()})
    return loc["id"]


async def barber_name(p: Principal, barber_id: str | None) -> str | None:
    if not barber_id:
        return None
    u = await db.users.find_one({"id": barber_id, "tenant_id": p.tenant_id}, {"_id": 0, "name": 1})
    if not u:
        raise HTTPException(400, "Barber not found in this workspace")
    return u["name"]


async def load_product(p: Principal, product_id: str) -> dict:
    doc = await Scoped("products", p).find_one({"id": product_id})
    if not doc:
        raise HTTPException(404, "Product not found")
    return doc


async def fefo_lot(p: Principal, product_id: str, need: int) -> dict | None:
    """First-expired, first-out: earliest expiry (no-expiry last) that can cover the quantity."""
    lots = await Scoped("lots", p).find({"product_id": product_id, "quantity_on_hand": {"$gt": 0}})
    lots.sort(key=lambda l: (l.get("expiry_date") is None, l.get("expiry_date") or "", l["received_date"]))
    for lot in lots:
        if lot["quantity_on_hand"] >= need:
            return lot
    return lots[0] if lots else None


def _avg_cost_pipeline(qty: int, cost: float, at: str) -> list[dict]:
    base = {"$max": ["$quantity_on_hand", 0]}
    return [{"$set": {
        "unit_cost": {"$round": [{"$cond": [
            {"$gt": [{"$add": [base, qty]}, 0]},
            {"$divide": [{"$add": [{"$multiply": [base, "$unit_cost"]}, qty * cost]}, {"$add": [base, qty]}]},
            cost,
        ]}, 4]},
        "quantity_on_hand": {"$add": ["$quantity_on_hand", qty]},
        "updated_at": at,
    }}]


async def post_movement(
    p: Principal, product: dict, type_: str, qty: int, *,
    unit_cost: float | None = None, unit_price: float | None = None,
    lot_id: str | None = None, lot_number: str | None = None, expiry_date: str | None = None,
    serial_numbers: list[str] | None = None, serial_ids: list[str] | None = None, serial_status: str = "sold",
    warranty_until: str | None = None, reason: str = "", note: str = "", supplier_name: str = "",
    barber_id: str | None = None, linked_transaction_id: str | None = None, linked_invoice_id: str | None = None,
    at: str | None = None, movement_id: str | None = None, update_avg_cost: bool = False,
    op_id: str | None = None, compensates: str | None = None,
) -> dict:
    if qty == 0:
        raise HTTPException(400, "Quantity cannot be zero")
    at = at or now_iso()
    mid = movement_id or str(uuid.uuid4())
    pid = product["id"]
    mode = product["tracking_mode"]
    bname = await barber_name(p, barber_id)
    lot_doc: dict | None = None
    serial_docs: list[dict] = []
    unit_basis = product["unit_cost"]

    if mode == "lot":
        lots = Scoped("lots", p)
        if qty > 0:
            if lot_id:
                lot_doc = await lots.update({"id": lot_id, "product_id": pid}, {"$inc": {"quantity_on_hand": qty}})
                if not lot_doc:
                    raise HTTPException(404, "Lot not found")
            else:
                ln = (lot_number or "").strip()
                if not ln:
                    raise HTTPException(400, "Lot number is required for lot-tracked products")
                lot_doc = await lots.update({"product_id": pid, "lot_number": ln}, {"$inc": {"quantity_on_hand": qty}})
                if not lot_doc:
                    lot_doc = await lots.insert({
                        "id": str(uuid.uuid4()), "product_id": pid, "location_id": product["location_id"],
                        "lot_number": ln, "expiry_date": expiry_date or None, "received_date": at[:10],
                        "unit_cost": unit_cost if unit_cost is not None else product["unit_cost"], "quantity_on_hand": qty,
                    })
            unit_basis = lot_doc["unit_cost"]
        else:
            need = -qty
            if not lot_id:
                pick = await fefo_lot(p, pid, need)
                if not pick:
                    raise HTTPException(409, "Not enough stock: no lot has units on hand")
                lot_id = pick["id"]
            lot_doc = await lots.update({"id": lot_id, "product_id": pid, "quantity_on_hand": {"$gte": need}},
                                        {"$inc": {"quantity_on_hand": -need}})
            if not lot_doc:
                cur = await lots.find_one({"id": lot_id, "product_id": pid})
                if not cur:
                    raise HTTPException(404, "Lot not found")
                raise HTTPException(409, f"Not enough stock in lot {cur['lot_number']}: only {cur['quantity_on_hand']} left")
            unit_basis = lot_doc["unit_cost"]

    elif mode == "serial":
        serials = Scoped("serial_units", p)
        if qty > 0 and type_ != "return":
            nums = [s.strip() for s in (serial_numbers or []) if s.strip()]
            if len(nums) != qty or len(set(nums)) != qty:
                raise HTTPException(400, f"Enter exactly {qty} unique serial number(s)")
            dup = await serials.find_one({"product_id": pid, "serial_number": {"$in": nums}})
            if dup:
                raise HTTPException(409, f"Serial {dup['serial_number']} already exists for this product")
            cost = unit_cost if unit_cost is not None else product["unit_cost"]
            for n in nums:
                serial_docs.append(await serials.insert({
                    "id": str(uuid.uuid4()), "product_id": pid, "location_id": product["location_id"], "serial_number": n,
                    "status": "in_stock", "unit_cost": cost, "received_date": at[:10], "sold_date": None,
                    "warranty_until": warranty_until, "linked_movement_ids": [mid],
                }))
        else:
            ids = list(dict.fromkeys(serial_ids or []))
            if len(ids) != abs(qty):
                raise HTTPException(400, f"Select exactly {abs(qty)} serial number(s)")
            from_status = {"$in": ["sold", "used"]} if qty > 0 else "in_stock"
            new_status = "in_stock" if qty > 0 else serial_status
            done: list[dict] = []
            for sid in ids:
                patch = {"status": new_status, "sold_date": at[:10] if new_status == "sold" else None}
                d = await serials.update({"id": sid, "product_id": pid, "status": from_status},
                                         {"$set": patch, "$push": {"linked_movement_ids": mid}})
                if not d:
                    for prev in done:  # compensate
                        await serials.update({"id": prev["id"]}, {"$set": {"status": prev["_old"], "sold_date": prev.get("sold_date_old")},
                                                                  "$pull": {"linked_movement_ids": mid}})
                    cur = await serials.find_one({"id": sid, "product_id": pid})
                    label = cur["serial_number"] if cur else sid
                    state = cur["status"].replace("_", " ") if cur else "missing"
                    raise HTTPException(409, f"Serial {label} is {state} and can't be {'returned' if qty > 0 else type_ + ('d' if type_.endswith('e') else 'ed')}")
                d["_old"] = "sold" if qty > 0 else "in_stock"
                done.append(d)
            serial_docs = [{k: v for k, v in d.items() if not k.startswith("_")} for d in done]
        if serial_docs and qty < 0:
            unit_basis = sum(d["unit_cost"] for d in serial_docs) / len(serial_docs)

    # Product cached on-hand total (same logical operation as the ledger insert).
    products = Scoped("products", p)
    filt: dict = {"id": pid}
    if qty < 0 and mode == "none" and not p.settings.get("allow_negative_stock"):
        filt["quantity_on_hand"] = {"$gte": -qty}
    if qty > 0 and update_avg_cost and unit_cost is not None:
        update: dict | list = _avg_cost_pipeline(qty, unit_cost, at)
    else:
        update = {"$inc": {"quantity_on_hand": qty}, "$set": {"updated_at": at}}
    after = await products.update(filt, update)
    if not after:
        raise HTTPException(409, f"Not enough stock: only {product['quantity_on_hand']} {product['unit']} on hand")

    cogs = 0.0
    if type_ in ("sale", "use") or (type_ == "adjustment" and qty < 0):
        cogs = _cents(-qty * unit_basis)
    elif type_ == "return":
        cogs = _cents(-qty * unit_basis)  # negative: reverses cost of goods

    doc = {
        "id": mid, "product_id": pid, "product_name": product["name"], "product_sku": product.get("sku"),
        "product_type": product["type"], "location_id": product["location_id"], "type": type_, "quantity": qty,
        "unit_cost": unit_cost if unit_cost is not None else round(unit_basis, 4),
        "unit_price": unit_price, "cogs": cogs,
        "lot_id": lot_doc["id"] if lot_doc else None, "lot_number": lot_doc["lot_number"] if lot_doc else None,
        "serial_unit_ids": [d["id"] for d in serial_docs], "serial_numbers": [d["serial_number"] for d in serial_docs],
        "reason": reason, "note": note, "supplier_name": supplier_name,
        "linked_transaction_id": linked_transaction_id, "linked_invoice_id": linked_invoice_id,
        "performed_by": p.user_id, "performed_by_name": p.name, "barber_id": barber_id, "barber_name": bname,
        "op_id": op_id, "compensates": compensates, "created_at": at,
    }
    await Scoped("movements", p).insert(doc)
    from lib.bookkeeping import mirror_cogs, mirror_inventory_inflow  # local import avoids a circular dependency
    await mirror_cogs(p, doc)
    # Inflows with no paid-purchase txn behind them must still book the inventory asset.
    if type_ in ("restock", "adjustment") and qty > 0 and linked_transaction_id is None:
        await mirror_inventory_inflow(p, doc)
    doc.pop("tenant_id", None)
    return doc
