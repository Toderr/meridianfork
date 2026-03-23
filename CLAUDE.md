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
| `tools/screening.js` | Pool discovery and candidate scoring |
| `tools/executor.js` | Tool dispatch, post-tool hooks (notify, journal, sync) |
| `tools/definitions.js` | LLM tool schemas for all agent roles |
| `lessons.js` | Performance recording and learning system |
| `journal.js` | Append-only trade journal (open/close/claim events) |
| `reports.js` | Daily/weekly/monthly HTML reports |
| `briefing.js` | Morning briefing (wraps `generateReport("daily")`) |
| `prompt.js` | System prompt builder |
| `telegram.js` | Telegram bot (long-polling) |
| `hive-mind.js` | Opt-in collective intelligence network |
| `stats.js` | Shared in-memory counters + flags (`_stats`, `_flags`) |
| `strategy-library.js` | LP strategy template storage and retrieval |
| `pool-memory.js` | Per-pool deploy history and notes |
| `scripts/patch-anchor.js` | Postinstall: patches `@coral-xyz/anchor` + `@meteora-ag/dlmm` for Node ESM |

## Runtime Files (gitignored, never overwrite on VPS)

- `user-config.json` — RPC URL, wallet key, API keys, LLM models
- `state.json` — active position tracking
- `journal.json` — trade history
- `lessons.json` — performance records and derived lessons
- `strategy-library.json` — saved LP strategy templates
- `pool-memory.json` — per-pool deploy history and notes
- `.env` — environment variables
- `.agent.pid` — PID lock file (prevents duplicate instances)

## Architecture

### Cron Cycles
- **Management** (default 10m): reviews open positions, decides close/hold
- **Screening** (default 30m): scans pools, deploys new positions

### Agent Types
- `MANAGER` — manages existing positions
- `SCREENER` — finds and deploys new positions (more important — determines entry quality)
- `GENERAL` — TTY/Telegram ad-hoc queries

### LLM Models (configured in `user-config.json`)
- `managementModel` — used for management cycle (simpler task, can use lighter model)
- `screeningModel` — used for screening cycle (**more important** — use the best model here)
- `generalModel` — used for TTY and Telegram queries
- All fall back to `process.env.LLM_MODEL` then hardcoded defaults

### LLM Fallback
If the primary model fails 3 times (empty response, provider error, or timeout), the agent automatically falls back to `z-ai/glm-5` for that turn only. Next step reverts to the original model. Model is resolved per-step so hot-reload changes take effect immediately.

### Hot-reload
`user-config.json` is watched via `fs.watchFile` (2s interval). Changes to screening thresholds, management settings, risk limits, strategy, and LLM models apply without restart. `rpcUrl`, `walletKey`, `dryRun`, and schedule intervals require restart.

## SOL PnL — Important

**Never compute `pnl_sol` via USD conversion.** The Meteora DLMM API returns native SOL fields: `pnlSol`, `balancesSol`, `amountSol`. Use these directly.

Chain: `getMyPositions()` returns `pnl_sol` from Meteora API `pnlSol` → cached as `_positionsCache` → `closePosition` snapshots `cachedPos.pnl_sol` → `recordPerformance` → `recordJournalClose` → `journal.json` → reports. Also passed to `notifyClose()` for Telegram.

**PnL passthrough**: `closePosition` passes `pnl_usd` from Meteora's API to `recordPerformance`. `lessons.js` uses `perf.pnl_usd` directly when provided, avoiding formula recalculation errors caused by missing `initial_value_usd`.

## Management Cycle — Report

The `finally` block in the management cron (`index.js`) sends the Telegram report. It reuses the pre-loaded PnL from the start of the cycle (no re-fetch) so the PnL shown matches what the agent saw. Positions closed during the agent loop are filtered out. Each open position gets its own block with inline reasoning:

```
🔄 MANAGE

📍 TOKEN-SOL
💰 PnL: +$0.02 | +0.0000 SOL | +0.04%
⏱️ Age: 74m

📊 Ranges:
TOKEN-SOL [━━━━━━━━●━━━━━━━] ✅
💡 STAY — in range, no rules triggered

———————————

📍 OTHER-SOL
💰 PnL: -$0.10 | -0.0002 SOL | -0.22%
⏱️ Age: 25m

📊 Ranges:
OTHER-SOL [━━━━━━━━━━━━━━━●] ⚠️
💡 STAY — OOR 2 bins, below 5-bin threshold

———————————
💰 Balance: 0.32 SOL | ⏰ Next: 5m
```

