---
name: cli-anything-meridian
version: 0.1.0
description: CLI harness for the Meridian autonomous Solana DLMM LP agent
binary: cli-anything-meridian
install: pip install -e /path/to/meridianfork/agent-harness
env:
  MERIDIAN_DIR: "path to meridianfork project root (default: parent of agent-harness)"
output_formats:
  - human (default)
  - json (--json flag on any command)
---

# cli-anything-meridian Skill

CLI harness for inspecting and configuring the Meridian LP agent's state,
journal, lessons, and configuration. All commands are **read-only** except
`config set`, which writes `user-config.json` (hot-reloaded by the agent
within ~2 seconds).

## Command Groups

### `status` — Agent runtime state

```bash
cli-anything-meridian status overview [--json]
# Open/closed position counts, fees claimed, last state update, recent events

cli-anything-meridian status positions [--json]
# List open positions: pool name, strategy, SOL amount, age, OOR status

cli-anything-meridian status config [--json]
# Dump user-config.json (sensitive keys redacted in human mode)
```

### `journal` — Trade journal queries

```bash
cli-anything-meridian journal recent [--n N] [--json]
# Last N entries (opens + closes + claims). Default N=5, max 20.

cli-anything-meridian journal closes [--n N] [--json]
# Last N close events with PnL (USD | SOL | %). Default N=10.

cli-anything-meridian journal today [--json]
# Today's stats: opened, closed, PnL, fees, win rate (UTC+7 day boundary)

cli-anything-meridian journal stats [--json]
# All-time: total trades, win rate, total PnL, avg profit/loss %, avg hold
```

### `report` — Period trading reports

```bash
cli-anything-meridian report daily [--json]    # Last 24h
cli-anything-meridian report weekly [--json]   # Last 7 days
cli-anything-meridian report monthly [--json]  # Last 30 days
```

Report fields: positions_opened, positions_closed, total_pnl_usd,
total_pnl_sol, total_pnl_pct, total_fees_usd, win_rate_pct, wins, losses,
best_trade, worst_trade, avg_hold_minutes, strategy_breakdown.

### `config` — Read/write configuration

```bash
cli-anything-meridian config get [KEY] [--json]
# Get all config or a specific key. Sensitive keys shown as *** in human mode.

cli-anything-meridian config set KEY VALUE [--json]
# Write a single key. Auto-casts numbers and booleans.
# Hot-reloaded by agent within ~2s for most keys.
# Keys requiring restart: rpcUrl, walletKey, dryRun, *IntervalMin
```

### `lessons` — Learning system

```bash
cli-anything-meridian lessons list [--n N] [--type TYPE] [--json]
# Lessons list. TYPE: good | poor | bad | manual | neutral

cli-anything-meridian lessons performance [--n N] [--json]
# Last N position performance records (pool, strategy, PnL, hold time)

cli-anything-meridian lessons summary [--json]
# Win rate, rolling win rate (last 10), total PnL, lessons by type
```

### `repl` — Interactive mode

```bash
cli-anything-meridian repl
# Interactive REPL — type commands without the binary prefix
```

## JSON Output Schemas

### `status overview`
```json
{
  "open_positions": 2,
  "closed_positions": 47,
  "total_fees_claimed_usd": 12.50,
  "last_updated": "2026-03-26T10:00:00.000Z",
  "recent_events": [{"ts": "...", "action": "deploy", "pool_name": "WIZARD-SOL"}]
}
```

### `status positions` (array)
```json
[{
  "position": "8FxV...",
  "pool_name": "WIZARD-SOL",
  "strategy": "bid_ask",
  "amount_sol": 0.5,
  "initial_value_usd": 85.0,
  "deployed_at": "2026-03-26T08:00:00.000Z",
  "age_minutes": 120,
  "out_of_range_since": null,
  "minutes_out_of_range": 0,
  "instruction": null,
  "total_fees_claimed_usd": 0.0,
  "bin_step": 100,
  "volatility": 2,
  "organic_score": 75
}]
```

### `journal stats`
```json
{
  "total_trades": 52,
  "wins": 34,
  "losses": 18,
  "win_rate_pct": 65,
  "total_pnl_usd": 23.40,
  "total_pnl_sol": 0.1376,
  "avg_profit_pct": 3.21,
  "avg_loss_pct": -1.84,
  "avg_hold_minutes": 87
}
```

### `config set`
```json
{
  "key": "takeProfitFeePct",
  "old": 5,
  "new": 8,
  "requires_restart": false,
  "warning": null
}
```

## Agent Usage Pattern

```bash
# 1. Check agent health
cli-anything-meridian status overview --json

# 2. Inspect open positions
cli-anything-meridian status positions --json

# 3. Check recent performance
cli-anything-meridian journal stats --json
cli-anything-meridian report daily --json

# 4. Tune a threshold (hot-reloaded in ~2s)
cli-anything-meridian config set takeProfitFeePct 8

# 5. Check lessons learned
cli-anything-meridian lessons list --n 5 --type bad --json
```

## Notes for AI Agents

- All commands exit 0 on success, nonzero on errors (missing arg, invalid type)
- All commands handle missing runtime files gracefully (return zeros/empty lists)
- `config set` never touches `walletKey` or credentials in normal use
- PnL is always in both USD and native SOL — never convert between them
- Journal entries use ISO 8601 timestamps in UTC
- Position addresses are base58 Solana pubkeys (~44 chars)
