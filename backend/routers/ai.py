"""Optional ChatGPT features: dashboard insights + "Ask the shop" assistant grounded in the workspace's own data.

Only a compact JSON snapshot of THIS workspace's numbers is sent to the model. Off unless the owner enables it
(Settings) and EMERGENT_LLM_KEY is set.
"""

import json
import importlib
import logging
import os
import uuid
from datetime import date, timedelta
from types import ModuleType
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from lib.auth import Principal, require
from lib.dates import now_iso, today_iso
from lib.db import db
from lib.repo import Scoped
from models.inventory import OutboxEmail
from models.ai import AiChatIn, AiInsights, AiMessage, ReorderPlan, ReorderPlanLine

router = APIRouter(prefix="/ai")
logger = logging.getLogger(__name__)


def _ai_sdk() -> ModuleType:
    """Load the optional provider only when an enabled AI feature is used."""
    try:
        return importlib.import_module("emergentintegrations.llm.chat")
    except ImportError as exc:
        logger.warning("Optional AI provider unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "AI integration is not installed on this server. Contact the administrator.") from exc


def _model() -> str:
    return os.environ.get("AI_MODEL", "gpt-5-mini")


async def require_ai(p: Principal = Depends(require("report:read"))) -> Principal:
    if not p.settings.get("ai_enabled") or not os.environ.get("EMERGENT_LLM_KEY"):
        raise HTTPException(404, "Not found")
    _ai_sdk()
    return p


async def shop_snapshot(p: Principal) -> dict:
    """Compact, workspace-scoped facts for grounding. Reuses the same report functions the UI shows."""
    from routers.money import pnl
    today = today_iso(p.settings.get("timezone"))
    month_start = today[:8] + "01"
    last_month_end = (date.fromisoformat(month_start) - timedelta(days=1)).isoformat()
    snap: dict = {"shop": p.tenant_name, "today": today, "currency": p.settings.get("currency", "USD")}
    this_m = await pnl(start=month_start, end=today, p=p)
    last_m = await pnl(start=last_month_end[:8] + "01", end=last_month_end, p=p)
    snap["pnl_this_month"] = this_m.model_dump()
    snap["pnl_last_month"] = {"total_income": last_m.total_income, "total_expenses": last_m.total_expenses, "net_profit": last_m.net_profit}
    team = await db.users.find({"tenant_id": p.tenant_id}, {"_id": 0, "name": 1, "role": 1, "commission_rate": 1}).to_list(100)
    snap["team"] = team
    if p.settings.get("inventory_enabled"):
        from routers.inv_reports import report
        from routers.insights import compute_suggestions
        rep = await report(start=month_start, end=today, p=p)
        snap["inventory_this_month"] = {
            "stock_value_at_cost": rep.total_value, "stock_value_at_retail": rep.retail_value, "totals": rep.totals,
            "best_sellers": [x.model_dump(exclude={"product_id"}) for x in rep.best_sellers[:8]],
            "profit_and_commission_by_barber": [x.model_dump(exclude={"barber_id"}) for x in rep.profit_by_barber],
            "low_or_out_of_stock": [{"name": x.name, "on_hand": x.quantity_on_hand, "reorder_at": x.reorder_point} for x in rep.low_stock],
            "expiring_lots": [x.model_dump(exclude={"lot_id", "product_id"}) for x in rep.expiring_lots],
            "supply_usage": [x.model_dump(exclude={"product_id"}) for x in rep.supply_usage[:8]],
            "stock": [{"name": x.name, "type": x.type, "on_hand": x.quantity_on_hand, "unit_cost": x.unit_cost} for x in rep.stock],
        }
        snap["reorder_suggestions"] = [s.model_dump(include={"name", "quantity_on_hand", "suggested_qty", "urgency", "days_of_cover",
                                                             "supplier_name", "estimated_cost"}) for s in (await compute_suggestions(p))[:12]]
        snap["open_purchase_orders"] = [{"number": d["number"], "supplier": d["supplier_name"], "status": d["status"], "total": d["total"]}
                                        for d in await Scoped("purchase_orders", p).find({"status": {"$in": ["draft", "ordered", "partial"]}})]
    return snap


SYSTEM = """You are the assistant inside "Ledger", bookkeeping + inventory software for a small business.
Answer ONLY from the business data JSON below; if the data doesn't contain the answer, say so plainly. Never invent numbers.
Be brief and practical (owners read this on a phone between clients). Use $ amounts with 2 decimals. Commission = retail
revenue x the staff member's commission_rate %. Use short bullet points when listing. Plain text, no markdown tables.

SHOP DATA (JSON):
"""


def _chat(system: str, session: str) -> Any:
    return _ai_sdk().LlmChat(api_key=os.environ["EMERGENT_LLM_KEY"], session_id=session, system_message=system).with_model("openai", _model())


async def _complete(chat: Any, text: str) -> str:
    sdk = _ai_sdk()
    out = []
    async for ev in chat.stream_message(sdk.UserMessage(text=text)):
        if isinstance(ev, sdk.TextDelta):
            out.append(ev.content)
        elif isinstance(ev, sdk.StreamDone):
            break
    return "".join(out).strip()


@router.get("/insights", response_model=AiInsights)
async def insights(refresh: bool = False, p: Principal = Depends(require_ai)):
    """One AI summary per workspace per day (cached), regenerated on demand."""
    today = today_iso(p.settings.get("timezone"))
    if not refresh:
        cached = await db.ai_insights.find_one({"tenant_id": p.tenant_id, "date": today}, {"_id": 0, "tenant_id": 0})
        if cached:
            return AiInsights(**cached)
    snap = await shop_snapshot(p)
    prompt = ("Write today's briefing for the owner: exactly 5 lines, each starting with '- '. Cover: how the month is going vs last "
              "month, the retail standout, the most urgent stock/expiry risk, one concrete reorder or purchasing action, and one "
              "money-making tip grounded in the data. Max 25 words per line.")
    try:
        text = await _complete(_chat(SYSTEM + json.dumps(snap, default=str), f"insights-{p.tenant_id}-{uuid.uuid4()}"), prompt)
    except Exception as exc:
        logger.error("AI insights failed: %s", exc)
        raise HTTPException(502, "The AI service didn't respond — try again in a minute")
    doc = {"date": today, "text": text, "model": _model(), "created_at": now_iso()}
    await db.ai_insights.update_one({"tenant_id": p.tenant_id, "date": today}, {"$set": {**doc, "tenant_id": p.tenant_id}}, upsert=True)
    return AiInsights(**doc)


@router.get("/chat", response_model=list[AiMessage])
async def chat_history(p: Principal = Depends(require_ai)):
    docs = await db.ai_messages.find({"tenant_id": p.tenant_id, "user_id": p.user_id}, {"_id": 0}).sort("created_at", 1).to_list(200)
    return [AiMessage(**d) for d in docs]


@router.delete("/chat")
async def clear_chat(p: Principal = Depends(require_ai)):
    await db.ai_messages.delete_many({"tenant_id": p.tenant_id, "user_id": p.user_id})
    return {"ok": True}


@router.post("/chat/stream")
async def chat_stream(body: AiChatIn, p: Principal = Depends(require_ai)):
    """Server-sent events: `data: {"delta": "..."}` chunks, then `data: {"done": true, "id": ...}`."""
    sdk = _ai_sdk()
    history = await db.ai_messages.find({"tenant_id": p.tenant_id, "user_id": p.user_id}, {"_id": 0}).sort("created_at", -1).to_list(12)
    transcript = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in reversed(history))
    snap = await shop_snapshot(p)
    system = SYSTEM + json.dumps(snap, default=str) + (f"\n\nEARLIER IN THIS CONVERSATION:\n{transcript}" if transcript else "")
    user_doc = {"id": str(uuid.uuid4()), "tenant_id": p.tenant_id, "user_id": p.user_id, "role": "user", "content": body.message.strip(), "created_at": now_iso()}
    await db.ai_messages.insert_one(dict(user_doc))
    chat = _chat(system, f"ask-{p.user_id}-{uuid.uuid4()}")

    async def gen():
        parts: list[str] = []
        try:
            async for ev in chat.stream_message(sdk.UserMessage(text=body.message.strip())):
                if isinstance(ev, sdk.TextDelta):
                    parts.append(ev.content)
                    yield f"data: {json.dumps({'delta': ev.content})}\n\n"
                elif isinstance(ev, sdk.StreamDone):
                    break
        except Exception as exc:
            logger.error("AI chat failed: %s", exc)
            yield f"data: {json.dumps({'error': 'The AI service did not respond. Please try again.'})}\n\n"
            return
        aid = str(uuid.uuid4())
        await db.ai_messages.insert_one({"id": aid, "tenant_id": p.tenant_id, "user_id": p.user_id, "role": "assistant",
                                         "content": "".join(parts).strip(), "created_at": now_iso()})
        yield f"data: {json.dumps({'done': True, 'id': aid})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/reorder-plan", response_model=ReorderPlan)
