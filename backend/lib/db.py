"""Shared Mongo handle — import `client`/`db` from here (server.py, routers, seed.py)."""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING, IndexModel

load_dotenv(Path(__file__).parent.parent / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

logger = logging.getLogger(__name__)

# One entry per collection: every field a route filters, sorts, or dedupes on. Applied by ensure_indexes() at startup.
INDEXES: dict[str, list[IndexModel]] = {
    "tenants": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "users": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("email", ASCENDING)], name="email", unique=True),
        IndexModel([("tenant_id", ASCENDING), ("created_at", ASCENDING)], name="tenant_created"),
    ],
    "products": [
        IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True),
        IndexModel([("tenant_id", ASCENDING), ("sku", ASCENDING)], name="tenant_sku_u", unique=True,
                   partialFilterExpression={"sku": {"$type": "string"}}),
        IndexModel([("tenant_id", ASCENDING), ("barcode", ASCENDING)], name="tenant_barcode_u", unique=True,
                   partialFilterExpression={"barcode": {"$type": "string"}}),
        IndexModel([("tenant_id", ASCENDING), ("name", ASCENDING)], name="tenant_name"),
    ],
    "movements": [
        IndexModel([("tenant_id", ASCENDING), ("created_at", DESCENDING)], name="tenant_created"),
        IndexModel([("tenant_id", ASCENDING), ("product_id", ASCENDING), ("created_at", DESCENDING)], name="tenant_product_created"),
        IndexModel([("tenant_id", ASCENDING), ("serial_unit_ids", ASCENDING)], name="tenant_serials"),
        IndexModel([("tenant_id", ASCENDING), ("op_id", ASCENDING)], name="tenant_op"),
    ],
    "lots": [
        IndexModel([("tenant_id", ASCENDING), ("product_id", ASCENDING), ("lot_number", ASCENDING)], name="tenant_product_lot", unique=True),
        IndexModel([("tenant_id", ASCENDING), ("expiry_date", ASCENDING)], name="tenant_expiry"),
    ],
    "serial_units": [
        IndexModel([("tenant_id", ASCENDING), ("product_id", ASCENDING), ("serial_number", ASCENDING)], name="tenant_product_serial", unique=True),
    ],
    "transactions": [IndexModel([("tenant_id", ASCENDING), ("date", DESCENDING)], name="tenant_date"),
                     IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True),
                     IndexModel([("tenant_id", ASCENDING), ("op_id", ASCENDING)], name="tenant_op")],
    "idempotency": [IndexModel([("tenant_id", ASCENDING), ("key", ASCENDING)], name="tenant_key", unique=True),
                    IndexModel([("created_dt", ASCENDING)], name="ttl", expireAfterSeconds=7 * 86400)],
    "ops": [IndexModel([("id", ASCENDING)], name="id", unique=True), IndexModel([("status", ASCENDING), ("created_at", ASCENDING)], name="status_created")],
    "stripe_events": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "login_attempts": [IndexModel([("created_dt", ASCENDING)], name="ttl", expireAfterSeconds=3600),
                       IndexModel([("email", ASCENDING), ("created_dt", ASCENDING)], name="email_dt"),
                       IndexModel([("ip", ASCENDING), ("created_dt", ASCENDING)], name="ip_dt")],
    "password_resets": [IndexModel([("token_hash", ASCENDING)], name="token", unique=True),
                        IndexModel([("expires_dt", ASCENDING)], name="ttl", expireAfterSeconds=86400)],
    "audit_log": [IndexModel([("tenant_id", ASCENDING), ("created_at", DESCENDING)], name="tenant_created")],
    "cash_closes": [IndexModel([("tenant_id", ASCENDING), ("date", ASCENDING)], name="tenant_date_u", unique=True)],
    "error_events": [IndexModel([("created_dt", ASCENDING)], name="ttl", expireAfterSeconds=30 * 86400)],
    "invoices": [IndexModel([("tenant_id", ASCENDING), ("created_at", DESCENDING)], name="tenant_created")],
    "email_outbox": [IndexModel([("tenant_id", ASCENDING), ("created_at", DESCENDING)], name="tenant_created")],
    "locations": [IndexModel([("tenant_id", ASCENDING), ("is_default", ASCENDING)], name="tenant_default")],
    "suppliers": [IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True)],
    "accounts": [IndexModel([("tenant_id", ASCENDING), ("code", ASCENDING)], name="tenant_code_u", unique=True)],
    "vendors": [IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True)],
    "estimates": [IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True)],
    "bills": [IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True)],
    "recurring": [IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True)],
    "bank_txns": [IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True),
                  IndexModel([("tenant_id", ASCENDING), ("dedupe", ASCENDING)], name="tenant_dedupe")],
    "journal_entries": [
        IndexModel([("tenant_id", ASCENDING), ("ref", ASCENDING)], name="tenant_ref_u", unique=True),
        IndexModel([("tenant_id", ASCENDING), ("date", ASCENDING)], name="tenant_date"),
        IndexModel([("tenant_id", ASCENDING), ("lines.account", ASCENDING), ("date", ASCENDING)], name="tenant_account_date"),
    ],
    "purchase_orders": [
        IndexModel([("tenant_id", ASCENDING), ("id", ASCENDING)], name="tenant_id_id", unique=True),
        IndexModel([("tenant_id", ASCENDING), ("status", ASCENDING), ("created_at", DESCENDING)], name="tenant_status_created"),
    ],
}


async def ensure_indexes() -> None:
    try:  # migration: the old non-partial SKU index rejected multiple products without a SKU
        await db.products.drop_index("tenant_sku")
    except Exception:
        pass
    for collection, models in INDEXES.items():
        for model in models:  # one at a time so a bad spec skips only itself
            try:
                await db[collection].create_indexes([model])
            except Exception as exc:  # never block boot on an index; the log line names what to fix
                logger.error("ensure_indexes(%s.%s): %s", collection, model.document["name"], exc)
