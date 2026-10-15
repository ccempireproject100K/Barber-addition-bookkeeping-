"""Two-factor auth: TOTP authenticator-app codes + backup codes.

Flow:
  1. Signed-in user: POST /auth/2fa/setup -> {secret, otpauth_url}. They add it
     to their authenticator app (manual key entry).
  2. POST /auth/2fa/enable {code} -> verifies, enables, returns 10 one-time
     backup codes (shown once, stored hashed).
  3. At login: password OK + 2FA enabled -> 202 {totp_required: true, challenge}.
     POST /auth/2fa/verify {challenge, code} (or {challenge, backup_code})
     -> session cookie as normal.
  4. POST /auth/2fa/disable {password}; POST /auth/2fa/backup-codes/regenerate.

The TOTP secret is Fernet-encrypted at rest (lib.pii). Verification attempts
are rate-limited with the same login-attempt throttle as passwords.
"""

import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone

import jwt as pyjwt
import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, get_principal, hash_password, verify_password, set_session, principal_for_user
from lib.dates import now_iso
from lib.db import db
from lib.pii import pii_decrypt, pii_encrypt
from lib.security import check_login_allowed, client_ip, record_login_failure

router = APIRouter(prefix="/auth/2fa")

CHALLENGE_TTL = timedelta(minutes=5)
BACKUP_CODE_COUNT = 10


def _challenge_token(user_id: str) -> str:
    import os
    return pyjwt.encode({"sub": user_id, "purpose": "totp-challenge",
                         "exp": datetime.now(timezone.utc) + CHALLENGE_TTL},
                        os.environ["JWT_SECRET"], algorithm="HS256")


def _challenge_user(challenge: str) -> dict:
    import os
    try:
        claims = pyjwt.decode(challenge, os.environ["JWT_SECRET"], algorithms=["HS256"])
    except pyjwt.PyJWTError:
        raise HTTPException(401, "Challenge expired — sign in again")
    if claims.get("purpose") != "totp-challenge":
        raise HTTPException(401, "Invalid challenge")
    return claims


def _get_secret(user: dict) -> str:
    enc = user.get("totp_secret")
    if not enc:
        raise HTTPException(400, "Two-factor auth is not enabled")
    return pii_decrypt(enc)


def _new_backup_codes() -> tuple[list[str], list[str]]:
    """Returns (plaintext codes to show once, bcrypt hashes to store)."""
    plain = [secrets.token_hex(4) for _ in range(BACKUP_CODE_COUNT)]
    hashed = [hash_password(c) for c in plain]
    return plain, hashed


class EnableIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class VerifyIn(BaseModel):
    challenge: str
    code: str = ""
    backup_code: str = ""


class PasswordIn(BaseModel):
    password: str = Field(min_length=1)


@router.post("/setup")
async def setup_2fa(p: Principal = Depends(get_principal)):
    """Start enrollment: returns the secret + otpauth URI. Not enabled until /enable."""
    user = await db.users.find_one({"id": p.user_id}, {"_id": 0})
    if not user:
        raise HTTPException(401, "Invalid session")
    if user.get("totp_enabled"):
        raise HTTPException(400, "Two-factor auth is already enabled")
    secret = pyotp.random_base32()
    await db.users.update_one({"id": p.user_id}, {"$set": {"totp_pending": pii_encrypt(secret)}})
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=user["email"], issuer_name="Ledger Books")
    await audit(p, "auth.2fa.setup_started", "user", p.user_id, {})
    return {"secret": secret, "otpauth_url": uri}


