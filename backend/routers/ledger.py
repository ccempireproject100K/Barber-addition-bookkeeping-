"""Audit log, accountant exports, transaction reversals, recovery trigger and health."""

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Response

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso, today_iso
from lib.db import db
from lib.money import create_txn
from lib.ops import recover_ops
from lib.repo import Scoped
from lib.security import is_production
from models.ledger import AuditEntry, Health, RecoverResult, ReverseIn
from models.money import Transaction

router = APIRouter()


async def reverse_txn(p: Principal, id: str, reason: str, allowed_sources: tuple[str, ...]) -> dict:
    """Posted entries are never edited or deleted: a correction is an equal-and-opposite entry linked both ways."""
    txns = Scoped("transactions", p)
    orig = await txns.find_one({"id": id})
    if not orig:
        raise HTTPException(404, "Transaction not found")
    if orig.get("reversal_of"):
        raise HTTPException(400, "This entry is itself a reversal")
    if orig["source"] not in allowed_sources:
        raise HTTPException(400, "Stock-linked entries are corrected with a return or stock adjustment, not a reversal")
    rev_id = __import__("uuid").uuid4().hex
    claimed = await txns.update({"id": id, "reversed_by": None}, {"$set": {"reversed_by": rev_id, "reversed_at": now_iso()}})
    if not claimed:
        raise HTTPException(409, "This entry was already reversed")
    doc = await create_txn(p, orig["kind"], orig["category"], -orig["amount"], today_iso(p.settings.get("timezone")), f"Reversal: {orig['description'] or orig['category']} — {reason}",
                           source=orig["source"], barber_id=orig.get("barber_id"), txn_id=rev_id, reversal_of=id,
                           payment_method=orig.get("payment_method", "other"), processor=orig.get("processor", "recorded"),
                           capitalized=orig.get("capitalized", False), invoice_id=orig.get("linked_invoice_id"))
    await audit(p, "txn.reverse", "transaction", id, {"reversal_id": rev_id, "amount": orig["amount"], "reason": reason})
    return doc


@router.post("/transactions/{id}/reverse", response_model=Transaction)
async def reverse(id: str, body: ReverseIn, p: Principal = Depends(require("txn:adjust"))):
    return Transaction(**await reverse_txn(p, id, body.reason.strip(), ("manual", "invoice")))


@router.get("/audit", response_model=list[AuditEntry])
async def list_audit(action: str = "", limit: int = 300, p: Principal = Depends(require("audit:read"))):
    f = {"action": {"$regex": f"^{action}"}} if action and action.replace(".", "").replace("_", "").isalnum() else {}
    return [AuditEntry(**d) for d in await Scoped("audit_log", p).find(f, sort=[("created_at", -1)], limit=min(limit, 2000))]


def _csv(rows: list[list], header: list[str], name: str) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/exports/transactions.csv")
async def export_txns(start: str = "", end: str = "", p: Principal = Depends(require("export:read"))):
    f: dict = {}
    if start or end:
        f["date"] = {**({"$gte": start} if start else {}), **({"$lte": end} if end else {})}
    rows = await Scoped("transactions", p).find(f, sort=[("date", 1), ("created_at", 1)], limit=100000)
    await audit(p, "export.transactions", "export", None, {"start": start, "end": end, "rows": len(rows)})
    return _csv([[t["id"], t["date"], t["kind"], t["category"], f"{t['amount']:.2f}", t.get("payment_method", ""), t.get("processor", ""),
                  t["source"], "yes" if t.get("capitalized") else "no", t["description"], t.get("barber_name") or "",
                  t.get("reversal_of") or "", t.get("reversed_by") or "", t.get("linked_invoice_id") or "",
                  " ".join(t.get("linked_movement_ids") or []), t["created_at"]] for t in rows],
                ["id", "date", "kind", "category", "amount", "payment_method", "processor", "source", "inventory_purchase", "description",
                 "barber", "reversal_of", "reversed_by", "invoice_id", "movement_ids", "created_at"], "transactions.csv")


@router.get("/exports/audit.csv")
async def export_audit(p: Principal = Depends(require("export:read"))):
    rows = await Scoped("audit_log", p).find({}, sort=[("created_at", 1)], limit=100000)
    return _csv([[a["created_at"], a["actor_name"], a.get("actor_role") or "", a["action"], a["entity"], a.get("entity_id") or "", str(a.get("details") or {})]
                 for a in rows], ["at", "actor", "role", "action", "entity", "entity_id", "details"], "audit_log.csv")


@router.post("/ops/recover", response_model=RecoverResult)
async def recover(min_age_seconds: int = 120, p: Principal = Depends(require("ops:recover"))):
    """Owner-triggered journal recovery (also runs at startup and daily). Tenant-agnostic but idempotent."""
    if is_production():
        min_age_seconds = max(min_age_seconds, 60)
    return RecoverResult(**await recover_ops(max(min_age_seconds, 0)))


@router.get("/health", response_model=Health)
async def health():
    try:
        await db.command("ping")
        ok = True
    except Exception:
        ok = False
    pending = await db.ops.count_documents({"status": {"$in": ["pending", "recovery_failed"]}}) if ok else 0
    return Health(status="ok" if ok else "degraded", db=ok, pending_ops=pending, env="production" if is_production() else "development")
