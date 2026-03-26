"""
cli-anything-meridian — CLI harness for the Meridian Solana DLMM LP agent.

Command groups:
  status    — agent/system status (positions, balances, config)
  journal   — query trade journal
  report    — generate trading reports
  config    — read/update user-config.json
  lessons   — view lessons and performance records
  repl      — interactive REPL
"""

import json
import sys
import os

import click

from cli_anything.meridian.core import journal as journal_mod
from cli_anything.meridian.core import state as state_mod
from cli_anything.meridian.core import config as config_mod
from cli_anything.meridian.core import lessons as lessons_mod
from cli_anything.meridian.utils.formatting import (
    format_position_row,
    format_close_row,
    format_lesson_row,
    pnl_str,
    age_str,
)


# ─── Output helpers ──────────────────────────────────────────────


def out(data, as_json: bool):
    """Print data as JSON or human-readable."""
    if as_json:
        click.echo(json.dumps(data, indent=2, default=str))
    else:
        if isinstance(data, str):
            click.echo(data)
        elif isinstance(data, list):
            for item in data:
                click.echo(item)
        elif isinstance(data, dict):
            for k, v in data.items():
                click.echo(f"  {k}: {v}")


# ─── Root command ────────────────────────────────────────────────


@click.group()
@click.version_option("0.1.0", prog_name="cli-anything-meridian")
def cli():
    """Meridian LP agent CLI harness — inspect state, journal, config."""
    pass


# ═══════════════════════════════════════════
#  STATUS GROUP
# ═══════════════════════════════════════════


@cli.group()
def status():
    """Agent and system status."""
    pass


@status.command("overview")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def status_overview(as_json):
    """Open positions count, fees claimed, last update."""
    data = state_mod.get_overview()
    if as_json:
        out(data, True)
    else:
        click.echo("=== Meridian Agent Overview ===")
        click.echo(f"  Open positions:       {data['open_positions']}")
        click.echo(f"  Closed positions:     {data['closed_positions']}")
        click.echo(f"  Total fees claimed:   ${data['total_fees_claimed_usd']:.2f}")
        click.echo(f"  State last updated:   {data['last_updated'] or 'unknown'}")
        if data.get("recent_events"):
            click.echo("\nRecent events:")
            for ev in data["recent_events"][-5:]:
                ts = (ev.get("ts") or "")[:16]
                action = ev.get("action", "?")
                pool = ev.get("pool_name") or ""
                click.echo(f"  {ts}  {action:<8}  {pool}")


@status.command("positions")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def status_positions(as_json):
    """List open positions with age and OOR status."""
    positions = state_mod.summarize_positions()
    if as_json:
        out(positions, True)
    else:
        if not positions:
            click.echo("No open positions.")
            return
        click.echo(f"=== Open Positions ({len(positions)}) ===")
        click.echo(f"  {'Pool':<18} {'Strategy':<8} {'Amount':<12} {'Age'}")
        click.echo("  " + "-" * 60)
        for pos in positions:
            click.echo(format_position_row(pos))


@status.command("config")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def status_config(as_json):
    """Dump active user-config.json."""
    cfg = config_mod.get_config()
    if as_json:
        out(cfg, True)
    else:
        if not cfg:
            click.echo("user-config.json not found or empty.")
            return
        click.echo("=== Active Configuration ===")
        # Hide sensitive fields
        hidden = {"walletKey", "telegramBotToken", "telegramJournalBotToken",
                  "openrouterApiKey", "hiveMindApiKey", "dashboardPassword"}
        for k, v in cfg.items():
            if k in hidden:
                click.echo(f"  {k}: ***")
            else:
                click.echo(f"  {k}: {v}")


# ═══════════════════════════════════════════
#  JOURNAL GROUP
# ═══════════════════════════════════════════


@cli.group()
def journal():
    """Query the trade journal."""
    pass


@journal.command("recent")
@click.option("--n", default=5, show_default=True, help="Number of entries")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def journal_recent(n, as_json):
    """Last N journal entries (opens, closes, claims)."""
    entries = journal_mod.recent(n=min(n, 20))
    if as_json:
        out(entries, True)
    else:
        if not entries:
            click.echo("No journal entries found.")
            return
        click.echo(f"=== Last {len(entries)} Journal Entries ===")
        for e in entries:
            ts = (e.get("timestamp") or "")[:16]
            etype = e.get("type", "?")
            pool = e.get("pool_name") or e.get("pool", "?")[:16]
            extra = ""
            if etype == "close":
                extra = f"  {pnl_str(e.get('pnl_usd'), e.get('pnl_sol'), e.get('pnl_pct'))}"
            elif etype == "open":
                sol = e.get("amount_sol") or 0
                extra = f"  {sol:.3f} SOL"
            elif etype == "claim":
                fees = e.get("fees_usd") or 0
                extra = f"  fees=${fees:.2f}"
            click.echo(f"  {ts}  [{etype:<5}]  {pool:<20}{extra}")


