"""Payroll-lite: pay schedules, gross-to-net pay runs, printable stubs, journal posting.

EXPLICIT SCOPE LIMITS (also shown in the UI):
- This is NOT tax filing and NOT direct deposit. Deduction lines labeled
  "withholding" are planning estimates, not filed taxes.
- For compliant payroll (actual withholding, IRS/state filing, direct
  deposit), use a payroll provider. The Payroll page has a stub card for a
  future Gusto / Check partnership.
"""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.bookkeeping import post_entry
from lib.dates import now_iso
from lib.money import money
from lib.repo import Scoped

router = APIRouter(prefix="/payroll")

DISCLAIMER = (
    "Payroll-lite computes pay estimates only. It does not withhold or file taxes, "
    "and it does not run direct deposit. Use a payroll provider (e.g. Gusto, Check) "
    "for compliant tax filing and payments."
)


def _gross(item: dict) -> float:
    if item.get("pay_type") == "salary":
        return money(item.get("amount", 0))
    return money(float(item.get("hours", 0)) * float(item.get("rate", 0)))


def _deductions(item: dict) -> list[dict]:
    gross = _gross(item)
    out = []
    for d in item.get("deductions", []) or []:
        amt = money(gross * float(d.get("value", 0)) / 100) if d.get("kind") == "percent" else money(d.get("value", 0))
        out.append({"label": d.get("label", "Deduction"), "kind": d.get("kind", "amount"), "value": d.get("value", 0), "amount": amt})
    return out


def _net(item: dict) -> float:
    return money(_gross(item) - sum(d["amount"] for d in _deductions(item)))


def _totals(items: list[dict]) -> dict:
    g = money(sum(_gross(i) for i in items))
    d = money(sum(sum(x["amount"] for x in _deductions(i)) for i in items))
    return {"gross": g, "deductions": d, "net": money(g - d)}


# ---------------------------------------------------------------- schedules

class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    frequency: str = Field(pattern=r"^(weekly|biweekly|semimonthly|monthly)$")
    next_run_date: str
    active: bool = True


@router.get("/schedules")
async def list_schedules(p: Principal = Depends(require("payroll:read"))):
    return await Scoped("pay_schedules", p).find().sort("name", 1)


@router.post("/schedules")
async def create_schedule(body: ScheduleIn, p: Principal = Depends(require("payroll:write"))):
    doc = {"id": str(uuid.uuid4()), **body.model_dump(), "created_at": now_iso()}
    await Scoped("pay_schedules", p).insert(doc)
    await audit(p, "payroll.schedule.create", "pay_schedule", doc["id"], {"name": doc["name"]})
    return doc


@router.put("/schedules/{sid}")
async def update_schedule(sid: str, body: ScheduleIn, p: Principal = Depends(require("payroll:write"))):
    doc = await Scoped("pay_schedules", p).update({"id": sid}, {"$set": body.model_dump()})
    if not doc:
        raise HTTPException(404, "Schedule not found")
    return doc


@router.delete("/schedules/{sid}")
async def delete_schedule(sid: str, p: Principal = Depends(require("payroll:write"))):
    n = await Scoped("pay_schedules", p).delete({"id": sid})
    if not n:
        raise HTTPException(404, "Schedule not found")
    await audit(p, "payroll.schedule.delete", "pay_schedule", sid, {})
    return {"ok": True}


# ---------------------------------------------------------------- runs

