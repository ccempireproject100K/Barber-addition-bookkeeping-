"""Estimates / quotes. An estimate is a non-posting quote (no journal impact). When the client
accepts, convert it into a real invoice in one click — reusing the invoice pipeline so product
lines, discounts, tax and tips carry over and revenue is recognized only when that invoice issues."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pymongo import ReturnDocument

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso
from lib.db import db
from lib.money import invoice_amounts
from lib.repo import Scoped
from lib.stock import barber_name
from models.money import Estimate, EstimateStatusIn, Invoice, InvoiceIn, InvoiceLineIn

router = APIRouter()


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "tenant_id"}


async def _next_estimate_no(p: Principal) -> str:
    t = await db.tenants.find_one_and_update({"id": p.tenant_id}, {"$inc": {"estimate_seq": 1}}, return_document=ReturnDocument.AFTER)
    return f"EST-{t.get('estimate_seq', 1):04d}"


@router.get("/estimates", response_model=list[Estimate])
async def list_estimates(p: Principal = Depends(require("invoice:read"))):
    return [Estimate(**_strip(d)) for d in await Scoped("estimates", p).find({}, sort=[("created_at", -1)])]


@router.get("/estimates/{id}", response_model=Estimate)
async def get_estimate(id: str, p: Principal = Depends(require("invoice:read"))):
    doc = await Scoped("estimates", p).find_one({"id": id})
    if not doc:
        raise HTTPException(404, "Estimate not found")
    return Estimate(**_strip(doc))


@router.post("/estimates", response_model=Estimate)
async def create_estimate(body: InvoiceIn, p: Principal = Depends(require("invoice:write"))):
    lines = []
    for l in body.lines:
        d = l.model_dump()
        d["movement_id"] = None
        d["unit_cost"] = 0
        if d.get("kind") == "product" and d.get("product_id"):
            prod = await Scoped("products", p).find_one({"id": d["product_id"]})
            if not prod:
                raise HTTPException(404, f"Product {d['product_id']} not found")
            if prod["type"] != "retail":
                raise HTTPException(400, f"{prod['name']} is a supply and can't be quoted on an estimate")
            d["unit_cost"] = prod["unit_cost"]
        else:
            d["kind"] = "service"
            d["product_id"] = None
        lines.append(d)
    amt = invoice_amounts(lines, body.discount_amount, body.tax_rate, body.tip_amount)
    doc = {"id": str(uuid.uuid4()), "number": await _next_estimate_no(p), "client_name": body.client_name.strip(),
           "date": body.date, "valid_until": body.due_date, "status": "draft", "lines": lines,
           "barber_id": body.barber_id, "barber_name": await barber_name(p, body.barber_id), "notes": body.notes,
           "converted_invoice_id": None, "converted_invoice_number": None, "created_at": now_iso(), **amt}
    doc.pop("balance_due", None)
    await audit(p, "estimate.create", "estimate", doc["id"], {"number": doc["number"], "total": doc["total"]})
    return Estimate(**_strip(await Scoped("estimates", p).insert(doc)))


@router.post("/estimates/{id}/status", response_model=Estimate)
async def set_estimate_status(id: str, body: EstimateStatusIn, p: Principal = Depends(require("invoice:write"))):
    ests = Scoped("estimates", p)
    doc = await ests.find_one({"id": id})
    if not doc:
        raise HTTPException(404, "Estimate not found")
    if doc["status"] == "converted":
        raise HTTPException(400, "This estimate was already converted to an invoice")
    if body.status not in ("draft", "sent", "accepted", "declined"):
        raise HTTPException(400, "Use the convert endpoint to turn an estimate into an invoice")
    return Estimate(**_strip(await ests.update({"id": id}, {"$set": {"status": body.status}})))


@router.post("/estimates/{id}/convert", response_model=Invoice)
async def convert_estimate(id: str, p: Principal = Depends(require("invoice:write"))):
    ests = Scoped("estimates", p)
    doc = await ests.find_one({"id": id})
    if not doc:
        raise HTTPException(404, "Estimate not found")
    if doc["status"] == "converted":
        raise HTTPException(400, "Already converted")
    from routers.money import create_invoice
    inv_in = InvoiceIn(client_name=doc["client_name"], date=doc["date"], due_date=doc.get("valid_until"),
                       barber_id=doc.get("barber_id"), notes=doc.get("notes", ""),
                       discount_amount=doc.get("discount_amount", 0), tax_rate=doc.get("tax_rate", 0),
                       tip_amount=doc.get("tip_amount", 0),
                       lines=[InvoiceLineIn(description=l["description"], quantity=l["quantity"], unit_price=l["unit_price"],
                                            kind=l.get("kind", "service"), product_id=l.get("product_id")) for l in doc["lines"]])
    invoice = await create_invoice(inv_in, p)
    await ests.update({"id": id}, {"$set": {"status": "converted", "converted_invoice_id": invoice.id, "converted_invoice_number": invoice.number}})
    await audit(p, "estimate.convert", "estimate", id, {"invoice": invoice.number})
    return invoice


@router.delete("/estimates/{id}")
async def delete_estimate(id: str, p: Principal = Depends(require("invoice:write"))):
    doc = await Scoped("estimates", p).find_one({"id": id})
    if not doc:
        raise HTTPException(404, "Estimate not found")
    if doc["status"] == "converted":
        raise HTTPException(400, "Converted estimates are kept for your records")
    await Scoped("estimates", p).delete({"id": id})
    return {"ok": True}