async def reorder_plan(p: Principal = Depends(require_ai)):
    """AI reviews the rule-based suggestions (+ price history, cash position) and proposes this week's order.
    The model can only pick from real suggestions; quantities are clamped. Nothing is created until the owner approves."""
    if not p.settings.get("inventory_enabled"):
        raise HTTPException(404, "Not found")
    from routers.insights import compute_suggestions, price_table
    sugg = {s.product_id: s for s in await compute_suggestions(p) if s.supplier_id}
    if not sugg:
        return ReorderPlan(summary="Nothing needs reordering right now.", lines=[], model=_model())
    prices = {x.product_id: x for x in await price_table(p)}
    items = [{"product_id": s.product_id, "name": s.name, "on_hand": s.quantity_on_hand, "suggested_qty": s.suggested_qty, "urgency": s.urgency,
              "days_of_cover": s.days_of_cover, "per_day": s.daily_velocity, "supplier": s.supplier_name, "unit_cost": s.unit_cost,
              "cheapest_known": prices[s.product_id].best_supplier if s.product_id in prices else None} for s in sugg.values()]
    snap = await shop_snapshot(p)
    prompt = ("Plan this week's purchase order from REORDER_CANDIDATES. Return ONLY JSON: "
              '{"summary": "<=40 words", "lines": [{"product_id": "...", "quantity": int, "reason": "<=15 words"}]}. '
              "Include critical/high items; skip items with plenty of cover; you may adjust quantity between 50% and 150% of suggested_qty "
              "(e.g. less if cash is tight or demand is slow). Use only product_ids from the list.\nREORDER_CANDIDATES: " + json.dumps(items))
    try:
        raw = await _complete(_chat(SYSTEM + json.dumps({k: v for k, v in snap.items() if k != "reorder_suggestions"}, default=str),
                                    f"plan-{p.tenant_id}-{uuid.uuid4()}"), prompt)
        data = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    except Exception as exc:
        logger.error("AI reorder plan failed: %s", exc)
        raise HTTPException(502, "The AI couldn't produce a plan — try again, or use the rule-based suggestions")
    lines, seen = [], set()
    for ln in data.get("lines", []):
        s = sugg.get(str(ln.get("product_id")))
        if not s or s.product_id in seen:
            continue
        seen.add(s.product_id)
        q = max(1, min(int(ln.get("quantity") or s.suggested_qty), round(s.suggested_qty * 1.5) or 1))
        lines.append(ReorderPlanLine(product_id=s.product_id, name=s.name, supplier_id=s.supplier_id or "", supplier_name=s.supplier_name or "",
                                     quantity=q, unit_cost=s.unit_cost, reason=str(ln.get("reason", ""))[:160]))
    return ReorderPlan(summary=str(data.get("summary", ""))[:400], lines=lines, model=_model())


