"""Platform-scheduled jobs (.emergent/crons.yml). Bearer WEBHOOK_CRON_SECRET; ack fast, work in the background."""

import hmac
import logging
import os

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request
from pymongo.errors import DuplicateKeyError

from lib.auth import principal_for_user, tenant_settings
from lib.dates import now_iso, today_iso
from lib.db import db

router = APIRouter(prefix="/cron")
logger = logging.getLogger(__name__)
JOBS = ("daily-digest", "weekly-ai")


async def owners_for(query: dict):
    async for t in db.tenants.find(query, {"_id": 0}):
        owner = await db.users.find_one({"tenant_id": t["id"], "role": "admin"}, {"_id": 0}, sort=[("created_at", 1)])
        p = await principal_for_user(owner) if owner else None
        if p:
            yield t, tenant_settings(t), p


async def run_daily_digest(base: str = "") -> None:
    from routers.inv_reports import send_digest
    from lib.ops import recover_ops
    await recover_ops(300)
    async for t, s, p in owners_for({"settings.inventory_enabled": True}):
        if not p.settings.get("inventory_enabled"):  # unpaid: add-on masked by entitlement
            continue
        try:
            if s["low_stock_email"] and t.get("last_digest_date") != today_iso(p.settings.get("timezone")):
                await send_digest(p)
        except Exception as exc:
            logger.error("daily digest %s: %s", t["id"], exc)


async def run_weekly_ai(base: str = "") -> None:
    from routers.ai import send_weekly_email
    if not os.environ.get("EMERGENT_LLM_KEY"):
        return
    async for t, s, p in owners_for({"settings.ai_enabled": True}):
        try:
            if s.get("weekly_ai_email", True):
                await send_weekly_email(p, base)
        except Exception as exc:
            logger.error("weekly AI email %s: %s", t["id"], exc)


RUNNERS = {"daily-digest": run_daily_digest, "weekly-ai": run_weekly_ai}


@router.post("/{job}")
async def cron(job: str, request: Request, tasks: BackgroundTasks, authorization: str = Header(default=""),
               x_webhook_id: str = Header(default="")):
    # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
    secret = os.environ.get("WEBHOOK_CRON_SECRET", "")
    token = authorization[7:] if authorization.startswith("Bearer ") else ""
    if not secret or not token or not hmac.compare_digest(token.encode(), secret.encode()):
        raise HTTPException(401, "Unauthorized")
    if job not in RUNNERS:
        raise HTTPException(404, "Unknown job")
    try:
        envelope = await request.json()
    except Exception:
        envelope = {}
    if not isinstance(envelope, dict):
        raise HTTPException(400, "Invalid body")
    run_id = x_webhook_id or str(envelope.get("run_id") or "")
    if run_id:
        try:
            await db.cron_runs.insert_one({"_id": f"{job}:{run_id}", "job": job, "at": now_iso()})
        except DuplicateKeyError:
            return {"accepted": True, "duplicate": True}
    from routers.po_links import public_base
    tasks.add_task(RUNNERS[job], public_base(request))
    return {"accepted": True}
