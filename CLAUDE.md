# Meridian — Autonomous Solana DLMM LP Agent

Node.js autonomous agent managing liquidity positions on Meteora DLMM pools (Solana). Screens pools, deploys positions, monitors them, closes based on LLM decisions.

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
| `tools/dlmm.js` | Meteora DLMM SDK — deploy/close/PnL/positions (LPAgent primary for economics) |
| `tools/wallet.js` | Wallet balance, SOL price, Jupiter swaps |
| `tools/screening.js` | Pool discovery and candidate scoring |
| `tools/okx.js` | OKX DEX API — risk flags, advanced token intel, clusters, price/ATH |
| `tools/study.js` | LPAgent API — top LPer patterns per pool |
| `tools/executor.js` | Tool dispatch, post-tool hooks (notify, journal, sync) |
| `tools/definitions.js` | LLM tool schemas for all agent roles |
| `experiment.js` | Experiment tier — strategy optimization loop |
| `lessons.js` | Performance recording and learning system |
| `lesson-rules.js` | Lesson rule extractor + compliance checkers |
| `wiki.js` | Knowledge wiki — auto-compiled markdown KB from journal/lessons/snapshots |
| `journal.js` | Append-only trade journal |
| `reports.js` | Daily/weekly/monthly plain-text reports |
| `prompt.js` | System prompt builder |
| `telegram.js` | Main Telegram bot (long-polling) |
| `telegram-journal.js` | Journal bot — close notifications, error alerts, `/recent`, `/today`, `/closes`, `/stats` |
| `hive-mind.js` | Opt-in collective intelligence network |
| `stats.js` | Shared in-memory counters + flags |
| `strategy-library.js` | LP strategy template storage |
| `pool-memory.js` | Per-pool deploy history and notes |
| `management-rules.js` | Deterministic management rule engine — replaces LLM for position decisions |
| `scripts/patch-anchor.js` | Postinstall: patches `@coral-xyz/anchor` + `@meteora-ag/dlmm` for Node ESM |
| `scripts/claude-ask.js` | Telegram `/claude` Q&A agent via `claude --print` |
| `scripts/claude-lesson-updater.js` | Auto lesson updater — runs every 5 closes, enriched with autoresearch backtest |
| `scripts/claude-lesson-summarizer.js` | Daily lesson cleanup at 23:59 UTC+7 |
| `scripts/autoresearch-bridge.js` | Bridge to autoresearch-dlmm — pool selection, backtest runner, output parser |
| `scripts/autoresearch-loop.js` | Daily research review — biggest win vs loss analysis at 23:30 UTC+7 |
| `scripts/goals.js` | Goals system — progress tracking, prompt/notification formatting |

## Runtime Files (gitignored, never overwrite on VPS)

`user-config.json`, `state.json`, `journal.json`, `lessons.json`, `experiment-lessons.json`, `strategy-library.json`, `pool-memory.json`, `experiments.json`, `.env`, `.agent.pid`, `wiki/`

All runtime JSON files use **atomic writes** (write to `.tmp` then `fs.renameSync`) to prevent corruption on crash.

## Architecture

### Cron Cycles

Management runs on 3 volatility tiers via 1-minute dispatcher. Only one tier runs at a time (`_managementBusy` mutex). The `finally` block uses nested `try/finally` to guarantee `_managementBusy = false` even if notification code throws.

| Tier | Volatility | Interval |
|------|-----------|----------|
| high | ≥ 5 | 3 min |
| med | 2–5 or null | 5 min |
| low | < 2 | 10 min |

- Screening triggers only from the **lowest-frequency active tier**
- **Screening** (default 30m): scans pools, deploys new positions

### Agent Types
- `MANAGER` — manages existing positions
- `SCREENER` — finds and deploys new positions (most important — determines entry quality)
- `GENERAL` — TTY/Telegram ad-hoc queries

