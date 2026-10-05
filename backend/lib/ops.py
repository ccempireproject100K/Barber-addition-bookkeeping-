"""Reliability layer for multi-document writes on MongoDB without multi-document transactions.

The in-pod / self-hosted default is a standalone mongod (no replica set -> no transactions), so composite writes
(stock movements + income record + invoice lines) use:

1. Idempotency keys  (collection `idempotency`, unique (tenant_id, key)): a retried request with the same
   Idempotency-Key returns the stored result instead of posting twice. Stripe fulfilment uses key `stripe:<session>`.
2. An operation journal (collection `ops`): before the first write the full plan (incl. pre-generated transaction id)
   is stored with status `pending`; every movement carries `op_id`. On success -> `committed`.
3. Recovery (`recover_ops`, run at startup, by the daily cron and by POST /api/ops/recover):
   a pending op older than the threshold is either ROLLED FORWARD (all planned movements exist -> create the missing
   transaction with its pre-generated id) or ROLLED BACK (partial -> reverse posted movements with compensating
   `return` movements, release the discount code). Both paths are idempotent and audited.
"""

import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from lib.auth import Principal, principal_for_user
from lib.dates import now_iso
from lib.db import db

logger = logging.getLogger(__name__)


def fault(point: str, requested: str | None) -> None:
    """Test-only crash injection between writes. Ignored unless ALLOW_FAULT_INJECTION=true (never set in production)."""
    if requested == point and os.environ.get("ALLOW_FAULT_INJECTION", "false").lower() == "true":
        raise RuntimeError(f"injected fault at {point}")


async def idem_start(p: Principal, key: str | None, scope: str) -> dict | None:
    """Returns the stored response if this key already completed; raises 409 if it's still in flight."""
    if not key:
        return None
    try:
        await db.idempotency.insert_one({"tenant_id": p.tenant_id, "key": key, "scope": scope, "status": "pending",
                                         "created_at": now_iso(), "created_dt": datetime.now(timezone.utc)})
        return None
    except DuplicateKeyError:
        doc = await db.idempotency.find_one({"tenant_id": p.tenant_id, "key": key})
        if doc and doc["status"] == "done" and doc.get("scope") == scope:
            return doc["response"]
        if doc and doc.get("scope") != scope:
            raise HTTPException(422, "Idempotency-Key was already used for a different request")
        raise HTTPException(409, "This request is already being processed — wait a moment and refresh")


async def idem_finish(p: Principal, key: str | None, response: dict) -> None:
    if key:
        await db.idempotency.update_one({"tenant_id": p.tenant_id, "key": key}, {"$set": {"status": "done", "response": response}})


async def idem_fail(p: Principal, key: str | None) -> None:
    if key:
        await db.idempotency.delete_one({"tenant_id": p.tenant_id, "key": key, "status": "pending"})


async def begin_op(p: Principal, op_id: str, kind: str, plan: dict) -> None:
    await db.ops.insert_one({"id": op_id, "tenant_id": p.tenant_id, "user_id": p.user_id, "kind": kind, "plan": plan,
                             "status": "pending", "created_at": now_iso()})


async def commit_op(op_id: str) -> None:
    await db.ops.update_one({"id": op_id}, {"$set": {"status": "committed", "finished_at": now_iso()}})


async def recover_ops(min_age_seconds: int = 120) -> dict:
    """Resolve stale pending ops. Safe to run concurrently: each op is claimed atomically."""
    from lib.audit import audit
    from lib.money import create_txn
    from lib.stock import load_product, post_movement

    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=min_age_seconds)).isoformat()
    out = {"rolled_forward": 0, "rolled_back": 0, "failed": 0}
    while True:
        op = await db.ops.find_one_and_update({"status": "pending", "created_at": {"$lte": cutoff}},
                                              {"$set": {"status": "recovering", "recovery_started_at": now_iso()}})
        if not op:
            break
        try:
            user = await db.users.find_one({"id": op["user_id"], "tenant_id": op["tenant_id"]}, {"_id": 0})
            p = await principal_for_user(user) if user else None
            if not p:
                raise RuntimeError("operator no longer exists")
            plan = op["plan"]
            posted = await db.movements.find({"tenant_id": op["tenant_id"], "op_id": op["id"], "compensates": None},
                                             {"_id": 0}).to_list(1000)
            if len(posted) == plan.get("movement_count", 0):
                txn = plan.get("txn")
                if txn and not await db.transactions.find_one({"tenant_id": op["tenant_id"], "id": txn["txn_id"]}):
                    await create_txn(p, txn["kind"], txn["category"], txn["amount"], txn["date"], txn["description"],
                                     source=txn.get("source", "inventory"), barber_id=txn.get("barber_id"),
                                     movement_ids=[m["id"] for m in posted], txn_id=txn["txn_id"],
                                     payment_method=txn.get("payment_method", "other"), processor=txn.get("processor", "recorded"),
                                     capitalized=txn.get("capitalized", False), op_id=op["id"])
                status = "rolled_forward"
            else:
                for m in posted:
                    prod = await load_product(p, m["product_id"])
                    await post_movement(p, prod, "return", -m["quantity"], lot_id=m.get("lot_id"), serial_ids=m.get("serial_unit_ids"),
                                        unit_price=m.get("unit_price"), note=f"Recovery: rolled back incomplete {op['kind']}",
                                        op_id=op["id"], compensates=m["id"])
                if plan.get("discount_code"):
                    await db.discount_codes.update_one({"tenant_id": op["tenant_id"], "code": plan["discount_code"]}, {"$set": {"used_at": None}})
                if plan.get("idempotency_key"):
                    await db.idempotency.delete_one({"tenant_id": op["tenant_id"], "key": plan["idempotency_key"], "status": "pending"})
                status = "rolled_back"
            if status == "rolled_forward" and plan.get("idempotency_key"):
                await db.idempotency.delete_one({"tenant_id": op["tenant_id"], "key": plan["idempotency_key"], "status": "pending"})
            await db.ops.update_one({"id": op["id"]}, {"$set": {"status": status, "finished_at": now_iso()}})
            await audit(p, f"ops.{status}", "op", op["id"], {"kind": op["kind"], "movements": len(posted)}, system=True)
            out[status] += 1
        except Exception as exc:  # keep going; leave a trace for the owner
            logger.exception("recover_ops failed for %s", op["id"])
            await db.ops.update_one({"id": op["id"]}, {"$set": {"status": "recovery_failed", "error": str(exc)[:300]}})
            out["failed"] += 1
    # Stripe fulfilment claims stuck by a crash: release so the next status poll / webhook retries (idempotent key).
    stale = (datetime.now(timezone.utc) - timedelta(seconds=max(min_age_seconds, 0))).isoformat()
    await db.payment_transactions.update_many({"fulfilling": True, "fulfilled": False, "updated_at": {"$lte": stale}},
                                              {"$set": {"fulfilling": False}})
    return out
