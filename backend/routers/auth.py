import hashlib
import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import httpx

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from lib.auth import (ROLE_PERMS, Principal, clear_session, get_principal, hash_password, principal_for_user, require,
                      set_session, verify_password, DEFAULT_SETTINGS)
from lib.dates import now_iso
from lib.audit import audit
from lib.db import db
from lib.mailer import send_email
from lib.security import check_login_allowed, clear_login_failures, client_ip, is_production, record_login_failure
from models.auth import (GoogleSessionIn, LoginIn, Me, OkOut, PasswordResetConfirmIn, PasswordResetRequestIn, SignupIn,
                         TeamMember, TeamMemberCreate, TeamMemberUpdate)

router = APIRouter()
logger = logging.getLogger(__name__)
RESET_TTL = timedelta(hours=1)


def _new_tenant(tid: str, name: str) -> dict:
    # New workspaces start with no paid access; add-ons unlock only via a verified Stripe subscription.
    return {"id": tid, "name": name, "po_seq": 0, "invoice_seq": 0, "settings": dict(DEFAULT_SETTINGS), "access": "none",
            "is_demo": False, "billing": {"status": "none"}, "created_at": now_iso()}


def _me(p: Principal) -> Me:
    return Me(user_id=p.user_id, name=p.name, email=p.email, role=p.role,  # type: ignore[arg-type]
              tenant_id=p.tenant_id, tenant_name=p.tenant_name, permissions=sorted(ROLE_PERMS.get(p.role, set())),
              inventory_enabled=bool(p.settings.get("inventory_enabled")),
              ai_enabled=bool(p.settings.get("ai_enabled")) and bool(os.environ.get("EMERGENT_LLM_KEY")),
              access="paid" if p.access != "demo" and any(p.entitlements.values()) else p.access,  # type: ignore[arg-type]
              entitlements=p.entitlements, currency=p.settings.get("currency", "USD"),
              timezone=p.settings.get("timezone", "UTC"), locale=p.settings.get("locale", "en-US"))


@router.post("/auth/signup", response_model=Me)
async def signup(body: SignupIn, response: Response):
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "An account with this email already exists")
    tid = str(uuid.uuid4())
    tenant = _new_tenant(tid, body.company_name.strip())
    tenant["settings"].update(currency=body.currency, timezone=body.timezone, locale=body.locale)
    await db.tenants.insert_one(tenant)
    await db.locations.insert_one({"id": str(uuid.uuid4()), "tenant_id": tid, "name": "Main shop", "is_default": True, "created_at": now_iso()})
    user = {"id": str(uuid.uuid4()), "tenant_id": tid, "email": email, "name": body.name.strip(),
            "password_hash": hash_password(body.password), "role": "admin", "commission_rate": 0, "created_at": now_iso()}
    await db.users.insert_one(dict(user))
    set_session(response, user["id"], 0)
    p = await principal_for_user(user)
    assert p
    return _me(p)


@router.post("/auth/login", response_model=Me)
async def login(body: LoginIn, response: Response, request: Request):
    email, ip = body.email.lower(), client_ip(request)
    await check_login_allowed(email, ip)
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user or not user.get("password_hash") or not verify_password(body.password, user["password_hash"]):
        await record_login_failure(email, ip)
        raise HTTPException(401, "Invalid email or password")
    p = await principal_for_user(user)
    if not p:
        raise HTTPException(401, "Invalid email or password")
    await clear_login_failures(email)
    set_session(response, user["id"], user.get("session_version", 0))
    await audit(p, "auth.login", "user", p.user_id, {"ip": ip})
    return _me(p)


