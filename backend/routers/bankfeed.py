"""Live bank feeds via Plaid: connect a bank once, transactions flow in automatically.

Writes into the same `bank_txns` staging collection the CSV import uses, so the
match/resolve UI needs no changes. Plaid access tokens are Fernet-encrypted at
rest and never returned by the API.

Setup (env vars; see PLAID_SETUP.md):
  PLAID_CLIENT_ID, PLAID_SECRET   - from the Plaid dashboard
  PLAID_ENV                        - sandbox | development | production (default: sandbox)
  TOKEN_ENCRYPTION_KEY             - Fernet key; generate with:
      python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  PUBLIC_APP_URL                   - needed so Plaid webhooks can reach this server

Until the keys are set, GET /bankfeed/status reports configured=false and the
UI shows setup instructions instead of a Connect button.
"""

import os
import uuid

import httpx
from cryptography.fernet import Fernet
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso
from lib.db import db
from lib.money import money

router = APIRouter(prefix="/bankfeed")

PLAID_BASES = {
    "sandbox": "https://sandbox.plaid.com",
    "development": "https://development.plaid.com",
    "production": "https://production.plaid.com",
}


class ExchangeIn(BaseModel):
    public_token: str = Field(min_length=1, max_length=500)


class SyncIn(BaseModel):
    connection_id: str = Field(default="", max_length=80)


def _plaid_cfg():
    cid = os.environ.get("PLAID_CLIENT_ID", "").strip()
    sec = os.environ.get("PLAID_SECRET", "").strip()
    env = os.environ.get("PLAID_ENV", "sandbox").strip().lower()
    return cid, sec, env, PLAID_BASES.get(env, PLAID_BASES["sandbox"])


def _require_plaid():
    cid, sec, env, base = _plaid_cfg()
    if not cid or not sec:
        raise HTTPException(503, "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET (see PLAID_SETUP.md).")
    return cid, sec, env, base


def _fernet() -> Fernet:
    key = os.environ.get("TOKEN_ENCRYPTION_KEY", "").strip()
    if not key:
        raise HTTPException(503, "TOKEN_ENCRYPTION_KEY is not set. Generate one and set it (see PLAID_SETUP.md).")
    try:
        return Fernet(key.encode())
    except Exception:
        raise HTTPException(500, "TOKEN_ENCRYPTION_KEY is not a valid Fernet key.")