class DeductionIn(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    kind: str = Field(pattern=r"^(percent|amount)$")
    value: float = Field(ge=0)


class RunItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    user_id: str | None = None
    pay_type: str = Field(pattern=r"^(hourly|salary)$")
    hours: float = Field(default=0, ge=0)
    rate: float = Field(default=0, ge=0)
    amount: float = Field(default=0, ge=0)
    deductions: list[DeductionIn] = []
    time_entry_ids: list[str] = []


class RunIn(BaseModel):
    schedule_id: str | None = None
    period_start: str
    period_end: str
    notes: str = Field(default="", max_length=500)
    items: list[RunItemIn] = Field(min_length=1)


async def _consume_time_entries(p: Principal, run_id: str, entry_ids: list[str]) -> None:
    """Mark approved, unconsumed time entries as consumed by this run (all-or-nothing)."""
    ids = list(dict.fromkeys(entry_ids))
    if not ids:
        return
    col = Scoped("time_entries", p).c
    ok = await col.count_documents({"tenant_id": p.tenant_id, "id": {"$in": ids},
                                    "status": "approved", "payroll_run_id": None})
    if ok != len(ids):
        raise HTTPException(400, "Time entries must be approved and not already in a pay run")
    await col.update_many({"tenant_id": p.tenant_id, "id": {"$in": ids}},
                          {"$set": {"payroll_run_id": run_id}})


@router.get("/runs")
async def list_runs(p: Principal = Depends(require("payroll:read"))):
    return await Scoped("payroll_runs", p).find().sort("created_at", -1)


@router.post("/runs")
async def create_run(body: RunIn, p: Principal = Depends(require("payroll:write"))):
    run_id = str(uuid.uuid4())
    entry_ids = [eid for it in body.items for eid in it.time_entry_ids]
    await _consume_time_entries(p, run_id, entry_ids)
    items: list[dict[str, Any]] = []
    for it in body.items:
        d = it.model_dump()
        d.update({"gross": _gross(d), "deductions": _deductions(d)})
        d["net"] = money(d["gross"] - sum(x["amount"] for x in d["deductions"]))
        items.append(d)
    doc = {"id": run_id, "schedule_id": body.schedule_id, "period_start": body.period_start,
           "period_end": body.period_end, "notes": body.notes, "items": items,
           "totals": _totals(items), "status": "draft", "disclaimer": DISCLAIMER,
           "created_by": p.name, "created_at": now_iso()}
    await Scoped("payroll_runs", p).insert(doc)
    await audit(p, "payroll.run.create", "payroll_run", run_id, {"net": doc["totals"]["net"]})
    return doc


@router.get("/runs/{rid}")
async def get_run(rid: str, p: Principal = Depends(require("payroll:read"))):
    doc = await Scoped("payroll_runs", p).find_one({"id": rid})
    if not doc:
        raise HTTPException(404, "Pay run not found")
    return doc


@router.post("/runs/{rid}/approve")
async def approve_run(rid: str, p: Principal = Depends(require("payroll:write"))):
    doc = await Scoped("payroll_runs", p).find_one({"id": rid})
    if not doc:
        raise HTTPException(404, "Pay run not found")
    if doc["status"] != "draft":
        raise HTTPException(400, f"Run is {doc['status']}")
    doc = await Scoped("payroll_runs", p).update(
        {"id": rid}, {"$set": {"status": "approved", "approved_by": p.name, "approved_at": now_iso()}})
    await audit(p, "payroll.run.approve", "payroll_run", rid, {"net": doc["totals"]["net"]})
    return doc


@router.post("/runs/{rid}/post")
async def post_run(rid: str, p: Principal = Depends(require("payroll:write"))):
    """Post the payroll journal entry: Dr 6110 wages, Cr 2120 deductions payable, Cr 1010 bank (net)."""
    doc = await Scoped("payroll_runs", p).find_one({"id": rid})
    if not doc:
        raise HTTPException(404, "Pay run not found")
    if doc["status"] != "approved":
        raise HTTPException(400, "Approve the run before posting")
    t = doc["totals"]
    entry = await post_entry(
        p, doc["period_end"], f"Payroll {doc['period_start']}–{doc['period_end']}",
        [("6110", t["gross"]), ("2120", -t["deductions"]), ("1010", -t["net"])],
        source="payroll", ref=f"payroll:{rid}")
    doc = await Scoped("payroll_runs", p).update(
        {"id": rid}, {"$set": {"status": "posted", "journal_entry_id": (entry or {}).get("id"),
                               "posted_by": p.name, "posted_at": now_iso()}})
    await audit(p, "payroll.run.post", "payroll_run", rid, {"journal": (entry or {}).get("id")})
    return doc


@router.delete("/runs/{rid}")
async def delete_run(rid: str, p: Principal = Depends(require("payroll:write"))):
    doc = await Scoped("payroll_runs", p).find_one({"id": rid})
    if not doc:
        raise HTTPException(404, "Pay run not found")
    if doc["status"] != "draft":
        raise HTTPException(400, "Only draft runs can be deleted")
    # release consumed time entries
    await Scoped("time_entries", p).c.update_many(
        {"tenant_id": p.tenant_id, "payroll_run_id": rid}, {"$set": {"payroll_run_id": None}})
    await Scoped("payroll_runs", p).delete({"id": rid})
    await audit(p, "payroll.run.delete", "payroll_run", rid, {})
    return {"ok": True}
