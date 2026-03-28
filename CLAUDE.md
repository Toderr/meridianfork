# Meridian — Autonomous Solana DLMM LP Agent

## Project Overview

Meridian is a Node.js autonomous agent that manages liquidity positions on Meteora DLMM pools on Solana. It screens pools, deploys positions, monitors them, and closes them based on LLM decisions.

## Repository

- **Fork (active):** https://github.com/Toderr/meridianfork
- **Upstream:** https://github.com/yunus-0x/meridian
- Push all changes: `git push origin main`

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
| `experiment.js` | Experiment tier — strategy optimization loop (deploy→close→iterate until convergence) |
| `lessons.js` | Performance recording and learning system |
| `lesson-rules.js` | Lesson rule extractor + compliance checkers (hard enforcement) |
| `journal.js` | Append-only trade journal (open/close/claim events) |
| `reports.js` | Daily/weekly/monthly plain-text reports |
| `briefing.js` | Morning briefing (wraps `generateReport("daily")`) |
| `prompt.js` | System prompt builder |
| `telegram.js` | Telegram bot (long-polling) |
| `telegram-journal.js` | Dedicated journal bot — notifies on close, supports `/recent`, `/today`, `/closes`, `/stats` |
| `hive-mind.js` | Opt-in collective intelligence network |
| `stats.js` | Shared in-memory counters + flags (`_stats`, `_flags`) |
| `strategy-library.js` | LP strategy template storage and retrieval |
| `pool-memory.js` | Per-pool deploy history and notes |
| `scripts/patch-anchor.js` | Postinstall: patches `@coral-xyz/anchor` + `@meteora-ag/dlmm` for Node ESM |
| `scripts/claude-ask.js` | General-purpose Q&A agent for Telegram `/claude` command — loads runtime context, spawns `claude --print` |
| `scripts/claude-lesson-updater.js` | Auto lesson updater — runs every 5 closes via `claude --print` |

## Runtime Files (gitignored, never overwrite on VPS)

- `user-config.json` — RPC URL, wallet key, API keys, LLM models
- `state.json` — active position tracking
- `journal.json` — trade history
- `lessons.json` — performance records and regular (non-experiment) lessons
- `experiment-lessons.json` — experiment-sourced lessons (auto-migrated from lessons.json)
- `strategy-library.json` — saved LP strategy templates
- `pool-memory.json` — per-pool deploy history and notes
- `experiments.json` — active and completed experiment state
- `.env` — environment variables
- `.agent.pid` — PID lock file (prevents duplicate instances)

## Architecture

### Cron Cycles

Management runs on 3 independent volatility tiers via a 1-minute `setInterval` dispatcher. Each tier fires independently; only one runs at a time (`_managementBusy` mutex).

| Tier | Volatility | Interval | Telegram header |
|------|-----------|----------|-----------------|
| high | ≥ 5       | 3 min    | `🔄 MANAGE [HIGH]` |
| med  | 2–5 or null (old deploys) | 5 min | `🔄 MANAGE [MED]` |
| low  | < 2       | 10 min   | `🔄 MANAGE [LOW]` |

- Positions with `volatility === null` (deployed before volatility tracking) → classified as **med**
- If a tier has no matching positions it skips silently (no Telegram send)
- Screening trigger: only from the **lowest-frequency active tier** (prefer low → med → high)
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

**Pair name resolution** in `getMyPositions()`: tracked state `pool_name` → PnL API `pairName` (or `tokenName0-tokenName1`) → `getPoolDetail()` fallback → address slice. Discovered names are backfilled into state.json via `updatePoolName()` so they persist for future calls.

**PnL passthrough**: `closePosition` passes `pnl_usd` from Meteora's API to `recordPerformance`. `lessons.js` uses `perf.pnl_usd` directly when provided, avoiding formula recalculation errors caused by missing `initial_value_usd`.

## Management Cycle — Report

