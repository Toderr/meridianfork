# cli-anything-meridian

CLI harness for the [Meridian](https://github.com/Toderr/meridianfork) autonomous Solana DLMM LP agent.

Provides structured access to the agent's state, trade journal, configuration,
and learning system — all without touching the running Node.js process.

## Installation

```bash
cd /path/to/meridianfork/agent-harness
pip install -e .
```

Verify:
```bash
cli-anything-meridian --version
# cli-anything-meridian, version 0.1.0
```

## Configuration

Set `MERIDIAN_DIR` to your Meridian project root (default: parent of this directory):

```bash
export MERIDIAN_DIR=/path/to/meridianfork
```

Or pass it per-command:
```bash
MERIDIAN_DIR=/path/to/meridianfork cli-anything-meridian status overview
```

## Quick Start

```bash
# Agent overview
cli-anything-meridian status overview

# Open positions
cli-anything-meridian status positions

# All-time stats
cli-anything-meridian journal stats

# Daily report
cli-anything-meridian report daily

# Tune take-profit threshold (hot-reloaded by agent in ~2s)
cli-anything-meridian config set takeProfitFeePct 8

# JSON output for scripting/agents
cli-anything-meridian journal stats --json
```

## Command Reference

| Command | Description |
|---------|-------------|
| `status overview` | Position counts, fees, last update |
| `status positions` | Open positions with age and OOR status |
| `status config` | Dump active user-config.json |
| `journal recent [--n N]` | Last N journal entries |
| `journal closes [--n N]` | Last N closed positions with PnL |
| `journal today` | Today's trading summary |
| `journal stats` | All-time win rate and PnL |
| `report daily/weekly/monthly` | Period trading reports |
| `config get [KEY]` | Read config |
| `config set KEY VALUE` | Update config (hot-reloaded) |
| `lessons list [--n N] [--type TYPE]` | View lessons |
| `lessons performance [--n N]` | Performance records |
| `lessons summary` | Performance statistics |
| `repl` | Interactive REPL mode |

All commands support `--json` for machine-readable output.

## Running Tests

```bash
cd agent-harness

# Unit tests (no deps)
python3 -m pytest cli_anything/meridian/tests/test_core.py -v

# E2E tests (real files)
MERIDIAN_DIR=/path/to/meridianfork \
  python3 -m pytest cli_anything/meridian/tests/test_full_e2e.py -v
```
