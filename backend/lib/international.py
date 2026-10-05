"""Initial single-currency workspaces; historical amounts are never converted."""
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pydantic import BaseModel, field_validator

Currency = Literal["USD", "CAD", "GBP", "EUR", "AUD", "NZD", "SGD"]
Locale = Literal["en-US", "en-CA", "en-GB", "en-AU", "en-IE", "en-NZ", "en-SG"]

class InternationalSettings(BaseModel):
    currency: Currency = "USD"
    timezone: str = "UTC"
    locale: Locale = "en-US"

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError, TypeError):
            raise ValueError("Use a valid IANA time zone, such as America/Chicago")
        return value
