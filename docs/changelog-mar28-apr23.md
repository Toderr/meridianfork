# Meridian Changelog — 28 Mar s/d 23 Apr 2026

> Auto-generated from `git log` on branch `main`. Range: `2026-03-28 00:00 +0800` → `2026-04-23 23:59 +0800`.

## Overview

- **Total commits (non-merge):** 72
- **Actual date range:** 2026-03-28 → 2026-04-23
- **Reverts:** 1
- **Distinct categories touched:** 9

### Major themes (4 weeks)

1. **Learning system maturity** — moved from freeform LLM-driven derivation to a 3-layer enforced system (prompt / pre-agent / executor) with goal-aligned lessons, threshold evolution guardrails, token-characteristic analysis, and daily Claude summarizer + autoresearch loops.
2. **PnL correctness** — eliminated USD↔SOL conversion drift and double-counting; adopted Meteora datapi's canonical fee-inclusive `pnlUsd` as the single source of truth, journaled with fee-inclusive totals.
3. **Deterministic rule engine** — replaced LLM management decisions with `management-rules.js` (yield-exit, OOR, hard-hold cap, claim fees) backed by audit-derived constants. LLM fallback only for unparseable instructions.
4. **Big-loss mitigation** — hardcoded volatility cap (≤5), unique-token-across-pools guard, post-loss cooldown, forced single-sided SOL, variant null-guard + proven-variant bonus, confidence cap at 8.
5. **Observability** — structured decision log, error notifications, per-source throttling, portfolio snapshots, compare-periods A/B audit, /audit slash command, daily autoresearch biggest-win-vs-loss.

### Most-touched files (top 10)

| File | Commits |
| --- | ---: |
| `CLAUDE.md` | 43 |
| `index.js` | 28 |
| `tools/executor.js` | 22 |
| `tools/dlmm.js` | 20 |
| `lessons.js` | 16 |
| `telegram-journal.js` | 12 |
| `dashboard/api.js` | 12 |
| `dashboard/index.html` | 12 |
| `tools/definitions.js` | 12 |
| `prompt.js` | 10 |

## Per-Week Changelog

### Week 1 (28 Mar – 3 Apr) — 28 commits

**Theme:** Experiment tier ships, hive-mind opens, multi-provider LLM routing, goals system & token-characteristic lessons land.

#### Lessons & Learning
- `456b0ad` 2026-04-03 — feat: fee-inclusive PnL display + lesson policy consolidation
- `bda75db` 2026-04-02 — fix: experiment deploys no longer blocked by lesson hard rules
- `08a2660` 2026-04-02 — feat: lesson summarizer batching, remove_lesson tool, dashboard fixes
- `7d6b9d2` 2026-04-02 — feat: lesson management — dashboard edit/categories, daily summarizer, experiment source
- `1c14104` 2026-04-02 — feat: lesson dedup, dashboard search/labels, experiment bypass fixes
- `e3e38c7` 2026-04-01 — feat: auto-close empty positions, aggressive dust sweep, Claude review lesson format
- `a7d170f` 2026-03-28 — fix: exempt experiment positions from regular lesson enforcement
- `2c688c3` 2026-03-28 — feat: separate lesson storage — regular vs experiment files
- `7f63230` 2026-03-28 — feat: dashboard lesson delete, pin cap, lesson TP, pnl_checker SL/TP

#### Screening & Candidates
- `2ec6b60` 2026-04-02 — feat: integrate OKX risk flags into getTopCandidates screening
- `367a4e3` 2026-03-28 — feat: dashboard positions grouped by volatility tier

#### PnL & Reporting
- `197409f` 2026-03-31 — feat: swap all tokens after close, fix pool name resolution, journal edit/delete
- `8cd76c9` 2026-03-29 — fix: on-chain PnL fallback when Meteora datapi returns zero balances
- `50a2c09` 2026-03-28 — feat: include experiment lessons in convergence report + journal updates
- `29effd8` 2026-03-28 — fix: show invested amount for untracked positions via PnL API fallback
- `1b03ef8` 2026-03-28 — fix: separate fees from price PnL in management report

