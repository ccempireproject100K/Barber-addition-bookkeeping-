"""Phase 1 tests: money accuracy, idempotency, failure recovery, concurrency, payments, entitlements, security, roles,
cash close. Runs against the live backend (see conftest.py) with the seeded demo data (python seed.py)."""

import asyncio
import hashlib
import hmac
import json
import os
import time
import uuid

import httpx
import pytest

from tests.conftest import API_URL

OWNER = ("demo@example.invalid", "Owner123!")
BARBER = ("demo@example.invalid", "Barber123!")
OTHER_OWNER = ("demo@example.invalid", "Owner123!")
ORIGIN = {"Origin": "http://localhost:8001"}


def login(creds) -> httpx.Client:
    c = httpx.Client(base_url=API_URL, timeout=30.0, headers=ORIGIN)
    r = c.post("/auth/login", json={"email": creds[0], "password": creds[1]})
    assert r.status_code == 200, r.text
    return c


def new_workspace() -> tuple[httpx.Client, str]:
    c = httpx.Client(base_url=API_URL, timeout=30.0, headers=ORIGIN)
    email = f"t{uuid.uuid4().hex[:10]}@test.example"
    r = c.post("/auth/signup", json={"company_name": "Test Shop", "name": "Tess", "email": email, "password": "Passw0rd!x"})
    assert r.status_code == 200
    return c, email