The LLM report format is one line per position: `[PAIR]: STAY/CLOSE — [short reason]`. This is parsed and embedded inline under each position block.

## Telegram Notifications

All notifications use plain-text format (no HTML bold). Format:

| Event | Header |
|-------|--------|
| Deploy | `✅ DEPLOY` |
| Close | `🔒 CLOSE` |
| Instruction close | `📋 INSTRUCTION CLOSE` |
| Out of range | `⚠️ OUT OF RANGE` |
| Auto-swap | `💱 SWAP` |
| Swap failed | `⚠️ SWAP FAILED` |
| Gas low | `⛽ LOW GAS` |
| Max positions | `📵 MAX POSITIONS` |
| Threshold evolved | `🧠 THRESHOLD EVOLVED` |
| Screening report | `🔍 SCREEN` |
| Management report | `🔄 MANAGE` |

- **Close format**: `💰 PnL: +$0.02 | +0.0000 SOL | +0.04%` — all three values (USD, SOL, %)
- **Gas low**: sent once when SOL is insufficient; suppressed until a position closes. Uses `_flags.gasLowNotified` in `stats.js`.

## Screening Cycle — Report

The `finally` block sends the screening report to Telegram. LLM output is formatted as a strict one-liner, then wrapped with a footer:

```
🔍 SCREEN

💡 WIZARD-SOL: DEPLOY — high fees, smart wallets present

———————————
💰 Balance: 0.47 SOL | ⏰ Next: 29m
```

No deploy:
```
🔍 SCREEN

💡 NO DEPLOY — all narratives still generating
Best candidate: CHIBI-SOL — narrative pending

———————————
💰 Balance: 0.97 SOL | ⏰ Next: 29m
```

The LLM prompt enforces: no markdown, no tables, no headers, no next-steps — just the result line(s).

## Transaction Retry

All on-chain `sendAndConfirmTransaction` calls in `tools/dlmm.js` go through `sendWithRetry()` — 5 attempts with exponential backoff (1s, 2s, 4s, 8s). Covers:
- `closePosition`: step 1 claim fees, step 2 remove liquidity
- `deployPosition`: create position tx(s), add liquidity tx(s)
- `claimFees`

On failure, each attempt logs `[retry] <label> attempt N/5 failed (...), retrying in Xs...`.

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

### If `@meteora-ag/dlmm` is broken (missing index.mjs)
Do NOT `rm` the file manually. Reinstall the package:
```bash
npm install @meteora-ag/dlmm
pm2 restart meridian
```

### Hive Mind Registration (one-time)
```bash
node -e "import('./hive-mind.js').then(m => m.register('https://meridian-hive-api-production.up.railway.app', '<token>'))"
```
Saves `hiveMindUrl`, `hiveMindApiKey`, and `hiveMindAgentId` to `user-config.json`.

## Key Data Flows

### Position Deployment
```
screening cron → getMyPositions (count check) → getWalletBalances (SOL check)
→ computeDeployAmount (scale from wallet) → getTopCandidates (filtered pools)
→ parallel: smart_wallets + token_holders + narrative + token_info + hive consensus
→ agent loop (pick best, apply rules) → deploy_position (on-chain)
→ trackPosition (state.json) → recordOpen (journal.json) → notifyDeploy (Telegram)
```

### Position Close & Learning
```
close_position (on-chain claim + remove liquidity)
→ snapshot PnL from cache BEFORE invalidating
→ recordClose (state.json) → recordPerformance (lessons.json + derivLesson)
→ every 5 positions: evolveThresholds (auto-tune config)
→ recordJournalClose (journal.json with native pnl_sol)
→ auto-swap base token to SOL (if >= $0.10) → notifyClose (Telegram)
→ syncToHive() (upload deploy history + lessons to hive network)
→ _flags.gasLowNotified = false (reset gas warning)
```

### PnL Checker (every 30s, no LLM)

Runs alongside the management cycle via `setInterval`. Skips when `_managementBusy`. If a position has an `instruction` set, it is skipped entirely (deferred to management cycle).

