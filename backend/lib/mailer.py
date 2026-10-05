"""Generic SMTP mailer (self-hosted friendly). With no SMTP_HOST configured, emails are only logged to the outbox."""

import asyncio
import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)


def _send_sync(to: str, subject: str, body: str, reply_to: str | None = None) -> None:
    msg = EmailMessage()
    msg["From"] = os.environ.get("SMTP_FROM", "ledger@localhost")
    msg["To"] = to
    msg["Subject"] = subject
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(body)
    host, port = os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587"))
    with smtplib.SMTP(host, port, timeout=20) as s:
        if os.environ.get("SMTP_TLS", "true").lower() == "true":
            s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)


async def send_email(to: str, subject: str, body: str, reply_to: str | None = None) -> tuple[str, str]:
    """Returns (status, error): 'sent', 'logged' (no SMTP configured) or 'failed'."""
    if not os.environ.get("SMTP_HOST"):
        logger.info("SMTP not configured; logged email to %s: %s", to, subject)
        return "logged", ""
    try:
        await asyncio.to_thread(_send_sync, to, subject, body, reply_to)
        return "sent", ""
    except Exception as exc:  # never crash the caller over email
        logger.error("Email send failed: %s", exc)
        return "failed", str(exc)[:300]