### LLM Models (in `user-config.json`)
- `managementModel`, `screeningModel` (use best model here), `generalModel`
- Fallback: `process.env.LLM_MODEL` → hardcoded default
- On 3 consecutive failures: auto-fallback to `z-ai/glm-5` for that turn only
- Telegram/TTY deploy requests auto-route to `screeningModel` (not generalModel)
- Step 0 forces `tool_choice: "required"` for action intents (deploy/close/swap) to prevent hallucinated results

### Hot-reload
`user-config.json` watched via `fs.watchFile` (2s). Most settings apply live. `rpcUrl`, `walletKey`, `dryRun`, schedule intervals require restart.

### Helius API Key Rotation
Two keys (`HELIUS_API_KEY`, `HELIUS_API_KEY_2`). On 429, rotates and retries. Both exhausted → RPC fallback for SOL-only balance. Post-close swap has full RPC fallback via `getAllTokenBalancesViaRpc()`.

## SOL PnL — Important

**Never compute `pnl_sol` via USD conversion.** Meteora DLMM API returns native SOL fields: `pnlSol`, `balancesSol`, `amountSol`. Use these directly.

**LPAgent as primary PnL source**: When `LPAGENT_API_KEY` is set, `getPositionPnl()` and `getMyPositions()` fetch live economics (value, PnL, fees) from LPAgent API (`/lp-positions/opening`), using Meteora only for structure (bins, range, OOR, age). 30s cache shared across PnL checker and management cycle. Falls back to Meteora automatically if LPAgent is unavailable or key is unset.

**On-chain PnL fallback**: When both LPAgent and Meteora datapi fail (or Meteora returns `balances: 0`), `getOnChainPositionValue()` fetches real position value from DLMM SDK + Jupiter Price API.

## PnL Display — Fee Inclusion

Journal stores `pnl_usd` (price-only) and `fees_earned_usd` separately. **Fee inclusion is done at the display/aggregation layer only:**
- Close notifications (both bots): fee-inclusive USD, SOL, and % in all three values
- Management reports: price PnL (USD, SOL) on one line, unclaimed fees + total % separately
- Dashboard & reports: fee-inclusive totals for net PnL, win/loss, best/worst trade
- `pnl_pct` from `getPositionPnl()` is already fee-inclusive: LPAgent provides it directly when available, otherwise `(pnlUsd + unclaimedFees) / initial * 100`

## PnL Checker (every 30s, no LLM)

Runs via `setInterval`, skips when `_managementBusy` or position has `instruction` set.

```
empty position (value=0, fees=0)     → CLOSE
pnl_pct <= emergencyPriceDropPct     → CLOSE (stop loss)
pnl_pct >= fastTpPct                 → CLOSE (hard TP)
pnl_pct >= takeProfitFeePct          → CLOSE (regular TP)
lesson min_profit_pct rule           → CLOSE (lesson TP)
pnl_pct > trailingActivate           → activate trailing, track peak
trailing active AND < trailingFloor  → CLOSE (trailing stop)
```

Empty-position closes report `pnl_pct = 0` (not -100%). Thresholds hot-reload from config. Peak stored in-memory (`_trailingStops` Map, resets on restart). **Per-strategy TP**: if strategy library has `exit.take_profit_pct`, it overrides global `takeProfitFeePct` for non-experiment positions.

### Management Decision Rules (deterministic — no LLM)

Handled by `management-rules.js` rule engine (`evaluateAll()`). LLM only called as fallback for positions with unparseable natural-language instructions.

1. lesson force-hold → STAY (overrides everything)
2. instruction "close at X%" parseable AND condition met → CLOSE
3. instruction set AND condition NOT met → HOLD
4. unparseable instruction → **LLM fallback** (only these positions, max 3 steps)
5. yield-exit: `fee_tvl_24h < minFeeTvl24h` (suppressed when `pnl_pct < 0`, 1% grace zone)
6. OOR: `bins_above_range >= outOfRangeBinsToClose` → CLOSE (high-volatility young positions tolerate +2 extra bins)
7. `unclaimed_fee_usd >= minClaimAmount` → claim_fees

NOTE: Stop loss / take profit handled by PnL checker, not management cycle.
NOTE: Health check is also deterministic (no LLM) — logs portfolio summary hourly.

## Confidence-Based Position Sizing

