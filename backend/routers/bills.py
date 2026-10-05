"""Vendor bills / Accounts Payable. A bill records an amount owed to a vendor (DR expense or
DR Inventory for stock purchases, CR Accounts Payable). Paying it later: DR A/P, CR cash/bank.
This lets purchasing be on terms instead of assuming every purchase is paid immediately in cash."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.bookkeeping import MONEY_ACCT, account_balances, assert_open, expense_account, post_entry, _f
from lib.dates import now_iso, today_iso
from lib.money import D, money
from lib.repo import Scoped

router = APIRouter()
DateStr = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class BillIn(BaseModel):
    vendor_id: str | None = None
    date: str = DateStr
    due_date: str | None = None
    category: str = Field(min_length=1, max_length=80)
    amount: float = Field(gt=0)
    is_inventory: bool = False
    description: str = Field(default="", max_length=300)


class BillPayIn(BaseModel):
    amount: float = Field(gt=0)
    method: str = "bank"
    date: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "tenant_id"}


@router.get("/bills")
async def list_bills(status: str = "", p: Principal = Depends(require("txn:read"))):
    f = {"status": status} if status else {}
    return [_strip(d) for d in await Scoped("bills", p).find(f, sort=[("created_at", -1)])]


@router.get("/bills/ap-summary")
async def ap_summary(p: Principal = Depends(require("report:read"))):
    allb = await account_balances(p, end=today_iso(p.settings.get("timezone")))
    open_bills = await Scoped("bills", p).find({"status": {"$in": ["open", "partial"]}})
    return {"accounts_payable": _f(-allb.get("2000", 0)), "open_bills": len(open_bills),
            "open_balance": money(sum(D(b.get("balance", 0)) for b in open_bills))}


@router.post("/bills")
async def create_bill(body: BillIn, p: Principal = Depends(require("txn:write"))):
    await assert_open(p, body.date)
    vendor_name = None
    if body.vendor_id:
        v = await Scoped("vendors", p).find_one({"id": body.vendor_id})
        if not v:
            raise HTTPException(404, "Vendor not found")
        vendor_name = v["name"]
    amount = money(body.amount)
    debit_acct = "1200" if body.is_inventory else expense_account(body.category, False)
    bill = {"id": str(uuid.uuid4()), "vendor_id": body.vendor_id, "vendor_name": vendor_name, "date": body.date,
            "due_date": body.due_date, "category": body.category, "amount": amount, "amount_paid": 0,
            "balance": amount, "is_inventory": body.is_inventory, "description": body.description,
            "status": "open", "payments": [], "created_at": now_iso()}
    await post_entry(p, body.date, f"Bill · {vendor_name or body.category} — {body.description}".strip(" —"),
                     [(debit_acct, amount), ("2000", -amount)], source="bill", ref=f"bill:{bill['id']}:issue")
    await Scoped("bills", p).insert(bill)
    await audit(p, "bill.create", "bill", bill["id"], {"amount": amount, "vendor": vendor_name})
    return _strip(bill)


@router.post("/bills/{bill_id}/pay")
async def pay_bill(bill_id: str, body: BillPayIn, p: Principal = Depends(require("txn:write"))):
    bills = Scoped("bills", p)
    bill = await bills.find_one({"id": bill_id})
    if not bill:
        raise HTTPException(404, "Bill not found")
    d = body.date or today_iso(p.settings.get("timezone"))
    await assert_open(p, d)
    amount = money(body.amount)
    if amount > money(D(bill["balance"]) + D("0.005")):
        raise HTTPException(400, f"Payment {amount} exceeds balance {bill['balance']}")
    pid = str(uuid.uuid4())
    acct = MONEY_ACCT.get(body.method, "1010")
    await post_entry(p, d, f"Bill payment · {bill.get('vendor_name') or bill['category']}",
                     [("2000", amount), (acct, -amount)], source="bill", ref=f"bill:{bill_id}:pay:{pid}")
    paid = money(D(bill["amount_paid"]) + D(amount))
    balance = money(D(bill["amount"]) - D(paid))
    status = "paid" if balance <= 0.005 else "partial"
    payment = {"id": pid, "date": d, "amount": amount, "method": body.method, "created_at": now_iso()}
    updated = await bills.update({"id": bill_id}, {"$set": {"amount_paid": paid, "balance": balance, "status": status}, "$push": {"payments": payment}})
    await audit(p, "bill.pay", "bill", bill_id, {"amount": amount})
    return _strip(updated)
