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
| `tools/dlmm.js` | Meteora DLMM SDK — deploy/close/PnL/positions |
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
| `journal.js` | Append-only trade journal — open + close entries carry full token profile, strategy library entry, runtime config thresholds, and a duration object (opened_at, closed_at, seconds_held, time_to_first_fee_min, peak_pnl_pct, minutes_to_peak) |
| `reports.js` | Daily/weekly/monthly plain-text reports |
| `prompt.js` | System prompt builder |
| `telegram.js` | Main Telegram bot (long-polling) |
| `telegram-journal.js` | Journal bot — close notifications, error alerts, `/recent`, `/today`, `/closes`, `/stats` |
| `hive-mind.js` | Opt-in collective intelligence network |
| `stats.js` | Shared in-memory counters + flags |
| `strategy-library.js` | LP strategy template storage |
| `pool-memory.js` | Per-pool deploy history and notes |
| `screening-cache.js` | In-memory cache of token characteristics from screening → used at close for lesson derivation |
| `management-rules.js` | Deterministic management rule engine — replaces LLM for position decisions |
| `decision-log.js` | Structured why-log of every deploy/close/skip/no-deploy — answers "why did you…?" without re-deriving from logs |
| `scripts/patch-anchor.js` | Postinstall: patches `@coral-xyz/anchor` + `@meteora-ag/dlmm` for Node ESM |
| `scripts/claude-ask.js` | Telegram `/claude` Q&A agent via `claude --print` |
| `scripts/claude-lesson-updater.js` | Auto lesson updater — runs every 5 closes, enriched with autoresearch backtest |
| `scripts/claude-lesson-summarizer.js` | Daily lesson cleanup at 23:59 UTC+7 |
| `scripts/autoresearch-bridge.js` | Bridge to autoresearch-dlmm — pool selection, backtest runner, output parser |
| `scripts/autoresearch-loop.js` | Daily research review — biggest win vs loss analysis at 23:30 UTC+7 |
| `scripts/goals.js` | Goals system — progress tracking, prompt/notification formatting |

## Runtime Files (gitignored, never overwrite on VPS)

`user-config.json`, `state.json`, `journal.json`, `lessons.json`, `experiment-lessons.json`, `strategy-library.json`, `pool-memory.json`, `experiments.json`, `decision-log.json`, `.env`, `.agent.pid`, `wiki/`

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

### Multi-Provider LLM Routing
Models default to OpenRouter. Use `provider:model` prefix syntax for direct API access:
- `minimax:MiniMax-M2.7` → MiniMax API directly (`https://api.minimax.io/v1`, key: `MINIMAX_API_KEY`)
- `minimax/minimax-m2.7` → OpenRouter (no prefix = OpenRouter)
- Fallback model always routes to OpenRouter regardless of primary provider
- New providers can be added to the `providers` map in `agent.js`

### Hot-reload
`user-config.json` watched via `fs.watchFile` (2s). Most settings apply live. `rpcUrl`, `walletKey`, `dryRun`, schedule intervals require restart.

### Helius API Key Rotation
Three keys (`HELIUS_API_KEY`, `HELIUS_API_KEY_2`, `HELIUS_API_KEY_3`). On 429, rotates and retries. All exhausted → RPC fallback for SOL-only balance. Post-close swap has full RPC fallback via `getAllTokenBalancesViaRpc()`.

## SOL PnL — Important

**Never compute `pnl_sol` via USD conversion.** Meteora DLMM API returns native SOL fields: `pnlSol`, `balancesSol`, `amountSol`. Use these directly. Exception: `feesSol` in notifications uses `fees_earned_usd / sol_price` (fees only, not pnl_sol itself).

**On-chain PnL fallback**: When Meteora datapi fails (or returns `balances: 0`), `getOnChainPositionValue()` fetches real position value from DLMM SDK + Jupiter Price API.

## PnL Display

Every user-facing surface reads `pnl_usd` / `pnl_sol` / `pnl_pct` straight from the Meteora datapi (via `getPositionPnl` / `getMyPositions`) or from the journal close entry. Fees are displayed separately via `fees_earned_usd` / `unclaimed_fees_usd`.

