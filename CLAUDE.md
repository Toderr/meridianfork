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
| `tools/executor.js` | Tool dispatch, post-tool hooks (notify, journal, sync) |
| `tools/definitions.js` | LLM tool schemas for all agent roles |
| `experiment.js` | Experiment tier — strategy optimization loop |
| `lessons.js` | Performance recording and learning system |
| `lesson-rules.js` | Lesson rule extractor + compliance checkers |
| `journal.js` | Append-only trade journal |
| `reports.js` | Daily/weekly/monthly plain-text reports |
| `prompt.js` | System prompt builder |
| `telegram.js` | Main Telegram bot (long-polling) |
| `telegram-journal.js` | Journal bot — close notifications, `/recent`, `/today`, `/closes`, `/stats` |
| `hive-mind.js` | Opt-in collective intelligence network |
| `stats.js` | Shared in-memory counters + flags |
| `strategy-library.js` | LP strategy template storage |
| `pool-memory.js` | Per-pool deploy history and notes |
| `scripts/patch-anchor.js` | Postinstall: patches `@coral-xyz/anchor` + `@meteora-ag/dlmm` for Node ESM |
| `scripts/claude-ask.js` | Telegram `/claude` Q&A agent via `claude --print` |
| `scripts/claude-lesson-updater.js` | Auto lesson updater — runs every 5 closes |
| `scripts/claude-lesson-summarizer.js` | Daily lesson cleanup at 23:59 UTC+7 |

## Runtime Files (gitignored, never overwrite on VPS)

`user-config.json`, `state.json`, `journal.json`, `lessons.json`, `experiment-lessons.json`, `strategy-library.json`, `pool-memory.json`, `experiments.json`, `.env`, `.agent.pid`

## Architecture

### Cron Cycles

Management runs on 3 volatility tiers via 1-minute dispatcher. Only one tier runs at a time (`_managementBusy` mutex).

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

### Hot-reload
`user-config.json` watched via `fs.watchFile` (2s). Most settings apply live. `rpcUrl`, `walletKey`, `dryRun`, schedule intervals require restart.

### Helius API Key Rotation
Two keys (`HELIUS_API_KEY`, `HELIUS_API_KEY_2`). On 429, rotates and retries. Both exhausted → RPC fallback for SOL-only balance. Post-close swap has full RPC fallback via `getAllTokenBalancesViaRpc()`.

## SOL PnL — Important

**Never compute `pnl_sol` via USD conversion.** Meteora DLMM API returns native SOL fields: `pnlSol`, `balancesSol`, `amountSol`. Use these directly.

**On-chain PnL fallback**: When Meteora datapi returns `balances: 0` (pricing failure), `getOnChainPositionValue()` fetches real position value from DLMM SDK + Jupiter Price API.

## PnL Display — Fee Inclusion

Journal stores `pnl_usd` (price-only) and `fees_earned_usd` separately. **Fee inclusion is done at the display/aggregation layer only:**
- Close notifications (both bots): fee-inclusive USD, SOL, and % in all three values
- Management reports: price PnL (USD, SOL) on one line, unclaimed fees + total % separately
- Dashboard & reports: fee-inclusive totals for net PnL, win/loss, best/worst trade
- `pnl_pct` from `getPositionPnl()` is already fee-inclusive: `(pnlUsd + unclaimedFees) / initial * 100`

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

Empty-position closes report `pnl_pct = 0` (not -100%). Thresholds hot-reload from config. Peak stored in-memory (`_trailingStops` Map, resets on restart).

### Management Decision Rules (priority order)
1. instruction set AND condition met → CLOSE
2. instruction set AND condition NOT met → HOLD
3. yield-exit: `fee_tvl_24h < minFeeTvl24h` (suppressed when `pnl_pct < 0`)
4. OOR: `bins_above_range >= outOfRangeBinsToClose` → CLOSE
5. `unclaimed_fee_usd >= minClaimAmount` → claim_fees

NOTE: Stop loss / take profit handled by PnL checker, not management cycle.

## Confidence-Based Position Sizing

Deploys only if confidence > 7. Amount scales: `deployAmount × (confidence/10)`, minimum 0.1 SOL.

## Transaction Retry

All on-chain calls go through `sendWithRetry()` — 5 attempts with exponential backoff (1s, 2s, 4s, 8s).