The `finally` block in the management cycle (`index.js`) sends the Telegram report. It reuses the pre-loaded PnL from the start of the cycle (no re-fetch) so the PnL shown matches what the agent saw. Positions closed during the agent loop are filtered out. Each open position gets its own block with inline reasoning.

The report header includes the tier label: `🔄 MANAGE [HIGH]`, `🔄 MANAGE [MED]`, or `🔄 MANAGE [LOW]`. If a tier has no matching positions it returns immediately without sending any message.

```
🔄 MANAGE [MED]

📍 TOKEN-SOL
💵 Invested: 0.50 SOL | $85.00
💰 PnL: +$0.02 | +0.0000 SOL
💸 Fees: $0.05 | Total: +0.04%
⏱️ Age: 74m | 🎯 bid_ask

📊 Ranges:
TOKEN-SOL [━━━━━━━━●━━━━━━━] ✅
💡 STAY — in range, no rules triggered

———————————

📍 OTHER-SOL
💵 Invested: 0.30 SOL | $51.00
💰 PnL: -$0.10 | -0.0002 SOL
📊 -0.22%
⏱️ Age: 25m | 🎯 spot

📊 Ranges:
OTHER-SOL [━━━━━━━━━━━━━━━●] ⚠️
💡 STAY — OOR 2 bins, below 5-bin threshold

———————————
💰 Balance: 0.32 SOL | ⏰ Next: 5m
```

PnL line shows raw price PnL (USD, SOL) without fees. Fees line shown separately when `unclaimed_fee_usd > 0`, with `Total:` showing the fee-inclusive pnl_pct. When no unclaimed fees, just shows the pnl_pct on its own line.

The LLM report format is one line per position: `[PAIR]: STAY/CLOSE — [short reason]`. This is parsed and embedded inline under each position block.

## Telegram Notifications

All notifications use plain-text format (no HTML bold). Format:

| Event | Header | Notable fields |
|-------|--------|----------------|
| Deploy | `✅ DEPLOY` | pair, strategy, amount SOL, position, tx |
| Close | `🔒 CLOSE` | pair, strategy, PnL ($USD \| SOL \| %) |
| Instruction close | `📋 INSTRUCTION CLOSE` | |
| Out of range | `⚠️ OUT OF RANGE` | |
| Auto-swap | `💱 SWAP` | |
| Swap failed | `⚠️ SWAP FAILED` | |
| Gas low | `⛽ LOW GAS` | |
| Max positions | `📵 MAX POSITIONS` | |
| Threshold evolved | `🧠 THRESHOLD EVOLVED` | field, old→new value, reason |
| Screening report | `🔍 SCREEN` | |
| Management report | `🔄 MANAGE` | per-position: PnL, age, strategy, range bar, reasoning |

- **Close format**: `💰 PnL: +$0.02 | +0.0000 SOL | +0.04%` — all three values (USD, SOL, %). Close notifications include fees in all values (fees are claimed at close).
- **Management report PnL**: price PnL (USD, SOL) on one line, unclaimed fees + total % on a separate line. This avoids confusion where pnl_pct (fee-inclusive) differs in sign from pnl_usd/sol (price-only).
- **Gas low**: sent once when SOL is insufficient; suppressed until a position closes. Uses `_flags.gasLowNotified` in `stats.js`.
- **Max positions**: sent once when slot limit is hit; suppressed until a position closes. Uses `_flags.maxPositionsNotified` in `stats.js`.

## Journal Bot (telegram-journal.js)

Separate Telegram bot dedicated to the trading journal. Configured via `TELEGRAM_JOURNAL_BOT_TOKEN` in `.env`. Chat ID auto-saved as `telegramJournalChatId` in `user-config.json` on first message.

**Notification** — fires on every position close:
```
📍 TOKEN-SOL
💰 +0.04% | +$0.02 | +0.0001 SOL

📊 bid_ask | 10 bins
💵 Invested: 0.50 SOL ($85.00)
💡 yield-exit
⏱️ Held: 74m
📖 POSITION CLOSED
```

