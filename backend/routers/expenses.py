"""Operating expenses + vendors. Expenses post through create_txn (so they auto-book to the journal
as DR expense / CR cash). Inventory purchases are NOT expenses here — they are received via Procurement
/ restock and capitalized to the Inventory asset account."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

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


class ReceiptIn(BaseModel):
    image: str = Field(min_length=10, max_length=8_000_000)  # data URL or base64


@router.post("/expenses/scan-receipt")
async def scan_receipt(body: ReceiptIn, p: Principal = Depends(require("txn:write"))):
    """Read a receipt photo and pre-fill an expense (owner still confirms). Uses the AI add-on."""
    import importlib
    import json
    import os
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        raise HTTPException(503, "Receipt scanning needs the AI add-on. Add an AI key in settings to enable it.")
    try:
        sdk = importlib.import_module("emergentintegrations.llm.chat")
    except ImportError:
        raise HTTPException(503, "AI integration is not installed on this server.")
    b64 = body.image.split(",", 1)[1] if body.image.startswith("data:") else body.image
    prompt = ("Read this expense receipt. Reply with ONLY compact JSON: "
              '{"vendor":string,"date":"YYYY-MM-DD","amount":number,"tax":number,'
              f'"category":one of {EXPENSE_CATEGORIES},"description":string}}. Use the grand total for amount.')
    try:
        chat = sdk.LlmChat(api_key=key, session_id=f"receipt-{p.tenant_id}", system_message="You extract structured data from receipts.").with_model("openai", os.environ.get("AI_MODEL", "gpt-5-mini"))
        msg = sdk.UserMessage(text=prompt, file_contents=[sdk.ImageContent(image_base64=b64)])
        raw = await chat.send_message(msg)
    except Exception as exc:
        raise HTTPException(502, f"Could not read the receipt: {type(exc).__name__}")
    text = raw if isinstance(raw, str) else getattr(raw, "content", str(raw))
    try:
        start, end = text.find("{"), text.rfind("}")
        data = json.loads(text[start:end + 1])
    except (ValueError, json.JSONDecodeError):
        raise HTTPException(502, "Receipt read but could not be parsed — enter it manually.")
    cat = data.get("category")
    return {"vendor": data.get("vendor", ""), "date": data.get("date", ""),
            "amount": data.get("amount", 0), "tax": data.get("tax", 0),
            "category": cat if cat in EXPENSE_CATEGORIES else "Other", "description": data.get("description", "")}
