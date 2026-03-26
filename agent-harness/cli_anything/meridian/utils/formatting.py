"""
Output formatters for human-readable CLI output.
"""

from datetime import datetime, timezone
from typing import Optional


def pnl_str(usd: Optional[float], sol: Optional[float], pct: Optional[float]) -> str:
    parts = []
    if usd is not None:
        sign = "+" if usd >= 0 else "-"
        parts.append(f"{sign}${abs(usd):.2f}")
    if sol is not None:
        sign = "+" if sol >= 0 else ""
        parts.append(f"{sign}{sol:.4f} SOL")
    if pct is not None:
        sign = "+" if pct >= 0 else ""
        parts.append(f"{sign}{pct:.2f}%")
    return " | ".join(parts) if parts else "N/A"


def age_str(minutes: Optional[int]) -> str:
    if minutes is None:
        return "?"
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    mins = minutes % 60
    return f"{hours}h {mins}m"


def ts_short(iso: Optional[str]) -> str:
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.strftime("%m-%d %H:%M")
    except Exception:
        return iso[:16]


def pct_bar(pct: Optional[float], width: int = 20) -> str:
    """Simple ASCII bar for a percentage value (0-100)."""
    if pct is None:
        return "?" * width
    filled = int(min(100, max(0, pct)) / 100 * width)
    return "█" * filled + "░" * (width - filled)


def format_position_row(pos: dict) -> str:
    name = pos.get("pool_name") or pos.get("pool", "?")[:12]
    strategy = pos.get("strategy") or "?"
    sol = pos.get("amount_sol") or 0
    age = age_str(pos.get("age_minutes"))
    oor = pos.get("minutes_out_of_range", 0)
    oor_str = f" ⚠️ OOR {oor}m" if oor > 0 else ""
    instruction = pos.get("instruction")
    instr_str = f" 📋 {instruction}" if instruction else ""
    return f"  {name:<18} {strategy:<8} {sol:.3f} SOL  age={age}{oor_str}{instr_str}"


def format_close_row(entry: dict) -> str:
    name = entry.get("pool_name") or "?"
    pnl_usd = entry.get("pnl_usd")
    pnl_sol = entry.get("pnl_sol")
    pnl_pct = entry.get("pnl_pct")
    ts = ts_short(entry.get("timestamp"))
    held = entry.get("minutes_held")
    held_str = f" {age_str(held)}" if held else ""
    reason = entry.get("close_reason") or ""
    reason_short = reason[:30] + "..." if len(reason) > 30 else reason
    return (
        f"  {ts}  {name:<18} "
        f"{pnl_str(pnl_usd, pnl_sol, pnl_pct):<30}"
        f"{held_str}  {reason_short}"
    )


def format_lesson_row(lesson: dict) -> str:
    ltype = lesson.get("type", "?")
    rule = lesson.get("rule") or ""
    if len(rule) > 80:
        rule = rule[:77] + "..."
    pool = lesson.get("pool_name") or ""
    pool_str = f" [{pool}]" if pool else ""
    return f"  [{ltype:<7}]{pool_str} {rule}"
