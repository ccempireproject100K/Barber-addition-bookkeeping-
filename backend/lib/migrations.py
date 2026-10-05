"""Idempotent startup migrations (safe to run on every boot)."""

import logging

from lib.db import db

logger = logging.getLogger(__name__)


async def run_migrations() -> None:
    # 1. Paid access: seeded sandboxes are 'demo'; every other workspace must earn add-ons via Stripe.
    await db.tenants.update_many({"access": {"$exists": False}, "id": {"$regex": "^demo-"}}, {"$set": {"access": "demo", "is_demo": True}})
    await db.tenants.update_many({"access": {"$exists": False}}, {"$set": {"access": "none", "is_demo": False, "billing": {"status": "none"}}})
    # 2. Accounting flags on legacy transactions.
    await db.transactions.update_many({"capitalized": {"$exists": False}, "kind": "expense", "source": "inventory",
                                       "category": {"$ne": "Retail refunds"}}, {"$set": {"capitalized": True}})
    await db.transactions.update_many({"capitalized": {"$exists": False}}, {"$set": {"capitalized": False}})
    await db.transactions.update_many({"processor": {"$exists": False}, "stripe_session_id": {"$exists": True}}, {"$set": {"processor": "stripe"}})
    await db.transactions.update_many({"processor": {"$exists": False}}, {"$set": {"processor": "recorded"}})
    await db.transactions.update_many({"payment_method": {"$exists": False}}, {"$set": {"payment_method": "other"}})
    await db.transactions.update_many({"reversed_by": {"$exists": False}}, {"$set": {"reversed_by": None, "reversal_of": None}})
    await db.movements.update_many({"compensates": {"$exists": False}}, {"$set": {"compensates": None}})
    logger.info("migrations done")
