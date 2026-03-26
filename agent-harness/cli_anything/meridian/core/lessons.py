"""
Read Meridian lessons.json — performance records and derived lessons.

lessons.json structure:
  {
    "lessons": [ { rule, type, created_at, pool_name, strategy, ... } ],
    "performance": [ { position, pool_name, pnl_usd, pnl_pct, ... } ]
  }
"""

import json
from typing import Optional

from cli_anything.meridian.core.paths import lessons_path


def load_lessons_data() -> dict:
    path = lessons_path()
    if not path.exists():
        return {"lessons": [], "performance": []}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {"lessons": [], "performance": []}


def get_lessons(n: Optional[int] = None, lesson_type: Optional[str] = None) -> list[dict]:
    """
    Return lessons, optionally filtered by type (good/poor/bad/manual/neutral).
    """
    data = load_lessons_data()
    lessons = data.get("lessons", [])
    if lesson_type:
        lessons = [l for l in lessons if l.get("type") == lesson_type]
    if n:
        return lessons[-n:]
    return lessons


def get_performance(n: Optional[int] = None) -> list[dict]:
    """Return last N performance records."""
    data = load_lessons_data()
    perf = data.get("performance", [])
    if n:
        return perf[-n:]
    return perf


def performance_summary() -> dict:
    """Rolling stats from all performance records."""
    data = load_lessons_data()
    perf = data.get("performance", [])
    lessons = data.get("lessons", [])

    if not perf:
        return {
            "total_records": 0,
            "win_rate_pct": None,
            "total_pnl_usd": None,
            "lessons_count": len(lessons),
        }

    wins = [p for p in perf if (p.get("pnl_usd") or 0) > 0]
    total_pnl = sum(p.get("pnl_usd") or 0 for p in perf)

    # Last 10 positions rolling win rate (used for sizing evolution)
    last10 = perf[-10:]
    last10_wins = [p for p in last10 if (p.get("pnl_usd") or 0) > 0]

    return {
        "total_records": len(perf),
        "win_rate_pct": round(len(wins) / len(perf) * 100) if perf else None,
        "total_pnl_usd": round(total_pnl, 2),
        "rolling_win_rate_pct": round(len(last10_wins) / len(last10) * 100) if last10 else None,
        "lessons_count": len(lessons),
        "lessons_by_type": {
            t: len([l for l in lessons if l.get("type") == t])
            for t in ("good", "poor", "bad", "manual", "neutral")
        },
    }
