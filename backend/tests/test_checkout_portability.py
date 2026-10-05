"""Offline Stripe boundary checks; no provider requests or MongoDB required."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import stripe
from fastapi import HTTPException
from lib.auth import Principal
from lib.money import discounted_unit_price, line_total
from lib.stripe_resources import stripe_dict
from models.ledger import BillingSyncIn
from routers import billing, payments, clients


def owner():
    return Principal(user_id="tester", tenant_id="shop-a", tenant_name="Test", role="admin", name="Owner", email="demo@example.invalid", settings={"inventory_enabled": True})


class CheckoutPortability(unittest.IsolatedAsyncioTestCase):
    async def test_tax_failure_is_not_retried_or_recorded(self):
        scoped = SimpleNamespace(find_one=AsyncMock(return_value={"name": "Test", "quantity_on_hand": 5}))
        collection = SimpleNamespace(insert_one=AsyncMock())
        body = payments.CardCheckoutIn(lines=[{"product_id": "p", "quantity": 1, "unit_price": 10}], origin_url="https://example.com")
        with patch.object(payments, "Scoped", return_value=scoped), patch.object(payments, "db", SimpleNamespace(payment_transactions=collection)), patch.object(stripe.checkout.Session, "create", side_effect=stripe.InvalidRequestError("Tax setup needed", "automatic_tax")) as create:
            with self.assertRaises(HTTPException) as caught:
                await payments.card_checkout(body, owner())
            self.assertEqual(caught.exception.status_code, 502)
            self.assertEqual(create.call_count, 1)
            self.assertEqual(create.call_args.kwargs["automatic_tax"], {"enabled": True})
            collection.insert_one.assert_not_awaited()

    async def test_fractional_unit_price_matches_processor_and_saved_cart_total(self):
        scoped = SimpleNamespace(find_one=AsyncMock(return_value={"name": "Test", "quantity_on_hand": 5}))
        collection = SimpleNamespace(insert_one=AsyncMock())
        body = payments.CardCheckoutIn(lines=[{"product_id": "p", "quantity": 2, "unit_price": .125}], origin_url="https://example.com")
        session = stripe.checkout.Session.construct_from({"id": "cs_test", "url": "https://checkout.stripe.com/test"}, None)
        with patch.object(payments, "Scoped", return_value=scoped), patch.object(payments, "db", SimpleNamespace(payment_transactions=collection)), patch.object(stripe.checkout.Session, "create", return_value=session) as create:
            await payments.card_checkout(body, owner())
            self.assertEqual(create.call_args.kwargs["line_items"][0]["price_data"]["unit_amount"], 13)
            self.assertEqual(collection.insert_one.call_args.args[0]["amount"], .26)

    async def test_discount_uses_decimal_half_up_in_both_paths(self):
        body = payments.CardCheckoutIn(lines=[{"product_id": "p", "quantity": 3, "unit_price": .25}], discount_code="TEST", origin_url="https://example.com")
        discount_scope = SimpleNamespace(update=AsyncMock(return_value={"pct": 50}))
        with patch.object(clients, "Scoped", return_value=discount_scope):
            pct = await clients.apply_discount(owner(), body)
        self.assertEqual(pct, 50)
        self.assertEqual(body.lines[0].unit_price, .13)
        self.assertEqual(discounted_unit_price(.25, 50), .13)
        self.assertEqual(line_total(3, body.lines[0].unit_price), .39)

    async def test_complete_but_unpaid_checkout_does_not_mark_paid(self):
        record = {"session_id": "cs_test", "status": "initiated", "payment_status": "pending", "amount": 10}
        collection = SimpleNamespace(find_one=AsyncMock(return_value=record), update_one=AsyncMock())
        session = stripe.checkout.Session.construct_from({"id": "cs_test", "status": "complete", "payment_status": "unpaid", "payment_intent": "pi_test"}, None)
        with patch.object(payments, "db", SimpleNamespace(payment_transactions=collection)), patch.object(stripe.checkout.Session, "retrieve", return_value=session), patch.object(payments, "_mark_paid", new=AsyncMock()) as paid, patch.object(payments, "fulfill", new=AsyncMock()):
            result = await payments.payment_status("cs_test")
            paid.assert_not_awaited()
            self.assertEqual(result.payment_status, "pending")

    async def test_billing_sync_accepts_stripe_resource_objects(self):
        session = stripe.checkout.Session.construct_from({"id": "cs_test", "client_reference_id": "shop-a", "subscription": "sub_test"}, None)
        sub = stripe.Subscription.construct_from({"id": "sub_test", "status": "active", "items": {"data": [{"current_period_end": 1800000000}]}}, None)
        with patch.object(stripe.checkout.Session, "retrieve", return_value=session), patch.object(stripe.Subscription, "retrieve", return_value=sub), patch.object(billing, "apply_subscription", new=AsyncMock()) as apply, patch.object(billing, "billing_status", new=AsyncMock(return_value="ok")):
            self.assertEqual(await billing.billing_sync(BillingSyncIn(session_id="cs_test"), owner()), "ok")
            applied = apply.call_args.args[1]
            self.assertIsInstance(applied, dict)
            self.assertIsInstance(applied["items"], dict)

    async def test_billing_sync_rejects_another_workspace(self):
        session = stripe.checkout.Session.construct_from({"id": "cs_test", "client_reference_id": "another-shop", "subscription": "sub_test"}, None)
        with patch.object(stripe.checkout.Session, "retrieve", return_value=session), patch.object(stripe.Subscription, "retrieve") as retrieve:
            with self.assertRaises(HTTPException) as caught:
                await billing.billing_sync(BillingSyncIn(session_id="cs_test"), owner())
            self.assertEqual(caught.exception.status_code, 404)
            retrieve.assert_not_called()

    def test_resource_conversion_preserves_nested_data(self):
        resource = stripe.Subscription.construct_from({"id": "sub_test", "items": {"data": [{"current_period_end": 1800000000}]}}, None)
        self.assertEqual(stripe_dict(resource)["items"]["data"][0]["current_period_end"], 1800000000)


if __name__ == "__main__":
    unittest.main()
