"""Built-in reorder forecasting (no external services)."""

import math
import re
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException

from lib.auth import Principal, require
from lib.dates import business_date_filter, now_iso, today_iso
from lib.stock import load_product
from lib.db import db
from lib.repo import Scoped
from models.inventory import ImportRowError, POLineIn, PriceListIn, PriceListResult, ProductPrices, SupplierScorecard, SwitchSupplierIn, PurchaseOrder, ReorderCreateIn, ReorderSuggestion, SupplierPrice
from routers.purchase_orders import create_po

router = APIRouter()

WINDOW, COVER_DAYS, DEFAULT_LEAD = 30, 30, 7


async def compute_suggestions(p: Principal) -> list[ReorderSuggestion]:
    products = await Scoped("products", p).find({"active": True})
    suppliers = {s["id"]: s for s in await Scoped("suppliers", p).find()}
    start = (date.fromisoformat(today_iso(p.settings.get("timezone"))) - timedelta(days=WINDOW - 1)).isoformat()
    outs: dict[str, int] = defaultdict(int)
    for r in await Scoped("movements", p).aggregate([
        {"$match": {"type": {"$in": ["sale", "use"]}, **business_date_filter(start)}},
        {"$group": {"_id": "$product_id", "units": {"$sum": "$quantity"}}},
    ]):
        outs[r["_id"]] = -r["units"]
    incoming: dict[str, int] = defaultdict(int)
    for po in await Scoped("purchase_orders", p).find({"status": {"$in": ["draft", "ordered", "partial"]}}):
        for ln in po["lines"]:
            incoming[ln["product_id"]] += ln["quantity"] - ln.get("received_qty", 0)

    result = []
    for d in products:
        sup = suppliers.get(d.get("supplier_id") or "")
        lead = sup["lead_time_days"] if sup else DEFAULT_LEAD
        velocity = outs[d["id"]] / WINDOW
        qoh, inc = d["quantity_on_hand"], incoming[d["id"]]
        effective = qoh + inc
        cover = round(max(qoh, 0) / velocity, 1) if velocity > 0 else None
        eff_cover = effective / velocity if velocity > 0 else math.inf
        if not (effective <= d["reorder_point"] or eff_cover <= lead + 7):
            continue
        target = math.ceil(velocity * (lead + COVER_DAYS)) + d["reorder_point"]
        qty = max(target - effective, (d.get("reorder_qty") or 0), d["reorder_point"] * 2 - effective, 0)
        if qty <= 0:
            continue
        urgency = "critical" if qoh <= 0 or (cover is not None and cover <= lead) else "high" if qoh <= d["reorder_point"] else "medium"
        result.append(ReorderSuggestion(
            product_id=d["id"], sku=d.get("sku"), name=d["name"], type=d["type"], quantity_on_hand=qoh, reorder_point=d["reorder_point"],
            incoming=inc, daily_velocity=round(velocity, 2), days_of_cover=cover, lead_time_days=lead, suggested_qty=qty,
            urgency=urgency, supplier_id=sup["id"] if sup else None, supplier_name=sup["name"] if sup else None,
            unit_cost=d["unit_cost"], estimated_cost=round(qty * d["unit_cost"], 2)))
    rank = {"critical": 0, "high": 1, "medium": 2}
    result.sort(key=lambda s: (rank[s.urgency], s.days_of_cover if s.days_of_cover is not None else 9999))
    return result


@router.get("/reorder", response_model=list[ReorderSuggestion])
async def reorder(p: Principal = Depends(require("insight:read"))):
    return await compute_suggestions(p)


@router.post("/reorder/create-pos", response_model=list[PurchaseOrder])
async def create_pos(body: ReorderCreateIn, p: Principal = Depends(require("po:write"))):
    wanted = set(body.product_ids)
    groups: dict[str, list[POLineIn]] = defaultdict(list)
    for s in await compute_suggestions(p):
        if s.product_id in wanted and s.supplier_id:
            prod = await Scoped("products", p).find_one({"id": s.product_id})
            if prod and prod["tracking_mode"] != "serial":
                groups[s.supplier_id].append(POLineIn(product_id=s.product_id, quantity=s.suggested_qty, unit_cost=s.unit_cost))
    created = []
    for sid, lines in groups.items():
        sup = await Scoped("suppliers", p).find_one({"id": sid})
        if sup:
            created.append(await create_po(p, sup, lines, None, "Generated from reorder suggestions"))
    return created