**Scheduled reports** (all at 23:59 UTC+7):
- Daily — every day
- Weekly — every Sunday (last 7 days)
- Monthly — last day of the month

**Commands:**
- `/recent [N]` — last N entries (default 5, max 20)
- `/today` — today's summary stats
- `/closes` — last 10 closed positions with PnL
- `/stats` — all-time win rate and total PnL

## Screening Cycle — Report

The `finally` block sends the screening report to Telegram. LLM output is formatted as a strict one-liner, then wrapped with a footer:

```
🔍 SCREEN

💡 WIZARD-SOL: DEPLOY (9/10) — high fees, smart wallets present

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

The screening prompt uses "ACTION REQUIRED" framing (not "STEPS") and explicitly instructs the LLM to call `deploy_position` BEFORE writing any text. A CRITICAL warning is included: writing "DEPLOY" without calling the tool is wrong. This prevents the LLM from hallucinating a deploy report without actually executing the tool call. The report format distinguishes three outcomes: `DEPLOY (X/10)` (tool succeeded, confidence shown), `BLOCKED` (tool returned blocked/error), `NO DEPLOY` (no candidate passed rules or confidence <= 7).

## Confidence-Based Position Sizing

The screener rates each candidate 0-10 before deploying. Deploys are only allowed if confidence > 7. The amount scales linearly: `amount_y = deployAmount × (confidence/10)`, minimum 0.1 SOL.

- confidence 8 → 80% of computed deploy amount
- confidence 9 → 90%
- confidence 10 → 100% (full amount)

`confidence_level` is a parameter on the `deploy_position` tool. The executor blocks deploys with confidence <= 7 and uses the absolute 0.1 SOL floor (instead of the configured `deployAmountSol` floor) for confidence-scaled amounts.

## Management Cycle — Exit Rules

Rule 5 (yield-exit: `fee_tvl_24h < minFeeTvl24h`) is suppressed when `pnl_pct < 0`. This prevents closing a losing position just because yield is low — any loss blocks yield-exit so the position has room to recover.

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
| `/claude <question>` | Ask Claude anything — loads runtime context (positions, journal, lessons, config), answers via `claude --print`. Supports "take lesson" → outputs `LESSON: ...` and "update config" → outputs `CONFIG: key=value` |
| `/review` | Manually trigger Claude lesson updater |

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

**Wide-range deploys** (>69 bins) use a 2-phase process: (1) create position account, (2) add liquidity. The position is tracked in state.json **after phase 1** (create) succeeds, before phase 2 (addLiquidity) begins. This ensures that if addLiquidity fails (e.g., block height exceeded), the position is still tracked and can be managed/closed — preventing zombie positions with no pair name.

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
if pnl_pct <= emergencyPriceDropPct  → CLOSE (stop loss)
if pnl_pct >= fastTpPct              → CLOSE (hard take-profit)
if pnl_pct >= takeProfitFeePct       → CLOSE (regular take-profit)
if lesson min_profit_pct rule hit    → CLOSE (lesson-based TP)
if pnl_pct > trailingActivate        → activate trailing stop, track peak
if trailing active AND
   pnl_pct < trailingFloor           → CLOSE (trailing stop triggered)
```

Thresholds (`fastTpPct=15`, `takeProfitFeePct`, `trailingActivate=6`, `trailingFloor=5`, `emergencyPriceDropPct`) are stored in `config.management` and read each tick — hot-reload and auto-evolution apply immediately. Lesson TP rules (`min_profit_pct`) are also loaded each tick from `extractRules("MANAGER")`. Peak is stored in `_trailingStops` Map (in-memory, resets on restart). Calls `executeTool("close_position")` which handles close → notify → swap → journal → hive sync.

