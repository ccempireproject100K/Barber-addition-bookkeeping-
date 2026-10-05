"""Self-host import and optional-provider checks; no database or network calls."""
import asyncio
import importlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ.setdefault("DB_NAME", "selfhost_check_only")
os.environ.setdefault("JWT_SECRET", "selfhost-check-only-not-a-production-secret")

from fastapi import HTTPException
import httpx
from routers import ai
import server


class OptionalAI(unittest.TestCase):
    def test_disabled_ai_never_loads_provider(self):
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": ""}), patch.object(
            importlib, "import_module", side_effect=AssertionError("unexpected provider import")
        ):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(ai.require_ai(SimpleNamespace(settings={"ai_enabled": False})))
            self.assertEqual(caught.exception.status_code, 404)

    def test_enabled_ai_missing_provider_returns_503(self):
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-only"}), patch.object(
            importlib, "import_module", side_effect=ModuleNotFoundError("optional provider absent")
        ):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(ai.require_ai(SimpleNamespace(settings={"ai_enabled": True})))
            self.assertEqual(caught.exception.status_code, 503)

    def test_provider_stream_stops_at_completion(self):
        class UserMessage:
            def __init__(self, text): self.text = text
        class TextDelta:
            def __init__(self, content): self.content = content
        class StreamDone: pass
        class Chat:
            def __init__(self, **kwargs): pass
            def with_model(self, *args): return self
            async def stream_message(self, message):
                yield TextDelta("hello ")
                yield TextDelta("shop")
                yield StreamDone()
                yield TextDelta("ignored")
        sdk = SimpleNamespace(LlmChat=Chat, UserMessage=UserMessage, TextDelta=TextDelta, StreamDone=StreamDone)
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-only"}), patch.object(importlib, "import_module", return_value=sdk):
            self.assertEqual(asyncio.run(ai._complete(ai._chat("system", "session"), "question")), "hello shop")

    def test_app_routes_without_database_lifespan(self):
        async def check():
            # ASGITransport deliberately does not run database startup/migrations.
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://test") as client:
                root = await client.get("/api/")
                self.assertEqual(root.status_code, 200)
                self.assertEqual(root.json()["message"], "The Barber's Ledger API")
                private = await client.get("/api/inventory/products")
                self.assertEqual(private.status_code, 401)
        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