```
if pnl_pct >= 15%         → CLOSE (hard take-profit)
if pnl_pct > 6%           → activate trailing stop, track peak
if trailing active AND
   pnl_pct < 5%           → CLOSE (trailing stop triggered)
```

Peak is stored in `_trailingStops` Map (in-memory, resets on restart). Calls `executeTool("close_position")` which handles close → notify → swap → journal → hive sync.

### Management Decision Rules (in priority order)
1. instruction set AND condition met → CLOSE
2. instruction set AND condition NOT met → HOLD (skip remaining)
3. pnl_pct <= emergencyPriceDropPct → CLOSE (stop loss)
4. pnl_pct >= takeProfitFeePct → CLOSE (take profit)
5. age >= minAgeForYieldExit AND fee_tvl_24h < minFeeTvl24h → CLOSE (yield too low)
6. bins_above_range >= outOfRangeBinsToClose → CLOSE (price pumped above range)
7. unclaimed_fee_usd >= minClaimAmount → claim_fees

## Hive Mind

Opt-in collective intelligence network (`hive-mind.js`). When enabled:
- **Screening**: pool consensus injected into agent prompt if 3+ agents have data
- **After close**: local data (lessons, deploys, thresholds) synced to hive
- **Agent tools**: `get_hive_pulse`, `get_hive_pool_consensus`, `get_hive_lessons`
- Enabled by setting `hiveMindUrl` + `hiveMindApiKey` in `user-config.json`
- All calls are fire-and-forget, never block the agent loop

## ESM Compatibility Patch

`scripts/patch-anchor.js` runs as `postinstall`. It:
1. Adds `exports` map to `@coral-xyz/anchor/package.json` (fixes bare directory imports)
2. Rewrites `@meteora-ag/dlmm/dist/index.mjs` — fixes bare imports and removes duplicate `BN` declarations
   - Deduplication handles the case where the file was patched multiple times before the guard existed

## Risk Management

- **Position sizing**: `(wallet - gasReserve) × positionSizePct`, clamped between `deployAmountSol` and `maxDeployAmount`
- **Max positions**: Hard cap via `config.risk.maxPositions` (default 3)
- **Gas reserve**: Always keep `gasReserve` SOL (default 0.2) untouched
- **Anti-scam**: Skip if `global_fees_sol < minTokenFeesSol`, top_10_pct > 60%, bundlers > 30%

## Learning System

- **Lesson derivation**: Auto after each close — good (≥5%), neutral (0-5% → no lesson), poor (-5%–0%), bad (<-5%)
- **Threshold evolution**: Every 5 closes, auto-adjusts volatility ceiling, min fee/TVL floor, min organic score
- **Lesson injection**: ALL lessons injected — no caps. Pinned → Role-matched → Recent. Priority: good > bad > manual > neutral
- **Max change per step**: 20% to prevent whiplash
- **Persistent instructions**: Tell agent "hold until X%" or "save lesson: ..." → agent calls `set_position_note` / `add_lesson` → stored in state.json / lessons.json → applied every cycle. Verbal-only instructions (no tool call) are forgotten after the turn.

## Roadmap / Improvement Ideas

### High Impact
- Multi-strategy templates: each strategy screens with its own criteria, LP settings, and exit rules
- Dynamic position sizing by volatility (high vol → smaller size)
- Pool memory success rates (track win/loss per pool for screener signal)
- Auto-rebalance: detect better yield opportunity → close stale + redeploy

### Medium Impact
- Re-evaluate management interval during holding (volatility changes)
- Deduplicate similar lessons (10 OOR failures → 1 merged lesson)
- Cross-role learning (manager mistakes → screener avoidance)
- ATH proximity check (skip tokens near their all-time high)

### Low Impact
- Dust token consolidation (batch sweep tokens < $0.10)
- Per-pool strategy overrides (some pools better with "spot" vs "bid_ask")
- Prometheus metrics / observability endpoint
- A/B testing framework for strategy variants

## Git Workflow

- Push to `fork` remote: `git push fork main`
- Commit frequently with clear messages explaining *why*, not just *what*
- `user-config.json`, state files, and logs are gitignored — safe to `git pull` on VPS without overwriting live data