async def _plaid_post(base: str, path: str, payload: dict, cid: str, sec: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(base + path, json={**payload, "client_id": cid, "secret": sec})
    if r.status_code != 200:
        detail = r.text[:300]
        try:
            detail = r.json().get("error_message", detail)
        except Exception:
            pass
        raise HTTPException(502, f"Plaid error: {detail}")
    return r.json()


async def _auto_match(p: Principal, d: str, amt: float):
    """Same auto-match as the CSV import: journal cash/bank line, same date + amount."""
    side = "debit_cents" if amt > 0 else "credit_cents"
    cents = abs(int(round(amt * 100)))
    return await db.journal_entries.find_one(
        {"tenant_id": p.tenant_id, "date": d,
         "lines": {"$elemMatch": {"account": {"$in": ["1000", "1010"]}, side: cents}}},
        {"_id": 0, "id": 1, "memo": 1})


@router.get("/status")
async def status(p: Principal = Depends(require("report:read"))):
    cid, sec, env, _ = _plaid_cfg()
    conns = await db.bank_connections.find(
        {"tenant_id": p.tenant_id},
        {"_id": 0, "tenant_id": 0, "access_token_enc": 0}).sort("created_at", -1).to_list(50)
    return {"configured": bool(cid and sec), "env": env, "connections": conns}


@router.post("/link-token")
async def link_token(p: Principal = Depends(require("txn:adjust"))):
    cid, sec, env, base = _require_plaid()
    data = await _plaid_post(base, "/link/token/create", {
        "client_name": "Ledger",
        "country_codes": ["US"],
        "language": "en",
        "user": {"client_user_id": f"{p.tenant_id}:{p.user_id}"},
        "products": ["transactions"],
    }, cid, sec)
    return {"link_token": data["link_token"], "env": env}


@router.post("/exchange")
async def exchange(body: ExchangeIn, p: Principal = Depends(require("txn:adjust"))):
    cid, sec, env, base = _require_plaid()
    f = _fernet()
    data = await _plaid_post(base, "/item/public_token/exchange", {"public_token": body.public_token}, cid, sec)
    access_token, item_id = data["access_token"], data["item_id"]
    accts = await _plaid_post(base, "/accounts/get", {"access_token": access_token}, cid, sec)
    accounts = [{"account_id": a.get("account_id"), "name": a.get("name"), "mask": a.get("mask"),
                 "type": a.get("type"), "subtype": a.get("subtype")}
                for a in accts.get("accounts", [])]
    inst = (accts.get("item") or {})
    conn_id = str(uuid.uuid4())
    await db.bank_connections.insert_one({
        "tenant_id": p.tenant_id, "id": conn_id, "item_id": item_id,
        "access_token_enc": f.encrypt(access_token.encode()).decode(),
        "institution": inst.get("institution_id", ""), "accounts": accounts,
        "cursor": "", "last_sync": "", "created_at": now_iso(),
    })
    await audit(p, "bankfeed.connect", "bank_connection", conn_id, {"accounts": len(accounts)})
    return {"connection_id": conn_id, "accounts": accounts}


@router.post("/sync")
async def sync(body: SyncIn, p: Principal = Depends(require("txn:adjust"))):
    cid, sec, env, base = _require_plaid()
    f = _fernet()
    q: dict = {"tenant_id": p.tenant_id}
    if body.connection_id:
        q["id"] = body.connection_id
    conns = await db.bank_connections.find(q).to_list(50)
    if not conns:
        raise HTTPException(404, "No bank connection found. Connect a bank first.")
    added = matched = dups = 0
    for conn in conns:
        try:
            access_token = f.decrypt(conn["access_token_enc"].encode()).decode()
        except Exception:
            raise HTTPException(500, "Could not decrypt a stored bank token. Check TOKEN_ENCRYPTION_KEY.")
        cursor = conn.get("cursor") or ""
        while True:
            data = await _plaid_post(base, "/transactions/sync",
                                     {"access_token": access_token, "cursor": cursor, "count": 500},
                                     cid, sec)
            for t in data.get("added", []) + data.get("modified", []):
                # Plaid convention: positive amount = money OUT. Our ledger: positive = money IN.
                amt = money(-float(t.get("amount") or 0))
                d = (t.get("date") or "")[:10]
                desc = (t.get("merchant_name") or t.get("name") or "").strip()
                key = f"plaid|{t.get('transaction_id')}"[:200]
                if await db.bank_txns.find_one({"tenant_id": p.tenant_id, "dedupe": key}):
                    dups += 1
                    continue
                match = await _auto_match(p, d, amt)
                pfc = t.get("personal_finance_category") or {}
                await db.bank_txns.insert_one({
                    "tenant_id": p.tenant_id, "id": str(uuid.uuid4()), "account": "1010",
                    "date": d, "description": desc, "amount": amt, "dedupe": key,
                    "source": "plaid", "plaid_account_id": t.get("account_id"),
                    "plaid_category": pfc.get("primary") if isinstance(pfc, dict) else None,
                    "pending": bool(t.get("pending")),
                    "status": "matched" if match else "unmatched",
                    "matched_entry": match["id"] if match else None, "created_at": now_iso()})
                added += 1
                if match:
                    matched += 1
            cursor = data.get("next_cursor", cursor)
            if not data.get("has_more"):
                break
        await db.bank_connections.update_one(
            {"tenant_id": p.tenant_id, "id": conn["id"]},
            {"$set": {"cursor": cursor, "last_sync": now_iso()}})
    await audit(p, "bankfeed.sync", "tenant", p.tenant_id, {"added": added, "matched": matched})
    return {"added": added, "matched": matched, "duplicates": dups}


@router.post("/webhook")
async def webhook(request: Request):
    """Plaid transaction webhooks (TRANSACTIONS SYNC_UPDATES etc.). Logged here;
    the next /sync (manual or cron) pulls the actual changes."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    await db.bank_webhooks.insert_one({
        "webhook_type": body.get("webhook_type"), "webhook_code": body.get("webhook_code"),
        "item_id": body.get("item_id"), "received_at": now_iso(), "raw": str(body)[:2000]})
    return {"ok": True}


@router.delete("/connection/{conn_id}")
async def disconnect(conn_id: str, p: Principal = Depends(require("txn:adjust"))):
    conn = await db.bank_connections.find_one({"tenant_id": p.tenant_id, "id": conn_id})
    if not conn:
        raise HTTPException(404, "Connection not found")
    try:  # best-effort: revoke at Plaid too
        cid, sec, env, base = _require_plaid()
        f = _fernet()
        await _plaid_post(base, "/item/remove",
                          {"access_token": f.decrypt(conn["access_token_enc"].encode()).decode()},
                          cid, sec)
    except Exception:
        pass
    await db.bank_connections.delete_one({"tenant_id": p.tenant_id, "id": conn_id})
    await audit(p, "bankfeed.disconnect", "bank_connection", conn_id, {})
    return {"ok": True}
