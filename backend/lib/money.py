"""Money helpers. All amounts are rounded through Decimal (ROUND_HALF_UP to cents) — never raw float round().

Rounding rule: every stored amount = Decimal(str(x)).quantize(0.01, ROUND_HALF_UP); sums are computed in Decimal
then rounded once. Line totals are rounded per line (unit price x qty) before summing, matching what a receipt shows.
"""

import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable

from lib.auth import Principal
from lib.dates import now_iso
from lib.repo import Scoped
from lib.stock import barber_name

CENT = Decimal("0.01")


def D(x: float | int | str | Decimal | None) -> Decimal:
    return x if isinstance(x, Decimal) else Decimal(str(x or 0))


def money(x: float | int | str | Decimal | None) -> float:
    """Round to cents, half-up. Returns float for JSON/Mongo storage (always exactly 2dp)."""
    return float(D(x).quantize(CENT, rounding=ROUND_HALF_UP))


def msum(values: Iterable[float | int | Decimal | None]) -> float:
    return money(sum((D(v) for v in values), Decimal(0)))


def line_total(qty: float | int, unit_price: float) -> float:
    return money(D(qty) * D(unit_price))


def discounted_unit_price(unit_price: float, pct: float = 0) -> float:
    """Round the discounted per-unit price once, before multiplying quantity."""
    return money(D(unit_price) * (Decimal(100) - D(pct)) / Decimal(100))


def invoice_amounts(lines: list[dict], discount_amount: float = 0, tax_rate: float = 0,
                    tip_amount: float = 0, amount_paid: float = 0) -> dict:
    """Derive an invoice's money fields from its lines. Discount is invoice-level and capped at subtotal;
    tax applies to the discounted subtotal; the grand total adds tips on top."""
    subtotal = msum(line_total(l["quantity"], l["unit_price"]) for l in lines)
    discount = money(min(D(discount_amount), D(subtotal)))
    taxable = money(D(subtotal) - D(discount))
    tax = money(D(taxable) * D(tax_rate) / Decimal(100))
    tip = money(tip_amount)
    total = money(D(taxable) + D(tax) + D(tip))
    return {"subtotal": subtotal, "discount_amount": discount, "tax_rate": float(tax_rate), "tax_amount": tax,
            "tip_amount": tip, "total": total, "balance_due": money(D(total) - D(amount_paid))}


async def create_txn(p: Principal, kind: str, category: str, amount: float, date: str, description: str, *,
                     source: str = "manual", barber_id: str | None = None, movement_ids: list[str] | None = None,
                     invoice_id: str | None = None, txn_id: str | None = None, created_at: str | None = None,
                     payment_method: str = "other", processor: str = "recorded", capitalized: bool = False,
                     reversal_of: str | None = None, op_id: str | None = None, extra: dict | None = None) -> dict:
    """processor: 'recorded' = owner says it was paid (cash/manual); 'stripe' = confirmed by the card processor.
    capitalized: inventory purchase — an asset, expensed as COGS when sold/used (accrual P&L skips it)."""
    doc = {
        "id": txn_id or str(uuid.uuid4()), "kind": kind, "category": category, "amount": money(amount),
        "date": date, "description": description, "barber_id": barber_id, "barber_name": await barber_name(p, barber_id),
        "source": source, "linked_movement_ids": movement_ids or [], "linked_invoice_id": invoice_id,
        "payment_method": payment_method, "processor": processor, "capitalized": capitalized,
        "reversal_of": reversal_of, "reversed_by": None, "op_id": op_id, "created_by": p.user_id,
        "created_at": created_at or now_iso(), **(extra or {}),
    }
    doc = await Scoped("transactions", p).insert(doc)
    from lib.bookkeeping import mirror_txn  # local import avoids a circular dependency
    await mirror_txn(p, doc)
    doc.pop("tenant_id", None)
    return doc
