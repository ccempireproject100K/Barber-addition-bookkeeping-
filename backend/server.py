import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, Depends
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import logging
from pathlib import Path


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
from lib.auth import require_inventory, principal_for_user, tenant_settings
from lib.dates import today_iso
from lib.db import client, db, ensure_indexes
from lib.migrations import run_migrations
from lib.ops import recover_ops
from lib.security import SecurityMiddleware
from routers import billing, cash, ledger
from routers import ai, auth, clients, cron, game, payments, po_links, source, insights, inv_reports, money, movements, products, purchase_orders, suppliers
from routers import bookkeeping, expenses

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async def boot():
        await ensure_indexes()
        await run_migrations()
        try:
            logger.info("startup recovery: %s", await recover_ops(120))
        except Exception as exc:
            logger.error("startup recovery failed: %s", exc)
    app.state.index_task = asyncio.create_task(boot())  # background: a big index build must not block boot
    yield
    client.close()


app = FastAPI(lifespan=lifespan, title="The Barber's Ledger")

api_router = APIRouter(prefix="/api")


@api_router.get("/")
async def root():
    return {"message": "The Barber's Ledger API"}


# Money core + auth + settings: always available.
api_router.include_router(auth.router)
api_router.include_router(money.router)
api_router.include_router(ai.router)
api_router.include_router(cron.router)
api_router.include_router(source.router)
api_router.include_router(po_links.router)
api_router.include_router(clients.router)
api_router.include_router(payments.router)
api_router.include_router(game.router)
api_router.include_router(billing.router)
api_router.include_router(cash.router)
api_router.include_router(ledger.router)
api_router.include_router(bookkeeping.router)
api_router.include_router(expenses.router)

# Inventory add-on: every route sits behind the per-workspace module flag (404 when off).
inventory_router = APIRouter(prefix="/inventory", dependencies=[Depends(require_inventory)])
for r in (products, movements, suppliers, purchase_orders, insights, inv_reports):
    inventory_router.include_router(r.router)
api_router.include_router(inventory_router)

app.add_middleware(SecurityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Include the router in the main app (must stay last)
app.include_router(api_router)