async def send_weekly_email(p: Principal, base: str = "") -> dict:
    """Monday email: fresh AI briefing + the AI's draft order, created as draft POs the owner approves in Procurement."""
    from lib.mailer import send_email
    from routers.purchase_orders import create_po
    brief = await insights(refresh=True, p=p)
    created = []
    if p.settings.get("inventory_enabled"):
        plan = await reorder_plan(p=p)
        groups: dict[str, list] = {}
        for ln in plan.lines:
            groups.setdefault(ln.supplier_id, []).append(ln)
        for sid, lines in groups.items():
            sup = await Scoped("suppliers", p).find_one({"id": sid})
            if sup:
                from models.inventory import POLineIn
                po = await create_po(p, sup, [POLineIn(product_id=l.product_id, quantity=l.quantity, unit_cost=l.unit_cost) for l in lines],
                                     None, f"Weekly AI draft: {plan.summary}"[:1900])
                created.append((po, lines))
    body = [f"Good morning {p.name.split()[0]},", "", f"Here's your week at {p.tenant_name}:", "", brief.text, ""]
    if created:
        body += ["DRAFT ORDERS READY FOR YOUR APPROVAL"]
        for po, lines in created:
            body.append(f"{po.number} · {po.supplier_name} · ${po.total:.2f}" + ("  (over your approval limit)" if po.awaiting_approval else ""))
            body += [f"   {l.quantity} × {l.name} — {l.reason}" for l in lines]
            if base:
                from routers.po_links import action_link
                body += [f"   Approve: {action_link(base, p.tenant_id, p.user_id, po.id, 'approve')}",
                         f"   Reject:  {action_link(base, p.tenant_id, p.user_id, po.id, 'reject')}"]
        body += ["", "Tap Approve/Reject above (links work for 7 days, once each), or open Procurement to edit them. Nothing is sent to suppliers until you do."]
    else:
        body.append("No reorders needed this week.")
    body += ["", f"AI-generated with {_model()} from your shop data — double-check before acting."]
    owner = await db.users.find_one({"tenant_id": p.tenant_id, "role": "admin"}, {"_id": 0, "email": 1}, sort=[("created_at", 1)])
    to = owner["email"] if owner else p.email
    subject = f"[{p.tenant_name}] Your Monday briefing" + (f" + {len(created)} draft order(s) to approve" if created else "")
    status, err = await send_email(to, subject, "\n".join(body))
    doc = {"id": str(uuid.uuid4()), "to": to, "subject": subject, "body": "\n".join(body), "status": status, "error": err, "created_at": now_iso()}
    await Scoped("email_outbox", p).insert(dict(doc))
    await db.tenants.update_one({"id": p.tenant_id}, {"$set": {"last_weekly_ai": today_iso(p.settings.get("timezone"))}})
    return doc


