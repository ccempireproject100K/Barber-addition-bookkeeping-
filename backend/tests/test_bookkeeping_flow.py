"""End-to-end backend tests for the double-entry bookkeeping layer.

Covers: auth, chart of accounts, trial balance / balance sheet balancing, full invoice sales flow
(partial + final payment w/ processing fee), inventory decrement, COGS posting, refund (contra-revenue),
void, service-only invoice (no stock change), expenses + vendors, cross-tenant isolation, manual journal
balanced + unbalanced, CSV export.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"


def _login(email, pw):
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": email, "password": pw}, timeout=20)
    assert r.status_code == 200, f"login failed {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def owner1():
    return _login("owner1@test.com", "Passw0rd!")


@pytest.fixture(scope="module")
def owner2():
    return _login("owner2@test.com", "Passw0rd!")


# ---------- Auth / basics ----------
def test_login_and_me(owner1):
    r = owner1.get(f"{API}/auth/me", timeout=10)
    assert r.status_code == 200
    j = r.json()
    assert j["email"] == "owner1@test.com"
    assert j["tenant_name"] == "Shop One"


def test_chart_of_accounts(owner1):
    r = owner1.get(f"{API}/books/accounts")
    assert r.status_code == 200
    codes = {a["code"] for a in r.json()}
    for c in ("1000", "1100", "1200", "2100", "2200", "4000", "4010", "4900", "4910", "5000", "6200"):
        assert c in codes, f"missing account {c}"


# ---------- Reports: reconciliation ----------
def test_trial_balance_balanced(owner1):
    r = owner1.get(f"{API}/books/trial-balance")
    assert r.status_code == 200
    j = r.json()
    assert abs(j["total_debit"] - j["total_credit"]) < 0.01
    assert j["balanced"] is True


def test_balance_sheet_balanced(owner1):
    r = owner1.get(f"{API}/books/balance-sheet")
    assert r.status_code == 200
    j = r.json()
    assert abs(j["total_assets"] - (j["total_liabilities"] + j["total_equity"])) < 0.01
    assert j["balanced"] is True


def test_ar_aging_reconciled(owner1):
    r = owner1.get(f"{API}/books/ar-aging")
    assert r.status_code == 200
    assert r.json()["reconciled"] is True


def test_inventory_valuation_reconciled(owner1):
    r = owner1.get(f"{API}/books/inventory-valuation")
    assert r.status_code == 200
    assert r.json()["reconciled"] is True


def test_csv_export(owner1):
    r = owner1.get(f"{API}/books/trial-balance?format=csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    assert "attachment" in r.headers.get("content-disposition", "")
    assert "code" in r.text.splitlines()[0]


# ---------- Full sales flow ----------
@pytest.fixture(scope="module")
def retail_product(owner1):
    r = owner1.get(f"{API}/inventory/products")
    assert r.status_code == 200
    prods = [p for p in r.json() if p.get("type") == "retail" and (p.get("tracking_mode") or "none") == "none"]
    if prods:
        p = prods[0]
    else:
        body = {"name": f"TEST_Prod_{uuid.uuid4().hex[:6]}", "sku": f"T{uuid.uuid4().hex[:6]}",
                "type": "retail", "unit_price": 20.0, "unit_cost": 5.0, "reorder_point": 2,
                "tracking_mode": "none"}
        r = owner1.post(f"{API}/inventory/products", json=body)
        assert r.status_code in (200, 201), r.text
        p = r.json()
    # restock to ensure enough qty + unit cost
    rr = owner1.post(f"{API}/inventory/stock/restock",
                     json={"product_id": p["id"], "quantity": 20, "unit_cost": 5.0,
                           "note": "TEST_restock", "record_expense": True})
    assert rr.status_code == 200, rr.text
    r2 = owner1.get(f"{API}/inventory/products/{p['id']}")
    assert r2.status_code == 200
    j = r2.json()
    return j.get("product", j)


def _get_inv(owner1, inv_id):
    r = owner1.get(f"{API}/invoices/{inv_id}")
    assert r.status_code == 200
    return r.json()


def _get_product_qty(owner1, pid):
    r = owner1.get(f"{API}/inventory/products/{pid}")
    assert r.status_code == 200
    j = r.json()
    return (j.get("product") or j)["quantity_on_hand"]


def test_full_sales_flow(owner1, retail_product):
    pid = retail_product["id"]
    qty_before = _get_product_qty(owner1, pid)

    today = "2026-01-15"
    body = {
        "client_name": "TEST_Client",
        "date": today,
        "lines": [
            {"description": "Haircut", "quantity": 1, "unit_price": 30.0, "kind": "service"},
            {"description": retail_product["name"], "quantity": 2, "unit_price": 20.0,
             "kind": "product", "product_id": pid},
        ],
        "discount_amount": 5.0,
        "tax_rate": 10.0,
        "tip_amount": 5.0,
    }
    r = owner1.post(f"{API}/invoices", json=body)
    assert r.status_code == 200, r.text
    inv = r.json()
    inv_id = inv["id"]
    # subtotal = 30 + 40 = 70; - disc 5 = 65; +tax 10% of 65 = 6.5; +tip 5 => 76.5
    assert abs(inv["subtotal"] - 70.0) < 0.01
    assert abs(inv["discount_amount"] - 5.0) < 0.01
    assert abs(inv["tax_amount"] - 6.5) < 0.01
    assert abs(inv["total"] - 76.5) < 0.01
    assert inv["status"] == "draft"

    # issue
    r = owner1.post(f"{API}/invoices/{inv_id}/issue")
    assert r.status_code == 200, r.text
    inv = r.json()
    assert inv["status"] == "sent"

    qty_after = _get_product_qty(owner1, pid)
    assert qty_after == qty_before - 2, f"stock not decremented: {qty_before} -> {qty_after}"

    # partial payment w/ processing fee
    r = owner1.post(f"{API}/invoices/{inv_id}/payments",
                    json={"amount": 40.0, "method": "card", "fee": 1.5, "processor": "recorded"})
    assert r.status_code == 200, r.text
    inv = r.json()
    assert inv["status"] == "sent"
    assert abs(inv["amount_paid"] - 40.0) < 0.01
    assert abs(inv["balance_due"] - 36.5) < 0.01

    # final payment
    r = owner1.post(f"{API}/invoices/{inv_id}/payments",
                    json={"amount": 36.5, "method": "cash", "fee": 0})
    assert r.status_code == 200, r.text
    inv = r.json()
    assert inv["status"] == "paid"
    assert abs(inv["balance_due"]) < 0.01

    # trial balance still balanced
    tb = owner1.get(f"{API}/books/trial-balance").json()
    assert tb["balanced"] is True

    # sales summary has entries
    ss = owner1.get(f"{API}/books/sales-summary?start=2026-01-01&end=2026-12-31").json()
    assert ss["service_revenue"] >= 30
    assert ss["product_revenue"] >= 40
    assert ss["discounts"] >= 5
    assert ss["tax_collected"] >= 6.5
    assert ss["tips_collected"] >= 5
    assert ss["processing_fees"] >= 1.5
    assert ss["cogs"] >= 10  # 2 * 5

    # paid invoice no longer in AR aging
    aging = owner1.get(f"{API}/books/ar-aging").json()
    assert all(row["invoice_id"] != inv_id for row in aging["rows"])
    assert aging["reconciled"] is True

    # store inv_id for refund test
    pytest.paid_invoice_id = inv_id


def test_refund_part_of_paid_invoice(owner1):
    inv_id = pytest.paid_invoice_id
    is_before = owner1.get(f"{API}/books/income-statement?start=2026-01-01&end=2026-12-31").json()
    ni_before = is_before["net_income"]

    r = owner1.post(f"{API}/invoices/{inv_id}/refund",
                    json={"amount": 10.0, "method": "cash", "reason": "TEST_partial_refund"})
    assert r.status_code == 200, r.text
    inv = _get_inv(owner1, inv_id)
    assert inv["status"] == "paid"

    is_after = owner1.get(f"{API}/books/income-statement?start=2026-01-01&end=2026-12-31").json()
    assert is_after["net_income"] < ni_before - 9.9  # contra-revenue reduces NI by 10

    # AR aging must not show phantom receivable for this invoice
    aging = owner1.get(f"{API}/books/ar-aging").json()
    assert all(row["invoice_id"] != inv_id for row in aging["rows"])
    assert aging["reconciled"] is True

    tb = owner1.get(f"{API}/books/trial-balance").json()
    assert tb["balanced"] is True


def test_void_draft_sent_invoice(owner1):
    # service-only, issue, then void
    body = {
        "client_name": "TEST_VoidClient",
        "date": "2026-01-16",
        "lines": [{"description": "Trim", "quantity": 1, "unit_price": 15, "kind": "service"}],
    }
    r = owner1.post(f"{API}/invoices", json=body)
    inv = r.json()
    inv_id = inv["id"]
    owner1.post(f"{API}/invoices/{inv_id}/issue")

    aging = owner1.get(f"{API}/books/ar-aging").json()
    assert any(row["invoice_id"] == inv_id for row in aging["rows"]), "should be in aging before void"

    r = owner1.post(f"{API}/invoices/{inv_id}/status", json={"status": "void"})
    assert r.status_code == 200, r.text
    inv = _get_inv(owner1, inv_id)
    assert inv["status"] == "void"

    aging = owner1.get(f"{API}/books/ar-aging").json()
    assert all(row["invoice_id"] != inv_id for row in aging["rows"])
    assert aging["reconciled"] is True

    tb = owner1.get(f"{API}/books/trial-balance").json()
    assert tb["balanced"] is True


def test_service_only_no_stock_change(owner1, retail_product):
    pid = retail_product["id"]
    qty_before = _get_product_qty(owner1, pid)
    body = {
        "client_name": "TEST_ServiceOnly",
        "date": "2026-01-17",
        "lines": [{"description": "Shave", "quantity": 1, "unit_price": 25, "kind": "service"}],
    }
    r = owner1.post(f"{API}/invoices", json=body)
    inv_id = r.json()["id"]
    r = owner1.post(f"{API}/invoices/{inv_id}/issue")
    assert r.status_code == 200
    qty_after = _get_product_qty(owner1, pid)
    assert qty_after == qty_before


# ---------- Expenses ----------
def test_create_vendor_and_expense(owner1):
    r = owner1.post(f"{API}/vendors", json={"name": f"TEST_Vendor_{uuid.uuid4().hex[:6]}",
                                             "contact_name": "", "email": "", "phone": "", "notes": ""})
    assert r.status_code == 200, r.text
    v = r.json()
    assert "id" in v

    body = {"date": "2026-01-10", "category": "Rent", "amount": 123.45,
            "description": "TEST_rent", "vendor_id": v["id"], "payment_method": "bank"}
    r = owner1.post(f"{API}/expenses", json=body)
    assert r.status_code == 200, r.text
    exp = r.json()
    assert exp["amount"] == 123.45

    # appears in list
    lst = owner1.get(f"{API}/expenses").json()
    assert any(e["id"] == exp["id"] for e in lst)

    # appears in income statement expenses
    inc = owner1.get(f"{API}/books/income-statement?start=2026-01-01&end=2026-12-31").json()
    rent = next((e for e in inc["expenses"] if e["name"] == "Rent"), None)
    assert rent is not None and rent["amount"] >= 123.45

    # journal has an entry
    jnl = owner1.get(f"{API}/books/journal?start=2026-01-10&end=2026-01-10").json()
    assert any(any(ln["account"] == "6100" for ln in e["lines"]) for e in jnl)


# ---------- Manual journal ----------
def test_manual_journal_unbalanced_rejected(owner1):
    body = {"date": "2026-01-20", "memo": "TEST_unbalanced",
            "lines": [{"account": "1000", "debit": 10, "credit": 0},
                      {"account": "3000", "debit": 0, "credit": 5}]}
    r = owner1.post(f"{API}/books/journal", json=body)
    assert r.status_code == 400


def test_manual_journal_balanced_accepted(owner1):
    body = {"date": "2026-01-20", "memo": "TEST_balanced",
            "lines": [{"account": "1000", "debit": 10, "credit": 0},
                      {"account": "3000", "debit": 0, "credit": 10}]}
    r = owner1.post(f"{API}/books/journal", json=body)
    assert r.status_code == 200, r.text
    entry = r.json()
    assert entry["total"] == 10

    tb = owner1.get(f"{API}/books/trial-balance").json()
    assert tb["balanced"] is True


# ---------- Cross-tenant isolation ----------
def test_cross_tenant_isolation(owner1, owner2):
    # Create an invoice as owner1
    body = {"client_name": "TEST_IsolationA", "date": "2026-01-18",
            "lines": [{"description": "Haircut", "quantity": 1, "unit_price": 20, "kind": "service"}]}
    r = owner1.post(f"{API}/invoices", json=body)
    assert r.status_code == 200
    inv_id = r.json()["id"]
    owner1.post(f"{API}/invoices/{inv_id}/issue")

    # owner2 cannot read it
    r2 = owner2.get(f"{API}/invoices/{inv_id}")
    assert r2.status_code == 404

    # owner2 cannot pay it
    r2 = owner2.post(f"{API}/invoices/{inv_id}/payments", json={"amount": 10, "method": "cash"})
    assert r2.status_code == 404

    # owner2 trial balance is independent and still balanced
    tb2 = owner2.get(f"{API}/books/trial-balance").json()
    assert tb2["balanced"] is True
