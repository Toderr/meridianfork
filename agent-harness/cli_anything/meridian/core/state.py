"""
Read Meridian state.json — active position tracking.

state.json structure:
  {
    "positions": {
      "<address>": {
        position, pool, pool_name, strategy, bin_range, amount_sol,
        deployed_at, out_of_range_since, closed, closed_at, notes,
        instruction, ...
      }
    },
    "recentEvents": [...],
    "lastUpdated": "..."
  }
"""

import json
from datetime import datetime, timezone
from typing import Optional

from cli_anything.meridian.core.paths import state_path


def load_state() -> dict:
    path = state_path()
    if not path.exists():
        return {"positions": {}, "recentEvents": [], "lastUpdated": None}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {"positions": {}, "recentEvents": [], "lastUpdated": None}


def get_open_positions() -> list[dict]:
    state = load_state()
    return [p for p in state.get("positions", {}).values() if not p.get("closed")]


def get_all_positions() -> list[dict]:
    state = load_state()
    return list(state.get("positions", {}).values())


def get_position(address: str) -> Optional[dict]:
    state = load_state()
    return state.get("positions", {}).get(address)


def position_age_minutes(pos: dict) -> Optional[int]:
    deployed_at = pos.get("deployed_at")
    if not deployed_at:
        return None
    try:
        dt = datetime.fromisoformat(deployed_at.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        return int(delta.total_seconds() / 60)
    except Exception:
        return None


def minutes_out_of_range(pos: dict) -> int:
    oor = pos.get("out_of_range_since")
    if not oor:
        return 0
    try:
        dt = datetime.fromisoformat(oor.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        return max(0, int(delta.total_seconds() / 60))
    except Exception:
        return 0


def summarize_positions() -> list[dict]:
    """Return open positions with computed age and OOR fields."""
    positions = get_open_positions()
    result = []
    for p in positions:
        result.append(
            {
                "position": p.get("position"),
                "pool": p.get("pool"),
                "pool_name": p.get("pool_name"),
                "strategy": p.get("strategy"),
                "amount_sol": p.get("amount_sol"),
                "initial_value_usd": p.get("initial_value_usd"),
                "deployed_at": p.get("deployed_at"),
                "age_minutes": position_age_minutes(p),
                "out_of_range_since": p.get("out_of_range_since"),
                "minutes_out_of_range": minutes_out_of_range(p),
                "instruction": p.get("instruction"),
                "total_fees_claimed_usd": p.get("total_fees_claimed_usd", 0),
                "rebalance_count": p.get("rebalance_count", 0),
                "bin_step": p.get("bin_step"),
                "volatility": p.get("volatility"),
                "organic_score": p.get("organic_score"),
            }
        )
    return result


def get_overview() -> dict:
    state = load_state()
    positions = list(state.get("positions", {}).values())
    open_pos = [p for p in positions if not p.get("closed")]
    closed_pos = [p for p in positions if p.get("closed")]
    total_fees = sum(p.get("total_fees_claimed_usd", 0) for p in positions)

    return {
        "open_positions": len(open_pos),
        "closed_positions": len(closed_pos),
        "total_fees_claimed_usd": round(total_fees, 2),
        "last_updated": state.get("lastUpdated"),
        "recent_events": (state.get("recentEvents") or [])[-10:],
    }