def _hash_token(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


@router.post("/auth/password-reset/request", response_model=OkOut)
async def reset_request(body: PasswordResetRequestIn, request: Request):
    """Always answers the same way (no account enumeration). Token: 32 random bytes, stored hashed, 1h, single use."""
    email = body.email.lower()
    await check_login_allowed(email, client_ip(request))
    user = await db.users.find_one({"email": email}, {"_id": 0})
    msg = "If that email has an account, a reset link is on its way."
    if not user:
        await record_login_failure(email, client_ip(request))  # throttles enumeration/spam too
        return OkOut(message=msg)
    token = secrets.token_urlsafe(32)
    await db.password_resets.insert_one({"token_hash": _hash_token(token), "user_id": user["id"], "used": False,
                                         "expires_dt": datetime.now(timezone.utc) + RESET_TTL, "created_at": now_iso()})
    base = (os.environ.get("PUBLIC_APP_URL") or request.headers.get("origin") or "").rstrip("/")
    link = f"{base}/reset-password?token={token}"
    status, _ = await send_email(email, "Reset your Barber's Ledger password",
                                 f"Use this link within 1 hour to choose a new password:\n\n{link}\n\nIf you didn't ask for this, ignore this email.")
    if status != "sent":
        if is_production():
            logger.error("Password reset email could not be sent (SMTP %s) for user %s", status, user["id"])
        else:  # local development with test accounts only — never in production
            logger.warning("DEV ONLY password reset link for %s: %s", email, link)
    await audit(None, "auth.password_reset_requested", "user", user["id"], {"email_status": status}, tenant_id=user["tenant_id"], system=True)
    return OkOut(message=msg)


@router.post("/auth/password-reset/confirm", response_model=OkOut)
async def reset_confirm(body: PasswordResetConfirmIn):
    rec = await db.password_resets.find_one_and_update(
        {"token_hash": _hash_token(body.token), "used": False, "expires_dt": {"$gt": datetime.now(timezone.utc)}},
        {"$set": {"used": True, "used_at": now_iso()}})
    if not rec:
        raise HTTPException(400, "This reset link is invalid, expired or already used — request a new one")
    user = await db.users.find_one_and_update({"id": rec["user_id"]}, {"$set": {"password_hash": hash_password(body.password)},
                                                                        "$inc": {"session_version": 1}})
    if user:
        await clear_login_failures(user["email"])
        await audit(None, "auth.password_reset", "user", user["id"], {}, tenant_id=user["tenant_id"], system=True)
    return OkOut(message="Password updated — sign in with your new password. Other sessions were signed out.")


@router.post("/auth/logout-all", response_model=OkOut)
async def logout_all(response: Response, p: Principal = Depends(get_principal)):
    await db.users.update_one({"id": p.user_id}, {"$inc": {"session_version": 1}})
    clear_session(response)
    await audit(p, "auth.logout_all", "user", p.user_id)
    return OkOut(message="Signed out on every device")


EMERGENT_SESSION_URL = "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"


@router.post("/auth/google", response_model=Me)
async def google_login(body: GoogleSessionIn, response: Response):
    """Emergent-managed Google sign-in: exchange the one-time session_id server-side, then issue OUR session cookie.
    Existing account with that email -> signed in to its workspace. New email -> a fresh workspace with them as owner."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(EMERGENT_SESSION_URL, headers={"X-Session-ID": body.session_id})
    except httpx.HTTPError:
        raise HTTPException(502, "Google sign-in is unavailable right now, try again")
    if r.status_code != 200:
        raise HTTPException(401, "Google sign-in expired or was cancelled, please try again")
    data = r.json()
    email = str(data.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(401, "Google didn't share an email address")
    name = str(data.get("name") or email.split("@")[0]).strip()
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if user:
        patch = {"google_id": data.get("id"), "picture": data.get("picture")}
        await db.users.update_one({"id": user["id"]}, {"$set": patch})
    else:
        tid = str(uuid.uuid4())
        await db.tenants.insert_one(_new_tenant(tid, f"{name.split()[0]}'s Shop"))
        await db.locations.insert_one({"id": str(uuid.uuid4()), "tenant_id": tid, "name": "Main shop", "is_default": True, "created_at": now_iso()})
        user = {"id": str(uuid.uuid4()), "tenant_id": tid, "email": email, "name": name, "password_hash": None, "role": "admin",
                "commission_rate": 0, "google_id": data.get("id"), "picture": data.get("picture"), "created_at": now_iso()}
        await db.users.insert_one(dict(user))
    p = await principal_for_user(user)
    if not p:
        raise HTTPException(401, "Account unavailable")
    set_session(response, user["id"], user.get("session_version", 0))
    return _me(p)


@router.post("/auth/logout")
async def logout(response: Response):
    clear_session(response)
    return {"ok": True}


@router.get("/auth/me", response_model=Me)
async def me(p: Principal = Depends(get_principal)):
    return _me(p)


# ---------- Team (barbers). Every query is filtered by the caller's tenant_id ----------
@router.get("/team", response_model=list[TeamMember])
async def list_team(p: Principal = Depends(require("team:read"))):
    users = await db.users.find({"tenant_id": p.tenant_id}, {"_id": 0, "password_hash": 0}).sort("created_at", 1).to_list(1000)
    return [TeamMember(**u) for u in users]


@router.post("/team", response_model=TeamMember)
async def add_member(body: TeamMemberCreate, p: Principal = Depends(require("team:write"))):
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "An account with this email already exists")
    user = {"id": str(uuid.uuid4()), "tenant_id": p.tenant_id, "email": email, "name": body.name.strip(),
            "password_hash": hash_password(body.password), "role": body.role, "commission_rate": body.commission_rate,
            "created_at": now_iso()}
    await db.users.insert_one(dict(user))
    await audit(p, "team.add", "user", user["id"], {"role": body.role, "commission_rate": body.commission_rate})
    return TeamMember(**user)


@router.patch("/team/{id}", response_model=TeamMember)
async def update_member(id: str, body: TeamMemberUpdate, p: Principal = Depends(require("team:write"))):
    if id == p.user_id and body.role != "admin":
        raise HTTPException(400, "You cannot demote yourself")
    res = await db.users.find_one_and_update({"id": id, "tenant_id": p.tenant_id},
                                             {"$set": {"commission_rate": body.commission_rate, "role": body.role}},
                                             projection={"_id": 0, "password_hash": 0}, return_document=True)
    if not res:
        raise HTTPException(404, "Member not found")
    await db.users.update_one({"id": id}, {"$inc": {"session_version": 1}})  # role change -> re-login with new perms
    await audit(p, "team.update", "user", id, {"role": body.role, "commission_rate": body.commission_rate})
    return TeamMember(**res)


@router.delete("/team/{id}")
async def remove_member(id: str, p: Principal = Depends(require("team:write"))):
    if id == p.user_id:
        raise HTTPException(400, "You cannot remove yourself")
    res = await db.users.delete_one({"id": id, "tenant_id": p.tenant_id})
    if not res.deleted_count:
        raise HTTPException(404, "Member not found")
    await audit(p, "team.remove", "user", id)
    return {"ok": True}
