"""Server-side date helpers. The pod clock is UTC — anchor "today" here, never in the browser."""

import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def today_iso(tz: str | None = None) -> str:
    """Today's date as YYYY-MM-DD in `tz` (default: APP_TZ env, else UTC)."""
    zone = tz or os.environ.get("APP_TZ", "UTC")
    return datetime.now(ZoneInfo(zone)).strftime("%Y-%m-%d")


def now_iso() -> str:
    """Aware UTC timestamp as ISO string — stored as a string so motor never hands back naive datetimes."""
    return datetime.now(timezone.utc).isoformat()


def business_date_filter(start: str = "", end: str = "") -> dict:
    """Filter immutable local dates, preserving legacy UTC-calendar interpretation."""
    from datetime import date, timedelta
    local, legacy = {}, {}
    if start:
        date.fromisoformat(start)
        local["$gte"] = start
        legacy["$gte"] = start
    if end:
        local["$lte"] = end
        legacy["$lt"] = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    if not local:
        return {}
    return {"$or": [{"business_date": local}, {"business_date": {"$exists": False}, "created_at": legacy}]}