### Management Decision Rules (in priority order)
1. instruction set AND condition met → CLOSE
2. instruction set AND condition NOT met → HOLD (skip remaining)
3. age >= minAgeForYieldExit AND fee_tvl_24h < minFeeTvl24h → CLOSE (yield too low)
4. bins_above_range >= outOfRangeBinsToClose → CLOSE (price pumped above range)
5. unclaimed_fee_usd >= minClaimAmount → claim_fees

NOTE: Stop loss and take profit are handled by the PnL checker (every 30s), not the LLM management cycle.

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
- **Max positions**: Hard cap via `config.risk.maxPositions` (default 10)
- **Gas reserve**: Always keep `gasReserve` SOL (default 0.2) untouched
- **Anti-scam**: Skip if `global_fees_sol < minTokenFeesSol`, top_10_pct > 60%, bundlers > 30%

## Learning System

- **Lesson derivation**: Auto after each close — good (≥5%), neutral (0-5% → no lesson), poor (-5%–0%), bad (<-5%). Each lesson gets `source: "regular"` or `"experiment"` based on the position's variant.
- **Experiment lesson separation**: Regular and experiment lessons are stored in separate files (`lessons.json` and `experiment-lessons.json`). On first load, existing experiment lessons are auto-migrated from `lessons.json` to `experiment-lessons.json`. Experiment lessons are excluded from prompt injection, threshold evolution, and rule extraction. Use `getExperimentLessons(experimentId?)` to query them. `list_lessons` accepts a `source` filter ("regular" or "experiment").
- **Threshold evolution**: Every 5 closes, `evolveThresholds()` in `lessons.js` auto-adjusts 7 dimensions (experiment positions excluded):
  - Screening: `maxVolatility`, `minFeeTvlRatio`, `minOrganic`
  - Strategy: `strategyRules` (spot vs bid_ask per volatility bucket), `binsBelow` (bin width via range_efficiency)
  - TP/SL: `takeProfitFeePct`, `fastTpPct`, `trailingFloor`, `emergencyPriceDropPct`
  - Sizing: `positionSizePct` (based on rolling win rate over last 10 positions)
- All evolved values written to `user-config.json` and applied live; each change triggers a `🧠 THRESHOLD EVOLVED` Telegram notification
- **Lesson injection**: ALL lessons injected — no caps. Pinned → Role-matched → Recent. Priority: good > bad > manual > neutral
- **Pinned lesson cap**: Max 10 pinned lessons. `pinLesson()` returns `{ error }` if cap is reached without saving.
- **Dashboard lesson delete**: Dashboard lessons grid has a per-card delete button (✕, appears on hover). Calls `DELETE /api/lessons/:id`.
- **Dashboard lessons filter**: `GET /api/lessons?source=regular|experiment` filters by lesson source. Without param, returns all.
- **Dashboard position tiers**: Active positions are grouped by volatility tier (High ≥ 5, Medium 2–5, Low < 2, null → Medium). Each tier has a color-coded header (red/yellow/green) with position count. Empty tiers are hidden.
- **Lesson enforcement (3-layer)**:
  1. **Prompt** — HARD RULES (AVOID/NEVER/SKIP/FAILED keywords) shown in numbered checklist with `❌ VIOLATION = ACTION BLOCKED` warning. GUIDANCE (PREFER/WORKED/CONSIDER) shown separately as secondary.
  2. **Pre-agent** — Before agent loop: screening cycle filters candidates violating lesson rules; management cycle force-closes/force-holds positions matching lesson conditions. Logged as `[lesson_enforce]`.
  3. **Executor** — `deploy_position` safety checks run `checkDeployCompliance()` from `lesson-rules.js`. Violations return `{ pass: false }` blocking the on-chain action entirely.
