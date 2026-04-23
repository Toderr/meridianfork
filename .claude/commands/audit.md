---
description: Re-run trough/full-data/token-param analyzers against latest journal & logs, surface key deltas
---
Run all three audit analyzers against the current journal/logs and produce a concise update.

**Step 1 — Run analyzers in parallel** (no shared state). Use one Bash call per analyzer with `run_in_background: true`, then read each output:

```
node scripts/analyze-trough-recovery.js --csv
node scripts/analyze-full-data.js
node scripts/analyze-token-params.js
```

The full reports are also written to disk:
- `logs/trough-recovery.csv`
- `logs/full-data-analysis-<today>.md`
- `logs/token-param-analysis-<today>.md`

**Step 2 — Inspect current state of the live config + lessons** so deltas are framed against what's actually deployed:

```
grep -E '"(positionSizePct|maxMcap|maxTvl|emergencyPriceDropPct|takeProfitFeePct|fastTpPct|maxPositions)"' user-config.json
grep -E 'HARD_HOLD_(CAP|MIN|FEE)' management-rules.js | head -3
```

**Step 3 — Synthesize a Bahasa Indonesia summary** with these sections (skip a section if there's nothing notable):

1. **Coverage** — for each analyzer, n analyzed / n total.
2. **Window trend (full-data)** — all_time vs last_14d vs last_7d avg + P5. Flag if last_7d is significantly worse.
3. **Trough → recovery** — recovery % at ≤ −3%, ≤ −5%, ≤ −10% (fee-incl). Compare to current `emergencyPriceDropPct`.
4. **Most predictive token parameters** — top 3-5 from composite ranking with gap (pp).
5. **Recommended deltas** — only NEW recommendations that aren't already reflected in current config/lessons. Format as `key: current → recommended (reason)`.
6. **Watch list** — anything degrading vs last audit (variant/strategy/dimension that flipped negative).

**Rules:**
- Do NOT auto-apply any changes. Recommendations only — user decides.
- Be honest about sample sizes. token_profile only added 2026-04-21 — flag when n is thin.
- If a previous report from today already exists, mention it but do not skip — fresh data may have arrived since.
- Keep the summary tight: under ~40 lines. Full data is in the saved markdown reports.
