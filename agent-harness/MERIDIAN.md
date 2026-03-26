# MERIDIAN CLI Harness — Standard Operating Procedures

## Overview

Meridian is an autonomous Node.js agent that manages liquidity positions on
Meteora DLMM pools on Solana. It runs scheduled management and screening
cycles, sends Telegram notifications, and self-tunes via a learning system.

The CLI harness (`cli-anything-meridian`) provides read-only access to all
agent state files and config, plus write access to `user-config.json` for
live threshold tuning. It does **not** start/stop the agent process — use
`pm2` for that.

## Installation

```bash
cd agent-harness
pip install -e .
cli-anything-meridian --help
```

## Runtime Files (read by the CLI)

| File | Description |
|------|-------------|
| `journal.json` | Append-only trade journal (open/close/claim events) |
| `state.json` | Active position tracking |
| `lessons.json` | Performance records and derived lessons |
| `user-config.json` | Agent configuration (hot-reloadable) |
| `strategy-library.json` | Saved LP strategy templates |
| `pool-memory.json` | Per-pool deploy history and notes |
| `agent-stats.json` | In-memory counters (deploys, closes, etc.) |

All runtime files live in the **project root** (`../` relative to this
harness). The CLI resolves paths via the `MERIDIAN_DIR` env var (default:
parent of this harness directory).

## Command Groups

### `status`
- `cli-anything-meridian status overview` — wallet balance, open positions count, cycle timers
- `cli-anything-meridian status positions` — list open positions with PnL and age
- `cli-anything-meridian status config` — dump active configuration

### `journal`
- `cli-anything-meridian journal recent [--n N]` — last N entries (default 5)
- `cli-anything-meridian journal closes [--n N]` — last N close events with PnL
- `cli-anything-meridian journal today` — today's summary stats
- `cli-anything-meridian journal stats` — all-time win rate and PnL

### `report`
- `cli-anything-meridian report daily` — last 24h trading report
- `cli-anything-meridian report weekly` — last 7 days
- `cli-anything-meridian report monthly` — last 30 days

### `config`
- `cli-anything-meridian config get [KEY]` — get all or specific config key
- `cli-anything-meridian config set KEY VALUE` — update user-config.json (hot-reloaded by agent)

### `lessons`
- `cli-anything-meridian lessons list [--n N]` — last N lessons
- `cli-anything-meridian lessons performance [--n N]` — last N position performance records

## Output Modes

All commands support `--json` for machine-readable output:
```bash
cli-anything-meridian status positions --json
cli-anything-meridian journal stats --json
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MERIDIAN_DIR` | `..` (parent of harness) | Path to Meridian project root |

## Agent Interaction Pattern (for AI agents)

```
1. cli-anything-meridian status overview --json        → check agent health
2. cli-anything-meridian status positions --json       → see open positions
3. cli-anything-meridian journal stats --json          → get performance summary
4. cli-anything-meridian config get --json             → read active thresholds
5. cli-anything-meridian config set takeProfitFeePct 8 → tune a threshold live
6. cli-anything-meridian report daily --json           → get trading report
```

## Key Domain Concepts

- **DLMM (Dynamic Liquidity Market Maker)**: Meteora's concentrated liquidity
  protocol. Positions are defined by a bin range around the active price bin.
- **Bin step**: Price increment per bin (80-125 basis points typical).
- **Strategy**: `bid_ask` (asymmetric, fees both sides) or `spot` (symmetric).
- **PnL**: Always tracked in native SOL and USD separately. Never convert via formula.
- **Organic score**: % of organic (non-bot) trading volume (0-100).
- **Fee/TVL ratio**: Fee yield relative to deployed capital — primary quality signal.
