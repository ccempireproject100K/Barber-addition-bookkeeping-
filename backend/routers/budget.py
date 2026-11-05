"""Budgeting + cash-flow forecasting.

Budgets: per-category, per-month. Variance = budgeted vs actual expense
transactions in the period. Categories with spend but no budget show up with
budgeted = 0 so nothing hides.

Forecast: projected cash over the next 30/60/90 days =
  starting cash (accounts 1000+1010)
  + trailing-90-day average daily inflow/outflow as the baseline
  + scheduled items layered on top: open invoices (AR), open bills,
    recurring expenses, recurring invoices.
Directional, not exact — assumptions are returned with the payload and shown
in the UI.
"""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.bookkeeping import account_balances
from lib.dates import now_iso, today_iso
from lib.money import money
from lib.repo import Scoped

router = APIRouter(prefix="/budget")


def _period(p: str) -> str:
    if len(p) == 7 and p[4] == "-" and p[:4].isdigit() and p[5:].isdigit():
        return p
    raise HTTPException(400, "period must be YYYY-MM")


class BudgetIn(BaseModel):
    period: str
    category: str = Field(min_length=1, max_length=80)
    amount: float = Field(ge=0)


@router.get("")
async def get_budget(period: str = Query(...), p: Principal = Depends(require("budget:read"))):
    """Budget vs actuals for a month. Includes unbudgeted categories that had spend."""
    period = _period(period)
    budgets = {d["category"]: d async for d in Scoped("budgets", p).c.find(
        {"tenant_id": p.tenant_id, "period": period}, {"_id": 0})}
    actual: dict[str, float] = {}
    async for t in Scoped("transactions", p).c.find(
            {"tenant_id": p.tenant_id, "kind": "expense", "date": {"$gte": period + "-01", "$lt": period + "-32"}},
            {"_id": 0, "category": 1, "amount": 1}):
        actual[t["category"]] = actual.get(t["category"], 0) + float(t["amount"])
    rows = []
    for cat in sorted(set(budgets) | set(actual)):
        b = budgets.get(cat, {})
        budgeted = float(b.get("amount", 0))
        spent = money(actual.get(cat, 0))
        rows.append({"id": b.get("id"), "category": cat, "budgeted": budgeted, "actual": spent,
                     "remaining": money(budgeted - spent),
                     "pct_used": round(spent / budgeted * 100, 1) if budgeted else (100.0 if spent else 0.0)})
    spent_total = money(sum(r["actual"] for r in rows))
    budget_total = money(sum(r["budgeted"] for r in rows))
    return {"period": period, "rows": rows,
            "totals": {"budgeted": budget_total, "actual": spent_total, "remaining": money(budget_total - spent_total)}}


@router.get("/categories")
async def budget_categories(p: Principal = Depends(require("budget:read"))):
    """Distinct expense categories from the last 12 months, for the budget form."""
    since = (date.today() - timedelta(days=365)).isoformat()
    cats = await Scoped("transactions", p).c.distinct(
        "category", {"tenant_id": p.tenant_id, "kind": "expense", "date": {"$gte": since}})
    return sorted(c for c in cats if c)


@router.post("")
async def upsert_budget(body: BudgetIn, p: Principal = Depends(require("budget:write"))):
    period = _period(body.period)
    col = Scoped("budgets", p).c
    doc = await col.find_one_and_update(
        {"tenant_id": p.tenant_id, "period": period, "category": body.category},
        {"$set": {"amount": money(body.amount), "updated_at": now_iso()},
         "$setOnInsert": {"id": str(uuid.uuid4()), "period": period, "category": body.category,
                          "created_at": now_iso()}},
        upsert=True, return_document=True, projection={"_id": 0})
    await audit(p, "budget.upsert", "budget", doc["id"], {"period": period, "category": body.category})
    return doc


@router.delete("/{bid}")
async def delete_budget(bid: str, p: Principal = Depends(require("budget:write"))):
    n = await Scoped("budgets", p).delete({"id": bid})
    if not n:
        raise HTTPException(404, "Budget not found")
    await audit(p, "budget.delete", "budget", bid, {})
    return {"ok": True}


class CopyIn(BaseModel):
    from_period: str
    to_period: str


@router.post("/copy")
async def copy_budget(body: CopyIn, p: Principal = Depends(require("budget:write"))):
    src, dst = _period(body.from_period), _period(body.to_period)
    if src == dst:
        raise HTTPException(400, "Pick a different target month")
    col = Scoped("budgets", p).c
    existing = {d["category"] async for d in col.find({"tenant_id": p.tenant_id, "period": dst}, {"_id": 0, "category": 1})}
    n = 0
    async for d in col.find({"tenant_id": p.tenant_id, "period": src}, {"_id": 0}):
        if d["category"] in existing:
            continue
        await col.insert_one({"tenant_id": p.tenant_id, "id": str(uuid.uuid4()), "period": dst,
                              "category": d["category"], "amount": d["amount"], "created_at": now_iso()})
        n += 1
    await audit(p, "budget.copy", "budget", dst, {"from": src, "copied": n})
    return {"ok": True, "copied": n}


