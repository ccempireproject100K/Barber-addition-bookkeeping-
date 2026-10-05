"""Append-only audit trail (collection `audit_log`). Never updated or deleted by the app."""

import uuid

from lib.auth import Principal
from lib.dates import now_iso
from lib.db import db


async def audit(p: Principal | None, action: str, entity: str, entity_id: str | None, details: dict | None = None, *,
                tenant_id: str | None = None, system: bool = False, request_id: str | None = None) -> None:
    await db.audit_log.insert_one({
        "id": str(uuid.uuid4()), "tenant_id": tenant_id or (p.tenant_id if p else None),
        "actor_id": None if system or not p else p.user_id, "actor_name": "system" if system or not p else p.name,
        "actor_role": None if system or not p else p.role, "action": action, "entity": entity, "entity_id": entity_id,
        "details": details or {}, "request_id": request_id, "created_at": now_iso(),
    })