Deploys only if confidence > 7. Amount scales: `deployAmount × (confidence/10)`, minimum 0.1 SOL.

## Transaction Retry

All on-chain calls go through `sendWithRetry()` — 5 attempts with exponential backoff (1s, 2s, 4s, 8s).

## Risk Management

- **Sizing**: `(wallet - gasReserve) × positionSizePct`, clamped between `deployAmountSol` and `maxDeployAmount`
- **Max positions**: `config.risk.maxPositions` (default 10)
- **Gas reserve**: `gasReserve` SOL (default 0.2) always kept
- **Anti-scam**: Skip if `global_fees_sol < minTokenFeesSol`, top_10_pct > 60%, bundlers > 30%
- **OKX hard filters**: honeypot → auto-reject, dev_rug_count > 0 → auto-reject (pre-LLM)
- **Known-mints allowlist**: Only swap tokens from positions the bot deployed into. `getKnownMints()` builds Set from ALL positions (open + closed). Unknown tokens never touched — prevents wallet drain from airdropped tokens. `/withdraw` bypasses filter.

## Screening Enrichment

All recon data is pre-loaded per candidate in parallel (`Promise.allSettled`) before the screener agent runs — no LLM tool calls needed for these:

| Source | Data | Signal |
|--------|------|--------|
| Smart wallets API | wallets in pool | Gradient confidence score 0.0–1.0 |
| Token holders API | top_10_pct, bundlers_pct, global_fees_sol | Scam filter |
| Token narrative | text narrative | Fundamental signal |
| Token info | 1h momentum, bot_holders_pct | Direction + filter |
| Pool memory | past deploy history | Avoid bad pools |
| Top LPers (LPAgent) | win_rate, hold time, ROI, scalper/holder ratio | Strategy guidance |
| OKX advanced | smart_money_buy, dev_rug_count, dev_sold_all, dev_buying_more, honeypot, bundle/sniper %, lp_burned | Token safety + conviction |
| OKX price | price_vs_ath_pct, 5m/1h price change | ATH proximity + momentum |
| OKX clusters | top holder trends (buy/sell), KOL presence, PnL | Distribution detection |

OKX honeypot and dev-rugger tokens are hard-filtered before reaching the LLM. All other OKX signals are soft — LLM adjusts confidence based on decision rules in the screening prompt.

**Strategy metadata**: Active strategy's full metadata (`token_criteria`, `entry`, `range`, `exit` rules) is injected into the screening prompt so the LLM can enforce strategy-specific criteria.

## Learning System

- **Unit-mix guard**: `recordPerformance()` skips records where `final_value_usd` looks like a SOL amount (e.g. 2.0 when initial was $20+). Prevents bad lessons from unit-mixed data.
- **Derivation**: Auto after close — good (≥5%), neutral (0-5% → no lesson), poor (-5%–0% → CAUTION guidance), bad (<-5%)
- **Experiment separation**: Regular in `lessons.json`, experiment in `experiment-lessons.json`. Experiment lessons excluded from prompt injection, threshold evolution, rule extraction, summarization.
- **Threshold evolution**: Every 5 closes, auto-adjusts screening/strategy/TP-SL/sizing params. Max 20% change per step.
- **Lesson dedup**: Same structural type → updates in place (no duplicates). Multi-variant types discriminated by strategy name, token, field.
- **Injection**: Capped at 35 lessons (10 pinned + 15 role-matched + 10 recent fill). Priority: pinned → role-matched → recent. Good > bad > manual > neutral.
- **Enforcement (3-layer)**:
  1. **Prompt** — HARD RULES (AVOID/NEVER/SKIP) as numbered checklist. GUIDANCE (PREFER/WORKED) shown separately.
  2. **Pre-agent** — screening filters violating candidates; management force-closes/holds matching positions.
  3. **Executor** — `checkDeployCompliance()` blocks deploy on-chain.
