"""Tenant-scoped repository — the only way routers touch tenant collections. tenant_id is injected everywhere."""

from typing import Any

from pymongo import ReturnDocument

from lib.auth import Principal
from lib.db import db


class Scoped:
    def __init__(self, collection: str, principal: Principal):
        self.c = db[collection]
        self.tenant_id = principal.tenant_id
        self.settings = principal.settings
        self.collection = collection

    def _f(self, f: dict | None = None) -> dict:
        return {**(f or {}), "tenant_id": self.tenant_id}

    async def find(self, f: dict | None = None, sort: list | None = None, limit: int = 10000) -> list[dict]:
        cur = self.c.find(self._f(f), {"_id": 0})
        if sort:
            cur = cur.sort(sort)
        return await cur.to_list(limit)

    async def find_one(self, f: dict) -> dict | None:
        return await self.c.find_one(self._f(f), {"_id": 0})

    async def insert(self, doc: dict) -> dict:
        doc = {**doc, "tenant_id": self.tenant_id}
        if self.collection in {"transactions", "invoices", "movements", "products", "purchase_orders", "cash_closes"}:
            from lib.dates import today_iso
            doc.setdefault("currency", self.settings.get("currency", "USD"))
            doc.setdefault("business_date", doc.get("date") or today_iso(self.settings.get("timezone")))
            doc.setdefault("business_timezone", self.settings.get("timezone", "UTC"))
        await self.c.insert_one(dict(doc))
        return doc

    async def update(self, f: dict, update: dict) -> dict | None:
        return await self.c.find_one_and_update(
            self._f(f), update, projection={"_id": 0}, return_document=ReturnDocument.AFTER
        )

    async def delete(self, f: dict) -> int:
        res = await self.c.delete_one(self._f(f))
        return res.deleted_count

    async def count(self, f: dict | None = None) -> int:
        return await self.c.count_documents(self._f(f))

    async def aggregate(self, pipeline: list[dict[str, Any]]) -> list[dict]:
        return await self.c.aggregate([{"$match": {"tenant_id": self.tenant_id}}, *pipeline]).to_list(10000)
