---
description: Re-run trough/full-data/token-param analyzers against latest journal & logs, surface key deltas since last audit
---
Run all three audit analyzers and produce a concise update **scoped to the window since the last audit run** (default).

`$ARGUMENTS` overrides the window:
- empty (default) → since last audit run
- `all_time` → no window filter (legacy behavior)
- ISO timestamp (e.g. `2026-04-30T00:00:00Z`) → since that ts
- `Nd` (e.g. `7d`) → last N days

**Step 0 — Resolve the window.**

```
tail -20 logs/audit-history.jsonl
```

Parse `$ARGUMENTS`:
- If `all_time` → set `SINCE=null`, label the window "all_time".
- If ISO ts → `SINCE=<ts>`, label `since <ts>`.
- If `Nd` → `SINCE=<now - N days>`, label `last Nd`.
- If empty → take the most recent `ts` from `logs/audit-history.jsonl` as `SINCE`. If the file is empty/missing, fall back to last 7d and note it.

State the resolved window in one line before running analyzers (e.g. *"Window: since 2026-05-02T00:00:00Z (last audit), $ARGUMENTS=empty"*).

**Step 1 — Run analyzers** (sequential — background execution is disabled in this project). Pass the resolved `SINCE` via `AUDIT_SINCE` env var; all three analyzers honor it natively and filter closes at source. Pass an empty string (or omit) for `all_time`.

```
AUDIT_SINCE=$SINCE node scripts/analyze-trough-recovery.js --csv
AUDIT_SINCE=$SINCE node scripts/analyze-full-data.js
AUDIT_SINCE=$SINCE node scripts/analyze-token-params.js
```

When `AUDIT_SINCE` is set, the bucket tables in the saved markdown reports (variant/strategy/hold_time/etc.) are also window-scoped — no need for post-hoc filtering on those.

Reports written to:
- `logs/trough-recovery.csv`
- `logs/full-data-analysis-<today>.md`
- `logs/token-param-analysis-<today>.md`

**Step 2 — Inspect current live config + hardcoded thresholds** so deltas are framed against what's actually deployed:

```
grep -nE '"(positionSizePct|maxMcap|maxTvl|emergencyPriceDropPct|takeProfitFeePct|fastTpPct|maxPositions|trailingActivate|trailingFloor|minFeeTvl24h|postLossCooldown)"' user-config.json
grep -E 'HARD_HOLD_(CAP|MIN|FEE|PROFITABLE)|MIN_HOLD_BEFORE_SL|SOFT_PEAK' management-rules.js index.js | head -15
```

**Step 3 — Compute the delta-window headline directly from the journal** as a sanity check (the analyzer headline already reflects the window since AUDIT_SINCE is honored, but this gives an independent fee-inclusive number that mirrors the PnL checker's formula exactly):

```
node -e "
const fs=require('fs');
const SINCE=process.env.SINCE||null;
const j=JSON.parse(fs.readFileSync('journal.json')).entries;
let c=j.filter(e=>e.type==='close'&&e.timestamp);
if(SINCE) c=c.filter(e=>new Date(e.timestamp)>=new Date(SINCE));
// fee-inclusive pct: pnl_pct + fees/initial*100 (mirror PnL checker)
const rows=c.map(e=>{
  const initial=e.initial_value_usd||e.token_profile?.initial_value_usd;
  const fees=e.fees_earned_usd||0;
  const feePct=initial>0?(fees/initial)*100:0;
  return {...e, total_pct:(e.pnl_pct||0)+feePct};
}).filter(r=>Number.isFinite(r.total_pct));
const n=rows.length;
const wins=rows.filter(r=>r.total_pct>0).length;
const avg=rows.reduce((s,r)=>s+r.total_pct,0)/(n||1);
const sorted=[...rows].map(r=>r.total_pct).sort((a,b)=>a-b);
const p5=sorted[Math.floor(n*0.05)]||0;
const p95=sorted[Math.floor(n*0.95)]||0;
console.log(JSON.stringify({n,win_rate:+(wins/n*100).toFixed(1),avg:+avg.toFixed(3),p5:+p5.toFixed(2),p95:+p95.toFixed(2),first:rows[0]?.timestamp,last:rows[n-1]?.timestamp}));
" 
```

Pass `SINCE` via env. Also slice by dimension (variant, strategy, hold_time bucket, close_reason) within this window — flag any group with n≥10 that is **net negative** or has flipped vs the prior audit's report.

**Step 4 — Synthesize a Bahasa Indonesia summary** with these sections (skip if nothing notable):

1. **Window** — resolved range + n closes in scope.
2. **Headline (delta window)** — n, win%, avg fee-incl, P5, P95.
3. **Coverage** — for each analyzer, n analyzed / n total (full journal — note that bucket tables in the saved reports are NOT window-scoped).
4. **Trough → recovery** — recovery % at ≤ −3%, ≤ −5%, ≤ −10% (fee-incl). Compare to `emergencyPriceDropPct`.
5. **Most predictive token parameters** — top 3–5 with gap (pp). Flag thin n.
6. **Delta-window dimension flags** — variants/strategies/hold-time buckets that are negative or degraded since last audit.
7. **Recommended deltas** — only NEW recommendations not already in current config/lessons. Format `key: current → recommended (reason, n)`.
8. **Watch list** — anything trending worse but not yet actionable.

**Step 5 — Append the run to `logs/audit-history.jsonl`** with: ts, scope (window label + SINCE), n_analyzed, headline, recommendations, applied=[]. This is the source of truth for the next default window.

**Rules:**
- Do NOT auto-apply changes. Recommendations only.
- Be honest about sample sizes. `token_profile` only added 2026-04-24 — flag when n is thin.
- If a previous report from today already exists, mention it but do not skip — fresh data may have arrived since.
- Keep the summary tight: under ~40 lines. Full data is in the saved markdown reports.