@router.post("/enable")
async def enable_2fa(body: EnableIn, p: Principal = Depends(get_principal)):
    user = await db.users.find_one({"id": p.user_id}, {"_id": 0})
    if not user:
        raise HTTPException(401, "Invalid session")
    if user.get("totp_enabled"):
        raise HTTPException(400, "Two-factor auth is already enabled")
    pending = user.get("totp_pending")
    if not pending:
        raise HTTPException(400, "Call /auth/2fa/setup first")
    totp = pyotp.TOTP(pii_decrypt(pending))
    if not totp.verify(body.code.strip(), valid_window=1):
        await record_login_failure(user["email"], "2fa-enable")
        raise HTTPException(401, "That code didn't work — check your authenticator app and try again")
    plain, hashed = _new_backup_codes()
    await db.users.update_one(
        {"id": p.user_id},
        {"$set": {"totp_secret": pending, "totp_enabled": True, "totp_backup_hashes": hashed,
                  "totp_enabled_at": now_iso()},
         "$unset": {"totp_pending": ""}})
    await audit(p, "auth.2fa.enabled", "user", p.user_id, {})
    return {"ok": True, "backup_codes": plain,
            "note": "Save these backup codes somewhere safe — each works once if you lose your device."}


@router.post("/disable")
async def disable_2fa(body: PasswordIn, p: Principal = Depends(get_principal)):
    user = await db.users.find_one({"id": p.user_id}, {"_id": 0})
    if not user or not user.get("password_hash") or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Password didn't match")
    await db.users.update_one(
        {"id": p.user_id},
        {"$unset": {"totp_secret": "", "totp_pending": "", "totp_backup_hashes": ""},
         "$set": {"totp_enabled": False}})
    await audit(p, "auth.2fa.disabled", "user", p.user_id, {})
    return {"ok": True}


@router.post("/backup-codes/regenerate")
async def regenerate_codes(body: PasswordIn, p: Principal = Depends(get_principal)):
    user = await db.users.find_one({"id": p.user_id}, {"_id": 0})
    if not user or not user.get("password_hash") or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Password didn't match")
    if not user.get("totp_enabled"):
        raise HTTPException(400, "Two-factor auth is not enabled")
    plain, hashed = _new_backup_codes()
    await db.users.update_one({"id": p.user_id}, {"$set": {"totp_backup_hashes": hashed}})
    await audit(p, "auth.2fa.codes_regenerated", "user", p.user_id, {})
    return {"ok": True, "backup_codes": plain}


@router.post("/verify")
async def verify_2fa(body: VerifyIn, request: Request):
    """Exchange a login challenge + TOTP/backup code for a session. Rate-limited like login."""
    claims = _challenge_user(body.challenge)
    user = await db.users.find_one({"id": claims["sub"]}, {"_id": 0})
    if not user or not user.get("totp_enabled"):
        raise HTTPException(401, "Challenge expired — sign in again")
    email, ip = user["email"], client_ip(request)
    await check_login_allowed(email, ip)

    ok = False
    used_backup_idx: int | None = None
    code = body.code.strip().replace(" ", "")
    if code:
        ok = pyotp.TOTP(_get_secret(user)).verify(code, valid_window=1)
    elif body.backup_code.strip():
        for i, h in enumerate(user.get("totp_backup_hashes") or []):
            if h and verify_password(body.backup_code.strip(), h):  # bcrypt comparison is constant-time
                ok, used_backup_idx = True, i
                break
    if not ok:
        await record_login_failure(email, ip)
        raise HTTPException(401, "That code didn't work")
    update: dict = {}
    if used_backup_idx is not None:
        hashes = [h for i, h in enumerate(user.get("totp_backup_hashes") or []) if i != used_backup_idx]
        update["totp_backup_hashes"] = hashes
    await db.users.update_one({"id": user["id"]}, {"$set": update} if update else {"$set": {"totp_last_used": now_iso()}})
    p = await principal_for_user(user)
    if not p:
        raise HTTPException(401, "Account unavailable")
    resp = JSONResponse({"ok": True})
    set_session(resp, user["id"], user.get("session_version", 0))
    await audit(p, "auth.login.2fa", "user", p.user_id, {"ip": ip, "via": "backup_code" if used_backup_idx is not None else "totp"})
    return resp
