"""Session auth + RBAC + module gating. Principal is re-derived from the DB on every request."""

import os
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel

from lib.db import db

COOKIE = "session"
TTL = timedelta(days=7)

DEFAULT_SETTINGS = {
    "currency": "USD", "timezone": os.environ.get("APP_TZ", "UTC"), "locale": "en-US",
    "inventory_enabled": False,
    "low_stock_email": True,
    "expiry_warning_days": 30,
    "expense_category_retail": "Inventory / Retail stock",
    "expense_category_supply": "Supplies",
    "allow_negative_stock": False,
    "ai_enabled": False,
    "po_approval_limit": 0,
    "weekly_ai_email": True,
}

STAFF_PERMS = {
    "product:read", "stock:write", "supplier:read", "po:read", "po:write", "insight:read", "team:read",
    "txn:read", "txn:write", "invoice:read", "invoice:write", "client:read", "settings:read", "cashclose:write",
}
ADMIN_PERMS = STAFF_PERMS | {
    "product:write", "product:delete", "stock:adjust", "supplier:write", "supplier:delete", "po:delete",
    "team:write", "report:read", "settings:write", "po:approve", "txn:adjust", "audit:read", "export:read",
    "cashclose:read", "cashclose:review", "billing:write", "ops:recover",
}
# Accountant: review + reconcile + export, no shop settings, no stock/sales, no client PII.
ACCOUNTANT_PERMS = {"txn:read", "invoice:read", "report:read", "audit:read", "export:read", "cashclose:read", "team:read", "product:read"}
# Bookkeeper = accountant who may also post corrections (reversals / adjusting entries). Still no settings.
BOOKKEEPER_PERMS = ACCOUNTANT_PERMS | {"txn:adjust"}
ROLE_PERMS: dict[str, set[str]] = {"admin": ADMIN_PERMS, "staff": STAFF_PERMS, "accountant": ACCOUNTANT_PERMS,
                                   "bookkeeper": BOOKKEEPER_PERMS}
PAID_FEATURES = ("inventory", "ai")


class Principal(BaseModel):
    user_id: str
    tenant_id: str
    tenant_name: str
    role: str
    name: str
    email: str
    settings: dict
    access: str = "none"
    entitlements: dict = {}


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


def set_session(response: Response, user_id: str, version: int = 0) -> None:
    token = jwt.encode({"sub": user_id, "ver": version, "exp": datetime.now(timezone.utc) + TTL}, os.environ["JWT_SECRET"], algorithm="HS256")
    response.set_cookie(
        COOKIE, token, httponly=True, samesite="lax",
        secure=os.environ.get("COOKIE_SECURE", "false").lower() == "true",
        max_age=int(TTL.total_seconds()), path="/",
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


def tenant_settings(tenant: dict) -> dict:
    return {**DEFAULT_SETTINGS, **(tenant.get("settings") or {})}


def entitlements(tenant: dict) -> dict[str, bool]:
    """Paid add-ons are unlocked ONLY by tenant.access == 'demo' (seeded sandbox) or by a Stripe subscription whose
    status was set from a verified Stripe event/API read (routers/billing.py). Ordinary settings can't unlock them."""
    if tenant.get("access") == "demo":
        return {f: True for f in PAID_FEATURES}
    active = (tenant.get("billing") or {}).get("status") in ("active", "trialing")
    return {f: active for f in PAID_FEATURES}


async def principal_for_user(user: dict) -> Principal | None:
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0})
    if not tenant:
        return None
    ent = entitlements(tenant)
    settings = tenant_settings(tenant)
    settings["inventory_enabled"] = bool(settings.get("inventory_enabled")) and ent["inventory"]
    settings["ai_enabled"] = bool(settings.get("ai_enabled")) and ent["ai"]
    return Principal(user_id=user["id"], tenant_id=user["tenant_id"], tenant_name=tenant["name"], role=user["role"],
                     name=user["name"], email=user["email"], settings=settings, access=tenant.get("access", "none"),
                     entitlements=ent)


async def get_principal(request: Request) -> Principal:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid session")
    user = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0})
    if user and int(payload.get("ver", 0)) != int(user.get("session_version", 0)):
        user = None  # revoked: password changed/reset or "sign out everywhere"
    p = await principal_for_user(user) if user else None
    if not p:
        raise HTTPException(401, "Invalid session")
    return p


def require(action: str):
    """Deny-by-default role gate."""

    async def dep(p: Principal = Depends(get_principal)) -> Principal:
        if action not in ROLE_PERMS.get(p.role, set()):
            raise HTTPException(403, "You don't have permission for this action")
        return p

    return dep


async def require_inventory(p: Principal = Depends(get_principal)) -> Principal:
    """Module gate: with the inventory add-on off, every inventory endpoint is invisible (404)."""
    if not p.settings.get("inventory_enabled"):
        raise HTTPException(404, "Not found")
    return p
