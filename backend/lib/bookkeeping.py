"""Double-entry bookkeeping engine.

A single balanced journal is the authoritative accounting record. Business events post entries
through post_entry() (debits == credits, integer cents) with a unique `ref` for exactly-once posting.
Posted entries are immutable; corrections are reversals (reverse_entry), never edits.

Wiring (choke points):
  * lib.money.create_txn  -> mirror_txn()  : manual + inventory (QuickSell/restock/return) cash events
  * lib.stock.post_movement -> mirror_cogs(): cost of goods sold / supplies used on stock outflows
  * routers.money invoices -> post issue (accrual AR) + payment (cash vs AR) entries directly
"""

import uuid
from decimal import ROUND_HALF_UP, Decimal

from pymongo.errors import DuplicateKeyError

from lib.auth import Principal
from lib.dates import now_iso
from lib.db import db

CENT = Decimal("0.01")

# code, name, type, normal-balance
CHART: list[tuple[str, str, str, str]] = [
    ("1000", "Cash", "asset", "debit"),
    ("1010", "Bank", "asset", "debit"),
    ("1100", "Accounts Receivable", "asset", "debit"),
    ("1200", "Inventory", "asset", "debit"),
    ("2000", "Accounts Payable", "liability", "credit"),
    ("2100", "Sales Tax Payable", "liability", "credit"),
    ("2200", "Tips Payable", "liability", "credit"),
    ("3000", "Owner's Equity", "equity", "credit"),
    ("3900", "Opening Balance Equity", "equity", "credit"),
    ("4000", "Service Revenue", "income", "credit"),
    ("4010", "Product Revenue", "income", "credit"),
    ("4090", "Other Income", "income", "credit"),
    ("4900", "Discounts Given", "income", "debit"),       # contra-revenue
    ("4910", "Refunds & Returns", "income", "debit"),      # contra-revenue
    ("5000", "Cost of Goods Sold", "expense", "debit"),
    ("5010", "Supplies Used", "expense", "debit"),
    ("6000", "Operating Expenses", "expense", "debit"),
    ("6100", "Rent", "expense", "debit"),
    ("6200", "Payment Processing Fees", "expense", "debit"),
    ("6300", "Chair / Booth Rent", "expense", "debit"),
]
ACCOUNT_NAME = {c: n for c, n, _, _ in CHART}
ACCOUNT_TYPE = {c: t for c, _, t, _ in CHART}
ACCOUNT_NORMAL = {c: nb for c, _, _, nb in CHART}

MONEY_ACCT = {"cash": "1000", "card": "1010", "bank": "1010", "other": "1000"}
INCOME_ACCT = {"Services": "4000", "Retail sales": "4010"}