async def price_table(p: Principal, product_id: str | None = None) -> list[ProductPrices]:
    """Per-product supplier price history from restock movements (what you actually paid, by supplier)."""
    match: dict = {"type": "restock", "supplier_name": {"$nin": ["", None]}, "unit_cost": {"$gt": 0}}
    if product_id:
        match["product_id"] = product_id
    rows = await Scoped("movements", p).aggregate([
        {"$match": match}, {"$sort": {"created_at": 1}},
        {"$group": {"_id": {"p": "$product_id", "s": "$supplier_name"}, "last_cost": {"$last": "$unit_cost"},
                    "last_date": {"$last": "$created_at"}, "min_cost": {"$min": "$unit_cost"}, "n": {"$sum": 1}}},
    ])
    products = {d["id"]: d for d in await Scoped("products", p).find({"active": True, **({"id": product_id} if product_id else {})})}
    suppliers = {s["id"]: s["name"] for s in await Scoped("suppliers", p).find()}
    by: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["_id"]["p"] in products:
            by[r["_id"]["p"]].append(r)
    qf: dict = {"product_id": product_id} if product_id else {}
    for q in await Scoped("supplier_prices", p).find(qf):  # uploaded price lists (quotes you haven't bought at yet)
        if q["product_id"] in products:
            by[q["product_id"]].append({"_id": {"p": q["product_id"], "s": q["supplier_name"]}, "last_cost": q["cost"],
                                        "last_date": q["uploaded_at"], "min_cost": q["cost"], "n": 0, "list": True})
    out = []
    for pid, rs in by.items():
        d = products[pid]
        cur = suppliers.get(d.get("supplier_id") or "")
        prices = sorted([SupplierPrice(supplier_name=r["_id"]["s"], last_cost=round(r["last_cost"], 2), last_date=r["last_date"][:10],
                                       min_cost=round(r["min_cost"], 2), purchases=r["n"], is_current_supplier=r["_id"]["s"] == cur,
                                       source="list" if r.get("list") else "paid") for r in rs],
                        key=lambda x: x.last_cost)
        best = prices[0]
        cur_price = next((x.last_cost for x in prices if x.is_current_supplier), None)
        out.append(ProductPrices(product_id=pid, name=d["name"], current_supplier=cur, current_cost=cur_price, best_supplier=best.supplier_name,
                                 best_cost=best.last_cost, saving_per_unit=round(max((cur_price or best.last_cost) - best.last_cost, 0), 2), prices=prices))
    return sorted(out, key=lambda x: (-x.saving_per_unit, x.name))


@router.get("/prices", response_model=list[ProductPrices])
async def prices(product_id: str = "", p: Principal = Depends(require("insight:read"))):
    return await price_table(p, product_id or None)