@journal.command("closes")
@click.option("--n", default=10, show_default=True, help="Number of closes")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def journal_closes(n, as_json):
    """Last N closed positions with PnL."""
    closes = journal_mod.recent_closes(n=min(n, 50))
    if as_json:
        out(closes, True)
    else:
        if not closes:
            click.echo("No close entries found.")
            return
        click.echo(f"=== Last {len(closes)} Closed Positions ===")
        for e in closes:
            click.echo(format_close_row(e))


@journal.command("today")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def journal_today(as_json):
    """Today's trading summary (UTC+7)."""
    data = journal_mod.today_summary()
    if as_json:
        out(data, True)
    else:
        click.echo(f"=== Today ({data['date']}) ===")
        click.echo(f"  Opened:    {data['positions_opened']}")
        click.echo(f"  Closed:    {data['positions_closed']}")
        click.echo(f"  PnL:       {pnl_str(data['total_pnl_usd'], data['total_pnl_sol'], None)}")
        click.echo(f"  Fees:      ${data['total_fees_usd']:.2f}")
        wr = data["win_rate_pct"]
        if wr is not None:
            click.echo(f"  Win rate:  {wr}% ({data['wins']}W / {data['losses']}L)")
        else:
            click.echo("  Win rate:  N/A (no closes today)")


@journal.command("stats")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def journal_stats(as_json):
    """All-time win rate and total PnL."""
    data = journal_mod.all_time_stats()
    if as_json:
        out(data, True)
    else:
        click.echo("=== All-Time Stats ===")
        click.echo(f"  Total trades:    {data['total_trades']}")
        wr = data["win_rate_pct"]
        click.echo(
            f"  Win rate:        {wr}% ({data['wins']}W / {data['losses']}L)"
            if wr is not None else "  Win rate:        N/A"
        )
        click.echo(f"  Total PnL:       {pnl_str(data['total_pnl_usd'], data['total_pnl_sol'], None)}")
        if data["avg_profit_pct"] is not None:
            click.echo(f"  Avg profit:      +{data['avg_profit_pct']:.2f}%")
        if data["avg_loss_pct"] is not None:
            click.echo(f"  Avg loss:        {data['avg_loss_pct']:.2f}%")
        if data["avg_hold_minutes"] is not None:
            click.echo(f"  Avg hold time:   {age_str(data['avg_hold_minutes'])}")


# ═══════════════════════════════════════════
#  REPORT GROUP
# ═══════════════════════════════════════════


@cli.group()
def report():
    """Generate trading reports."""
    pass


def _print_report(period: str, as_json: bool):
    data = journal_mod.period_report(period)
    if as_json:
        out(data, True)
        return

    emoji = {"daily": "☀️", "weekly": "📅", "monthly": "📆"}.get(period, "📊")
    click.echo(f"{emoji}  Trading Report — {data['label']}")
    click.echo("─" * 40)
    click.echo(f"  Opened:      {data['positions_opened']}")
    click.echo(f"  Closed:      {data['positions_closed']}")
    click.echo(f"  Net PnL:     {pnl_str(data['total_pnl_usd'], data['total_pnl_sol'], data['total_pnl_pct'])}")
    click.echo(f"  Fees earned: ${data['total_fees_usd']:.2f}")
    wr = data["win_rate_pct"]
    if wr is not None:
        click.echo(f"  Win rate:    {wr}% ({data['wins']}W / {data['losses']}L)")
    else:
        click.echo("  Win rate:    N/A")

    if data.get("best_trade"):
        b = data["best_trade"]
        click.echo(
            f"  Best trade:  {b['pool']}  +${b['pnl_usd']:.2f} ({b['pnl_pct']:.1f}%)"
        )
    if data.get("worst_trade"):
        w = data["worst_trade"]
        click.echo(
            f"  Worst trade: {w['pool']}  ${w['pnl_usd']:.2f} ({w['pnl_pct']:.1f}%)"
        )
    if data.get("avg_hold_minutes"):
        click.echo(f"  Avg hold:    {age_str(data['avg_hold_minutes'])}")

    if data.get("strategy_breakdown"):
        click.echo("\n  Strategy breakdown:")
        for strat, stats in data["strategy_breakdown"].items():
            click.echo(
                f"    {strat:<10} {stats['total']} trades  {stats['win_rate_pct']}% win"
            )


@report.command("daily")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def report_daily(as_json):
    """Last 24 hours trading report."""
    _print_report("daily", as_json)


@report.command("weekly")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def report_weekly(as_json):
    """Last 7 days trading report."""
    _print_report("weekly", as_json)


@report.command("monthly")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def report_monthly(as_json):
    """Last 30 days trading report."""
    _print_report("monthly", as_json)


# ═══════════════════════════════════════════
#  CONFIG GROUP
# ═══════════════════════════════════════════


@cli.group()
def config():
    """Read or update user-config.json."""
    pass


