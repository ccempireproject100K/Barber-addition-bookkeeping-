"""Tax + 1099s: contractor tracking, W-9 status, year summaries, e-file via TaxBandits.

SCOPE LIMITS:
- No in-house IRS e-filing. Filing goes through the TaxBandits API only.
- Without TAXBANDITS_* env keys, e-file endpoints return 503 with setup
  instructions (see TAXBANDITS_SETUP.md).
- Contractor tax IDs are stored as entered; field-level encryption lands in
  the security-hardening batch (it migrates the `tax_id` field in place).
"""

import os
import uuid
from datetime import datetime, timezone

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso
from lib.money import money
from lib.repo import Scoped

router = APIRouter(prefix="/tax")

THRESHOLD = 600.0
# Corps (C/S) generally don't receive 1099-NEC; everyone else might.
EXEMPT_ENTITIES = {"c_corp", "s_corp"}


# ---------------------------------------------------------------- contractors

class AddressIn(BaseModel):
    street: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""


class ContractorIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(default="", max_length=160)
    phone: str = Field(default="", max_length=40)
    business_name: str = Field(default="", max_length=160)
    entity_type: str = Field(default="individual",
                             pattern=r"^(individual|sole_prop|llc|c_corp|s_corp|partnership|trust)$")
    tax_id: str = Field(default="", max_length=20)  # SSN/EIN; encrypted at rest in the security-hardening batch
    address: AddressIn = AddressIn()


class W9In(BaseModel):
    received: bool


def _strip(c: dict, year_total: float = 0) -> dict:
    return {
        "id": c["id"], "name": c["name"], "email": c.get("email", ""), "phone": c.get("phone", ""),
        "business_name": c.get("business_name", ""), "entity_type": c.get("entity_type", "individual"),
        "tax_id_last4": (c.get("tax_id") or "")[-4:], "address": c.get("address", {}),
        "w9_received": c.get("w9_received", False), "w9_received_date": c.get("w9_received_date"),
        "year_total": year_total,
        "needs_1099": year_total >= THRESHOLD and c.get("entity_type") not in EXEMPT_ENTITIES,
        "efile": c.get("efile", {}),
    }