#### Docs
- `3ee5349` 2026-03-28 — docs: update CLAUDE.md with wide-range tracking + pair name resolution

#### Other
- `9c9066d` 2026-04-03 — fix: pin USD/SOL toggle to right edge of topbar on mobile
- `34a1709` 2026-04-02 — feat: deployer blocklist integrated into main screening flow
- `901cc40` 2026-04-02 — feat: apply 7 upstream fixes (race condition, deploy guard, bin IDs, bot filter)
- `02ae2f1` 2026-04-02 — chore: sync non-conflicting files from upstream main
- `01eb137` 2026-04-02 — fix: remove similar_amount signal from bundler detection
- `5a244dd` 2026-04-02 — Update user configuration with new parameters
- `c32f4fb` 2026-04-02 — feat: known-mints allowlist to prevent dust attack wallet drain
- `c58763e` 2026-03-31 — fix: enforce descriptive close_reason on all close paths
- `12a739a` 2026-03-31 — fix: post-close swap RPC fallback + Helius key rotation
- `5e2315a` 2026-03-28 — feat: experiment tier — strategy optimization loop
- `8889842` 2026-03-28 — fix: track wide-range positions early + resolve missing pair names

### Week 2 (4 Apr – 10 Apr) — 15 commits

**Theme:** Learning-system hardening — manual management mode, volatility guardrails, deploy floor, removing hardcoded screening, goals integration.

#### Lessons & Learning
- `d564e19` 2026-04-07 — fix: tighten max_loss_pct regex + dashboard lesson management UI
- `f054252` 2026-04-06 — feat: deterministic management engine, lesson caps, concise summarizer
- `1c86353` 2026-04-06 — feat: autoresearch integration, goals system, and /goals Telegram command
- `480ccba` 2026-04-04 — docs: update CLAUDE.md with anti-hallucination guard and lesson unit-mix
- `30cdfd9` 2026-04-04 — fix: guard against unit-mixed lesson records (upstream c601860)

#### Screening & Candidates
- `44041fe` 2026-04-04 — feat: pre-load top LPers + OKX token intel into screening cycle

#### PnL & Reporting
- `b786173` 2026-04-05 — feat: add knowledge wiki system — auto-compiled trading KB from journal/lessons/snapshots
- `e259b46` 2026-04-04 — fix: close notifications now show fee-inclusive PnL in USD and SOL

#### Docs
- `21c8dfd` 2026-04-04 — docs: condense CLAUDE.md from ~590 to ~220 lines

#### Other
- `aa14782` 2026-04-06 — fix: show fees in close notification and fix LPAgent pnl_pct double-multiply
- `43aa224` 2026-04-06 — fix: prevent management deadlock when notification code throws in finally block
- `d7e2da1` 2026-04-05 — feat: use LPAgent as primary source for live position economics (upstream 1a98513)
- `ba11a8b` 2026-04-05 — feat: comprehensive resilience, learning, and observability improvements (20 items)
- `0a8df9e` 2026-04-04 — fix: enforce real tool calls for deploys + use screening model (upstream a4681ab, b7aa4aa)
- `1dafbb5` 2026-04-04 — fix: preserve top lper wallet addresses (upstream 846ef55)

### Week 3 (11 Apr – 17 Apr) — 14 commits

**Theme:** PnL rewrite (fee-inclusive `true_pnl`), decision log landed, hold-time cuts disabled (30-Mar baseline restore), Telegram command matching hardened.

#### Lessons & Learning
- `b05dbe2` 2026-04-15 — feat: freeze lessons, hold-time cuts, single-sided SOL, evolution guardrails
- `421fb97` 2026-04-14 — feat: token characteristic lessons — learn which token traits match which strategies
- `8e8332e` 2026-04-13 — fix: respect volatility condition on max_deploy_sol lesson rules
- `f6cd32a` 2026-04-11 — feat: goals integration, remove LPAgent dependency, dashboard mobile UX