- **Rule extraction** (`lesson-rules.js`): Parses freeform lesson text into structured rules. Matches:
  - `block_strategy` (strategy+volatility condition)
  - `block_high_volatility`, `block_low_fees`, `block_concentration`
  - `oor_grace_period`, `force_close_aged_losing`, `protect_null_volatility`
  - `max_deploy_sol` — "NEVER deploy more than X SOL per position" → blocks deploy if `amount_y > X`
  - `max_loss_pct` — "NEVER hold a position below -X% pnl" → force-closes in management pre-enforcement
  - `min_profit_pct` — "TAKE PROFIT at X%" / "TP at X%" / "close at X% profit" → enforced in pnl_checker (30s) AND management pre-enforcement
  - `reserve_slot` — "spare N slot for TOKEN-SOL" → blocks other deploys when slot is needed (parsed from ALL lessons, no HARD keyword required)
  Unmatched rules remain prompt-only.
- **Constraint persistence (GENERAL role)**: When user gives verbal constraints (sizing cap, stop loss, slot reservation), the GENERAL agent is instructed to call `add_lesson` with exact parseable phrasing AND update config values (e.g. `emergencyPriceDropPct`, `maxDeployAmount`). Verbal-only instructions are NOT persisted across sessions.
- **Max change per step**: 20% to prevent whiplash
- **Persistent instructions**: Tell agent "hold until X%" or "save lesson: ..." → agent calls `set_position_note` / `add_lesson` → stored in state.json / lessons.json → applied every cycle. Verbal-only instructions (no tool call) are forgotten after the turn.
- **Claude lesson updater** (`scripts/claude-lesson-updater.js`): Runs every 5 closes, AFTER `evolveThresholds()`, fire-and-forget. Uses `claude --print` to analyze 20 recent closes + existing lessons, adds new lesson rules via `addLesson()`, applies minor config tweaks (allowed keys: `binsBelow`, `strategyRules`, `minFeeTvl24h`, `minAgeForYieldExit`, `outOfRangeBinsToClose`), notifies journal bot with `🧠 CLAUDE REVIEW` if any changes were made.
- **Claude Ask** (`scripts/claude-ask.js`): General-purpose Q&A agent triggered by Telegram `/claude <question>`. Loads runtime context (open positions from `state.json`, last 15 journal entries, last 20 lessons, last 10 performance records, strategy config subset) and spawns `claude --print` with a 3-minute timeout. Special output prefixes: `LESSON: <text>` → caller can extract and save lesson; `CONFIG: key=value` → caller can apply config change. Standalone test: `node scripts/claude-ask.js "your question"`.

## Experiment Tier

A self-contained strategy optimization loop (`experiment.js`). Iterates on a single pool: deploy → wait for close → analyze result → redeploy with optimized params → repeat until convergence.

### How It Works

- **Start**: Agent calls `start_experiment({ pool_address, pool_name, ... })` → deploys iteration 1 immediately
- **Iterate**: When a position with `variant` starting with `"exp_"` closes, `onExperimentPositionClosed()` fires (from executor.js post-close hook), records the result, runs the hill-climbing optimizer, and deploys the next iteration
- **Convergence**: Stops when N consecutive iterations don't improve the score (default 3), max iterations reached (default 20), or all parameter combinations exhausted
- **Rules**: Each experiment has its own TP/SL/trailing thresholds (`rules` object in `experiments.json`) — the PnL checker uses these instead of global config for experiment positions
- **Management**: Experiment positions appear normally in management cycles — the LLM manages them like any other position

### Optimization Algorithm

Deterministic hill-climbing (no LLM per iteration):
1. Score each closed iteration: `0.6 × pnl_pct_normalized + 0.4 × range_efficiency_normalized`
2. Start from best iteration's params, mutate one parameter at a time (round-robin: strategy → bins_below → bins_above)
3. Track all tried combinations — never repeat
4. If all single-param neighbors tried, cross best values from top-2 iterations
5. If all combinations exhausted → converge

### Default Experiment Rules (faster closes = faster iteration)
```
takeProfitFeePct:      3%     (vs global ~5%)
fastTpPct:             8%     (vs global ~15%)
emergencyPriceDropPct: -30%   (vs global -50%)
maxMinutesHeld:        120m   (force-close after 2h to keep loop moving)
trailingActivate:      4%
trailingFloor:         3%
```

