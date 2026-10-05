"""Operating expenses + vendors. Expenses post through create_txn (so they auto-book to the journal
as DR expense / CR cash). Inventory purchases are NOT expenses here — they are received via Procurement
/ restock and capitalized to the Inventory asset account."""

import uuid

from fastapi import APIRouter, Depends, HTTPException

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso
from lib.money import create_txn, money
from lib.repo import Scoped
from models.bookkeeping import EXPENSE_CATEGORIES, ExpenseIn, Vendor, VendorIn

router = APIRouter()


# ---------- Vendors ----------
@router.get("/vendors", response_model=list[Vendor])
async def list_vendors(p: Principal = Depends(require("txn:read"))):
    return [Vendor(**{k: v for k, v in d.items() if k != "tenant_id"})
            for d in await Scoped("vendors", p).find({}, sort=[("name", 1)])]


@router.post("/vendors", response_model=Vendor)
async def create_vendor(body: VendorIn, p: Principal = Depends(require("txn:write"))):
    doc = {"id": str(uuid.uuid4()), **body.model_dump(), "created_at": now_iso()}
    await Scoped("vendors", p).insert(doc)
    await audit(p, "vendor.create", "vendor", doc["id"], {"name": body.name})
    return Vendor(**doc)


@router.delete("/vendors/{vendor_id}")
async def delete_vendor(vendor_id: str, p: Principal = Depends(require("txn:write"))):
    if not await Scoped("vendors", p).delete({"id": vendor_id}):
        raise HTTPException(404, "Vendor not found")
    return {"ok": True}


# ---------- Expenses ----------
@router.get("/expense-categories", response_model=list[str])
async def expense_categories(p: Principal = Depends(require("txn:read"))):
    return EXPENSE_CATEGORIES


@router.get("/expenses")
async def list_expenses(start: str = "", end: str = "", p: Principal = Depends(require("txn:read"))):
    f: dict = {"kind": "expense", "source": "manual", "capitalized": {"$ne": True}}
    if start or end:
        f["date"] = {**({"$gte": start} if start else {}), **({"$lte": end} if end else {})}
    docs = await Scoped("transactions", p).find(f, sort=[("date", -1), ("created_at", -1)], limit=2000)
    return [{"id": d["id"], "date": d["date"], "category": d["category"], "amount": d["amount"],
             "description": d.get("description", ""), "payment_method": d.get("payment_method", "cash"),
             "vendor_id": d.get("vendor_id"), "vendor_name": d.get("vendor_name"),
             "receipt_url": d.get("receipt_url"), "receipt_name": d.get("receipt_name", ""),
             "reversed_by": d.get("reversed_by"), "reversal_of": d.get("reversal_of")} for d in docs]


@router.post("/expenses")
async def create_expense(body: ExpenseIn, p: Principal = Depends(require("txn:write"))):
    vendor_name = None
    if body.vendor_id:
        v = await Scoped("vendors", p).find_one({"id": body.vendor_id})
        if not v:
            raise HTTPException(404, "Vendor not found")
        vendor_name = v["name"]
    desc = body.description or (f"{body.category} — {vendor_name}" if vendor_name else body.category)
    doc = await create_txn(p, "expense", body.category.strip(), money(body.amount), body.date, desc,
                           payment_method=body.payment_method, capitalized=False,
                           extra={"vendor_id": body.vendor_id, "vendor_name": vendor_name,
                                  "receipt_url": body.receipt_url, "receipt_name": body.receipt_name})
    await audit(p, "expense.create", "transaction", doc["id"], {"category": body.category, "amount": doc["amount"], "vendor": vendor_name})
    return {"id": doc["id"], "date": doc["date"], "category": doc["category"], "amount": doc["amount"],
            "description": doc.get("description", ""), "payment_method": doc.get("payment_method", "cash"),
            "vendor_id": body.vendor_id, "vendor_name": vendor_name, "receipt_url": body.receipt_url,
            "receipt_name": body.receipt_name}


@router.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: str, p: Principal = Depends(require("txn:adjust"))):
    doc = await Scoped("transactions", p).find_one({"id": expense_id})
    if not doc or doc.get("source") != "manual" or doc["kind"] != "expense":
        raise HTTPException(404, "Expense not found")
    from routers.ledger import reverse_txn
    await reverse_txn(p, expense_id, f"expense removed by {p.name}", ("manual",))
    return {"ok": True}