- Storage layer: journal close entries persist `initial_value_usd`, `final_value_usd`, `fees_earned_usd`, `pnl_usd`, `pnl_sol`, `pnl_pct`. Live positions expose `initial_value_usd_api` (datapi-derived), `total_value_usd`, `unclaimed_fees_usd`, `collected_fees_usd`.
- `pnl_usd` from `getPositionPnl` / `getMyPositions` is **price-only** (datapi's fee-inclusive `pnlUsd` minus `unclaimedUsd`). `pnl_pct` is price-only %. Fees are tracked separately.
- PnL checker (`index.js`) composes `pnl_pct + feePct` inline for TP/SL threshold comparisons — fee-inclusive at the rule boundary.
- `feesSol` uses `fees_earned_usd / sol_price` (SOL price threaded from `closePosition` through the notification chain).

## PnL Checker (every 15s, no LLM)

Runs via `setInterval`, skips when `_managementBusy` or position has `instruction` set. Poll cadence was tightened from 30s→15s on 2026-04-21 to close the gap-through window on volatile meme dumps (stops that triggered at -10% were realizing -13% to -21% due to price moving between polls).

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
5. hold-time cut: **DISABLED** (30-Mar baseline restore). Original rules (age ≥15m & pnl<-0.3% → CLOSE; age ≥30m & pnl<0% → CLOSE) commented out in `management-rules.js`.
6. **HARDCODED 120m hold cap (Rule 3b)**: `age ≥ 120m` → CLOSE **unless** fees/hr over the last 30m ≥ $4 (raised from $2 on 2026-04-23 after full-data audit confirmed the 120m+ bucket only loses on average; productive fee compounders still allowed to extend). Computed from `getRecentFeeRate()` in `pool-memory.js` using `collected_fees_usd` deltas in snapshots. Constants live at the top of `management-rules.js` — `HARD_HOLD_CAP_MIN`, `HARD_HOLD_FEE_WINDOW_MIN`, `HARD_HOLD_MIN_FEE_RATE_USD_HR`.
7. yield-exit: `fee_tvl_24h < minFeeTvl24h` (suppressed when `pnl_pct < 0`, 1% grace zone)
8. OOR: `bins_above_range >= outOfRangeBinsToClose` → CLOSE (high-volatility young positions tolerate +2 extra bins)
9. `unclaimed_fee_usd >= minClaimAmount` → claim_fees

NOTE: Stop loss / take profit handled by PnL checker, not management cycle.
NOTE: Health check is also deterministic (no LLM) — logs portfolio summary hourly.

## Confidence-Based Position Sizing

Deploys only if confidence > 7. Amount scales: `deployAmount × (confidence/10)`, minimum 0.1 SOL.

**HARDCODED variant bonus** (`tools/executor.js`, early in `executeTool`): `confidence_level` is bumped by +1 (capped at 10) before the confidence gate and before sizing for these variants:
- `LPerProven`, `LPer-Proven` (case-sensitive — lowercase/underscore siblings excluded after 2026-04-23 audit dropped them for dragging the family below baseline)
- `pullback-entry` (case-insensitive, hyphens/underscores stripped)
- `upper-biased` (case-insensitive — provisional, added 2026-04-23 after full-data audit showed 100% wr / +3.15% avg on n=5; re-evaluate at n≥15)

## Transaction Retry

All on-chain calls go through `sendWithRetry()` — 5 attempts with exponential backoff (1s, 2s, 4s, 8s).

## Risk Management

- **Sizing**: `(wallet - gasReserve) × positionSizePct`, clamped between `deployAmountSol` and `maxDeployAmount`
- **Max positions**: `config.risk.maxPositions` (default 10)
- **Gas reserve**: `gasReserve` SOL (default 0.2) always kept
- **Single-sided SOL (HARDCODED)**: `bins_above` is always 0 in `tools/dlmm.js` — the config flag `forceSolSingleSided` is now moot. Any `bins_above` value requested by the LLM or by an experiment is silently overridden and logged. Prevents whipsaw IL from upside bin exposure on volatile meme tokens.
- **Post-loss cooldown**: `isInPostLossCooldown(pool, mint, cooldownMin, thresholdPct)` in `pool-memory.js` blocks re-entry on pools or base_mints that closed ≤ `postLossCooldownPct` (default -5%) within `postLossCooldownMin` minutes (default 120). Enforced in `tools/screening.js` `getTopCandidates` before the LLM sees the candidate list. Both config keys are hot-reloadable.
- **Unique token across pools**: `risk.uniqueTokenAcrossPools` (default `true`, hot-reloadable) blocks deploying into a `base_mint` that's already held in any open position, regardless of pool. Guards against correlated IL / drawdown across different fee tiers on the same token. Enforced at two layers: screening pre-filter drops duplicate-mint candidates before the LLM sees them and logs a `RULE_ENGINE` skip to the decision log; executor safety net re-checks at `deploy_position` and rejects the tool call. Experiment tier bypasses (experiments redeploy the same pool by design).
- **Volatility cap (HARDCODED)**: `tools/screening.js` `getTopCandidates` rejects any candidate with `volatility > 5` pre-LLM (constant `MAX_VOLATILITY_HARDCODED = 5`). Basis: 2026-04-21 fee-inclusive audit SLICE 5 — vol 2–5 bucket was 100% net wr / +1.51%, vol 5–10 was +0.08% net (marginal), vol ≥10 was −7.12% net. Not configurable.
- **Hold-time cut**: Currently **DISABLED** (30-Mar baseline restore). Originally a deterministic early-exit in management-rules.js: ≥15m at <-0.3% → close, ≥30m at <0% → close. Re-enable by un-commenting Rule 3.
- **Evolution guardrails**: `emergencyPriceDropPct` clamped [-15, -3], `takeProfitFeePct` [2, 5], `fastTpPct` [5, 15], `positionSizePct` [0.15, 0.3]. Prevents threshold evolution from drifting to dangerous values.
- **Anti-scam**: Only hardcoded gate: `global_fees_sol < 30` (cannot be lowered). All other screening thresholds (top_10_pct, bundlers, organic, mcap, bin_step, etc.) are configurable and learnable — the agent can adjust them via `update_config` or lessons.
- **OKX hard filters**: honeypot → auto-reject, dev_rug_count > 0 → auto-reject (pre-LLM)
- **Known-mints allowlist**: Only swap tokens from positions the bot deployed into. `getKnownMints()` builds Set from ALL positions (open + closed). Unknown tokens never touched — prevents wallet drain from airdropped tokens. `/withdraw` bypasses filter.

## Screening Enrichment

All recon data is pre-loaded per candidate in parallel (`Promise.allSettled`) before the screener agent runs — no LLM tool calls needed for these. All enrichment data is also cached via `screening-cache.js` (`cacheTokenProfile`) so it persists through deploy → close → lesson derivation:

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

- **Freeze mode**: `freezeLessons: true` in config blocks ALL auto-generated lessons: derivation, evolution, comparative, token-characteristic, Claude updater, Claude summarizer, autoresearch. Manual lessons via Dashboard/CLI still allowed (`bypassFreeze`). Toggle via `/freeze` and `/unfreeze` Telegram commands. Hot-reloadable.
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
- **Rule types** (`lesson-rules.js`): `block_strategy`, `block_high_volatility`, `block_low_fees`, `block_concentration`, `oor_grace_period`, `protect_null_volatility`, `max_deploy_sol`, `max_loss_pct`, `min_profit_pct`, `reserve_slot`. Unmatched → prompt-only.
- **`max_loss_pct` extraction**: Only matches explicit stop-loss intent patterns (`NEVER hold position below X%`, `stop loss at X%`, `cut losses at X%`). Does NOT match incidental `pnl < X%` in descriptive lessons. Keywords: `NEVER`, `DO NOT`, `STOP LOSS`, `CUT LOSS` (not `AVOID` — too broad).
- **Daily summarization**: Two phases — batch cleanup (aggressive: delete duplicates/noise, merge into <120 char rules, max 70% reduction) → policy consolidation (consolidate AVOID/PREFER groups into short parseable rules). Never deletes pinned or experiment lessons. Protected keywords: "AVOID holding" (hold-time rules), "bins_above" (range asymmetry).
- **Comparative lessons**: Every 5 closes, aggregates performance by strategy + volatility bucket. Generates PREFER lessons when one strategy outperforms another by >2% avg PnL (min 3 samples per group). Deduped by strategy pair.
- **Token characteristic lessons**: Every 5 closes, `analyzeTokenCharacteristics()` groups performance by token traits (mcap bucket, holder count, volume, smart wallets, OKX smart money, 1h momentum, ATH proximity). Generates PREFER lessons like "For mcap<$50k tokens, use strategy=bid_ask". Summary also injected into Claude lesson updater prompt for richer analysis.
- **Claude lesson updater**: Every 5 closes. Analyzes recent closes + token characteristic patterns, adds lessons, applies config tweaks (all screening/strategy/management/sizing keys). Includes token profile data per close and aggregated characteristic→strategy analysis.
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

**How it works**: `scripts/goals.js` calculates current performance vs targets (✅/❌ per goal). Goals are deeply integrated across the entire learning pipeline:

- **System prompt** (`prompt.js`): Goals injected into all agent prompts (screener/manager/general) so every decision is goal-aligned.
- **Lesson derivation** (`lessons.js` `derivLesson()`): Auto-derived lessons are goal-aware — losses exceeding `max_loss_pct` generate explicit stop-loss rules; unmet win rate appends entry filter guidance; unmet profit factor appends cut-losses-faster guidance. Tagged `goal_driven`.
- **Threshold evolution** (`lessons.js` `evolveThresholds()`): When goals are unmet, thresholds evolve more aggressively toward the goal (tighter SL for max_loss, smaller sizing for win_rate, earlier TP for profit_factor).
- **Lesson injection** (`getLessonsForPrompt()`): Goals progress section appended after all lessons — agents see which goals are met/unmet.
- **Review prompts** (every-5-closes + daily autoresearch): Goals injected with instruction to prioritize unmet goals.
- **Lesson summarizer** (`claude-lesson-summarizer.js`): Goals context injected into both batch cleanup and policy consolidation prompts — lessons tagged `GOAL` or addressing unmet goals are protected from deletion/merging.

**Key mapping** (Telegram shorthand → config key): `win_rate` → `win_rate_pct`, `max_loss` → `max_loss_pct`, `profit_factor` → `profit_factor`, `lookback` → `lookback`.

## Hive Mind

Opt-in collective intelligence (`hive-mind.js`). Pool consensus injected into screening if 3+ agents. After close: sync lessons, deploys, thresholds. All fire-and-forget. Circuit breaker: 3 consecutive failures → 30 min backoff (skips sync and queries).

## Telegram Commands

Primary interface — user always operates Meridian via Telegram (not TTY).

Command matching uses `cmd = text.toLowerCase()` with aggressive Unicode stripping (zero-width spaces, BOM, directional marks, word joiners) to handle invisible characters Telegram may inject. Debug logging on every slash command shows raw bytes for troubleshooting.

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
| `/freeze` / `/unfreeze` | Stop/resume all auto-lesson generation |
| `/withdraw` | Close all, swap to SOL, report balance |
| `/decisions [N]` | Last N decisions (default 10) — why deploys/closes/skips happened |

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

## Decision Log

Structured why-log at `decision-log.json` (gitignored, atomic writes, ring buffer 200 entries). Each entry: `{id, ts, type, actor, pool, pool_name, position, summary, reason, risks[], metrics{}}`.

- **Centralized capture**: `appendDecision()` is wired into the executor's success branch — every successful `deploy_position` and `close_position` is logged automatically with metrics. Never throws (failure logs and returns null).
- **Actor tagging via `_decision_source`**: Internal callers pass `_decision_source: "RULE_ENGINE" | "PNL_CHECKER" | "USER"` to `executeTool`. The executor strips this hint from args before invoking the underlying tool, then uses it to tag the decision actor. LLM-driven calls (no hint) default to `"AGENT"`.
- **Skip / no-deploy capture**: `index.js` calls `appendDecision()` directly for screening skips (max positions, low SOL) and for screener `NO DEPLOY` outputs.
- **Prompt injection**: `agent.js` calls `getDecisionSummary(6)` and passes it through `buildSystemPrompt()` into a `RECENT DECISIONS` block. Agents see the last 6 decisions in every cycle.
- **Tool**: `get_recent_decisions({limit, type, actor, position})` is registered for SCREENER, MANAGER, and GENERAL roles — preferred for answering "why did you…?" questions without triggering trades.
- **Telegram**: `/decisions [N]` shows the last N decisions formatted with timestamp, actor, type, summary, reason, and risks.

## Observability

- **Error notifications**: `notifyError(source, message)` in `telegram-journal.js` sends `🚨 ERROR` to journal bot. Throttled per source (15 min). Covers: management, screening, PnL checker, reports, dust sweep, lesson summarizer.
- **Portfolio snapshots**: `logSnapshot()` called every management cycle → `logs/snapshots-{date}.jsonl`. Tracks positions count, total value, PnL, unclaimed fees per tier.
- **Dashboard API**: `/api/actions?date=YYYY-MM-DD&limit=100&tool=deploy_position` — queries `actions-*.jsonl` for tool execution timeline.
- **Dashboard lesson management**: Full CRUD — add (POST `/api/lessons`), edit (PUT), delete (DELETE), bulk delete (POST `/api/lessons/bulk-delete`). Each lesson card shows enforcement badge (red `ENFORCED: type @ threshold`) when the rule engine actively enforces it. Bulk select mode for multi-delete.
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