def retail_product(c: httpx.Client, qty: int = 3) -> dict:
    r = c.post("/inventory/products", json={"name": f"P-{uuid.uuid4().hex[:6]}", "type": "retail", "sell_price": 10.005,
                                            "opening_unit_cost": 3.333, "reorder_point": 0, "tracking_mode": "none", "unit": "each"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    r = c.post("/inventory/stock/restock", json={"product_id": pid, "quantity": qty, "unit_cost": 3.335, "record_expense": True})
    assert r.status_code == 200, r.text
    return prod_of(c, pid)


def prod_of(c, pid):
    d = c.get(f"/inventory/products/{pid}").json()
    return d.get("product", d)


def txn_by_id(c, tid):
    return next((t for t in c.get("/transactions").json() if t["id"] == tid), None)


# ---------- money ----------
def test_decimal_half_up_rounding_and_capitalized_restock():
    c = login(OWNER)
    r = c.post("/transactions", json={"kind": "income", "category": "Services", "amount": 2.675, "date": "2026-01-02", "payment_method": "cash"})
    assert r.json()["amount"] == 2.68  # float round(2.675, 2) gives 2.67
    prod = retail_product(c, 3)
    restock_txn = [t for t in c.get("/transactions?kind=expense").json() if prod["name"] in t["description"]][0]
    assert restock_txn["amount"] == 10.01 and restock_txn["capitalized"] is True  # 3 x 3.335 = 10.005 -> 10.01


def test_pnl_bases_never_double_count_inventory():
    c = login(OWNER)
    rng = "start=2020-01-01&end=2099-12-31"
    cash, acc = c.get(f"/reports/pnl?{rng}&basis=cash").json(), c.get(f"/reports/pnl?{rng}&basis=accrual").json()
    assert cash["basis"] == "cash" and acc["basis"] == "accrual"
    assert cash["total_income"] == acc["total_income"]
    capitalized = round(sum(t["amount"] for t in c.get("/transactions?kind=expense").json() if t["capitalized"]), 2)
    assert abs(acc["inventory_purchases_excluded"] - capitalized) < 0.02
    # accrual expenses = cash expenses - purchases + COGS/usage (each counted once)
    assert abs(acc["total_expenses"] - (cash["total_expenses"] - capitalized + acc["cogs_deducted"])) < 0.05
    assert not any(e["category"] == "Cost of goods sold" for e in cash["expenses"])
    assert c.get(f"/reports/pnl?basis=weird").status_code == 422


# ---------- idempotency + recovery ----------
def test_checkout_retry_with_same_key_posts_once():
    c = login(OWNER)
    prod = retail_product(c, 5)
    key = uuid.uuid4().hex
    body = {"lines": [{"product_id": prod["id"], "quantity": 2, "unit_price": 10}], "payment_method": "cash"}
    r1 = c.post("/inventory/stock/checkout", json=body, headers={"Idempotency-Key": key})
    r2 = c.post("/inventory/stock/checkout", json=body, headers={"Idempotency-Key": key})
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["transaction_id"] == r2.json()["transaction_id"]
    assert prod_of(c, prod["id"])["quantity_on_hand"] == 3
    sales = [t for t in c.get("/transactions?kind=income").json() if t["id"] == r1.json()["transaction_id"]]
    assert len(sales) == 1 and sales[0]["payment_method"] == "cash" and sales[0]["processor"] == "recorded"


def test_crash_between_writes_rolls_forward_and_blocks_double_post():
    c = login(OWNER)
    prod = retail_product(c, 4)
    key = uuid.uuid4().hex
    body = {"lines": [{"product_id": prod["id"], "quantity": 1, "unit_price": 10}], "payment_method": "cash"}
    r = c.post("/inventory/stock/checkout", json=body, headers={"Idempotency-Key": key, "X-Test-Fault": "after_movements"})
    assert r.status_code == 500 and "request_id" in r.json()
    assert prod_of(c, prod["id"])["quantity_on_hand"] == 3  # movement landed, income missing
    assert c.post("/inventory/stock/checkout", json=body, headers={"Idempotency-Key": key}).status_code == 409  # retry can't double-post
    rec = c.post("/ops/recover?min_age_seconds=0").json()
    assert rec["rolled_forward"] >= 1
    mv = c.get(f"/inventory/movements?product_id={prod['id']}&type=sale").json()[0]
    t = txn_by_id(c, mv["linked_transaction_id"])
    assert t and t["amount"] == 10.0  # income now matches the stock movement
    assert prod_of(c, prod["id"])["quantity_on_hand"] == 3


def test_partial_checkout_failure_rolls_back_stock():
    c = login(OWNER)
    a, b = retail_product(c, 2), retail_product(c, 1)
    body = {"lines": [{"product_id": a["id"], "quantity": 1, "unit_price": 10}, {"product_id": b["id"], "quantity": 1, "unit_price": 10},
                      {"product_id": b["id"], "quantity": 1, "unit_price": 10}], "payment_method": "cash"}
    r = c.post("/inventory/stock/checkout", json=body)
    assert r.status_code == 409
    assert prod_of(c, a["id"])["quantity_on_hand"] == 2
    assert prod_of(c, b["id"])["quantity_on_hand"] == 1


@pytest.mark.asyncio
async def test_concurrent_last_unit_one_success():
    c = login(OWNER)
    prod = retail_product(c, 1)
    body = {"lines": [{"product_id": prod["id"], "quantity": 1, "unit_price": 10}], "payment_method": "cash"}
    async with httpx.AsyncClient(base_url=API_URL, cookies=c.cookies, headers=ORIGIN, timeout=30) as ac:
        rs = await asyncio.gather(*[ac.post("/inventory/stock/checkout", json=body) for _ in range(6)])
    codes = sorted(r.status_code for r in rs)
    assert codes.count(200) == 1 and all(x == 409 for x in codes if x != 200), codes
    assert prod_of(c, prod["id"])["quantity_on_hand"] == 0


# ---------- Stripe webhook ----------
def _signed(payload: dict) -> tuple[bytes, str]:
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET") or open("/app/backend/.env").read().split("STRIPE_WEBHOOK_SECRET=")[1].split("\n")[0].strip().strip('"')
    body = json.dumps(payload).encode()
    ts = str(int(time.time()))
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return body, f"t={ts},v1={sig}"


def _sub_event(tid: str, status: str, created: int, eid: str | None = None) -> dict:
    return {"id": eid or f"evt_{uuid.uuid4().hex}", "object": "event", "type": "customer.subscription.updated", "created": created,
            "data": {"object": {"id": f"sub_{tid[:8]}", "object": "subscription", "status": status, "customer": "cus_test",
                                "metadata": {"tenant_id": tid}, "current_period_end": created + 2592000, "cancel_at_period_end": False}}}


def post_event(evt: dict) -> httpx.Response:
    body, sig = _signed(evt)
    return httpx.post(f"{API_URL}/stripe/webhook", content=body, headers={"stripe-signature": sig, "Content-Type": "application/json"})


def test_entitlements_only_from_verified_events():
    c, _ = new_workspace()
    me = c.get("/auth/me").json()
    tid = me["tenant_id"]
    assert me["access"] == "none" and me["inventory_enabled"] is False
    s = c.get("/settings").json()
    r = c.put("/settings", json={**s, "inventory_enabled": True})
    assert r.status_code == 402  # can't unlock a paid add-on via settings
    assert c.get("/inventory/products").status_code == 404
    bad = httpx.post(f"{API_URL}/stripe/webhook", content=json.dumps(_sub_event(tid, "active", 1)).encode(), headers={"stripe-signature": "t=1,v1=bad"})
    assert bad.status_code == 400
    now = int(time.time())
    ev = _sub_event(tid, "active", now)
    assert post_event(ev).json()["status"] == "ok"
    assert post_event(ev).json()["status"] == "duplicate"  # redelivery is a no-op
    assert c.put("/settings", json={**s, "inventory_enabled": True}).status_code == 200
    assert c.get("/auth/me").json()["inventory_enabled"] is True
    post_event(_sub_event(tid, "past_due", now + 10))  # failed payment
    assert c.get("/auth/me").json()["inventory_enabled"] is False
    post_event(_sub_event(tid, "active", now + 5))  # older event arriving late is ignored
    assert c.get("/billing").json()["status"] == "past_due"
    post_event(_sub_event(tid, "canceled", now + 20))
    b = c.get("/billing").json()
    assert b["status"] == "canceled" and b["entitlements"]["inventory"] is False and b["test_mode"] is True


# ---------- security ----------
def test_login_rate_limit_and_password_reset_single_use():
    c, email = new_workspace()
    anon = httpx.Client(base_url=API_URL, timeout=30)
    codes = [anon.post("/auth/login", json={"email": email, "password": "wrong"}).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429
    r = anon.post("/auth/password-reset/request", json={"email": email})
    assert r.status_code == 429  # same throttle
    import pymongo
    if os.environ.get("MONGO_URL") and os.environ.get("DB_NAME"):
        env = {key: os.environ[key] for key in ("MONGO_URL", "DB_NAME")}
    else:
        env = dict(l.split("=", 1) for l in open("/app/backend/.env").read().splitlines() if "=" in l)
    mdb = pymongo.MongoClient(env["MONGO_URL"].strip('"'))[env["DB_NAME"].strip('"')]
    mdb.login_attempts.delete_many({"email": email})
    assert anon.post("/auth/password-reset/request", json={"email": email}).status_code == 200
    assert anon.post("/auth/password-reset/request", json={"email": "demo@example.invalid"}).json()["message"] == r.json().get("message", anon.post("/auth/password-reset/request", json={"email": email}).json()["message"])
    # inject a known token (the emailed/logged token is random; we test the confirm contract)
    tok = uuid.uuid4().hex + uuid.uuid4().hex
    uid = mdb.users.find_one({"email": email})["id"]
    from datetime import datetime, timedelta, timezone
    mdb.password_resets.insert_one({"token_hash": hashlib.sha256(tok.encode()).hexdigest(), "user_id": uid, "used": False,
                                    "expires_dt": datetime.now(timezone.utc) + timedelta(hours=1)})
    assert anon.post("/auth/password-reset/confirm", json={"token": tok, "password": "NewPassw0rd!"}).status_code == 200
    assert anon.post("/auth/password-reset/confirm", json={"token": tok, "password": "Other123!x"}).status_code == 400
    assert c.get("/auth/me").status_code == 401  # old session revoked
    assert anon.post("/auth/login", json={"email": email, "password": "NewPassw0rd!"}).status_code == 200


def test_csrf_cross_site_write_blocked():
    c = login(OWNER)
    r = c.post("/transactions", headers={"Origin": "https://evil.example"},
               json={"kind": "income", "category": "X", "amount": 1, "date": "2026-01-01"})
    assert r.status_code == 403


def test_every_private_route_requires_auth():
    spec = httpx.get(f"{API_URL[:-4]}/openapi.json").json()
    public = {"/api/", "/api/health", "/api/auth/login", "/api/auth/signup", "/api/auth/google", "/api/auth/logout",
              "/api/auth/password-reset/request", "/api/auth/password-reset/confirm", "/api/stripe/webhook", "/api/po-action",
              "/api/game/{tenant_id}", "/api/game/{tenant_id}/score", "/api/payments/status/{session_id}"}
    leaks = []
    for path, ops in spec["paths"].items():
        if path in public or path.startswith("/api/cron/"):
            continue
        url = API_URL[:-4] + path.replace("{", "").replace("}", "")
        for method in ops:
            r = httpx.request(method.upper(), url, json={}, timeout=15)
            if r.status_code not in (401, 403, 404, 405):
                leaks.append((method, path, r.status_code))
    assert not leaks, leaks


def test_tenant_isolation_on_new_endpoints():
    owner, other = login(OWNER), login(OTHER_OWNER)
    t = owner.post("/transactions", json={"kind": "income", "category": "Services", "amount": 5, "date": "2026-01-03"}).json()
    assert other.post(f"/transactions/{t['id']}/reverse", json={"reason": "nope nope"}).status_code == 404
    assert all(x["id"] != t["id"] for x in other.get("/transactions").json())
    assert t["id"] not in other.get("/exports/transactions.csv").text
    assert all(a.get("entity_id") != t["id"] for a in other.get("/audit").json())


# ---------- roles + corrections ----------
def test_accountant_and_bookkeeper_scopes():
    owner = login(OWNER)
    made = {}
    for role in ("accountant", "bookkeeper"):
        email = f"{role}{uuid.uuid4().hex[:6]}@fadeco.example"
        assert owner.post("/team", json={"name": role.title(), "email": email, "password": "Acct12345!", "role": role, "commission_rate": 0}).status_code == 200
        made[role] = login((email, "Acct12345!"))
    acc, bk = made["accountant"], made["bookkeeper"]
    for c in (acc, bk):
        assert c.get("/reports/pnl").status_code == 200
        assert c.get("/exports/transactions.csv").status_code == 200
        assert c.get("/audit").status_code == 200
        assert c.get("/settings").status_code == 403
        assert c.put("/settings", json={}).status_code in (403, 422)
        assert c.get("/clients").status_code == 403
        assert c.post("/inventory/stock/checkout", json={"lines": [{"product_id": "x", "quantity": 1, "unit_price": 1}]}).status_code == 403
        assert c.post("/transactions", json={"kind": "income", "category": "X", "amount": 1, "date": "2026-01-01"}).status_code == 403
    t = owner.post("/transactions", json={"kind": "expense", "category": "Rent", "amount": 100, "date": "2026-01-04"}).json()
    assert acc.post(f"/transactions/{t['id']}/reverse", json={"reason": "duplicate entry"}).status_code == 403
    r = bk.post(f"/transactions/{t['id']}/reverse", json={"reason": "duplicate entry"})
    assert r.status_code == 200 and r.json()["amount"] == -100 and r.json()["reversal_of"] == t["id"]
    assert bk.post(f"/transactions/{t['id']}/reverse", json={"reason": "again"}).status_code == 409
    assert any(a["action"] == "txn.reverse" and a["entity_id"] == t["id"] for a in owner.get("/audit").json())


# ---------- cash close ----------
def test_cash_close_math_explanation_review_lock():
    owner, _ = new_workspace()  # fresh workspace so the test is re-runnable (approved days lock)
    bemail = f"b{uuid.uuid4().hex[:8]}@test.example"
    assert owner.post("/team", json={"name": "Bea", "email": bemail, "password": "Barber123!x", "role": "staff", "commission_rate": 10}).status_code == 200
    barber = login((bemail, "Barber123!x"))
    day = __import__("datetime").date.today().isoformat()
    owner.post("/transactions", json={"kind": "income", "category": "Services", "amount": 40, "date": day, "payment_method": "cash"})
    owner.post("/transactions", json={"kind": "income", "category": "Services", "amount": 99, "date": day, "payment_method": "card"})
    pv = barber.get(f"/cash-closes/preview?day={day}").json()
    sales = pv["cash_sales"]
    assert sales >= 40
    exp = round(100 + sales - pv["cash_refunds"] - pv["cash_expenses"] + 5 - 12.5, 2)
    body = {"date": day, "opening_float": 100, "counted_cash": exp - 3, "drawer_moves": [{"kind": "paid_in", "amount": 5, "reason": "change"},
            {"kind": "paid_out", "amount": 12.5, "reason": "milk"}], "explanation": ""}
    assert barber.post("/cash-closes", json=body).status_code == 400  # short by $3, needs explanation
    r = barber.post("/cash-closes", json={**body, "explanation": "Gave wrong change to a client"})
    assert r.status_code == 200, r.text
    cc = r.json()
    assert cc["expected_cash"] == exp and cc["discrepancy"] == -3.0 and cc["status"] == "submitted"
    assert barber.post(f"/cash-closes/{cc['id']}/review", json={"approve": True}).status_code == 403
    assert owner.post(f"/cash-closes/{cc['id']}/review", json={"approve": True, "note": "ok"}).json()["status"] == "approved"
    assert barber.post("/cash-closes", json={**body, "explanation": "edit"}).status_code == 409  # locked
    acts = [a["action"] for a in owner.get("/audit?action=cash_close").json()]
    assert "cash_close.submit" in acts and "cash_close.approved" in acts
