"""Backup & restore: tenant-scoped JSON dump of every business collection, stored as a
zip. Restoring replaces current workspace data with the backup (backups themselves are kept)."""

import base64
import io
import json
import uuid
import zipfile

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso
from lib.db import db
from lib.repo import Scoped

router = APIRouter()

# Ephemeral/derived collections that are never worth restoring.
SKIP = {"login_attempts", "password_resets", "idempotency", "ops", "cron_runs", "stripe_events",
        "error_events", "used_action_tokens", "ai_messages", "email_outbox", "backups"}


async def _collections() -> list[str]:
    names = await db.list_collection_names()
    return sorted(n for n in names if n not in SKIP and not n.startswith("system."))


def _filter(coll: str, tenant_id: str) -> dict:
    return {"id": tenant_id} if coll == "tenants" else {"tenant_id": tenant_id}


class BackupMeta(BaseModel):
    id: str
    created_at: str
    created_by: str
    size_bytes: int
    collections: list[str]
    documents: int


async def _dump(p: Principal) -> tuple[bytes, list[str], int]:
    buf = io.BytesIO()
    collections = _collections()
    total = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for coll in collections:
            docs = await db[coll].find(_filter(coll, p.tenant_id), {"_id": 0}).to_list(200000)
            total += len(docs)
            z.writestr(f"{coll}.json", json.dumps(docs, default=str))
    return buf.getvalue(), collections, total


@router.post("/backup", response_model=BackupMeta)
async def create_backup(p: Principal = Depends(require("settings:write"))):
    raw, collections, total = await _dump(p)
    doc = {"id": str(uuid.uuid4()), "tenant_id": p.tenant_id, "created_at": now_iso(),
           "created_by": p.name, "size_bytes": len(raw), "collections": collections,
           "documents": total, "data_b64": base64.b64encode(raw).decode()}
    await db.backups.insert_one(doc)
    await audit(p, "backup.create", "backup", doc["id"], {"documents": total, "size_bytes": len(raw)})
    return BackupMeta(**{k: v for k, v in doc.items() if k not in ("tenant_id", "data_b64")})


@router.get("/backups", response_model=list[BackupMeta])
async def list_backups(p: Principal = Depends(require("settings:read"))):
    docs = await Scoped("backups", p).find({}, sort=[("created_at", -1)], limit=50)
    return [BackupMeta(**{k: v for k, v in d.items() if k not in ("tenant_id", "data_b64")}) for d in docs]


@router.get("/backup/{bid}/download")
async def download_backup(bid: str, p: Principal = Depends(require("settings:read"))):
    d = await Scoped("backups", p).find_one({"id": bid})
    if not d:
        raise HTTPException(404, "Backup not found")
    raw = base64.b64decode(d["data_b64"])
    return Response(raw, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="ledger-backup-{d["created_at"][:10]}.zip"'})


@router.post("/backup/{bid}/restore")
async def restore_backup(bid: str, p: Principal = Depends(require("settings:write"))):
    """Replace all current workspace data with the backup. The backups collection itself is kept."""
    d = await Scoped("backups", p).find_one({"id": bid})
    if not d:
        raise HTTPException(404, "Backup not found")
    raw = base64.b64decode(d["data_b64"])
    data: dict[str, list] = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for name in z.namelist():
            if name.endswith(".json"):
                data[name[:-5]] = json.loads(z.read(name))
    restored = 0
    for coll, docs in data.items():
        if coll in SKIP or coll == "backups":
            continue
        await db[coll].delete_many(_filter(coll, p.tenant_id))
        if docs:
            await db[coll].insert_many(docs)
            restored += len(docs)
    await audit(p, "backup.restore", "backup", bid, {"documents": restored, "from": d["created_at"]})
    return {"ok": True, "restored_documents": restored, "from": d["created_at"]}
