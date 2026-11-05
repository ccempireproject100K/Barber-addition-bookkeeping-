"""Vertical editions: a light packaging pass over the existing product.

Editions today: "general" (default) and "service-shop" (barbershops, salons,
spas — booth rent, tips, and QuickSell are already native here). The edition
lives in workspace settings and drives:
  - an edition-aware setup checklist (this router), and
  - small UI emphasis (badge + checklist on the dashboard).
Nothing is gated by edition — it's packaging, not a paywall.
"""

from fastapi import APIRouter, Depends

from lib.auth import Principal, require
from lib.db import db

router = APIRouter(prefix="/edition")


@router.get("/setup-status")
async def setup_status(p: Principal = Depends(require("settings:read"))):
    edition = p.settings.get("edition", "general")
    steps: list[dict] = []
    if edition == "service-shop":
        t = p.tenant_id
        team = await db.users.count_documents({"tenant_id": t})
        booth = await db.users.count_documents({"tenant_id": t, "booth_rent": {"$gt": 0}})
        services = await db.products.count_documents({"tenant_id": t})
        sales = await db.transactions.count_documents({"tenant_id": t, "kind": "income"})
        tips = await db.invoices.count_documents({"tenant_id": t, "tip_amount": {"$gt": 0}})
        steps = [
            {"id": "team", "label": "Add your team", "hint": "Barbers, stylists, front desk",
             "done": team > 1, "link": "/team"},
            {"id": "booth", "label": "Set booth rent", "hint": "Monthly rent per person, on the Team page",
             "done": booth > 0, "link": "/team"},
            {"id": "services", "label": "Add services & retail", "hint": "Cuts, color, product shelf",
             "done": services > 0, "link": "/inventory"},
            {"id": "tips", "label": "Take a tipped payment", "hint": "Tips flow into invoices automatically",
             "done": tips > 0, "link": "/invoices"},
            {"id": "sale", "label": "Record your first sale", "hint": "QuickSell at the chair, or an invoice",
             "done": sales > 0, "link": "/inventory/sell"},
        ]
    return {"edition": edition, "steps": steps,
            "complete": bool(steps) and all(s["done"] for s in steps)}