def _c(x) -> int:
    """float/str/Decimal money -> integer cents (half-up)."""
    return int((Decimal(str(x or 0)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _f(cents: int) -> float:
    return float((Decimal(cents) / 100).quantize(CENT, rounding=ROUND_HALF_UP))


def income_account(category: str) -> str:
    return INCOME_ACCT.get(category, "4090")


def expense_account(category: str, capitalized: bool) -> str:
    if capitalized:
        return "1200"  # inventory purchase is an asset, not an expense
    c = (category or "").lower()
    if "refund" in c:
        return "4910"
    if "processing" in c or "card fee" in c or "bank" in c:
        return "6200"
    if "chair" in c or "booth" in c:
        return "6300"
    if "rent" in c:
        return "6100"
    return "6000"


async def ensure_accounts(p: Principal) -> None:
    """Idempotently seed the default chart of accounts for the workspace."""
    existing = {d["code"] for d in await db.accounts.find({"tenant_id": p.tenant_id}, {"_id": 0, "code": 1}).to_list(500)}
    missing = [{"tenant_id": p.tenant_id, "code": c, "name": n, "type": t, "normal": nb, "is_system": True, "active": True}
               for c, n, t, nb in CHART if c not in existing]
    if missing:
        await db.accounts.insert_many(missing)


async def account_name(p: Principal, code: str) -> str:
    if code in ACCOUNT_NAME:
        return ACCOUNT_NAME[code]
    doc = await db.accounts.find_one({"tenant_id": p.tenant_id, "code": code}, {"_id": 0, "name": 1})
    return doc["name"] if doc else code


async def post_entry(p: Principal, date: str, memo: str, signed: list[tuple[str, float]], *,
                     source: str, ref: str, entry_id: str | None = None, reversal_of: str | None = None) -> dict | None:
    """Post ONE balanced journal entry. `signed` = [(account, signed_amount)] where +=debit, -=credit.

    Idempotent on (tenant_id, ref): a duplicate ref returns the existing entry and posts nothing.
    Returns the stored entry dict (without tenant_id), or None if every line nets to zero.
    """
    lines = []
    tot_d = tot_c = 0
    for acct, amt in signed:
        cents = _c(amt)
        if cents == 0:
            continue
        debit = cents if cents > 0 else 0
        credit = -cents if cents < 0 else 0
        tot_d += debit
        tot_c += credit
        lines.append({"account": acct, "account_name": await account_name(p, acct),
                      "debit_cents": debit, "credit_cents": credit, "memo": ""})
    if not lines:
        return None
    if tot_d != tot_c:
        raise ValueError(f"unbalanced journal entry {ref}: debit {tot_d} != credit {tot_c}")
    doc = {
        "id": entry_id or str(uuid.uuid4()), "tenant_id": p.tenant_id, "date": date, "memo": memo,
        "source": source, "ref": ref, "lines": lines, "total_cents": tot_d,
        "reversal_of": reversal_of, "reversed_by": None,
        "created_by": p.user_id, "created_by_name": p.name, "created_at": now_iso(),
    }
    try:
        await db.journal_entries.insert_one(dict(doc))
    except DuplicateKeyError:
        return await db.journal_entries.find_one({"tenant_id": p.tenant_id, "ref": ref}, {"_id": 0})
    doc.pop("_id", None)
    doc.pop("tenant_id", None)
    return doc


async def reverse_entry(p: Principal, entry_id: str, reason: str, source: str = "reversal") -> dict:
    from fastapi import HTTPException
    orig = await db.journal_entries.find_one({"tenant_id": p.tenant_id, "id": entry_id}, {"_id": 0})
    if not orig:
        raise HTTPException(404, "Journal entry not found")
    if orig.get("reversal_of"):
        raise HTTPException(400, "This entry is itself a reversal")
    claimed = await db.journal_entries.find_one_and_update(
        {"tenant_id": p.tenant_id, "id": entry_id, "reversed_by": None}, {"$set": {"reversed_by": "pending"}})
    if not claimed:
        raise HTTPException(409, "This entry was already reversed")
    rev_id = str(uuid.uuid4())
    signed = [(ln["account"], _f(ln["credit_cents"] - ln["debit_cents"])) for ln in orig["lines"]]
    out = await post_entry(p, orig["date"], f"Reversal: {orig['memo']} — {reason}", signed,
                           source=source, ref=f"rev:{entry_id}", entry_id=rev_id, reversal_of=entry_id)
    await db.journal_entries.update_one({"tenant_id": p.tenant_id, "id": entry_id}, {"$set": {"reversed_by": rev_id}})
    return out


# ---------- Event mirrors ----------
async def mirror_txn(p: Principal, txn: dict) -> None:
    """Mirror a cash transaction (manual / inventory source) as a double-entry journal entry.
    Invoice-sourced transactions are skipped — invoices post their own richer AR/tax/tip entries."""
    if txn.get("source") == "invoice":
        return
    amt = txn["amount"]
    money_acct = MONEY_ACCT.get(txn.get("payment_method") or "other", "1000")
    if txn["kind"] == "income":
        signed = [(money_acct, amt), (income_account(txn["category"]), -amt)]
    else:
        exp = expense_account(txn["category"], txn.get("capitalized", False))
        signed = [(exp, amt), (money_acct, -amt)]
    memo = f"{txn['category']} · {txn.get('description') or ''}".strip(" ·")
    try:
        await post_entry(p, txn["date"], memo or txn["category"], signed, source=f"txn:{txn['source']}", ref=f"txn:{txn['id']}")
    except ValueError:
        pass


async def mirror_cogs(p: Principal, mv: dict) -> None:
    """Post COGS / supplies-used for a stock outflow (or reverse it for a return)."""
    cogs = mv.get("cogs") or 0
    if not cogs:
        return
    acct = "5010" if mv.get("type") == "use" else "5000"
    signed = [(acct, cogs), ("1200", -cogs)]  # cogs>0: DR expense CR inventory; return (cogs<0) reverses
    memo = f"COGS · {mv.get('product_name', '')}".strip(" ·")
    try:
        await post_entry(p, mv["created_at"][:10], memo, signed, source="cogs", ref=f"mv:{mv['id']}:cogs")
    except ValueError:
        pass


async def account_balances(p: Principal, end: str = "", start: str = "") -> dict[str, int]:
    """Net balance (debit-credit, in cents) per account code over an optional date window."""
    f: dict = {"tenant_id": p.tenant_id}
    if start or end:
        f["date"] = {**({"$gte": start} if start else {}), **({"$lte": end} if end else {})}
    bal: dict[str, int] = {}
    async for e in db.journal_entries.find(f, {"_id": 0, "lines": 1}):
        for ln in e["lines"]:
            bal[ln["account"]] = bal.get(ln["account"], 0) + ln["debit_cents"] - ln["credit_cents"]
    return bal


async def closed_through(p: Principal) -> str | None:
    doc = await db.book_closes.find_one({"tenant_id": p.tenant_id}, {"_id": 0, "through": 1})
    return doc["through"] if doc else None


async def assert_open(p: Principal, date: str) -> None:
    from fastapi import HTTPException
    through = await closed_through(p)
    if through and date <= through:
        raise HTTPException(400, f"The books are closed through {through}. Reopen the period or use a later date.")


async def mirror_inventory_inflow(p: Principal, mv: dict) -> None:
    """Book the inventory asset for stock INFLOWS that have no paid-purchase transaction behind them
    (opening stock, restock with record_expense=false, positive count adjustments). Paid restocks
    instead ride the capitalized expense txn (mirror_txn DR 1200 / CR cash), so those are skipped here
    via the linked_transaction_id guard in post_movement. Contra = Opening Balance Equity (3900)."""
    amount = abs(mv.get("quantity") or 0) * (mv.get("unit_cost") or 0)
    if not amount:
        return
    memo = f"Stock received · {mv.get('product_name', '')}".strip(" ·")
    try:
        await post_entry(p, mv["created_at"][:10], memo, [("1200", amount), ("3900", -amount)],
                         source="inventory", ref=f"mv:{mv['id']}:inv")
    except ValueError:
        pass
