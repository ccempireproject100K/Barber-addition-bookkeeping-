"""Payment reminders: owner-approved nudges for overdue invoices. Reminders are always
sent manually from the UI (never automatic) — each send is logged and audited."""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, require
from lib.dates import now_iso, today_iso
from lib.mailer import send_email
from lib.repo import Scoped

router = APIRouter()


class OverdueInvoice(BaseModel):
    id: str
    number: str
    client_name: str
    due_date: str | None
    days_overdue: int
    balance_due: float
    total: float


class ReminderSendIn(BaseModel):
    invoice_id: str
    to_email: str = Field(min_length=3, max_length=200)
    subject: str = Field(default="", max_length=200)
    message: str = Field(default="", max_length=2000)


class ReminderRecord(BaseModel):
    id: str
    invoice_id: str
    number: str
    client_name: str
    to_email: str
    subject: str
    message: str = ""
    status: str
    error: str = ""
    sent_at: str
    sent_by: str


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "tenant_id"}


@router.get("/reminders/overdue", response_model=list[OverdueInvoice])
async def overdue_invoices(p: Principal = Depends(require("invoice:read"))):
    today = today_iso(p.settings.get("timezone"))
    docs = await Scoped("invoices", p).find(
        {"status": "sent", "balance_due": {"$gt": 0}, "due_date": {"$ne": None, "$lt": today}},
        sort=[("due_date", 1)])
    out = []
    for d in docs:
        due = d["due_date"]
        days = (date.fromisoformat(today) - date.fromisoformat(due)).days
        out.append(OverdueInvoice(id=d["id"], number=d["number"], client_name=d["client_name"],
                                 due_date=due, days_overdue=days, balance_due=d["balance_due"], total=d["total"]))
    return out


def default_message(inv: dict, days_overdue: int) -> str:
    return (f"Hi {inv['client_name']},\n\nJust a friendly reminder that invoice {inv['number']} "
            f"for ${inv['balance_due']:.2f} was due on {inv.get('due_date') or 'receipt'} "
            f"({days_overdue} days ago).\n\nCould you let us know when we can expect payment? "
            f"Reply to this email if anything looks off.\n\nThanks!")


@router.post("/reminders/send", response_model=ReminderRecord)
async def send_reminder(body: ReminderSendIn, p: Principal = Depends(require("invoice:write"))):
    inv = await Scoped("invoices", p).find_one({"id": body.invoice_id})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    today = today_iso(p.settings.get("timezone"))
    days = (date.fromisoformat(today) - date.fromisoformat(inv["due_date"])).days if inv.get("due_date") else 0
    subject = body.subject.strip() or f"Payment reminder: invoice {inv['number']} ({inv['client_name']})"
    message = body.message.strip() or default_message(inv, days)
    status, error = await send_email(body.to_email.strip(), subject, message)
    rec = {"id": str(uuid.uuid4()), "invoice_id": inv["id"], "number": inv["number"],
           "client_name": inv["client_name"], "to_email": body.to_email.strip(), "subject": subject,
           "message": message, "status": status, "error": error, "sent_at": now_iso(), "sent_by": p.name}
    await Scoped("payment_reminders", p).insert(dict(rec))
    await audit(p, "reminder.send", "invoice", inv["id"],
                {"to": rec["to_email"], "status": status, "number": inv["number"]})
    return ReminderRecord(**_strip(rec))


@router.get("/reminders", response_model=list[ReminderRecord])
async def reminder_history(p: Principal = Depends(require("invoice:read"))):
    docs = await Scoped("payment_reminders", p).find({}, sort=[("sent_at", -1)], limit=100)
    return [ReminderRecord(**{**_strip(d), "message": d.get("message", "")}) for d in docs]