#### Management & Rules
- `513b09c` 2026-04-17 — chore: disable hold-time cut — 30-Mar baseline restore

#### PnL & Reporting
- `247666b` 2026-04-15 — fix: eliminate PnL double-counting — Meteora datapi pnlUsd is fee-inclusive
- `b736723` 2026-04-14 — feat: notify journal bot on config changes from all sources
- `c6824cc` 2026-04-11 — chore: untrack journal.json (already in .gitignore)

#### Telegram & CLI
- `5e6c1af` 2026-04-16 — docs: update CLAUDE.md — Telegram is primary interface, command matching details
- `8937d2d` 2026-04-16 — fix: robust Telegram command matching — strip invisible Unicode, case-insensitive

#### Infra, Dev & Build
- `1431a8b` 2026-04-11 — feat: multi-provider LLM routing with MiniMax direct API support

#### Other
- `9837502` 2026-04-14 — feat: remove hardcoded screening restrictions — only global_fees_sol >= 30 remains
- `79209e0` 2026-04-14 — feat: manual management mode — block automation for specific positions
- `9f4d10a` 2026-04-13 — fix: enforce deployAmountSol as minimum deploy floor, linear confidence scaling

### Week 4 (18 Apr – 23 Apr) — 15 commits

**Theme:** Big-loss mitigation bundle, hardcoded guardrails (vol cap 5, variant casing, $4/hr escape), audit tooling — compare-periods, /audit slash command.

#### Screening & Candidates
- `46d6de8` 2026-04-23 — feat: cross-pool unique-token guard (uniqueTokenAcrossPools)

#### Management & Rules
- `f5f3e56` 2026-04-23 — feat: compare-periods.js — A/B audit with variant breakdown + close_reason classifier fix
- `bfdf419` 2026-04-23 — feat: full-data audit recs — $4/hr 120m escape, upper-biased variant bonus, 3 analyzers
- `7ee1669` 2026-04-23 — feat: big-loss mitigation bundle (R1-R6)
- `4fe03c2` 2026-04-22 — feat: variant null-guard, normalized lper bonus, confidence cap

#### PnL & Reporting
- `0842d41` 2026-04-21 — revert: drop true_pnl helper, use Meteora datapi pnl directly
- `2703064` 2026-04-21 — fix: route close notifs through canonical true_pnl, stop trusting LLM initial_value_usd
- `becc6aa` 2026-04-21 — fix: true_pnl matches Meteora UI exactly (drop datapi pnlUsd)
- `8394e27` 2026-04-21 — feat: true_pnl uses Meteora canonical formula directly
- `43b713c` 2026-04-21 — feat: true_pnl (fee-inclusive) as the single user-facing PnL + hardcoded guardrails
- `680051d` 2026-04-20 — feat: journal full token + strategy snapshots and duration metrics

#### Observability & Logs
- `3fa118e` 2026-04-18 — feat: structured decision log — every deploy/close/skip with reasoning

#### Telegram & CLI
- `674471b` 2026-04-23 — feat: /audit slash command — run all 3 analyzers + summarize deltas

#### Other
- `48eea96` 2026-04-20 — chore: raise swap failure threshold from 3 to 5
- `9c62082` 2026-04-18 — fix: migrate swaps to jupiter swap v2 api

## Reverts & Walk-backs

- `0842d41` 2026-04-21 — revert: drop true_pnl helper, use Meteora datapi pnl directly

## Appendix: Full Commit List (oldest → newest)