@router.post("/weekly-email", response_model=OutboxEmail)
async def weekly_email_now(request: Request, p: Principal = Depends(require_ai)):
    """Send the Monday email now (owner 'Send now' in Settings)."""
    from routers.po_links import public_base
    return OutboxEmail(**await send_weekly_email(p, public_base(request)))


# ---------- Copilot actions (approval-gated) ----------
# The AI proposes concrete bookkeeping actions; NOTHING executes until the
# owner explicitly approves it in the UI. Every execution re-checks the
# acting permission for its kind.

from lib.auth import ROLE_PERMS  # noqa: E402

ACTION_KINDS = ("chase_invoice", "pay_bill")
ACTION_PERMS = {"chase_invoice": "invoice:write", "pay_bill": "txn:write"}


def _action_doc(d: dict) -> dict:
    return {k: d.get(k) for k in ("id", "kind", "title", "detail", "payload", "status",
                                 "created_at", "decided_at", "decided_by", "result")}


@router.post("/actions/propose")
async def propose_actions(p: Principal = Depends(require_ai)):
    """Ask the model what to do, validate every proposal, save as proposed."""
    from routers.reminders import overdue_invoices
    overdue = await overdue_invoices(p)
    unpaid_bills = await Scoped("bills", p).find(
        {"status": {"$in": ["unpaid", "partial"]}}, sort=[("due_date", 1)])
    cash = ""
    try:
        from routers.money import cash_position
        cash = f"${(await cash_position(p)):.2f}"
    except Exception:
        pass
    prompt = (
        "You are the copilot inside \"Ledger\". Propose concrete bookkeeping actions the owner can approve with one tap. "
        "Return ONLY JSON: {\"actions\": [{\"kind\": \"chase_invoice\" | \"pay_bill\", \"title\": \"<=60 chars\", "
        "\"detail\": \"<=160 chars\", \"payload\": {...}}]}. "
        "chase_invoice payload: {\"invoice_id\": \"...\"} — only for invoices in OVERDUE below, oldest first. "
        "pay_bill payload: {\"bill_id\": \"...\", \"amount\": number, \"date\": \"YYYY-MM-DD\", \"method\": \"bank\"} — "
        "only for bills in UNPAID below; amount must not exceed the balance. "
        "At most 5 actions, most valuable first. If nothing is worth doing, return {\"actions\": []}.\n"
        f"OVERDUE: {json.dumps([{'id': o.id, 'number': o.number, 'client': o.client_name, 'days_overdue': o.days_overdue, 'balance_due': o.balance_due} for o in overdue], default=str)}\n"
        f"UNPAID BILLS: {json.dumps([{'id': b['id'], 'vendor': b.get('vendor_name'), 'balance': b.get('balance'), 'due_date': b.get('due_date')} for b in unpaid_bills], default=str)}\n"
        f"CASH TODAY: {cash}")
    try:
        raw = await _complete(_chat(SYSTEM + json.dumps({"today": today_iso(p.settings.get("timezone"))}, default=str),
                                    f"copilot-{p.tenant_id}-{uuid.uuid4()}"), prompt)
        data = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    except Exception as exc:
        logger.error("AI copilot propose failed: %s", exc)
        raise HTTPException(502, "The AI couldn't propose actions — try again in a minute")
    out = []
    for a in (data.get("actions") or [])[:5]:
        kind = str(a.get("kind") or "")
        if kind not in ACTION_KINDS:
            continue
        payload = a.get("payload") or {}
        if not _validate_proposal(p, kind, payload, overdue, unpaid_bills):
            continue
        doc = {"id": str(uuid.uuid4()), "tenant_id": p.tenant_id, "user_id": p.user_id, "kind": kind,
               "title": str(a.get("title", ""))[:80], "detail": str(a.get("detail", ""))[:300],
               "payload": payload, "status": "proposed", "created_at": now_iso(),
               "decided_at": None, "decided_by": None, "result": None}
        await db.ai_actions.insert_one(dict(doc))
        out.append(_action_doc(doc))
    return out