- **Rule types** (`lesson-rules.js`): `block_strategy`, `block_high_volatility`, `block_low_fees`, `block_concentration`, `oor_grace_period`, `force_close_aged_losing`, `protect_null_volatility`, `max_deploy_sol`, `max_loss_pct`, `min_profit_pct`, `reserve_slot`. Unmatched → prompt-only.
- **Daily summarization**: Two phases — batch cleanup (aggressive: delete duplicates/noise, merge into <120 char rules, max 70% reduction) → policy consolidation (consolidate AVOID/PREFER groups into short parseable rules). Never deletes pinned or experiment lessons.
- **Comparative lessons**: Every 5 closes, aggregates performance by strategy + volatility bucket. Generates PREFER lessons when one strategy outperforms another by >2% avg PnL (min 3 samples per group). Deduped by strategy pair.
- **Claude lesson updater**: Every 5 closes. Analyzes recent closes, adds lessons, applies config tweaks (limited keys).
- **Constraint persistence**: Verbal constraints must be saved via `add_lesson` or `set_position_note` tool calls. Verbal-only instructions are NOT persisted.

## Knowledge Wiki

Auto-compiled markdown knowledge base (`wiki.js`). Deterministic compilation — no LLM needed per update. Inspired by Karpathy's "raw data compiled into .md wiki" pattern.

- **Token pages** (`wiki/tokens/`): Per-token trade history, win rate, strategy breakdown, close reasons, lessons. Auto-updated after every close.
- **Strategy playbook** (`wiki/strategies/`): Per-strategy performance by volatility bucket, bin step, comparative lessons. Includes strategy definitions from library.
- **Market conditions** (`wiki/market/`): Regime detection (trending/ranging/volatile) from portfolio snapshots, trade performance signals, win rate trends. Updated every 10 snapshots.
- **Index** (`wiki/index.md`): Master index linking all pages with key metrics.

**Integration points**:
- `recordPerformance()` → `updateAfterClose()` (fire-and-forget after every close)
- `logSnapshot()` → `updateMarketFromSnapshot()` (every 10 snapshots)
- `buildSystemPrompt()` → `getWikiSummary()` (strategy playbook + market conditions injected into all agent prompts)
- Startup → `compileFullWiki()` (full rebuild from all data)
- Tools: `query_wiki` (agent can read any wiki page), `rebuild_wiki` (force full recompile)

**Runtime**: `wiki/` directory is gitignored. Rebuilt on startup from journal + lessons + snapshots.

## Experiment Tier

Strategy optimization loop (`experiment.js`): deploy → close → analyze → redeploy with optimized params → repeat until convergence.

- Deterministic hill-climbing optimizer (no LLM per iteration) with asymmetric score: losses penalized 2x harder than equivalent gains
- Own TP/SL/trailing thresholds per experiment (faster closes for faster iteration)
- Bypasses: maxPositions, duplicate guards, confidence gate, lesson compliance, bin_step range, management pre-enforcement, prompt-level hard rules
- Convergence: N iterations without improvement (default 3), max iterations (default 20), or all combinations exhausted

## Autoresearch Integration

External Python tool (`/home/ubuntu/autoresearch-dlmm`) backtests DLMM strategies against historical candle data and compares to top LP benchmarks.

**Two integration points:**

1. **Every-5-closes review** (`claude-lesson-updater.js`): Runs `prepare.py` + `backtest.py` for the most-traded pool from recent closes. Backtest metrics + benchmark comparison injected into the Claude review prompt. 3-min timeout; graceful skip on failure.

2. **Daily 23:30 UTC+7** (`autoresearch-loop.js`): Finds today's biggest win and biggest loss. Fetches historical candle data + top LP benchmarks for both pools (via `prepare.py` + `backtest.py`). Claude compares: what made the win work, what went wrong with the loss, and derives 1-4 generalizable lessons. ~3 min runtime; runs before lesson summarizer (23:59).

**Env bridging**: `LPAGENT_API_KEY` from Meridian's `.env` is mapped to `LPAGENT_API_KEYS` at spawn time. No duplicate config needed.

**Graceful degradation**: If autoresearch dir missing, uv not installed, or any subprocess fails → review/loop skips silently, logs reason.

## Goals System