- `8889842` 2026-03-28 00:51 — fix: track wide-range positions early + resolve missing pair names
- `3ee5349` 2026-03-28 00:52 — docs: update CLAUDE.md with wide-range tracking + pair name resolution
- `7f63230` 2026-03-28 10:36 — feat: dashboard lesson delete, pin cap, lesson TP, pnl_checker SL/TP
- `5e2315a` 2026-03-28 10:59 — feat: experiment tier — strategy optimization loop
- `1b03ef8` 2026-03-28 21:39 — fix: separate fees from price PnL in management report
- `2c688c3` 2026-03-28 23:00 — feat: separate lesson storage — regular vs experiment files
- `367a4e3` 2026-03-28 23:00 — feat: dashboard positions grouped by volatility tier
- `a7d170f` 2026-03-28 23:15 — fix: exempt experiment positions from regular lesson enforcement
- `29effd8` 2026-03-28 23:39 — fix: show invested amount for untracked positions via PnL API fallback
- `50a2c09` 2026-03-28 23:39 — feat: include experiment lessons in convergence report + journal updates
- `8cd76c9` 2026-03-29 13:58 — fix: on-chain PnL fallback when Meteora datapi returns zero balances
- `197409f` 2026-03-31 03:41 — feat: swap all tokens after close, fix pool name resolution, journal edit/delete
- `12a739a` 2026-03-31 10:24 — fix: post-close swap RPC fallback + Helius key rotation
- `c58763e` 2026-03-31 20:11 — fix: enforce descriptive close_reason on all close paths
- `e3e38c7` 2026-04-01 23:40 — feat: auto-close empty positions, aggressive dust sweep, Claude review lesson format
- `c32f4fb` 2026-04-02 00:02 — feat: known-mints allowlist to prevent dust attack wallet drain
- `1c14104` 2026-04-02 10:20 — feat: lesson dedup, dashboard search/labels, experiment bypass fixes
- `7d6b9d2` 2026-04-02 13:57 — feat: lesson management — dashboard edit/categories, daily summarizer, experiment source
- `5a244dd` 2026-04-02 14:06 — Update user configuration with new parameters
- `01eb137` 2026-04-02 14:06 — fix: remove similar_amount signal from bundler detection
- `02ae2f1` 2026-04-02 14:07 — chore: sync non-conflicting files from upstream main
- `901cc40` 2026-04-02 14:24 — feat: apply 7 upstream fixes (race condition, deploy guard, bin IDs, bot filter)
- `2ec6b60` 2026-04-02 14:41 — feat: integrate OKX risk flags into getTopCandidates screening
- `34a1709` 2026-04-02 14:58 — feat: deployer blocklist integrated into main screening flow
- `08a2660` 2026-04-02 17:32 — feat: lesson summarizer batching, remove_lesson tool, dashboard fixes
- `bda75db` 2026-04-02 22:41 — fix: experiment deploys no longer blocked by lesson hard rules
- `456b0ad` 2026-04-03 16:22 — feat: fee-inclusive PnL display + lesson policy consolidation
- `9c9066d` 2026-04-03 16:30 — fix: pin USD/SOL toggle to right edge of topbar on mobile
- `e259b46` 2026-04-04 11:32 — fix: close notifications now show fee-inclusive PnL in USD and SOL
- `21c8dfd` 2026-04-04 11:32 — docs: condense CLAUDE.md from ~590 to ~220 lines
- `44041fe` 2026-04-04 15:00 — feat: pre-load top LPers + OKX token intel into screening cycle
- `1dafbb5` 2026-04-04 15:06 — fix: preserve top lper wallet addresses (upstream 846ef55)
- `30cdfd9` 2026-04-04 15:08 — fix: guard against unit-mixed lesson records (upstream c601860)
- `0a8df9e` 2026-04-04 15:09 — fix: enforce real tool calls for deploys + use screening model (upstream a4681ab, b7aa4aa)
- `480ccba` 2026-04-04 15:12 — docs: update CLAUDE.md with anti-hallucination guard and lesson unit-mix
- `ba11a8b` 2026-04-05 20:35 — feat: comprehensive resilience, learning, and observability improvements (20 items)
- `b786173` 2026-04-05 22:48 — feat: add knowledge wiki system — auto-compiled trading KB from journal/lessons/snapshots
- `d7e2da1` 2026-04-05 23:49 — feat: use LPAgent as primary source for live position economics (upstream 1a98513)
- `43aa224` 2026-04-06 07:54 — fix: prevent management deadlock when notification code throws in finally block
- `1c86353` 2026-04-06 20:05 — feat: autoresearch integration, goals system, and /goals Telegram command
- `aa14782` 2026-04-06 20:05 — fix: show fees in close notification and fix LPAgent pnl_pct double-multiply
- `f054252` 2026-04-06 20:44 — feat: deterministic management engine, lesson caps, concise summarizer
- `d564e19` 2026-04-07 09:26 — fix: tighten max_loss_pct regex + dashboard lesson management UI
- `1431a8b` 2026-04-11 21:59 — feat: multi-provider LLM routing with MiniMax direct API support
- `c6824cc` 2026-04-11 22:00 — chore: untrack journal.json (already in .gitignore)
- `f6cd32a` 2026-04-11 22:14 — feat: goals integration, remove LPAgent dependency, dashboard mobile UX
- `9f4d10a` 2026-04-13 01:38 — fix: enforce deployAmountSol as minimum deploy floor, linear confidence scaling
- `8e8332e` 2026-04-13 01:50 — fix: respect volatility condition on max_deploy_sol lesson rules
- `79209e0` 2026-04-14 11:20 — feat: manual management mode — block automation for specific positions
- `421fb97` 2026-04-14 11:53 — feat: token characteristic lessons — learn which token traits match which strategies
- `9837502` 2026-04-14 11:53 — feat: remove hardcoded screening restrictions — only global_fees_sol >= 30 remains
- `b736723` 2026-04-14 11:53 — feat: notify journal bot on config changes from all sources
- `247666b` 2026-04-15 17:01 — fix: eliminate PnL double-counting — Meteora datapi pnlUsd is fee-inclusive
- `b05dbe2` 2026-04-15 21:29 — feat: freeze lessons, hold-time cuts, single-sided SOL, evolution guardrails
- `8937d2d` 2026-04-16 18:49 — fix: robust Telegram command matching — strip invisible Unicode, case-insensitive
- `5e6c1af` 2026-04-16 21:38 — docs: update CLAUDE.md — Telegram is primary interface, command matching details
- `513b09c` 2026-04-17 01:20 — chore: disable hold-time cut — 30-Mar baseline restore
- `3fa118e` 2026-04-18 02:18 — feat: structured decision log — every deploy/close/skip with reasoning
- `9c62082` 2026-04-18 02:30 — fix: migrate swaps to jupiter swap v2 api
- `680051d` 2026-04-20 12:18 — feat: journal full token + strategy snapshots and duration metrics
- `48eea96` 2026-04-20 12:19 — chore: raise swap failure threshold from 3 to 5
- `43b713c` 2026-04-21 15:26 — feat: true_pnl (fee-inclusive) as the single user-facing PnL + hardcoded guardrails
- `8394e27` 2026-04-21 15:51 — feat: true_pnl uses Meteora canonical formula directly
- `becc6aa` 2026-04-21 16:40 — fix: true_pnl matches Meteora UI exactly (drop datapi pnlUsd)
- `2703064` 2026-04-21 18:23 — fix: route close notifs through canonical true_pnl, stop trusting LLM initial_value_usd
- `0842d41` 2026-04-21 19:25 — revert: drop true_pnl helper, use Meteora datapi pnl directly
- `4fe03c2` 2026-04-22 19:30 — feat: variant null-guard, normalized lper bonus, confidence cap
- `46d6de8` 2026-04-23 18:23 — feat: cross-pool unique-token guard (uniqueTokenAcrossPools)
- `7ee1669` 2026-04-23 18:24 — feat: big-loss mitigation bundle (R1-R6)
- `bfdf419` 2026-04-23 19:41 — feat: full-data audit recs — $4/hr 120m escape, upper-biased variant bonus, 3 analyzers
- `674471b` 2026-04-23 19:47 — feat: /audit slash command — run all 3 analyzers + summarize deltas
- `f5f3e56` 2026-04-23 21:40 — feat: compare-periods.js — A/B audit with variant breakdown + close_reason classifier fix

---
*Generated 2026-04-24T04:33:20.382Z via `scripts/build-changelog.js`.*