def _validate_proposal(p: Principal, kind: str, payload: dict, overdue, unpaid_bills) -> bool:
    try:
        if kind == "chase_invoice":
            return any(o.id == str(payload.get("invoice_id")) for o in overdue)
        if kind == "pay_bill":
            b = next((x for x in unpaid_bills if x["id"] == str(payload.get("bill_id"))), None)
            if not b:
                return False
            amt = float(payload.get("amount") or 0)
            return 0 < amt <= float(b.get("balance") or 0) + 0.005
    except (ValueError, TypeError, KeyError):
        return False
    return False


@router.get("/actions")
async def list_actions(p: Principal = Depends(require_ai)):
    docs = await db.ai_actions.find({"tenant_id": p.tenant_id}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return [_action_doc(d) for d in docs]


@router.post("/actions/{action_id}/reject")
async def reject_action(action_id: str, p: Principal = Depends(require_ai)):
    doc = await db.ai_actions.find_one({"tenant_id": p.tenant_id, "id": action_id})
    if not doc:
        raise HTTPException(404, "Action not found")
    if doc["status"] != "proposed":
        raise HTTPException(409, "Action already decided")
    await db.ai_actions.update_one({"tenant_id": p.tenant_id, "id": action_id},
                                   {"$set": {"status": "rejected", "decided_at": now_iso(), "decided_by": p.name}})
    doc.update(status="rejected", decided_at=now_iso(), decided_by=p.name)
    return _action_doc(doc)


@router.post("/actions/{action_id}/approve")
async def approve_action(action_id: str, p: Principal = Depends(require_ai)):
    """Execute a proposed action. The acting permission is re-checked here —
    proposing never implies the right to execute."""
    doc = await db.ai_actions.find_one({"tenant_id": p.tenant_id, "id": action_id})
    if not doc:
        raise HTTPException(404, "Action not found")
    if doc["status"] != "proposed":
        raise HTTPException(409, "Action already decided")
    need = ACTION_PERMS.get(doc["kind"], "")
    if need not in ROLE_PERMS.get(p.role, set()):
        raise HTTPException(403, "You don't have permission to execute this action")
    try:
        if doc["kind"] == "chase_invoice":
            result = await _exec_chase_invoice(p, doc["payload"])
        elif doc["kind"] == "pay_bill":
            result = await _exec_pay_bill(p, doc["payload"])
        else:
            raise HTTPException(400, "Unknown action kind")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("AI copilot execute failed: %s", exc)
        raise HTTPException(502, "The action failed to execute — nothing was changed")
    await db.ai_actions.update_one(
        {"tenant_id": p.tenant_id, "id": action_id},
        {"$set": {"status": "executed", "decided_at": now_iso(), "decided_by": p.name, "result": result}})
    await audit(p, "ai.action.execute", "ai_action", action_id, {"kind": doc["kind"], "result": result})
    doc.update(status="executed", decided_at=now_iso(), decided_by=p.name, result=result)
    return _action_doc(doc)


async def _exec_chase_invoice(p: Principal, payload: dict) -> str:
    from routers.reminders import ReminderSendIn, send_reminder
    inv = await Scoped("invoices", p).find_one({"id": str(payload.get("invoice_id"))})
    if not inv or inv.get("status") != "sent" or float(inv.get("balance_due") or 0) <= 0:
        raise HTTPException(409, "Invoice is no longer overdue")
    client = await Scoped("clients", p).find_one({"name": inv.get("client_name")})
    email = (client or {}).get("email", "").strip()
    if not email:
        raise HTTPException(400, f"No email on file for {inv.get('client_name')} — add one on the Clients page first")
    rec = await send_reminder(ReminderSendIn(invoice_id=inv["id"], to_email=email, subject="", message=""), p)
    return f"Reminder sent to {email} for invoice {inv.get('number')} (${float(inv.get('balance_due') or 0):.2f})"


async def _exec_pay_bill(p: Principal, payload: dict) -> str:
    from routers.bills import BillPayIn, pay_bill
    bill = await Scoped("bills", p).find_one({"id": str(payload.get("bill_id"))})
    if not bill or bill.get("status") == "paid":
        raise HTTPException(409, "Bill is already paid")
    amt = float(payload.get("amount") or 0)
    if amt <= 0 or amt > float(bill.get("balance") or 0) + 0.005:
        raise HTTPException(400, "Payment amount is no longer valid for this bill")
    d = str(payload.get("date") or "")
    method = str(payload.get("method") or "bank")
    await pay_bill(bill["id"], BillPayIn(amount=amt, method=method, date=d), p)
    return f"Paid ${amt:.2f} to {bill.get('vendor_name') or 'vendor'}" + (f" (dated {d})" if d else "")
