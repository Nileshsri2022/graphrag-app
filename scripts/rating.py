"""1-5 rating rubric + freshness for GraphRAG v2 (approved 2026-11-22).

Rubric ("how much used in the current era"):
  5 = active <6mo + high stars, widely used
  4 = active <1yr, strong adoption
  3 = niche but alive / declining, activity 1-2yr
  2 = 2-4yr no activity, superseded
  1 = 4-5yr+ no activity, archived, or obsolete tech

Rules: archived -> max 1. Stars alone never give 5 -- activity is required.

The worker agent implements the same rubric in TypeScript; the two MUST agree.
If this file changes, update worker/src/rating.ts to match (and vice versa).

Freshness bands:
  archived            -> "outdated"
  activity < 12mo     -> "fresh"
  activity 12-<48mo   -> "stale"
  activity >= 48mo    -> "outdated"
  no activity date    -> "stale" (rating 2)
"""

from __future__ import annotations

import math
from datetime import date, datetime

DAYS_PER_MONTH = 30.44
HIGH_STARS = 1000


def parse_date(date_str):
    """Parse an ISO date/datetime string. Returns a date or None."""
    if not date_str:
        return None
    s = str(date_str).strip()
    if not s:
        return None
    try:
        if "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt.date()
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def months_since(date_str, today=None):
    """Whole months between date_str and today (floor(days / 30.44)).

    Returns None when the date is missing/unparseable.
    """
    d = parse_date(date_str)
    if d is None:
        return None
    if today is None:
        today = date.today()
    days = (today - d).days
    if days < 0:
        return 0
    return math.floor(days / DAYS_PER_MONTH)


def rate_repo(archived, last_activity, stars):
    """Return (rating 1-5, freshness 'fresh'|'stale'|'outdated').

    archived: bool. last_activity: ISO date string (pushedAt, else
    updatedAt, else None). stars: int.
    """
    if archived:
        return (1, "outdated")
    months = months_since(last_activity)
    if months is None:
        return (2, "stale")
    if months < 6:
        rating = 5 if (stars or 0) >= HIGH_STARS else 4
    elif months < 12:
        rating = 4 if (stars or 0) >= HIGH_STARS else 3
    elif months < 24:
        rating = 3
    elif months < 48:
        rating = 2
    else:
        rating = 1
    if months < 12:
        freshness = "fresh"
    elif months < 48:
        freshness = "stale"
    else:
        freshness = "outdated"
    return (rating, freshness)
