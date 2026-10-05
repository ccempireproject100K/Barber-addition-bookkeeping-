"""Inventory add-on acceptance tests (run against a live backend):  cd backend && python -m pytest tests/test_inventory_acceptance.py -n 0

Covers stock math, money links, workspace isolation, concurrency, lots (FEFO), serials, audit, CSV import and module gating.
"""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

BASE = os.environ.get("API_BASE", "http://localhost:8001/api")


def workspace(enable: bool = True) -> httpx.Client:
    c = httpx.Client(base_url=BASE, timeout=30)
    tag = uuid.uuid4().hex[:8]
    r = c.post("/auth/signup", json={"company_name": f"Test Shop {tag}", "name": "Owner", "email": f"owner-{tag}@example.com", "password": "Passw0rd!"})
    assert r.status_code == 200, r.text
    if enable:  # paid add-on: unlock the way production does — a verified (signed) Stripe subscription event
        import time
        from tests.test_phase1 import _sub_event, post_event
        assert post_event(_sub_event(r.json()["tenant_id"], "active", int(time.time()))).status_code == 200
        s = c.get("/settings").json()
        assert c.put("/settings", json={**s, "inventory_enabled": True}).status_code == 200
    return c


def product(c: httpx.Client, **kw) -> dict:
    body = {"name": f"Pomade {uuid.uuid4().hex[:5]}", "type": "retail", "sell_price": 15, "opening_qty": 0, "opening_unit_cost": 0, **kw}
    r = c.post("/inventory/products", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def qoh(c: httpx.Client, pid: str) -> int:
    return c.get(f"/inventory/products/{pid}").json()["product"]["quantity_on_hand"]


class TestInventory:
    def test_gating_off_hides_everything(self):
        c = workspace(enable=False)
        assert c.get("/auth/me").json()["inventory_enabled"] is False
        for path in ("/inventory/products", "/inventory/movements", "/inventory/alerts", "/inventory/reports", "/inventory/suppliers"):
            assert c.get(path).status_code == 404, path
        assert c.get("/dashboard").json()["inventory"] is None
        assert c.get("/reports/pnl").json()["retail"] is None

    def test_opening_plus_sale_math(self):
        c = workspace()
        p = product(c, opening_qty=10, opening_unit_cost=2)
        r = c.post("/inventory/stock/sell", json={"product_id": p["id"], "quantity": 3, "unit_price": 15})
        assert r.status_code == 200, r.text
        assert qoh(c, p["id"]) == 7
        assert len(c.get(f"/inventory/movements?product_id={p['id']}").json()) == 2

    def test_restock_expense_and_average_cost(self):
        c = workspace()
        p = product(c, opening_qty=7, opening_unit_cost=2)
        r = c.post("/inventory/stock/restock", json={"product_id": p["id"], "quantity": 12, "unit_cost": 4, "record_expense": True})
        assert r.status_code == 200, r.text
        txn = next(t for t in c.get("/transactions?kind=expense").json() if r.json()["id"] in t["linked_movement_ids"])
        assert txn["amount"] == 48
        assert c.get(f"/inventory/products/{p['id']}").json()["product"]["unit_cost"] == pytest.approx((7 * 2 + 48) / 19, abs=1e-3)

    def test_sale_income_and_pnl_lines(self):
        c = workspace()
        p = product(c, opening_qty=5, opening_unit_cost=6)
        mv = c.post("/inventory/stock/sell", json={"product_id": p["id"], "quantity": 2, "unit_price": 15}).json()
        inc = next(t for t in c.get("/transactions?kind=income").json() if mv["id"] in t["linked_movement_ids"])
        assert inc["amount"] == 30 and inc["category"] == "Retail sales"
        retail = c.get("/reports/pnl").json()["retail"]
        assert retail["retail_sales"] == 30 and retail["retail_cogs"] == 12 and retail["retail_gross_profit"] == 18

    def test_concurrent_last_unit(self):
        c = workspace()
        p = product(c, opening_qty=1, opening_unit_cost=3)
        cookies = dict(c.cookies)

        def sell(_):
            with httpx.Client(base_url=BASE, cookies=cookies, timeout=30) as cc:
                return cc.post("/inventory/stock/sell", json={"product_id": p["id"], "quantity": 1, "unit_price": 15}).status_code

        with ThreadPoolExecutor(4) as ex:
            codes = sorted(ex.map(sell, range(4)))
        assert codes.count(200) == 1 and codes.count(409) == 3, codes
        assert qoh(c, p["id"]) == 0

    def test_workspace_isolation(self):
        a, b = workspace(), workspace()
        p = product(a, opening_qty=3, opening_unit_cost=1, barcode=f"77{uuid.uuid4().int % 10**10}")
        assert b.get(f"/inventory/products/{p['id']}").status_code == 404
        assert b.get(f"/inventory/products/barcode/{p['barcode']}").json()["found"] is False
        assert b.post("/inventory/stock/sell", json={"product_id": p["id"], "quantity": 1, "unit_price": 1}).status_code == 404
        assert all(m["product_id"] != p["id"] for m in b.get("/inventory/movements").json())

    def test_lot_fefo(self):
        c = workspace()
        p = product(c, tracking_mode="lot", opening_qty=5, opening_unit_cost=2, opening_lot_number="LATE", opening_expiry_date="2031-01-01")
        c.post("/inventory/stock/restock", json={"product_id": p["id"], "quantity": 5, "unit_cost": 2, "lot_number": "EARLY", "expiry_date": "2030-01-01"})
        mv = c.post("/inventory/stock/sell", json={"product_id": p["id"], "quantity": 2, "unit_price": 15}).json()
        assert mv["lot_number"] == "EARLY"

    def test_serial_no_double_sale(self):
        c = workspace()
        p = product(c, tracking_mode="serial", opening_qty=2, opening_unit_cost=80, opening_serials=["S-1", "S-2"])
        sid = next(s["id"] for s in c.get(f"/inventory/products/{p['id']}").json()["serials"] if s["serial_number"] == "S-1")
        body = {"product_id": p["id"], "quantity": 1, "unit_price": 150, "serial_unit_ids": [sid]}
        assert c.post("/inventory/stock/sell", json=body).status_code == 200
        assert c.post("/inventory/stock/sell", json=body).status_code == 409
        assert len(c.get(f"/inventory/movements?serial_unit_id={sid}").json()) == 2  # opening + sale
        dup = c.post("/inventory/stock/restock", json={"product_id": p["id"], "quantity": 1, "unit_cost": 80, "serial_numbers": ["S-2"]})
        assert dup.status_code == 409

    def test_adjustment_requires_reason_and_is_audited(self):
        c = workspace()
        p = product(c, opening_qty=4, opening_unit_cost=1)
        assert c.post("/inventory/stock/adjust", json={"product_id": p["id"], "quantity": -1}).status_code == 422
        mv = c.post("/inventory/stock/adjust", json={"product_id": p["id"], "quantity": -1, "reason": "damaged"}).json()
        assert mv["reason"] == "damaged" and mv["performed_by_name"] == "Owner" and mv["created_at"]

    def test_csv_import_all_or_nothing(self):
        c = workspace()
        rows = "\n".join(f"Product {i},retail,10,4,3" for i in range(49))
        bad = "name,type,price,cost,quantity\n" + rows + "\nBroken,retail,abc,4,3"
        r = c.post("/inventory/products/import", json={"csv": bad}).json()
        assert r["imported"] == 0 and r["errors"][0]["row"] == 51
        assert c.get("/inventory/products").json() == []
        good = "name,type,price,cost,quantity\n" + rows + "\nFixed,retail,10,4,3"
        assert c.post("/inventory/products/import", json={"csv": good}).json()["imported"] == 50

    def test_report_matches_ledger(self):
        c = workspace()
        p = product(c, opening_qty=10, opening_unit_cost=2)
        c.post("/inventory/stock/sell", json={"product_id": p["id"], "quantity": 4, "unit_price": 15})
        rep = c.get("/inventory/reports").json()
        row = next(x for x in rep["profit_by_product"] if x["product_id"] == p["id"])
        assert (row["units"], row["revenue"], row["cogs"]) == (4, 60, 8)
        assert rep["total_value"] == 12


class TestProcurement:
    def _po(self, c: httpx.Client, qty: int = 10, cost: float = 8):
        sup = c.post("/inventory/suppliers", json={"name": f"Sup {uuid.uuid4().hex[:4]}", "email": "demo@example.invalid"}).json()
        p = product(c, opening_qty=0, opening_unit_cost=0, supplier_id=sup["id"])
        po = c.post("/inventory/purchase-orders", json={"supplier_id": sup["id"], "lines": [{"product_id": p["id"], "quantity": qty, "unit_cost": cost}], "notes": ""}).json()
        assert c.post(f"/inventory/purchase-orders/{po['id']}/status", json={"status": "ordered"}).status_code == 200
        return p, po, sup

    def test_partial_receive_backorder(self):
        c = workspace()
        p, po, _ = self._po(c)
        r = c.post(f"/inventory/purchase-orders/{po['id']}/receive", json={"lines": [{"product_id": p["id"], "quantity": 4}]}).json()
        assert r["status"] == "partial" and r["lines"][0]["received_qty"] == 4 and qoh(c, p["id"]) == 4
        assert c.post(f"/inventory/purchase-orders/{po['id']}/receive", json={"lines": [{"product_id": p["id"], "quantity": 7}]}).status_code == 400
        sugg = {s["product_id"]: s for s in c.get("/inventory/reorder").json()}
        assert p["id"] not in sugg or sugg[p["id"]]["incoming"] == 6
        r = c.post(f"/inventory/purchase-orders/{po['id']}/receive", json={"lines": [{"product_id": p["id"], "quantity": 2}], "close_backorder": True}).json()
        assert r["status"] == "received" and qoh(c, p["id"]) == 6
        exp = sum(t["amount"] for t in c.get("/transactions?kind=expense").json() if po["number"] in t["description"])
        assert exp == 48

    def test_price_history_by_supplier(self):
        c = workspace()
        p, po, sup = self._po(c, qty=2, cost=8)
        c.post(f"/inventory/purchase-orders/{po['id']}/status", json={"status": "received"})
        c.post("/inventory/stock/restock", json={"product_id": p["id"], "quantity": 1, "unit_cost": 6.5, "supplier_name": "Cheaper Co"})
        row = c.get(f"/inventory/prices?product_id={p['id']}").json()[0]
        assert row["best_supplier"] == "Cheaper Co" and row["current_cost"] == 8 and row["saving_per_unit"] == 1.5


class TestProcurementControls:
    def test_approval_limit_blocks_until_owner_approves(self):
        c = workspace()
        s = c.get("/settings").json()
        c.put("/settings", json={**s, "po_approval_limit": 50})
        sup = c.post("/inventory/suppliers", json={"name": "Big Sup", "email": "demo@example.invalid"}).json()
        p = product(c)
        po = c.post("/inventory/purchase-orders", json={"supplier_id": sup["id"], "lines": [{"product_id": p["id"], "quantity": 10, "unit_cost": 8}], "notes": ""}).json()
        assert po["awaiting_approval"] is True
        assert c.post(f"/inventory/purchase-orders/{po['id']}/status", json={"status": "ordered"}).status_code == 403
        assert c.post(f"/inventory/purchase-orders/{po['id']}/email", json={"mark_ordered": True, "message": ""}).status_code == 403
        r = c.post(f"/inventory/purchase-orders/{po['id']}/approval", json={"approve": True, "note": ""}).json()
        assert r["awaiting_approval"] is False and r["approved_by"] == "Owner"
        assert c.post(f"/inventory/purchase-orders/{po['id']}/status", json={"status": "ordered"}).status_code == 200

    def test_switch_supplier_and_scorecard(self):
        c = workspace()
        sup = c.post("/inventory/suppliers", json={"name": "Dear Co", "email": "demo@example.invalid", "lead_time_days": 3}).json()
        p = product(c, supplier_id=sup["id"])
        c.post("/inventory/stock/restock", json={"product_id": p["id"], "quantity": 2, "unit_cost": 9, "supplier_name": "Dear Co"})
        c.post("/inventory/stock/restock", json={"product_id": p["id"], "quantity": 2, "unit_cost": 7, "supplier_name": "Cheap Co"})
        r = c.post(f"/inventory/products/{p['id']}/switch-supplier", json={"supplier_name": "Cheap Co"}).json()
        assert r["current_supplier"] == "Cheap Co" and r["saving_per_unit"] == 0
        assert any(s["name"] == "Cheap Co" for s in c.get("/inventory/suppliers").json())
        po = c.post("/inventory/purchase-orders", json={"supplier_id": sup["id"], "lines": [{"product_id": p["id"], "quantity": 4, "unit_cost": 9}], "notes": ""}).json()
        c.post(f"/inventory/purchase-orders/{po['id']}/status", json={"status": "ordered"})
        c.post(f"/inventory/purchase-orders/{po['id']}/receive", json={"lines": [{"product_id": p["id"], "quantity": 3}], "close_backorder": True})
        card = next(x for x in c.get("/inventory/supplier-scorecards").json() if x["supplier_id"] == sup["id"])
        assert card["orders_received"] == 1 and card["short_shipment_rate"] == 100 and card["fill_rate"] == 75 and card["on_time_rate"] == 100


class TestEmailLinksAndPriceLists:
    def test_price_list_upload_feeds_comparison(self):
        c = workspace()
        cur = c.post("/inventory/suppliers", json={"name": "Current Co"}).json()
        other = c.post("/inventory/suppliers", json={"name": "Quote Co"}).json()
        p = product(c, sku="PL-1", supplier_id=cur["id"])
        c.post("/inventory/stock/restock", json={"product_id": p["id"], "quantity": 2, "unit_cost": 10, "supplier_name": "Current Co"})
        r = c.post(f"/inventory/suppliers/{other['id']}/price-list", json={"csv": "sku,cost\nPL-1,7.50\nNOPE,3\nPL-1,abc"}).json()
        assert r["matched"] == 1 and len(r["unmatched"]) == 2
        row = c.get(f"/inventory/prices?product_id={p['id']}").json()[0]
        assert row["best_supplier"] == "Quote Co" and row["saving_per_unit"] == 2.5
        assert row["prices"][0]["source"] == "list"

    def test_email_approve_link_confirm_then_single_use(self):
        import re
        c = workspace()
        s = c.get("/settings").json()
        c.put("/settings", json={**s, "po_approval_limit": 10})
        sup = c.post("/inventory/suppliers", json={"name": "Link Sup"}).json()
        p = product(c)
        po = c.post("/inventory/purchase-orders", json={"supplier_id": sup["id"], "lines": [{"product_id": p["id"], "quantity": 5, "unit_cost": 8}], "notes": ""}).json()
        me = c.get("/auth/me").json()
        from routers.po_links import action_link  # signs with the same JWT_SECRET via backend/.env
        from dotenv import load_dotenv
        load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
        link = action_link("http://x", me["tenant_id"], me["user_id"], po["id"], "approve")
        tok = re.search(r"t=(.+)$", link).group(1)
        anon = httpx.Client(base_url=BASE, timeout=30)
        assert "Approve" in anon.get(f"/po-action?t={tok}").text  # GET = confirmation only
        assert c.get("/inventory/purchase-orders").json()[0]["awaiting_approval"] is True
        assert "approved" in anon.post("/po-action", data={"t": tok}).text
        assert c.get("/inventory/purchase-orders").json()[0]["approved_by"] == "Owner"
        assert "already used" in anon.post("/po-action", data={"t": tok}).text
        assert anon.get("/po-action?t=garbage").status_code == 400


class TestClientsGameCard:
    def test_client_sale_profile_and_discount_code(self):
        c = workspace()
        me = c.get("/auth/me").json()
        p = product(c, opening_qty=5, opening_unit_cost=4, sell_price=20)
        cl = c.post("/clients", json={"name": "Kai"}).json()
        g = httpx.Client(base_url=BASE, timeout=30)
        r = g.post(f"/game/{me['tenant_id']}/score", json={"name": "Kai", "score": 700, "duration_ms": 30500}).json()
        assert r["code"] and r["pct"] == 20
        assert g.post(f"/game/{me['tenant_id']}/score", json={"name": "Kai", "score": 700, "duration_ms": 500}).status_code == 422
        res = c.post("/inventory/stock/checkout", json={"lines": [{"product_id": p["id"], "quantity": 1, "unit_price": 20, "serial_unit_ids": []}],
                                                        "client_id": cl["id"], "discount_code": r["code"]}).json()
        assert res["total"] == 16
        again = c.post("/inventory/stock/checkout", json={"lines": [{"product_id": p["id"], "quantity": 1, "unit_price": 20, "serial_unit_ids": []}], "discount_code": r["code"]})
        assert again.status_code == 400 and qoh(c, p["id"]) == 4
        prof = c.get(f"/clients/{cl['id']}").json()
        assert prof["client"]["total_spent"] == 16 and prof["purchases"][0]["unit_price"] == 16

    def test_card_checkout_creates_session_without_posting_stock(self):
        c = workspace()
        p = product(c, opening_qty=2, opening_unit_cost=4, sell_price=20)
        r = c.post("/payments/quick-sell", json={"lines": [{"product_id": p["id"], "quantity": 1, "unit_price": 20, "serial_unit_ids": []}],
                                                  "origin_url": "https://example.com"})
        assert r.status_code == 200 and r.json()["checkout_url"].startswith("https://checkout.stripe.com")
        st = httpx.get(f"{BASE}/payments/status/{r.json()['session_id']}").json()
        assert st["payment_status"] != "paid" and st["fulfilled"] is False and qoh(c, p["id"]) == 2
        assert c.post("/payments/quick-sell", json={"lines": [{"product_id": p["id"], "quantity": 9, "unit_price": 20, "serial_unit_ids": []}],
                                                     "origin_url": "https://example.com"}).status_code == 409
