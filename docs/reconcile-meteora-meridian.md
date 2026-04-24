# Reconciliation: Meridian Logs vs Meteora UI (11–23 Apr 2026)

> Ground truth: Meteora UI (user-provided, UTC+0). Comparison: Meridian's `logs/actions-*.jsonl` per-close `pnl_usd` and `fees_earned_usd`.

## Daily Reconciliation

| Date | Closes | Dup | Meteora ($) | Meridian net ($) | Δ net | Meridian pnl_only ($) | Δ pnl_only |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-04-11 | 79 | 0 | -1.47 | 34.81 | 36.28 | 0.10 | 1.57 |
| 2026-04-12 | 101 | 0 | -27.15 | 84.12 | 111.27 | -18.24 | 8.91 |
| 2026-04-13 | 96 | 0 | -53.39 | 103.73 | 157.12 | -46.73 | 6.66 |
| 2026-04-14 | 43 | 0 | -48.23 | 22.29 | 70.52 | -3.48 | 44.75 |
| 2026-04-15 | 61 | 0 | -17.42 | 23.13 | 40.55 | -40.39 | -22.97 |
| 2026-04-16 | 54 | 0 | -1.67 | -0.45 | 1.22 | -21.82 | -20.15 |
| 2026-04-17 | 51 | 0 | 13.78 | 18.89 | 5.11 | -34.09 | -47.87 |
| 2026-04-18 | 16 | 0 | 16.66 | 16.11 | -0.55 | -13.90 | -30.56 |
| 2026-04-19 | 26 | 0 | -0.05 | -0.77 | -0.72 | -27.67 | -27.62 |
| 2026-04-20 | 49 | 0 | -47.81 | -18.69 | 29.12 | -124.12 | -76.31 |
| 2026-04-21 | 57 | 0 | 8.57 | 38.69 | 30.12 | -75.07 | -83.64 |
| 2026-04-22 | 60 | 0 | -0.41 | 9.99 | 10.40 | -61.62 | -61.21 |
| 2026-04-23 | 31 | 0 | -16.92 | -19.75 | -2.83 | -41.00 | -24.08 |
| **TOTAL** | | | **-175.51** | **312.10** | **487.61** | **-508.03** | **-332.52** |

## Pattern Analysis

- **Meridian.net (pnl_usd + fees_usd):** RSS diff 216.57, avg diff per day 37.51
- **Meridian.pnl_only (pnl_usd alone):** RSS diff 155.55, avg diff per day -25.58
- **Formula closer to Meteora:** `pnl_usd` alone (datapi's pnlUsd is already fee-inclusive on these days)
- **Duplicate closes detected:** 0 (same position address closed twice in same day)

## Verdict

**Bug: fees double-counted.** Summing `pnl_usd + fees_earned_usd` gives a total off by $487.61 vs Meteora's $-175.51. Using `pnl_usd` alone reduces the error to $-332.52.

This matches commit **247666b** (15 Apr): _"eliminate PnL double-counting — Meteora datapi pnlUsd is fee-inclusive"_. After that commit, `pnl_usd` in logs should be price-only (fee-inclusive minus unclaimed). But the data here suggests `pnl_usd` in pre-15-Apr logs still held fee-inclusive value.

**Recommendation:** When computing "what-Meteora-shows" internal PnL, use `pnl_usd` only (NOT `pnl_usd + fees_earned_usd`). Or introduce a single canonical field like `true_pnl_usd` and populate it consistently.

## Day-by-Day Biggest Divergences (sorted by |Δ|)

| Date | Meteora | Meridian.net | Δ | Closes |
| --- | ---: | ---: | ---: | ---: |
| 2026-04-13 | -53.39 | 103.73 | 157.12 | 96 |
| 2026-04-12 | -27.15 | 84.12 | 111.27 | 101 |
| 2026-04-14 | -48.23 | 22.29 | 70.52 | 43 |
| 2026-04-15 | -17.42 | 23.13 | 40.55 | 61 |
| 2026-04-11 | -1.47 | 34.81 | 36.28 | 79 |

## Next Steps

1. Pick the 1-2 biggest-divergence days (table above), open `logs/actions-<that-date>.jsonl`, dump all `close_position` entries, and spot-check against Meteora UI per-position PnL.
2. If duplicates > 0: investigate why same position_address closed twice (possibly retry-on-error logic didn't check idempotency).
3. Decide canonical formula: (a) use `pnl_usd` alone everywhere, OR (b) keep `net = pnl_usd + fees` but verify `pnl_usd` is price-only.
4. Once formula is consistent, rebuild `journal.json` from action logs using the canonical formula (script can be written).

---
*Generated 2026-04-24T05:31:22.044Z via `scripts/reconcile-meteora-meridian.js`.*