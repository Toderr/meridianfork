---
description: Full audit — /audit analyzers PLUS telemetry logs (LLM, gas, decisions, snapshots)
---
Full-coverage audit combining trading analyzers with observability telemetry. Slower than `/audit` (reads more data). Use for deep-dive diagnostics.

**Step 1 — Run the 3 trading analyzers in parallel** (same as `/audit`). One Bash call per analyzer with `run_in_background: true`:

```
node scripts/analyze-trough-recovery.js --csv
node scripts/analyze-full-data.js
node scripts/analyze-token-params.js
```

Outputs to `logs/trough-recovery.csv`, `logs/full-data-analysis-<today>.md`, `logs/token-param-analysis-<today>.md`.

**Step 2 — Inspect live config + hardcoded constants:**

```
grep -E '"(positionSizePct|maxMcap|maxTvl|emergencyPriceDropPct|takeProfitFeePct|fastTpPct|maxPositions|minConfidenceToDeploy|freezeLessons)"' user-config.json
grep -E 'HARD_HOLD_(CAP|MIN|FEE)|MAX_VOLATILITY|BIN_STEP_(MIN|MAX)|TOP10_REJECT|BUNDLERS_REJECT|LPER_MIN_(COUNT|WIN_RATE)' management-rules.js tools/screening.js index.js | head
```

**Step 3 — Aggregate telemetry logs** (use one node one-liner per source; skip section if log file missing):

```
# 3a. LLM telemetry — today
node -e 'const fs=require("fs");const d=new Date().toISOString().slice(0,10);const f=`logs/llm-${d}.jsonl`;if(!fs.existsSync(f)){console.log("skip: no llm log today");process.exit(0)}const L=fs.readFileSync(f,"utf8").split("\n").filter(Boolean).map(JSON.parse);const tIn=L.reduce((s,x)=>s+(x.tokens_in||0),0);const tOut=L.reduce((s,x)=>s+(x.tokens_out||0),0);const errs=L.filter(x=>x.error).length;const fb=L.filter(x=>x.fallback_used).length;const models={};L.forEach(x=>models[x.model]=(models[x.model]||0)+1);console.log(`calls:${L.length} tokens_in:${tIn} tokens_out:${tOut} errors:${errs}(${(errs/L.length*100).toFixed(1)}%) fallback:${fb}(${(fb/L.length*100).toFixed(1)}%) avg_dur:${Math.round(L.reduce((s,x)=>s+(x.duration_ms||0),0)/L.length)}ms models:${JSON.stringify(models)}`)'

# 3b. Gas + wallet delta — today
node -e 'const fs=require("fs");const d=new Date().toISOString().slice(0,10);const f=`logs/gas-${d}.jsonl`;if(!fs.existsSync(f)){console.log("skip: no gas log today");process.exit(0)}const G=fs.readFileSync(f,"utf8").split("\n").filter(Boolean).map(JSON.parse);const byLabel={};G.forEach(x=>{const k=x.label.split(":")[0];if(!byLabel[k])byLabel[k]={n:0,gas:0,delta:0};byLabel[k].n++;byLabel[k].gas+=(x.fee_sol||0);byLabel[k].delta+=(x.wallet_sol_delta||0)});const totGas=G.reduce((s,x)=>s+(x.fee_sol||0),0);const totDelta=G.reduce((s,x)=>s+(x.wallet_sol_delta||0),0);console.log(`txs:${G.length} gas_total:${totGas.toFixed(6)}SOL wallet_delta:${totDelta.toFixed(4)}SOL byLabel:${JSON.stringify(byLabel)}`)'

# 3c. Decision log — breakdown by type + actor + top skip reasons
node -e 'const fs=require("fs");if(!fs.existsSync("decision-log.json")){console.log("skip: no decision log");process.exit(0)}const D=JSON.parse(fs.readFileSync("decision-log.json","utf8")).decisions||[];const byType={};const byActor={};const skipReasons={};D.forEach(x=>{byType[x.type]=(byType[x.type]||0)+1;byActor[x.actor]=(byActor[x.actor]||0)+1;if(x.type==="skip"&&x.reason){const k=x.reason.slice(0,60);skipReasons[k]=(skipReasons[k]||0)+1}});const topSkip=Object.entries(skipReasons).sort((a,b)=>b[1]-a[1]).slice(0,5);const skipN=byType.skip||0;const depN=byType.deploy||0;console.log(`total:${D.length} type:${JSON.stringify(byType)} actor:${JSON.stringify(byActor)} skip_per_deploy:${depN?(skipN/depN).toFixed(1):"inf"}`);console.log("top skip reasons:");topSkip.forEach(([r,n])=>console.log(`  ${n}x ${r}`))'

# 3d. Portfolio snapshot trend — 7d vs today
node -e 'const fs=require("fs");const path=require("path");const files=fs.readdirSync("logs").filter(f=>/^snapshots-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();if(files.length===0){console.log("skip: no snapshots");process.exit(0)}const last=fs.readFileSync(path.join("logs",files[files.length-1]),"utf8").split("\n").filter(Boolean).map(JSON.parse);const first=files.length>=7?fs.readFileSync(path.join("logs",files[files.length-7]),"utf8").split("\n").filter(Boolean).map(JSON.parse):last;const nowV=last[last.length-1]?.total_value_usd||0;const thenV=first[0]?.total_value_usd||0;const nowSol=last[last.length-1]?.sol_price;const thenSol=first[0]?.sol_price;const nowPnl=last[last.length-1]?.total_pnl_usd||0;console.log(`portfolio_7d:${thenV.toFixed(2)}->${nowV.toFixed(2)}USD delta:${(nowV-thenV).toFixed(2)} sol_price_7d:${thenSol||"n/a"}->${nowSol||"n/a"} current_unrealized_pnl:${nowPnl.toFixed(2)}`)'
```