async def _year_total(p: Principal, contractor_id: str, year: int) -> float:
    total = 0.0
    async for pay in Scoped("contractor_payments", p).c.find(
            {"tenant_id": p.tenant_id, "contractor_id": contractor_id,
             "date": {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"}},
            {"_id": 0, "amount": 1}):
        total += float(pay["amount"])
    return money(total)


@router.get("/contractors")
async def list_contractors(year: int = Query(datetime.now(timezone.utc).year),
                           p: Principal = Depends(require("tax:read"))):
    out = []
    for c in await Scoped("contractors", p).find().sort("name", 1):
        out.append(_strip(c, await _year_total(p, c["id"], year)))
    return out


@router.post("/contractors")
async def create_contractor(body: ContractorIn, p: Principal = Depends(require("tax:write"))):
    doc = {"id": str(uuid.uuid4()), **body.model_dump(), "w9_received": False,
           "w9_received_date": None, "efile": {}, "created_at": now_iso()}
    await Scoped("contractors", p).insert(doc)
    await audit(p, "tax.contractor.create", "contractor", doc["id"], {"name": doc["name"]})
    return _strip(doc)


@router.put("/contractors/{cid}")
async def update_contractor(cid: str, body: ContractorIn, p: Principal = Depends(require("tax:write"))):
    doc = await Scoped("contractors", p).update({"id": cid}, {"$set": body.model_dump()})
    if not doc:
        raise HTTPException(404, "Contractor not found")
    await audit(p, "tax.contractor.update", "contractor", cid, {})
    return _strip(doc)


@router.delete("/contractors/{cid}")
async def delete_contractor(cid: str, p: Principal = Depends(require("tax:write"))):
    n = await Scoped("contractors", p).delete({"id": cid})
    if not n:
        raise HTTPException(404, "Contractor not found")
    await audit(p, "tax.contractor.delete", "contractor", cid, {})
    return {"ok": True}


@router.post("/contractors/{cid}/w9")
async def set_w9(cid: str, body: W9In, p: Principal = Depends(require("tax:write"))):
    doc = await Scoped("contractors", p).update(
        {"id": cid},
        {"$set": {"w9_received": body.received,
                  "w9_received_date": now_iso()[:10] if body.received else None}})
    if not doc:
        raise HTTPException(404, "Contractor not found")
    await audit(p, "tax.w9", "contractor", cid, {"received": body.received})
    return _strip(doc)


# ---------------------------------------------------------------- payments

class PaymentIn(BaseModel):
    date: str
    amount: float = Field(gt=0)
    description: str = Field(default="", max_length=200)


@router.get("/contractors/{cid}/payments")
async def list_payments(cid: str, year: int = Query(datetime.now(timezone.utc).year),
                        p: Principal = Depends(require("tax:read"))):
    return await Scoped("contractor_payments", p).c.find(
        {"tenant_id": p.tenant_id, "contractor_id": cid,
         "date": {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"}},
        {"_id": 0}).sort("date", 1).to_list(2000)


@router.post("/contractors/{cid}/payments")
async def add_payment(cid: str, body: PaymentIn, p: Principal = Depends(require("tax:write"))):
    if not await Scoped("contractors", p).find_one({"id": cid}):
        raise HTTPException(404, "Contractor not found")
    doc = {"id": str(uuid.uuid4()), "contractor_id": cid, "date": body.date,
           "amount": money(body.amount), "description": body.description, "created_at": now_iso()}
    await Scoped("contractor_payments", p).insert(doc)
    await audit(p, "tax.payment.add", "contractor", cid, {"amount": doc["amount"], "date": body.date})
    return doc


@router.delete("/payments/{pid}")
async def delete_payment(pid: str, p: Principal = Depends(require("tax:write"))):
    n = await Scoped("contractor_payments", p).delete({"id": pid})
    if not n:
        raise HTTPException(404, "Payment not found")
    await audit(p, "tax.payment.delete", "contractor_payment", pid, {})
    return {"ok": True}


# ---------------------------------------------------------------- year summary

@router.get("/summary")
async def year_summary(year: int = Query(datetime.now(timezone.utc).year),
                       p: Principal = Depends(require("tax:read"))):
    contractors = []
    reportable = 0.0
    missing_w9 = []
    for c in await Scoped("contractors", p).find().sort("name", 1):
        total = await _year_total(p, c["id"], year)
        row = _strip(c, total)
        contractors.append(row)
        if row["needs_1099"]:
            reportable += total
            if not row["w9_received"]:
                missing_w9.append(row["name"])
    return {"year": year, "threshold": THRESHOLD, "contractors": contractors,
            "required_count": sum(1 for r in contractors if r["needs_1099"]),
            "reportable_total": money(reportable), "missing_w9": missing_w9}


# ---------------------------------------------------------------- TaxBandits e-file

def _tb_conf() -> dict:
    conf = {k: os.environ.get(k, "").strip() for k in
            ("TAXBANDITS_CLIENT_ID", "TAXBANDITS_CLIENT_SECRET", "TAXBANDITS_USER_TOKEN",
             "TAXBANDITS_BUSINESS_ID")}
    if not all(conf.values()):
        raise HTTPException(
            503, "TaxBandits is not configured. Set TAXBANDITS_CLIENT_ID, TAXBANDITS_CLIENT_SECRET, "
                 "TAXBANDITS_USER_TOKEN and TAXBANDITS_BUSINESS_ID — see TAXBANDITS_SETUP.md.")
    sandbox = os.environ.get("TAXBANDITS_SANDBOX", "true").lower() != "false"
    conf["base"] = "https://testapi.taxbandits.com/v2" if sandbox else "https://api.taxbandits.com/v2"
    conf["sandbox"] = sandbox
    return conf


async def _tb_token(conf: dict) -> str:
    """OAuth2 client-assertion flow per TaxBandits docs (JWT signed with client secret).

    Follows https://developer.taxbandits.com/docs/OAuth2.0Authentication — the
    token endpoint returns a Bearer token used on all subsequent calls. Any
    TaxBandits-side error is surfaced verbatim so credential/plan issues are visible.
    """
    now = int(datetime.now(timezone.utc).timestamp())
    assertion = jwt.encode(
        {"iss": conf["TAXBANDITS_CLIENT_ID"], "sub": conf["TAXBANDITS_CLIENT_ID"],
         "aud": f"{conf['base']}/OAuth/Token", "iat": now, "exp": now + 300},
        conf["TAXBANDITS_CLIENT_SECRET"], algorithm="HS256")
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{conf['base']}/OAuth/Token", json={
            "grant_type": "client_credentials",
            "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            "client_assertion": assertion,
            "user_token": conf["TAXBANDITS_USER_TOKEN"]})
    if r.status_code != 200:
        raise HTTPException(502, f"TaxBandits auth failed ({r.status_code}): {r.text[:300]}")
    token = r.json().get("AccessToken") or r.json().get("access_token")
    if not token:
        raise HTTPException(502, f"TaxBandits auth returned no token: {r.text[:300]}")
    return token


async def _tb_call(method: str, path: str, conf: dict, token: str, payload: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.request(method, f"{conf['base']}{path}", json=payload,
                            headers={"Authorization": f"Bearer {token}"})
    if r.status_code >= 400:
        raise HTTPException(502, f"TaxBandits {path} failed ({r.status_code}): {r.text[:500]}")
    return r.json()


@router.get("/taxbandits/status")
async def tb_status(p: Principal = Depends(require("tax:read"))):
    try:
        conf = _tb_conf()
    except HTTPException:
        return {"configured": False, "sandbox": True}
    return {"configured": True, "sandbox": conf["sandbox"]}


@router.post("/efile-1099/{cid}")
async def efile_1099(cid: str, year: int = Query(datetime.now(timezone.utc).year),
                     p: Principal = Depends(require("tax:write"))):
    """Create a 1099-NEC in TaxBandits for this contractor (does NOT transmit —
    review and transmit inside TaxBandits)."""
    c = await Scoped("contractors", p).find_one({"id": cid})
    if not c:
        raise HTTPException(404, "Contractor not found")
    total = await _year_total(p, cid, year)
    if total < THRESHOLD:
        raise HTTPException(400, f"Total ${total:,.2f} is under the ${THRESHOLD:,.0f} reporting threshold")
    if not c.get("w9_received"):
        raise HTTPException(400, "Collect the contractor's W-9 before e-filing")
    conf = _tb_conf()
    token = await _tb_token(conf)
    addr = c.get("address") or {}
    payload = {
        "BusinessId": conf["TAXBANDITS_BUSINESS_ID"],
        "TaxYear": year,
        "Recipient": {
            "Name": c["name"],
            "TIN": c.get("tax_id", ""),
            "Email": c.get("email", ""),
            "Address": {"Address1": addr.get("street", ""), "City": addr.get("city", ""),
                        "State": addr.get("state", ""), "ZipCd": addr.get("zip", "")},
        },
        "Form1099NEC": {"Box1 NEC": total},
    }
    resp = await _tb_call("POST", "/Form1099NEC/Create", conf, token, payload)
    rec = (resp.get("Form1099Records") or [{}])[0]
    efile = {"submission_id": resp.get("SubmissionId"), "record_id": rec.get("RecordId"),
             "status": rec.get("RecordStatus") or resp.get("Status", "created"),
             "year": year, "amount": total, "sandbox": conf["sandbox"], "updated_at": now_iso()}
    await Scoped("contractors", p).update({"id": cid}, {"$set": {"efile": efile}})
    await audit(p, "tax.efile.create", "contractor", cid, {"year": year, "amount": total})
    return {"ok": True, "efile": efile,
            "note": "Created in TaxBandits — review and Transmit inside TaxBandits to file with the IRS."}


@router.get("/efile-1099/{cid}/status")
async def efile_status(cid: str, p: Principal = Depends(require("tax:read"))):
    c = await Scoped("contractors", p).find_one({"id": cid})
    if not c:
        raise HTTPException(404, "Contractor not found")
    efile = c.get("efile") or {}
    if not efile.get("submission_id"):
        return {"efile": efile}
    conf = _tb_conf()
    token = await _tb_token(conf)
    resp = await _tb_call("GET", f"/Form1099NEC/Status?SubmissionId={efile['submission_id']}", conf, token)
    efile["status"] = resp.get("Status") or efile.get("status")
    efile["updated_at"] = now_iso()
    await Scoped("contractors", p).update({"id": cid}, {"$set": {"efile": efile}})
    return {"efile": efile}
