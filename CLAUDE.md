# Meridian — Autonomous Solana DLMM LP Agent

## Project Overview

Meridian is a Node.js autonomous agent that manages liquidity positions on Meteora DLMM pools on Solana. It screens pools, deploys positions, monitors them, and closes them based on LLM decisions.

## Repository

- **Fork (active):** https://github.com/Toderr/meridianfork
- **Upstream:** https://github.com/yunus-0x/meridian
- Push all changes to `fork` remote: `git push fork main`

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Entry point — cron scheduler, Telegram bot, TTY REPL |
| `agent.js` | Core ReAct agent loop (OpenRouter API) |
| `config.js` | Config loader with hot-reload for `user-config.json` |
| `tools/dlmm.js` | Meteora DLMM SDK — deploy/close/PnL/positions |
| `tools/wallet.js` | Wallet balance + SOL price |
| `lessons.js` | Performance recording and learning system |
| `journal.js` | Append-only trade journal (open/close/claim events) |
| `reports.js` | Daily/weekly/monthly HTML reports |
| `briefing.js` | Morning briefing (wraps `generateReport("daily")`) |
| `prompt.js` | System prompt builder |
| `telegram.js` | Telegram bot (long-polling) |

## Runtime Files (gitignored, never overwrite on VPS)

- `user-config.json` — RPC URL, wallet key, API keys, LLM models
- `state.json` — active position tracking
- `journal.json` — trade history
- `lessons.json` — performance records and derived lessons
- `.env` — environment variables
- `.agent.pid` — PID lock file (prevents duplicate instances)

## Architecture

### Cron Cycles
- **Management** (default 10m): reviews open positions, decides close/hold
- **Screening** (default 30m): scans pools, deploys new positions

### Agent Types
- `MANAGER` — manages existing positions
- `SCREENER` — finds and deploys new positions
- `GENERAL` — TTY/Telegram ad-hoc queries

### LLM Models (configured in `user-config.json`)
- `managementModel` — used for management cycle
- `screeningModel` — used for screening cycle
- `generalModel` — used for TTY and Telegram queries
- All fall back to `process.env.LLM_MODEL` then hardcoded defaults

### Hot-reload
`user-config.json` is watched via `fs.watchFile` (2s interval). Changes to screening thresholds, management settings, risk limits, strategy, and LLM models apply without restart. `rpcUrl`, `walletKey`, `dryRun`, and schedule intervals require restart.

## SOL PnL — Important

**Never compute `pnl_sol` via USD conversion.** The Meteora DLMM API returns native SOL fields: `pnlSol`, `balancesSol`, `amountSol`. Use these directly.

Chain: `cachedPos.pnl_sol` (from `tools/dlmm.js` → Meteora API `pnlSol`) → `recordPerformance` → `recordJournalClose` → `journal.json` → reports.

## Management Cycle — Range & PnL Block

The `finally` block in the management cron (`index.js`) sends the Telegram report. Range bars and PnL summary are built from a **fresh `getMyPositions()` call after the agent loop** — not from the pre-cycle snapshot. This ensures closed positions don't appear in the range/PnL block.

## Telegram Notifications

- **Deploy**: pair name, amount, position address (truncated), tx
- **Close**: pool name (from state tracker via `getTrackedPosition`), PnL $ and %
  - Source: `tools/executor.js` → `notifyClose()` in `telegram.js`
  - Always show `pool_name`, fallback to `position_address.slice(0,8)`
- **Out of range**: pair name, minutes OOR

## Telegram Commands

| Command | Action |
|---------|--------|
| `/start` | Start cron cycles |
| `/stop` | Stop cron cycles |
| `/briefing` | Last 24h trading report |
| `/report [daily\|weekly\|monthly]` | Trading report |

## VPS Deployment

### Initial Setup
```bash
git clone https://github.com/Toderr/meridianfork.git
cd meridianfork
npm install
# create user-config.json and .env manually
pm2 start index.js --name meridian
pm2 save && pm2 startup
```

### Updating
```bash
git pull origin main
npm install --omit=dev  # only if package.json changed
pm2 restart meridian
```

Or use `update.sh`:
```bash
#!/bin/bash
cd ~/meridianfork
git pull origin main
pm2 restart meridian
```

## Git Workflow

- Push to `fork` remote: `git push fork main`
- Commit frequently with clear messages explaining *why*, not just *what*
- `user-config.json`, state files, and logs are gitignored — safe to `git pull` on VPS without overwriting live data
