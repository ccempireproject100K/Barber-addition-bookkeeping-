"""Time tracking: clock in/out, manual entries, timesheets, approvals.

Approved, unbilled entries convert to invoice lines (POST /time/to-invoice) and
are consumable by payroll runs (entries carry payroll_run_id once paid).
Edits are never destructive: the original values stay in the audit log.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso, today_iso
from lib.db import db
from lib.repo import Scoped

router = APIRouter(prefix="/time")

DateStr = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")


class ClockIn(BaseModel):
    client_name: str = Field(default="", max_length=160)
    note: str = Field(default="", max_length=300)


class TimeEntryIn(BaseModel):
    user_id: str = Field(default="", max_length=80)  # default: self; managers may log for others
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    hours: float = Field(gt=0, le=24)
    client_name: str = Field(default="", max_length=160)
    note: str = Field(default="", max_length=300)
    billable: bool = True


class TimeEntryUp(BaseModel):
    date: str | None = Field(default=None, pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    hours: float | None = Field(default=None, gt=0, le=24)
    client_name: str | None = Field(default=None, max_length=160)
    note: str | None = Field(default=None, max_length=300)
    billable: bool | None = None


class ToInvoiceIn(BaseModel):
    entry_ids: list[str] = Field(min_length=1, max_length=200)
    client_name: str = Field(min_length=1, max_length=160)
    rate: float = Field(gt=0)  # hourly rate
    date: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")


def _entry_out(d: dict) -> dict:
    return {k: d.get(k) for k in ("id", "user_id", "user_name", "date", "clock_in", "clock_out",
                                 "hours", "client_name", "note", "billable", "status",
                                 "invoice_id", "approved_by", "approved_at", "created_at")}


async def _resolve_user(p: Principal, user_id: str) -> dict:
    """Who is this entry for? Defaults to the caller; managers may pick staff."""
    if user_id and user_id != p.user_id:
        if p.role not in ("admin", "bookkeeper", "accountant"):
            raise HTTPException(403, "Only managers can log time for others")
        u = await db.users.find_one({"tenant_id": p.tenant_id, "id": user_id}, {"_id": 0, "id": 1, "name": 1})
        if not u:
            raise HTTPException(404, "Team member not found")
        return {"user_id": u["id"], "user_name": u["name"]}
    return {"user_id": p.user_id, "user_name": p.name}


@router.post("/clock-in")
async def clock_in(body: ClockIn, p: Principal = Depends(require("time:write"))):
    entries = Scoped("time_entries", p)
    if await entries.find_one({"user_id": p.user_id, "status": "open"}):
        raise HTTPException(409, "Already clocked in")
    now = datetime.now(timezone.utc)
    doc = {"id": str(uuid.uuid4()), "tenant_id": p.tenant_id, "user_id": p.user_id, "user_name": p.name,
           "date": today_iso(p.settings.get("timezone")), "clock_in": now.isoformat(), "clock_out": None,
           "hours": 0.0, "client_name": body.client_name, "note": body.note, "billable": True,
           "status": "open", "invoice_id": None, "payroll_run_id": None,
           "approved_by": None, "approved_at": None, "created_at": now_iso()}
    await entries.insert(dict(doc))
    await audit(p, "time.clock_in", "time_entry", doc["id"], {"client": body.client_name})
    return _entry_out(doc)


@router.post("/clock-out")
async def clock_out(p: Principal = Depends(require("time:write"))):
    entries = Scoped("time_entries", p)
    doc = await entries.find_one({"user_id": p.user_id, "status": "open"})
    if not doc:
        raise HTTPException(404, "Not clocked in")
    out = datetime.now(timezone.utc)
    inn = datetime.fromisoformat(doc["clock_in"])
    hours = round((out - inn).total_seconds() / 3600, 2)
    await entries.update({"id": doc["id"]}, {"$set": {"clock_out": out.isoformat(), "hours": hours, "status": "logged"}})
    await audit(p, "time.clock_out", "time_entry", doc["id"], {"hours": hours})
    doc.update(clock_out=out.isoformat(), hours=hours, status="logged")
    return _entry_out(doc)


@router.get("/entries")
async def list_entries(user_id: str = "", date_from: str = "", date_to: str = "",
                       p: Principal = Depends(require("time:read"))):
    f: dict = {}
    if p.role not in ("admin", "bookkeeper", "accountant"):
        f["user_id"] = p.user_id
    elif user_id:
        f["user_id"] = user_id
    if date_from:
        f["date"] = {**f.get("date", {}), "$gte": date_from}
    if date_to:
        f["date"] = {**f.get("date", {}), "$lte": date_to}
    docs = await Scoped("time_entries", p).find(f, sort=[("date", -1), ("created_at", -1)]).to_list(2000)
    return [_entry_out(d) for d in docs]


@router.post("/entries")
async def create_entry(body: TimeEntryIn, p: Principal = Depends(require("time:write"))):
    who = await _resolve_user(p, body.user_id)
    doc = {"id": str(uuid.uuid4()), "tenant_id": p.tenant_id, **who,
           "date": body.date, "clock_in": None, "clock_out": None, "hours": round(body.hours, 2),
           "client_name": body.client_name, "note": body.note, "billable": body.billable,
           "status": "logged", "invoice_id": None, "payroll_run_id": None,
           "approved_by": None, "approved_at": None, "created_at": now_iso()}
    await Scoped("time_entries", p).insert(dict(doc))
    await audit(p, "time.create", "time_entry", doc["id"], {"hours": doc["hours"], "for": who["user_name"]})
    return _entry_out(doc)


@router.put("/entries/{entry_id}")
async def edit_entry(entry_id: str, body: TimeEntryUp, p: Principal = Depends(require("time:write"))):
    entries = Scoped("time_entries", p)
    doc = await entries.find_one({"id": entry_id})
    if not doc:
        raise HTTPException(404, "Entry not found")
    if p.role not in ("admin", "bookkeeper", "accountant") and doc["user_id"] != p.user_id:
        raise HTTPException(403, "You can only edit your own entries")
    if doc["status"] in ("billed", "void"):
        raise HTTPException(409, f"Cannot edit a {doc['status']} entry")
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(400, "Nothing to update")
    before = {k: doc.get(k) for k in patch}
    await entries.update({"id": entry_id}, {"$set": {**patch, "edited": True}})
    await audit(p, "time.edit", "time_entry", entry_id, {"before": before, "after": patch})
    doc.update(patch)
    return _entry_out(doc)


@router.delete("/entries/{entry_id}")
async def void_entry(entry_id: str, p: Principal = Depends(require("time:write"))):
    entries = Scoped("time_entries", p)
    doc = await entries.find_one({"id": entry_id})
    if not doc:
        raise HTTPException(404, "Entry not found")
    if p.role not in ("admin", "bookkeeper", "accountant") and doc["user_id"] != p.user_id:
        raise HTTPException(403, "You can only void your own entries")
    await entries.update({"id": entry_id}, {"$set": {"status": "void"}})
    await audit(p, "time.void", "time_entry", entry_id, {})
    return {"ok": True}


@router.post("/entries/{entry_id}/approve")
async def approve_entry(entry_id: str, p: Principal = Depends(require("time:approve"))):
    entries = Scoped("time_entries", p)
    doc = await entries.find_one({"id": entry_id})
    if not doc:
        raise HTTPException(404, "Entry not found")
    if doc["status"] != "logged":
        raise HTTPException(409, f"Only logged entries can be approved (is {doc['status']})")
    await entries.update({"id": entry_id}, {"$set": {"status": "approved", "approved_by": p.name, "approved_at": now_iso()}})
    await audit(p, "time.approve", "time_entry", entry_id, {})
    return {"ok": True}


@router.get("/summary")
async def summary(date_from: str = "", date_to: str = "", p: Principal = Depends(require("time:read"))):
    f: dict = {"status": {"$ne": "void"}}
    if p.role not in ("admin", "bookkeeper", "accountant"):
        f["user_id"] = p.user_id
    if date_from:
        f["date"] = {**f.get("date", {}), "$gte": date_from}
    if date_to:
        f["date"] = {**f.get("date", {}), "$lte": date_to}
    docs = await Scoped("time_entries", p).find(f).to_list(5000)
    by_staff: dict = {}
    by_client: dict = {}
    total = unbilled = 0.0
    for d in docs:
        h = float(d.get("hours") or 0)
        total += h
        if d.get("billable") and not d.get("invoice_id"):
            unbilled += h
        s = by_staff.setdefault(d.get("user_name") or "?", {"hours": 0.0, "billable": 0.0})
        s["hours"] += h
        if d.get("billable"):
            s["billable"] += h
        c = (d.get("client_name") or "Unassigned").strip() or "Unassigned"
        by_client[c] = by_client.get(c, 0.0) + h
    return {"total_hours": round(total, 2), "unbilled_hours": round(unbilled, 2),
            "by_staff": [{"name": k, **{kk: round(vv, 2) for kk, vv in v.items()}} for k, v in by_staff.items()],
            "by_client": [{"client": k, "hours": round(v, 2)} for k, v in sorted(by_client.items(), key=lambda x: -x[1])]}


@router.post("/to-invoice")
async def entries_to_invoice(body: ToInvoiceIn, p: Principal = Depends(require("invoice:write"))):
    """Create a draft invoice from approved, unbilled time entries."""
    from routers.money import create_invoice
    from models.money import InvoiceIn, InvoiceLineIn
    entries = Scoped("time_entries", p)
    docs = await entries.find({"id": {"$in": body.entry_ids}}).to_list(500)
    if len(docs) != len(body.entry_ids):
        raise HTTPException(404, "Some entries were not found")
    bad = [d for d in docs if d.get("status") != "approved" or d.get("invoice_id")]
    if bad:
        raise HTTPException(409, "Only approved, unbilled entries can be invoiced")
    clients = {d.get("client_name") for d in docs}
    if len(clients) > 1:
        raise HTTPException(400, "All entries must be for the same client")
    lines = [InvoiceLineIn(description=f"{d['date']} · {d['user_name']}" + (f" — {d['note']}" if d.get("note") else ""),
                           quantity=round(float(d["hours"]), 2), unit_price=round(body.rate, 2), kind="service")
             for d in docs]
    inv = await create_invoice(InvoiceIn(client_name=body.client_name,
                                        date=body.date or today_iso(p.settings.get("timezone")),
                                        lines=lines, notes="Billed time"), p)
    await entries.update_many({"id": {"$in": body.entry_ids}},
                              {"$set": {"status": "billed", "invoice_id": inv.id}})
    await audit(p, "time.to_invoice", "invoice", inv.id, {"entries": len(docs), "hours": sum(float(d["hours"]) for d in docs)})
    return {"invoice_id": inv.id, "number": inv.number, "entries": len(docs)}