Trading goals in `user-config.json` direct lesson generation toward specific targets. Hot-reloadable via config or `/goals` Telegram command.

```json
"goals": { "win_rate_pct": 80, "max_loss_pct": -10, "profit_factor": 2, "lookback": 50 }
```

**How it works**: `scripts/goals.js` calculates current performance vs targets (✅/❌ per goal). Injected into both review prompts (every-5-closes + daily autoresearch) with instruction: "prioritize lessons that close the gap on UNMET goals, don't hurt goals already being met."

**Key mapping** (Telegram shorthand → config key): `win_rate` → `win_rate_pct`, `max_loss` → `max_loss_pct`, `profit_factor` → `profit_factor`, `lookback` → `lookback`.

## Hive Mind

Opt-in collective intelligence (`hive-mind.js`). Pool consensus injected into screening if 3+ agents. After close: sync lessons, deploys, thresholds. All fire-and-forget. Circuit breaker: 3 consecutive failures → 30 min backoff (skips sync and queries).

## Telegram Commands

| Command | Action |
|---------|--------|
| `/start` / `/stop` | Start/stop cron cycles |
| `/status` | Wallet balance + open positions overview |
| `/briefing` | Last 24h report |
| `/report [daily\|weekly\|monthly]` | Trading report |
| `/claude <question>` | Ask Claude (loads runtime context) |
| `/review` | Trigger Claude lesson updater |
| `/update_lesson` / `/update_lesson <N> <rule>` | List or update lessons |
| `/del_lesson <N>` | Delete lesson (pinned blocked) |
| `/goals` | View progress, set (`/goals win_rate=80 max_loss=-10`), or clear (`/goals clear`) |
| `/withdraw` | Close all, swap to SOL, report balance |

## VPS Deployment

```bash
# Setup
git clone https://github.com/Toderr/meridianfork.git && cd meridianfork
npm install  # create user-config.json and .env manually
pm2 start index.js --name meridian && pm2 save && pm2 startup

# Update
git pull origin main && npm install --omit=dev && pm2 restart meridian

# If @meteora-ag/dlmm is broken (missing index.mjs) — reinstall, don't rm manually
npm install @meteora-ag/dlmm && pm2 restart meridian
```

## Wide-Range Deploys

>69 bins use 2-phase: (1) create position, (2) add liquidity. Position tracked after phase 1 to prevent zombie positions if phase 2 fails.

## CLI Harness (agent-harness/)

Python CLI (`cli-anything-meridian`) for inspecting/configuring the agent. Groups: `status`, `journal`, `report`, `config`, `lessons`, `repl`. All support `--json`. `config set` hot-reloads in ~2s.

## Git Workflow

- Commit frequently, explain *why*
- Runtime files are gitignored — safe to `git pull` on VPS
- **Always update `CLAUDE.md` before pushing**

## Observability

- **Error notifications**: `notifyError(source, message)` in `telegram-journal.js` sends `🚨 ERROR` to journal bot. Throttled per source (15 min). Covers: management, screening, PnL checker, reports, dust sweep, lesson summarizer.
- **Portfolio snapshots**: `logSnapshot()` called every management cycle → `logs/snapshots-{date}.jsonl`. Tracks positions count, total value, PnL, unclaimed fees per tier.
- **Dashboard API**: `/api/actions?date=YYYY-MM-DD&limit=100&tool=deploy_position` — queries `actions-*.jsonl` for tool execution timeline.
- **Reports tail risk**: Weekly/monthly reports include max drawdown ($) and max consecutive losses.

## Roadmap

### High Impact
- ~~Multi-strategy templates with own criteria/exit rules~~ ✅ Strategy metadata now enforced in screening prompt + per-strategy TP in PnL checker
- Dynamic position sizing by volatility
- ~~Pool memory success rates for screener signal~~ ✅ Already pre-loaded via `recallForPool()`
- Auto-rebalance: close stale → redeploy to better yield

### Medium Impact
- Re-evaluate management interval during holding
- ~~Cross-role learning (manager mistakes → screener avoidance)~~ ✅ Comparative lessons + poor-outcome CAUTION lessons now bridge roles