## Risk Management

- **Sizing**: `(wallet - gasReserve) × positionSizePct`, clamped between `deployAmountSol` and `maxDeployAmount`
- **Max positions**: `config.risk.maxPositions` (default 10)
- **Gas reserve**: `gasReserve` SOL (default 0.2) always kept
- **Anti-scam**: Skip if `global_fees_sol < minTokenFeesSol`, top_10_pct > 60%, bundlers > 30%
- **Known-mints allowlist**: Only swap tokens from positions the bot deployed into. `getKnownMints()` builds Set from ALL positions (open + closed). Unknown tokens never touched — prevents wallet drain from airdropped tokens. `/withdraw` bypasses filter.

## Learning System

- **Derivation**: Auto after close — good (≥5%), neutral (0-5% → no lesson), poor (-5%–0%), bad (<-5%)
- **Experiment separation**: Regular in `lessons.json`, experiment in `experiment-lessons.json`. Experiment lessons excluded from prompt injection, threshold evolution, rule extraction, summarization.
- **Threshold evolution**: Every 5 closes, auto-adjusts screening/strategy/TP-SL/sizing params. Max 20% change per step.
- **Lesson dedup**: Same structural type → updates in place (no duplicates). Multi-variant types discriminated by strategy name, token, field.
- **Injection**: ALL lessons injected. Priority: pinned → role-matched → recent. Good > bad > manual > neutral. Max 10 pinned.
- **Enforcement (3-layer)**:
  1. **Prompt** — HARD RULES (AVOID/NEVER/SKIP) as numbered checklist. GUIDANCE (PREFER/WORKED) shown separately.
  2. **Pre-agent** — screening filters violating candidates; management force-closes/holds matching positions.
  3. **Executor** — `checkDeployCompliance()` blocks deploy on-chain.
- **Rule types** (`lesson-rules.js`): `block_strategy`, `block_high_volatility`, `block_low_fees`, `block_concentration`, `oor_grace_period`, `force_close_aged_losing`, `protect_null_volatility`, `max_deploy_sol`, `max_loss_pct`, `min_profit_pct`, `reserve_slot`. Unmatched → prompt-only.
- **Daily summarization**: Two phases — batch cleanup (delete superseded, merge similar) → policy consolidation (consolidate AVOID/PREFER groups into parseable rules). Never deletes pinned or experiment lessons.
- **Claude lesson updater**: Every 5 closes. Analyzes recent closes, adds lessons, applies config tweaks (limited keys).
- **Constraint persistence**: Verbal constraints must be saved via `add_lesson` or `set_position_note` tool calls. Verbal-only instructions are NOT persisted.

## Experiment Tier

Strategy optimization loop (`experiment.js`): deploy → close → analyze → redeploy with optimized params → repeat until convergence.

- Deterministic hill-climbing optimizer (no LLM per iteration)
- Own TP/SL/trailing thresholds per experiment (faster closes for faster iteration)
- Bypasses: maxPositions, duplicate guards, confidence gate, lesson compliance, bin_step range, management pre-enforcement, prompt-level hard rules
- Convergence: N iterations without improvement (default 3), max iterations (default 20), or all combinations exhausted

## Hive Mind

Opt-in collective intelligence (`hive-mind.js`). Pool consensus injected into screening if 3+ agents. After close: sync lessons, deploys, thresholds. All fire-and-forget.

## Telegram Commands

| Command | Action |
|---------|--------|
| `/start` / `/stop` | Start/stop cron cycles |
| `/briefing` | Last 24h report |
| `/report [daily\|weekly\|monthly]` | Trading report |
| `/claude <question>` | Ask Claude (loads runtime context) |
| `/review` | Trigger Claude lesson updater |
| `/update_lesson` / `/update_lesson <N> <rule>` | List or update lessons |
| `/del_lesson <N>` | Delete lesson (pinned blocked) |
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

## Roadmap

### High Impact
- Multi-strategy templates with own criteria/exit rules
- Dynamic position sizing by volatility
- Pool memory success rates for screener signal
- Auto-rebalance: close stale → redeploy to better yield

### Medium Impact
- Re-evaluate management interval during holding
- Cross-role learning (manager mistakes → screener avoidance)
- ATH proximity check (skip tokens near all-time high)