@router.post("/products/{id}/switch-supplier", response_model=ProductPrices)
async def switch_supplier(id: str, body: SwitchSupplierIn, p: Principal = Depends(require("product:write"))):
    """One-tap: make the given (usually cheapest) supplier this product's default. Unknown names from restock history
    become a supplier record so future POs and reorder suggestions use them."""
    prod = await load_product(p, id)
    name = body.supplier_name.strip()
    sups = Scoped("suppliers", p)
    sup = await sups.find_one({"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}})
    if not sup:
        sup = await sups.insert({"id": str(uuid.uuid4()), "name": name, "contact_name": "", "email": "", "phone": "", "lead_time_days": 7,
                                 "notes": "Added from price comparison", "created_at": now_iso()})
    await Scoped("products", p).update({"id": prod["id"]}, {"$set": {"supplier_id": sup["id"], "updated_at": now_iso()}})
    rows = await price_table(p, prod["id"])
    if not rows:
        raise HTTPException(404, "No price history for this product")
    return rows[0]


def _days(a: str, b: str) -> float:
    return (datetime.fromisoformat(b[:19]) - datetime.fromisoformat(a[:19])).total_seconds() / 86400


@router.get("/supplier-scorecards", response_model=list[SupplierScorecard])
async def scorecards(p: Principal = Depends(require("insight:read"))):
    """Reliability from your own PO history: on-time delivery, short shipments, fill rate, and price drift."""
    sups = await Scoped("suppliers", p).find()
    pos = await Scoped("purchase_orders", p).find({"status": {"$in": ["ordered", "partial", "received"]}})
    restocks = await Scoped("movements", p).find({"type": "restock", "supplier_name": {"$nin": ["", None]}, "unit_cost": {"$gt": 0}},
                                                 sort=[("created_at", 1)])
    out = []
    for s in sups:
        mine = [d for d in pos if d["supplier_id"] == s["id"]]
        done = [d for d in mine if d["status"] == "received" or d.get("first_received_at")]
        on_time, leads, short, ordered_u, got_u = [], [], 0, 0, 0
        for d in done:
            first = d.get("first_received_at") or d.get("received_at")
            if d.get("ordered_at") and first:
                leads.append(_days(d["ordered_at"], first))
                due = d.get("expected_date") or (datetime.fromisoformat(d["ordered_at"][:19]) + timedelta(days=s.get("lead_time_days", 7))).date().isoformat()
                on_time.append(first[:10] <= due)
            o = sum(l["quantity"] for l in d["lines"])
            g = sum(l.get("received_qty", l["quantity"] if d["status"] == "received" and "received_qty" not in l else 0) for l in d["lines"])
            ordered_u += o
            got_u += g
            if g < o:
                short += 1
        by_prod: dict[str, list[float]] = defaultdict(list)
        for m in restocks:
            if m["supplier_name"].lower() == s["name"].lower():
                by_prod[m["product_id"]].append(m["unit_cost"])
        changes = [(c[-1] - c[0]) / c[0] * 100 for c in by_prod.values() if len(c) > 1 and c[0]]
        spend = sum(m["quantity"] * m["unit_cost"] for m in restocks if m["supplier_name"].lower() == s["name"].lower())
        n = len(done)
        ot = round(sum(on_time) / len(on_time) * 100, 1) if on_time else None
        sr = round(short / n * 100, 1) if n else None
        fr = round(got_u / ordered_u * 100, 1) if ordered_u else None
        pc = round(sum(changes) / len(changes), 1) if changes else None
        grade = "—"
        if n >= 2:
            score = (ot or 0) * 0.5 + (fr or 0) * 0.4 + max(0, 10 - max(pc or 0, 0))
            grade = "A" if score >= 92 else "B" if score >= 80 else "C" if score >= 65 else "D"
        out.append(SupplierScorecard(supplier_id=s["id"], name=s["name"], orders_received=n, on_time_rate=ot,
                                     avg_lead_days=round(sum(leads) / len(leads), 1) if leads else None, promised_lead_days=s.get("lead_time_days", 7),
                                     short_shipment_rate=sr, fill_rate=fr, price_change_pct=pc, price_increases=sum(1 for c in changes if c > 0.5),
                                     total_spend=round(spend, 2), open_orders=sum(1 for d in mine if d["status"] in ("ordered", "partial")), grade=grade))
    return sorted(out, key=lambda x: (x.grade == "—", x.grade, x.name))


@router.post("/suppliers/{id}/price-list", response_model=PriceListResult)
async def upload_price_list(id: str, body: PriceListIn, p: Principal = Depends(require("supplier:write"))):
    """CSV with a cost column and any of sku / barcode / name. Replaces this supplier's previous list."""
    import csv as _csv
    import io as _io
    sup = await Scoped("suppliers", p).find_one({"id": id})
    if not sup:
        raise HTTPException(404, "Supplier not found")
    reader = _csv.DictReader(_io.StringIO(body.csv.lstrip("\ufeff")))
    cols = {c.strip().lower(): c for c in (reader.fieldnames or [])}
    cost_col = next((cols[c] for c in ("cost", "unit_cost", "price", "unit price", "wholesale") if c in cols), None)
    if not cost_col or not any(c in cols for c in ("sku", "barcode", "name", "product")):
        raise HTTPException(400, "CSV needs a cost (or price) column and at least one of sku, barcode, name")
    prods = await Scoped("products", p).find({"active": True})
    by_sku = {d["sku"].lower(): d for d in prods if d.get("sku")}
    by_bc = {d["barcode"]: d for d in prods if d.get("barcode")}
    by_name = {d["name"].lower(): d for d in prods}
    now = now_iso()
    found, bad = {}, []
    for i, row in enumerate(reader, start=2):
        get = lambda k: (row.get(cols[k]) or "").strip() if k in cols else ""  # noqa: E731
        d = by_sku.get(get("sku").lower()) or by_bc.get(get("barcode")) or by_name.get((get("name") or get("product")).lower())
        try:
            cost = float(get(next(k for k in ("cost", "unit_cost", "price", "unit price", "wholesale") if k in cols)).replace("$", "").replace(",", ""))
        except ValueError:
            bad.append(ImportRowError(row=i, error="cost is not a number"))
            continue
        if not d:
            bad.append(ImportRowError(row=i, error=f"no product matches {get('sku') or get('barcode') or get('name') or get('product')!r}"))
            continue
        if cost <= 0:
            bad.append(ImportRowError(row=i, error="cost must be > 0"))
            continue
        found[d["id"]] = cost
    await db.supplier_prices.delete_many({"tenant_id": p.tenant_id, "supplier_id": id})
    for pid, cost in found.items():
        await Scoped("supplier_prices", p).insert({"id": str(uuid.uuid4()), "supplier_id": id, "supplier_name": sup["name"],
                                                   "product_id": pid, "cost": round(cost, 4), "uploaded_at": now})
    return PriceListResult(matched=len(found), unmatched=bad[:100])
