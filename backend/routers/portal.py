"""Magic-link client portal: passwordless, expiring links for clients.

The owner generates a link per invoice/estimate (from the Invoices/Estimates
pages). The client opens it with no login and can:
  - view the invoice / estimate,
  - accept or decline an estimate,
  - report a payment on an invoice (recorded as *reported*, awaiting owner
    confirmation — it never touches the balance until the owner books it).

Links are JWTs signed with PORTAL_LINK_SECRET, expire after 7 days, and can be
revoked (jti allowlist in `portal_links`). Set PORTAL_LINK_SECRET in env;
link creation 503s without it.
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso
from lib.db import db
from lib.repo import Scoped

router = APIRouter(prefix="/portal")

LINK_DAYS = 7


def _secret() -> str:
    s = os.environ.get("PORTAL_LINK_SECRET", "").strip()
    if not s:
        raise HTTPException(503, "PORTAL_LINK_SECRET is not set. Add it to the server env to enable magic links.")
    return s


def _mint(tenant_id: str, kind: str, doc_id: str) -> tuple[str, str]:
    jti = str(uuid.uuid4())
    exp = datetime.now(timezone.utc) + timedelta(days=LINK_DAYS)
    token = jwt.encode({"tenant_id": tenant_id, "kind": kind, "doc_id": doc_id,
                        "jti": jti, "exp": exp}, _secret(), algorithm="HS256")
    return token, jti


async def _verify(token: str) -> dict:
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(410, "This link has expired — ask the business for a fresh one")
    except jwt.InvalidTokenError:
        raise HTTPException(404, "This link is invalid")
    link = await db.portal_links.find_one({"jti": claims.get("jti")})
    if not link or link.get("revoked"):
        raise HTTPException(404, "This link is no longer active")
    return claims


def _public_base(request: Request) -> str:
    env = os.environ.get("PUBLIC_APP_URL", "").rstrip("/")
    if env:
        return env
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return f"{proto.split(',')[0]}://{host.split(',')[0]}"


async def _create_link(p: Principal, request: Request, kind: str, doc_id: str) -> dict:
    token, jti = _mint(p.tenant_id, kind, doc_id)
    await db.portal_links.insert_one({"jti": jti, "tenant_id": p.tenant_id, "kind": kind, "doc_id": doc_id,
                                      "created_by": p.name, "created_at": now_iso(),
                                      "expires_at": (datetime.now(timezone.utc) + timedelta(days=LINK_DAYS)).isoformat(),
                                      "revoked": False})
    await audit(p, "portal.link.create", kind, doc_id, {})
    return {"url": f"{_public_base(request)}/portal/v/{token}", "expires_in_days": LINK_DAYS}


@router.post("/invoices/{doc_id}/link")
async def invoice_link(doc_id: str, request: Request, p: Principal = Depends(require("invoice:read"))):
    if not await Scoped("invoices", p).find_one({"id": doc_id}):
        raise HTTPException(404, "Invoice not found")
    return await _create_link(p, request, "invoice", doc_id)


@router.post("/estimates/{doc_id}/link")
async def estimate_link(doc_id: str, request: Request, p: Principal = Depends(require("invoice:read"))):
    if not await Scoped("estimates", p).find_one({"id": doc_id}):
        raise HTTPException(404, "Estimate not found")
    return await _create_link(p, request, "estimate", doc_id)


@router.get("/links")
async def list_links(p: Principal = Depends(require("invoice:read"))):
    docs = await db.portal_links.find({"tenant_id": p.tenant_id, "revoked": False},
                                      {"_id": 0}).sort("created_at", -1).to_list(200)
    return docs


@router.delete("/links/{jti}")
async def revoke_link(jti: str, p: Principal = Depends(require("invoice:read"))):
    r = await db.portal_links.update_one({"tenant_id": p.tenant_id, "jti": jti}, {"$set": {"revoked": True}})
    if not r.matched_count:
        raise HTTPException(404, "Link not found")
    await audit(p, "portal.link.revoke", "portal_link", jti, {})
    return {"ok": True}


def _strip_invoice(d: dict) -> dict:
    return {k: d.get(k) for k in ("id", "number", "client_name", "date", "due_date", "status",
                                  "lines", "subtotal", "discount_amount", "tax_rate", "tax_amount",
                                  "tip_amount", "total", "amount_paid", "balance_due", "notes",
                                  "reported_payments")}


def _strip_estimate(d: dict) -> dict:
    return {k: d.get(k) for k in ("id", "number", "client_name", "date", "valid_until", "status",
                                  "lines", "subtotal", "discount_amount", "tax_rate", "tax_amount",
                                  "tip_amount", "total", "notes")}


@router.get("/view/{token}")
async def portal_view(token: str):
    """Public: view the linked document. No login required."""
    claims = await _verify(token)
    tenant_id, kind, doc_id = claims["tenant_id"], claims["kind"], claims["doc_id"]
    tenant = await db.tenants.find_one({"id": tenant_id}, {"_id": 0, "name": 1})
    if kind == "invoice":
        doc = await db.invoices.find_one({"tenant_id": tenant_id, "id": doc_id}, {"_id": 0, "tenant_id": 0})
        if not doc:
            raise HTTPException(404, "Invoice not found")
        return {"kind": "invoice", "business": (tenant or {}).get("name", ""),
                "invoice": _strip_invoice(doc)}
    doc = await db.estimates.find_one({"tenant_id": tenant_id, "id": doc_id}, {"_id": 0, "tenant_id": 0})
    if not doc:
        raise HTTPException(404, "Estimate not found")
    return {"kind": "estimate", "business": (tenant or {}).get("name", ""), "estimate": _strip_estimate(doc)}


class EstimateDecisionIn(BaseModel):
    decision: str = Field(pattern=r"^(accepted|declined)$")
    note: str = Field(default="", max_length=500)


@router.post("/estimate/{token}/decision")
async def portal_estimate_decision(token: str, body: EstimateDecisionIn):
    """Public: client accepts or declines a sent estimate."""
    claims = await _verify(token)
    if claims["kind"] != "estimate":
        raise HTTPException(400, "This link is not for an estimate")
    doc = await db.estimates.find_one({"tenant_id": claims["tenant_id"], "id": claims["doc_id"]})
    if not doc:
        raise HTTPException(404, "Estimate not found")
    if doc.get("status") not in ("sent",):
        raise HTTPException(409, f"Estimate is {doc.get('status')} — no longer awaiting a decision")
    await db.estimates.update_one(
        {"tenant_id": claims["tenant_id"], "id": doc["id"]},
        {"$set": {"status": body.decision, "client_note": body.note,
                  "decided_at": now_iso()}})
    await audit(None, "portal.estimate.decision", "estimate", doc["id"],
                {"decision": body.decision, "tenant_id": claims["tenant_id"]}, tenant_id=claims["tenant_id"])
    return {"ok": True, "status": body.decision}


class ReportPaymentIn(BaseModel):
    amount: float = Field(gt=0)
    method: str = Field(default="bank transfer", max_length=40)
    reference: str = Field(default="", max_length=120)


@router.post("/invoice/{token}/report-payment")
async def portal_report_payment(token: str, body: ReportPaymentIn):
    """Public: client reports a payment they made. Recorded as *reported* —
    the balance is untouched until the owner confirms it in Invoices."""
    claims = await _verify(token)
    if claims["kind"] != "invoice":
        raise HTTPException(400, "This link is not for an invoice")
    inv = await db.invoices.find_one({"tenant_id": claims["tenant_id"], "id": claims["doc_id"]})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.get("status") in ("void", "paid"):
        raise HTTPException(409, f"Invoice is {inv.get('status')}")
    if body.amount > float(inv.get("balance_due") or 0) + 0.005:
        raise HTTPException(400, "Amount exceeds the balance due")
    rep = {"id": str(uuid.uuid4()), "amount": round(body.amount, 2), "method": body.method,
           "reference": body.reference, "reported_at": now_iso(), "confirmed": False}
    await db.invoices.update_one({"tenant_id": claims["tenant_id"], "id": inv["id"]},
                                 {"$push": {"reported_payments": rep}})
    await audit(None, "portal.payment.reported", "invoice", inv["id"],
                {"amount": rep["amount"], "method": body.method, "tenant_id": claims["tenant_id"]},
                tenant_id=claims["tenant_id"])
    return {"ok": True, "message": "Payment reported — the business will confirm it shortly"}
