"""
Read and query the Meridian trade journal (journal.json).

journal.json structure:
  { "entries": [ { type, timestamp, position, pool_name, pnl_usd, ... } ] }

Entry types:
  - open   — position deployed
  - close  — position closed (has pnl_usd, pnl_sol, pnl_pct, minutes_held)
  - claim  — fees claimed mid-position
"""

import json
from datetime import datetime, timezone, timedelta
from typing import Optional

from cli_anything.meridian.core.paths import journal_path


def load_entries() -> list[dict]:
    path = journal_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        return data.get("entries", [])
    except Exception:
        return []


def filter_entries(
    entries: list[dict],
    type_: Optional[str] = None,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
) -> list[dict]:
    result = entries
    if type_:
        result = [e for e in result if e.get("type") == type_]
    if from_ts:
        result = [e for e in result if e.get("timestamp", "") >= from_ts]
    if to_ts:
        result = [e for e in result if e.get("timestamp", "") <= to_ts]
    return result


def recent(n: int = 5) -> list[dict]:
    entries = load_entries()
    return entries[-n:]


def recent_closes(n: int = 10) -> list[dict]:
    entries = load_entries()
    closes = [e for e in entries if e.get("type") == "close"]
    return closes[-n:]


def today_summary() -> dict:
    """Stats for today (UTC+7, matching journal bot convention)."""
    now = datetime.now(timezone(timedelta(hours=7)))
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    from_ts = today_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    entries = load_entries()
    opens = filter_entries(entries, type_="open", from_ts=from_ts)
    closes = filter_entries(entries, type_="close", from_ts=from_ts)
    claims = filter_entries(entries, type_="claim", from_ts=from_ts)

    total_pnl_usd = sum(e.get("pnl_usd") or 0 for e in closes)
    total_pnl_sol = sum(e.get("pnl_sol") or 0 for e in closes)
    total_fees = sum(e.get("fees_usd") or 0 for e in claims) + sum(
        e.get("fees_earned_usd") or 0 for e in closes
    )
    wins = [e for e in closes if (e.get("pnl_usd") or 0) > 0]
    win_rate = round(len(wins) / len(closes) * 100) if closes else None

    return {
        "date": today_start.strftime("%Y-%m-%d"),
        "positions_opened": len(opens),
        "positions_closed": len(closes),
        "total_pnl_usd": round(total_pnl_usd, 2),
        "total_pnl_sol": round(total_pnl_sol, 6),
        "total_fees_usd": round(total_fees, 2),
        "win_rate_pct": win_rate,
        "wins": len(wins),
        "losses": len(closes) - len(wins),
    }


def all_time_stats() -> dict:
    """All-time win rate and PnL from journal."""
    entries = load_entries()
    closes = [e for e in entries if e.get("type") == "close"]

    total_pnl_usd = sum(e.get("pnl_usd") or 0 for e in closes)
    total_pnl_sol = sum(e.get("pnl_sol") or 0 for e in closes)
    wins = [e for e in closes if (e.get("pnl_usd") or 0) > 0]
    losses = [e for e in closes if (e.get("pnl_usd") or 0) <= 0]

    avg_profit = (
        sum(e.get("pnl_pct") or 0 for e in wins) / len(wins) if wins else None
    )
    avg_loss = (
        sum(e.get("pnl_pct") or 0 for e in losses) / len(losses) if losses else None
    )
    avg_hold = (
        sum(e.get("minutes_held") or 0 for e in closes) / len(closes)
        if closes
        else None
    )

    return {
        "total_trades": len(closes),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": round(len(wins) / len(closes) * 100) if closes else None,
        "total_pnl_usd": round(total_pnl_usd, 2),
        "total_pnl_sol": round(total_pnl_sol, 6),
        "avg_profit_pct": round(avg_profit, 2) if avg_profit is not None else None,
        "avg_loss_pct": round(avg_loss, 2) if avg_loss is not None else None,
        "avg_hold_minutes": round(avg_hold) if avg_hold is not None else None,
    }


def period_report(period: str = "daily") -> dict:
    """Compute performance metrics for daily/weekly/monthly period."""
    now = datetime.now(timezone.utc)
    if period == "daily":
        from_dt = now - timedelta(hours=24)
        label = "Last 24h"
    elif period == "weekly":
        from_dt = now - timedelta(days=7)
        label = "Last 7 Days"
    elif period == "monthly":
        from_dt = now - timedelta(days=30)
        label = "Last 30 Days"
    else:
        from_dt = now - timedelta(hours=24)
        label = "Last 24h"

    from_ts = from_dt.strftime("%Y-%m-%dT%H:%M:%S")
    entries = load_entries()
    opens = filter_entries(entries, type_="open", from_ts=from_ts)
    closes = filter_entries(entries, type_="close", from_ts=from_ts)
    claims = filter_entries(entries, type_="claim", from_ts=from_ts)

    total_pnl_usd = sum(e.get("pnl_usd") or 0 for e in closes)
    total_pnl_sol = sum(e.get("pnl_sol") or 0 for e in closes)
    total_fees = sum(e.get("fees_usd") or 0 for e in claims) + sum(
        e.get("fees_earned_usd") or 0 for e in closes
    )
    wins = [e for e in closes if (e.get("pnl_usd") or 0) > 0]
    losses = [e for e in closes if (e.get("pnl_usd") or 0) <= 0]
    total_initial = sum(e.get("initial_value_usd") or 0 for e in closes)
    pnl_pct = (total_pnl_usd / total_initial * 100) if total_initial > 0 else 0

    result = {
        "period": period,
        "label": label,
        "positions_opened": len(opens),
        "positions_closed": len(closes),
        "total_pnl_usd": round(total_pnl_usd, 2),
        "total_pnl_sol": round(total_pnl_sol, 6),
        "total_pnl_pct": round(pnl_pct, 2),
        "total_fees_usd": round(total_fees, 2),
        "win_rate_pct": round(len(wins) / len(closes) * 100) if closes else None,
        "wins": len(wins),
        "losses": len(losses),
    }

    if closes:
        best = max(closes, key=lambda e: e.get("pnl_usd") or 0)
        worst = min(closes, key=lambda e: e.get("pnl_usd") or 0)
        result["best_trade"] = {
            "pool": best.get("pool_name"),
            "pnl_usd": best.get("pnl_usd"),
            "pnl_pct": best.get("pnl_pct"),
        }
        result["worst_trade"] = {
            "pool": worst.get("pool_name"),
            "pnl_usd": worst.get("pnl_usd"),
            "pnl_pct": worst.get("pnl_pct"),
        }

        avg_hold = sum(e.get("minutes_held") or 0 for e in closes) / len(closes)
        result["avg_hold_minutes"] = round(avg_hold)

        # Strategy breakdown
        strategies: dict = {}
        for e in closes:
            s = e.get("strategy") or "unknown"
            strategies.setdefault(s, {"wins": 0, "total": 0})
            strategies[s]["total"] += 1
            if (e.get("pnl_usd") or 0) > 0:
                strategies[s]["wins"] += 1
        result["strategy_breakdown"] = {
            s: {
                "total": v["total"],
                "wins": v["wins"],
                "win_rate_pct": round(v["wins"] / v["total"] * 100),
            }
            for s, v in strategies.items()
        }

    return result
