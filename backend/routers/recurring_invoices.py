"""Recurring invoice drafts: monthly templates that auto-create DRAFT invoices (never
auto-issued — the owner reviews and issues them). Uses the same validation, numbering and
line logic as manual invoice creation, and rides the existing platform cron."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, principal_for_user, require
from lib.dates import now_iso, today_iso
from lib.db import db
from lib.repo import Scoped
from models.money import Invoice, InvoiceIn, InvoiceLineIn
from routers.money import build_invoice_doc

router = APIRouter()


class RecurringInvoiceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    client_name: str = Field(min_length=1, max_length=160)
    lines: list[InvoiceLineIn] = Field(min_length=1, max_length=50)
    discount_amount: float = Field(default=0, ge=0)
    tax_rate: float = Field(default=0, ge=0, le=100)
    tip_amount: float = Field(default=0, ge=0)
    day_of_month: int = Field(default=1, ge=1, le=28)
    active: bool = True
    notes: str = Field(default="", max_length=1000)


class RecurringInvoice(RecurringInvoiceIn):
    id: str
    last_run: str | None = None
    created_at: str


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "tenant_id"}


async def _draft_from_template(p: Principal, t: dict, day: str) -> dict:
    """Create a DRAFT invoice from a template. Drafts never touch the journal until issued."""
    body = InvoiceIn(client_name=t["client_name"], date=day, due_date=None,
                     lines=[InvoiceLineIn(**l) for l in t["lines"]],
                     discount_amount=t.get("discount_amount", 0), tax_rate=t.get("tax_rate", 0),
                     tip_amount=t.get("tip_amount", 0), notes=t.get("notes", ""))
    doc = await build_invoice_doc(p, body)
    await Scoped("invoices", p).insert(doc)
    await audit(p, "recurring_invoice.draft", "invoice", doc["id"],
                {"number": doc["number"], "total": doc["total"], "template": t["name"]})
    return doc


@router.get("/recurring-invoices", response_model=list[RecurringInvoice])
async def list_recurring_invoices(p: Principal = Depends(require("invoice:read"))):
    return [RecurringInvoice(**_strip(d)) for d in await Scoped("recurring_invoices", p).find({}, sort=[("name", 1)])]


@router.post("/recurring-invoices", response_model=RecurringInvoice)
async def create_recurring_invoice(body: RecurringInvoiceIn, p: Principal = Depends(require("invoice:write"))):
    doc = {"id": str(uuid.uuid4()), **body.model_dump(), "last_run": None, "created_at": now_iso()}
    await Scoped("recurring_invoices", p).insert(doc)
    await audit(p, "recurring_invoice.create", "recurring_invoice", doc["id"], {"name": body.name})
    return RecurringInvoice(**_strip(doc))


@router.delete("/recurring-invoices/{rid}")
async def delete_recurring_invoice(rid: str, p: Principal = Depends(require("invoice:write"))):
    if not await Scoped("recurring_invoices", p).delete({"id": rid}):
        raise HTTPException(404, "Not found")
    return {"ok": True}


@router.post("/recurring-invoices/{rid}/run")
async def run_recurring_invoice_now(rid: str, p: Principal = Depends(require("invoice:write"))):
    t = await Scoped("recurring_invoices", p).find_one({"id": rid})
    if not t:
        raise HTTPException(404, "Not found")
    day = today_iso(p.settings.get("timezone"))
    doc = await _draft_from_template(p, t, day)
    await Scoped("recurring_invoices", p).update({"id": rid}, {"$set": {"last_run": day[:7]}})
    return {"ok": True, "invoice_id": doc["id"], "number": doc["number"]}


async def post_due_templates() -> int:
    """Create draft invoices for every active template whose day has arrived and that
    hasn't run this month. Called by the platform cron (same run as recurring expenses)."""
    posted = 0
    today = today_iso("UTC")
    this_month, dom = today[:7], int(today[8:10])
    async for t in db.recurring_invoices.find({"active": True, "day_of_month": {"$lte": dom}, "last_run": {"$ne": this_month}}):
        user = await db.users.find_one({"tenant_id": t["tenant_id"], "role": "admin"}, {"_id": 0}, sort=[("created_at", 1)])
        p = await principal_for_user(user) if user else None
        if not p:
            continue
        try:
            day = today_iso(p.settings.get("timezone"))
            await _draft_from_template(p, t, day)
            await db.recurring_invoices.update_one({"tenant_id": t["tenant_id"], "id": t["id"]}, {"$set": {"last_run": day[:7]}})
            posted += 1
        except Exception:
            continue
    return posted