# ---------------------------------------------------------------- forecast

def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    last = [31, 29 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 28,
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return date(y, m, min(d.day, last))


@router.get("/forecast")
async def forecast(days: int = Query(90, ge=7, le=365), p: Principal = Depends(require("budget:read"))):
    tz = p.settings.get("timezone")
    today = date.fromisoformat(today_iso(tz))
    end = today + timedelta(days=days)

    bals = await account_balances(p)
    start_cash = money((bals.get("1000", 0) + bals.get("1010", 0)) / 100)

    # trailing-90-day daily averages as the baseline
    win_start = (today - timedelta(days=90)).isoformat()
    inflow = outflow = 0.0
    async for t in Scoped("transactions", p).c.find(
            {"tenant_id": p.tenant_id, "date": {"$gte": win_start, "$lt": today.isoformat()}},
            {"_id": 0, "kind": 1, "amount": 1}):
        if t["kind"] == "income":
            inflow += float(t["amount"])
        elif t["kind"] == "expense":
            outflow += float(t["amount"])
    avg_in, avg_out = money(inflow / 90), money(outflow / 90)

    sched_in: dict[str, float] = {}
    sched_out: dict[str, float] = {}

    def add(bucket: dict[str, float], when: str, amt: float):
        when = max(when, today.isoformat())
        if when <= end.isoformat():
            bucket[when] = bucket.get(when, 0) + amt

    # AR: open invoices land on their due date (overdue → today)
    ar_total = 0.0
    async for inv in Scoped("invoices", p).c.find(
            {"tenant_id": p.tenant_id, "status": {"$nin": ["draft", "void", "paid"]}},
            {"_id": 0, "due_date": 1, "balance_due": 1, "number": 1}):
        bal = float(inv.get("balance_due") or 0)
        if bal > 0:
            ar_total += bal
            add(sched_in, (inv.get("due_date") or today.isoformat()), bal)

    # Open bills go out on their due date
    bills_total = 0.0
    async for b in Scoped("bills", p).c.find(
            {"tenant_id": p.tenant_id, "status": {"$in": ["open", "partial"]}},
            {"_id": 0, "due_date": 1, "balance": 1}):
        bal = float(b.get("balance") or 0)
        if bal > 0:
            bills_total += bal
            add(sched_out, (b.get("due_date") or today.isoformat()), bal)

    # Recurring monthly expenses / invoices
    rec_out = rec_in = 0.0
    async for r in Scoped("recurring", p).c.find(
            {"tenant_id": p.tenant_id, "active": True}, {"_id": 0, "day_of_month": 1, "amount": 1}):
        for n in range(0, 13):
            d = _add_months(today, n)
            when = date(d.year, d.month, min(int(r.get("day_of_month", 1)), 28)).isoformat()
            if today.isoformat() <= when <= end.isoformat():
                amt = float(r["amount"])
                rec_out += amt
                add(sched_out, when, amt)
    async for r in Scoped("recurring_invoices", p).c.find(
            {"tenant_id": p.tenant_id, "active": True}, {"_id": 0, "day_of_month": 1, "lines": 1,
                                                        "discount_amount": 1, "tax_rate": 1, "tip_amount": 1}):
        total = sum(float(l.get("quantity", 0)) * float(l.get("unit_price", 0)) for l in r.get("lines", []))
        total = total - float(r.get("discount_amount", 0)) + float(r.get("tip_amount", 0))
        total = total * (1 + float(r.get("tax_rate", 0)) / 100)
        for n in range(0, 13):
            d = _add_months(today, n)
            when = date(d.year, d.month, min(int(r.get("day_of_month", 1)), 28)).isoformat()
            if today.isoformat() <= when <= end.isoformat():
                rec_in += total
                add(sched_in, when, money(total))

    points = []
    cash = start_cash
    d = today
    min_cash, min_date = cash, today.isoformat()
    while d <= end:
        key = d.isoformat()
        i, o = avg_in + sched_in.get(key, 0), avg_out + sched_out.get(key, 0)
        cash = money(cash + i - o)
        if cash < min_cash:
            min_cash, min_date = cash, key
        points.append({"date": key, "inflow": money(i), "outflow": money(o), "cash": cash})
        d += timedelta(days=1)

    return {
        "start_date": today.isoformat(), "days": days, "start_cash": start_cash,
        "end_cash": cash, "min_cash": min_cash, "min_cash_date": min_date,
        "avg_daily_inflow": avg_in, "avg_daily_outflow": avg_out,
        "scheduled": {"ar": money(ar_total), "bills": money(bills_total),
                      "recurring_inflow": money(rec_in), "recurring_outflow": money(rec_out)},
        "points": points,
        "assumptions": [
            "Baseline inflow/outflow = trailing 90-day daily averages.",
            "Open invoices assumed collected on their due date (overdue → today).",
            "Open bills assumed paid on their due date.",
            "Recurring expenses and invoices assumed on their day-of-month.",
            "Scheduled items layer on top of the baseline — some overlap is expected; treat as directional.",
        ],
    }