**Step 4 — Synthesize a Bahasa Indonesia summary** with these sections (skip any section with no notable signal):

1. **Coverage** — for each analyzer, n analyzed / n total.
2. **Window trend (full-data)** — all_time vs last_14d vs last_7d avg + P5. Flag kalau last_7d significantly worse.
3. **Trough → recovery** — recovery % at ≤ −3%, ≤ −5%, ≤ −10% (fee-incl). Compare ke current `emergencyPriceDropPct`.
4. **Most predictive token parameters** — top 3-5 dari composite ranking + gap (pp).
5. **Recommended deltas** — HANYA rekomendasi BARU yang belum tercermin di current config/lessons. Format: `key: current → recommended (reason)`.
6. **Watch list** — apapun yang degrading vs last audit (variant/strategy/dimension yang flip negative).
7. **LLM telemetry** — total calls hari ini, token spend, fallback rate, error rate. Flag kalau fallback rate > 5% atau error rate > 2%.
8. **Gas + wallet economics** — total gas SOL hari ini, avg per action label, net wallet delta direction. Flag kalau gas/tx > 0.001 SOL atau net outflow tinggi.
9. **Decision log patterns** — type/actor breakdown, top 3 skip reasons, skip/deploy ratio. Flag kalau skip/deploy > 20 (terlalu aggresif) atau no_deploy tinggi.
10. **Portfolio trajectory** — 7d total_value_usd delta, sol_price change, current unrealized PnL. Flag kalau portfolio turun sementara journal pnl positif (IL bleeding).

**Rules:**
- Do NOT auto-apply any changes. Recommendations only.
- Be honest about sample sizes. Token_profile only added 2026-04-21 — flag kalau n thin.
- Kalau a previous report from today exists, mention it but don't skip — fresh data may have arrived.
- Target: summary tight, < 60 lines. Full data tersimpan di markdown + log files.
- Untuk section 7-10, kalau log file tidak ada hari ini (fresh restart / new deploy), kasih "skipped: no data" — bukan error.