@config.command("get")
@click.argument("key", required=False)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def config_get(key, as_json):
    """Get all config or a specific KEY."""
    data = config_mod.get_config(key)
    if as_json:
        out(data, True)
    else:
        if key is None:
            cfg = data
            if not cfg:
                click.echo("user-config.json not found or empty.")
                return
            click.echo("=== user-config.json ===")
            hidden = {"walletKey", "telegramBotToken", "telegramJournalBotToken",
                      "openrouterApiKey", "hiveMindApiKey", "dashboardPassword"}
            for k, v in cfg.items():
                display = "***" if k in hidden else v
                click.echo(f"  {k}: {display}")
        else:
            if data is None:
                click.echo(f"Key '{key}' not found in user-config.json")
                sys.exit(1)
            click.echo(f"{key} = {data}")


@config.command("set")
@click.argument("key")
@click.argument("value")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def config_set(key, value, as_json):
    """Set KEY to VALUE in user-config.json."""
    try:
        result = config_mod.set_config(key, value)
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if as_json:
        out(result, True)
    else:
        click.echo(f"  {result['key']}: {result['old']} → {result['new']}")
        if result.get("warning"):
            click.echo(f"  ⚠️  {result['warning']}")
        else:
            click.echo("  ✓ Applied — agent will pick up the change within ~2s")


# ═══════════════════════════════════════════
#  LESSONS GROUP
# ═══════════════════════════════════════════


@cli.group()
def lessons():
    """View lessons and performance records."""
    pass


@lessons.command("list")
@click.option("--n", default=10, show_default=True, help="Number of lessons")
@click.option(
    "--type", "lesson_type",
    type=click.Choice(["good", "poor", "bad", "manual", "neutral"]),
    default=None,
    help="Filter by lesson type",
)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def lessons_list(n, lesson_type, as_json):
    """List recent lessons."""
    data = lessons_mod.get_lessons(n=n, lesson_type=lesson_type)
    if as_json:
        out(data, True)
    else:
        if not data:
            click.echo("No lessons found.")
            return
        click.echo(f"=== Lessons ({len(data)}) ===")
        for lesson in data:
            click.echo(format_lesson_row(lesson))


@lessons.command("performance")
@click.option("--n", default=10, show_default=True, help="Number of records")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def lessons_performance(n, as_json):
    """Last N position performance records."""
    records = lessons_mod.get_performance(n=n)
    if as_json:
        out(records, True)
    else:
        if not records:
            click.echo("No performance records found.")
            return
        click.echo(f"=== Performance Records ({len(records)}) ===")
        for r in records:
            pool = r.get("pool_name") or "?"
            pnl = r.get("pnl_usd") or 0
            pct = r.get("pnl_pct") or 0
            strat = r.get("strategy") or "?"
            held = r.get("minutes_held")
            sign = "+" if pnl >= 0 else ""
            held_str = f"  {age_str(held)}" if held else ""
            click.echo(
                f"  {pool:<22} {strat:<8} {sign}${pnl:.2f} ({sign}{pct:.2f}%){held_str}"
            )


@lessons.command("summary")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
def lessons_summary(as_json):
    """Performance and lesson summary statistics."""
    data = lessons_mod.performance_summary()
    if as_json:
        out(data, True)
    else:
        click.echo("=== Lessons Summary ===")
        click.echo(f"  Total performance records: {data['total_records']}")
        wr = data["win_rate_pct"]
        click.echo(f"  Win rate:                  {wr}%" if wr is not None else "  Win rate:                  N/A")
        rwr = data["rolling_win_rate_pct"]
        click.echo(f"  Rolling win rate (last 10): {rwr}%" if rwr is not None else "  Rolling win rate (last 10): N/A")
        pnl = data.get("total_pnl_usd")
        click.echo(f"  Total PnL:                 ${pnl:.2f}" if pnl is not None else "  Total PnL:                 N/A")
        click.echo(f"  Total lessons:             {data['lessons_count']}")
        by_type = data.get("lessons_by_type", {})
        if by_type:
            click.echo("  Lessons by type:")
            for t, cnt in by_type.items():
                click.echo(f"    {t:<8} {cnt}")


# ═══════════════════════════════════════════
#  REPL
# ═══════════════════════════════════════════


@cli.command("repl")
def repl():
    """Interactive REPL — type commands without the 'cli-anything-meridian' prefix."""
    click.echo("Meridian CLI REPL — type 'help' or 'exit'")
    click.echo("Commands: status overview|positions|config  journal recent|closes|today|stats")
    click.echo("          report daily|weekly|monthly  config get|set  lessons list|performance|summary")
    while True:
        try:
            line = click.prompt("meridian", prompt_suffix="> ")
        except (EOFError, KeyboardInterrupt):
            click.echo("\nBye.")
            break

        line = line.strip()
        if not line:
            continue
        if line in ("exit", "quit", "q"):
            click.echo("Bye.")
            break
        if line in ("help", "?"):
            click.echo(cli.get_help(click.Context(cli)))
            continue

        args = line.split()
        try:
            cli.main(args, standalone_mode=False)
        except SystemExit:
            pass
        except Exception as e:
            click.echo(f"Error: {e}", err=True)


def main():
    cli()


if __name__ == "__main__":
    main()
