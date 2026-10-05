"""HTTP hardening: request IDs + error capture, CSRF origin check for cookie-authenticated writes, login rate limit."""

import logging
import os
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from lib.dates import now_iso
from lib.db import db

logger = logging.getLogger("app.errors")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
# Server-to-server endpoints authenticated by signature/secret, not by the session cookie.
CSRF_EXEMPT = ("/api/stripe/webhook", "/api/cron/", "/api/po-action")


def is_production() -> bool:
    return os.environ.get("APP_ENV", "development").lower() == "production"


def _allowed_hosts(request: Request) -> set[str]:
    hosts = {request.headers.get("x-forwarded-host") or "", request.headers.get("host") or ""}
    for o in os.environ.get("CORS_ORIGINS", "").split(","):
        o = o.strip()
        if o and o != "*":
            hosts.add(urlparse(o).netloc)
    if not is_production():  # Vite dev proxy rewrites Host to :8001 while the browser Origin stays :3000
        hosts.update({"localhost:3000", "127.0.0.1:3000"})
    if os.environ.get("PUBLIC_APP_URL"):
        hosts.add(urlparse(os.environ["PUBLIC_APP_URL"]).netloc)
    return {h.split(",")[0].strip() for h in hosts if h}


class SecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        request.state.request_id = rid
        path = request.url.path
        if request.method in UNSAFE and request.cookies.get("session") and not path.startswith(CSRF_EXEMPT):
            origin = request.headers.get("origin") or request.headers.get("referer") or ""
            if origin and urlparse(origin).netloc not in _allowed_hosts(request):
                return JSONResponse({"detail": "Cross-site request blocked", "request_id": rid}, status_code=403)
        try:
            response = await call_next(request)
        except Exception as exc:  # unhandled -> logged with request id, generic body (no stack to the client)
            logger.error("unhandled %s %s rid=%s: %s", request.method, path, rid, exc)
            try:
                await db.error_events.insert_one({"request_id": rid, "method": request.method, "path": path,
                                                  "error": f"{type(exc).__name__}: {str(exc)[:300]}",
                                                  "trace": traceback.format_exc()[-4000:], "created_at": now_iso(),
                                                  "created_dt": datetime.now(timezone.utc)})
            except Exception:
                pass
            return JSONResponse({"detail": "Something went wrong — our team has the error reference", "request_id": rid}, status_code=500)
        response.headers["X-Request-ID"] = rid
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if is_production():
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response


MAX_FAILS = int(os.environ.get("LOGIN_MAX_FAILS", "5"))
WINDOW = timedelta(minutes=int(os.environ.get("LOGIN_WINDOW_MINUTES", "15")))


def client_ip(request: Request) -> str:
    return (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "")).split(",")[0].strip()


async def check_login_allowed(email: str, ip: str) -> None:
    since = datetime.now(timezone.utc) - WINDOW
    by_email = await db.login_attempts.count_documents({"email": email, "created_dt": {"$gte": since}})
    by_ip = await db.login_attempts.count_documents({"ip": ip, "created_dt": {"$gte": since}})
    if by_email >= MAX_FAILS or by_ip >= MAX_FAILS * 4:
        raise HTTPException(429, f"Too many failed sign-in attempts. Try again in {int(WINDOW.total_seconds() // 60)} minutes or reset your password.")


async def record_login_failure(email: str, ip: str) -> None:
    await db.login_attempts.insert_one({"email": email, "ip": ip, "created_dt": datetime.now(timezone.utc)})


async def clear_login_failures(email: str) -> None:
    await db.login_attempts.delete_many({"email": email})