### Default Parameter Space
```
strategy:   ["bid_ask", "spot"]
bins_below: [30, 50, 69, 100]
bins_above: [0, 10, 20, 30]
```

### State File: `experiments.json`
```json
{
  "experiments": {
    "exp_<timestamp>": {
      "id", "pool", "pool_name", "status",         // "running"|"converged"|"paused"|"cancelled"|"failed"
      "deploy_amount_sol", "max_iterations", "convergence_window",
      "best_pnl_pct", "best_iteration", "iterations_without_improvement",
      "active_position",
      "rules": { TP/SL thresholds },
      "parameter_space": { strategy, bins_below, bins_above },
      "iterations": [{ iteration, position, params, deployed_at, closed_at, result, analysis, status }]
    }
  }
}
```

### Agent Tools
| Tool | Action |
|------|--------|
| `start_experiment` | Start optimization loop on a pool |
| `get_experiment` | Full details + iteration history |
| `list_experiments` | List all experiments (filter by status) |
| `pause_experiment` | Pause — stops auto-redeploy after next close |
| `resume_experiment` | Resume paused — deploys next iteration now |
| `cancel_experiment` | Cancel — active position stays open (manage normally) |

### Notifications
Both the main Telegram bot and the journal bot receive:
- `🧪 EXPERIMENT #N → #N+1` — after each iteration closes (prev result + next params)
- `🧪 EXPERIMENT CONVERGED` — full progression report with best parameters found

### Safety Bypasses (executor.js)
Experiment deploys (variant starts with `"exp_"`) bypass:
- `maxPositions` check (experiment has its own 1-active-position limit)
- `alreadyInPool` duplicate guard (intentionally redeploying same pool)
- `base_mint` duplicate guard (same token, iterating)
- Confidence gate (experiments always use `confidence_level: 10`)

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

## CLI Harness (agent-harness/)

A Python Click-based CLI (`cli-anything-meridian`) for inspecting and configuring the agent without touching the running Node.js process.

### Installation
```bash
cd agent-harness
pip install -e .
export MERIDIAN_DIR=/path/to/meridianfork
```

### Command Groups

| Group | Commands | Description |
|-------|----------|-------------|
| `status` | `overview`, `positions`, `config` | Runtime state from state.json / user-config.json |
| `journal` | `recent`, `closes`, `today`, `stats` | Query journal.json |
| `report` | `daily`, `weekly`, `monthly` | Period performance reports |
| `config` | `get [KEY]`, `set KEY VALUE` | Read/write user-config.json (hot-reloaded in ~2s) |
| `lessons` | `list`, `performance`, `summary` | lessons.json data |
| `repl` | — | Interactive REPL mode |

All commands support `--json` for machine-readable output. All runtime files are resolved via `MERIDIAN_DIR` env var.

`config set` is the only write operation — it patches user-config.json and the agent hot-reloads within ~2 seconds. Keys requiring restart: `rpcUrl`, `walletKey`, `dryRun`, schedule intervals.

### Structure
```
agent-harness/
├── MERIDIAN.md                          # SOP document
├── setup.py                             # namespace package (cli_anything.*)
└── cli_anything/meridian/
    ├── meridian_cli.py                  # CLI entry point
    ├── core/  (journal, state, config, lessons, paths)
    ├── utils/ (formatting)
    ├── skills/SKILL.md                  # AI-discoverable skill definition
    └── tests/ (test_core.py, test_full_e2e.py — 66 tests, 100% pass)
```

## Git Workflow

- Push to `fork` remote: `git push fork main`
- Commit frequently with clear messages explaining *why*, not just *what*
- `user-config.json`, state files, and logs are gitignored — safe to `git pull` on VPS without overwriting live data
- **Always update `CLAUDE.md` before pushing** — keep it in sync with any behavioural changes, new data flows, report formats, or architectural decisions made in the same commit
