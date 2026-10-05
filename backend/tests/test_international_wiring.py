"""Synthetic provider checks and real isolated-DB API coverage for initial market settings."""
import os, uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import httpx
import pytest
import stripe
from pydantic import ValidationError
from lib.dates import today_iso, business_date_filter
from lib.international import InternationalSettings
from lib.auth import Principal
from routers import payments

class FixedClock(datetime):
    @classmethod
    def now(cls, tz=None):
        value=cls(2026, 10, 3, 1, 0, tzinfo=timezone.utc)
        return value.astimezone(tz) if tz else value

def test_same_instant_has_different_shop_dates():
    with patch('lib.dates.datetime', FixedClock):
        assert today_iso('America/Chicago') == '2026-10-02'
        assert today_iso('Asia/Singapore') == '2026-10-03'

@pytest.mark.parametrize('field,value', [('currency','JPY'),('currency','KWD'),('timezone','Invalid/City'),('locale','made-up')])
def test_unsupported_settings_rejected(field,value):
    with pytest.raises(ValidationError): InternationalSettings(**{field:value})

def test_business_filter_preserves_legacy_and_frozen_dates():
    query=business_date_filter('2026-10-02','2026-10-02')
    assert query['$or'][0] == {'business_date': {'$gte':'2026-10-02','$lte':'2026-10-02'}}
    assert query['$or'][1] == {'business_date':{'$exists':False},'created_at':{'$gte':'2026-10-02','$lt':'2026-10-03'}}

@pytest.mark.asyncio
async def test_checkout_uses_workspace_currency_and_records_it():
    p=Principal(user_id='test',tenant_id='shop-cad',tenant_name='Canada',role='admin',name='Owner',email='demo@example.invalid',settings={'inventory_enabled':True,'currency':'CAD','timezone':'America/Toronto'})
    scope=SimpleNamespace(find_one=AsyncMock(return_value={'name':'Item','quantity_on_hand':5}))
    collection=SimpleNamespace(insert_one=AsyncMock())
    body=payments.CardCheckoutIn(lines=[{'product_id':'p','quantity':2,'unit_price':.125}],origin_url='https://example.com')
    session=stripe.checkout.Session.construct_from({'id':'cs_test','url':'https://checkout.stripe.com/test'},None)
    with patch.object(payments,'Scoped',return_value=scope), patch.object(payments,'db',SimpleNamespace(payment_transactions=collection)), patch.object(stripe.checkout.Session,'create',return_value=session) as create:
        await payments.card_checkout(body,p)
        price=create.call_args.kwargs['line_items'][0]['price_data']
        assert price['currency']=='cad' and price['unit_amount']==13
        row=collection.insert_one.call_args.args[0]
        assert row['currency']=='cad' and row['amount']==.26


def test_real_db_settings_and_record_currency():
    base=os.environ['API_BASE']
    with httpx.Client(base_url=base,trust_env=False,timeout=20) as c:
        signup=c.post('/auth/signup',json={'company_name':'Synthetic Canadian shop','name':'Test Owner','email':f'test-{uuid.uuid4().hex}@example.com','password':'SyntheticTest123!','currency':'CAD','timezone':'America/Toronto','locale':'en-CA'})
        assert signup.status_code==200,signup.text
        assert signup.json()['currency']=='CAD'
        settings=c.get('/settings').json()
        assert settings['timezone']=='America/Toronto'
        result=c.post('/transactions',json={'kind':'income','category':'Services','amount':12.34,'date':'2026-10-02','description':'synthetic','payment_method':'cash'})
        assert result.status_code==200,result.text
        assert result.json()['currency']=='CAD'
        settings['currency']='EUR'
        denied=c.put('/settings',json=settings)
        assert denied.status_code==409
        settings['currency']='CAD';settings['timezone']='Asia/Singapore'
        saved=c.put('/settings',json=settings)
        assert saved.status_code==200,saved.text
        assert c.get('/auth/me').json()['timezone']=='Asia/Singapore'
        row=c.get('/transactions').json()[0]
        assert row['currency']=='CAD' and row['date']=='2026-10-02' and row['amount']==12.34
        # An older client omitting the new fields must not reset the workspace.
        for key in ('currency','timezone','locale'):settings.pop(key)
        assert c.put('/settings',json=settings).status_code==200
        effective=c.get('/settings').json()
        assert effective['currency']=='CAD' and effective['timezone']=='Asia/Singapore'
        effective['timezone']='not/a-zone'
        assert c.put('/settings',json=effective).status_code==422
        assert c.get('/auth/me').json()['timezone']=='Asia/Singapore'
