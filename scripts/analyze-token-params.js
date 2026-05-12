#!/usr/bin/env node
// Analyze every token_profile field on closed positions, bucket adaptively,
// compute fee-inclusive PnL stats, and synthesize a composite "ideal token
// profile" tied to current screening config keys.
//
// Usage: node scripts/analyze-token-params.js
//
// Output:
//   - Console: top-10 most predictive parameters
//   - File:    logs/token-param-analysis-YYYY-MM-DD.md

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const J = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

const MIN_N_PER_BUCKET = 10;
const MIN_GAP_PP = 1.0;          // ≥1pp gap best vs worst to declare directional
const MIN_BOTH_BUCKETS_N = 15;   // both ends need n≥15 before recommending

// ── Load + outlier exclude (same policy as analyze-full-data.js) ──────────
const journal = J("journal.json");
const SINCE_MS = process.env.AUDIT_SINCE ? Date.parse(process.env.AUDIT_SINCE) : null;
if (process.env.AUDIT_SINCE && Number.isNaN(SINCE_MS)) {
  console.error(`AUDIT_SINCE invalid: ${process.env.AUDIT_SINCE}`); process.exit(1);
}
const allClosesUnfiltered = (journal.entries || []).filter(e => e.type === "close");
const allCloses = SINCE_MS
  ? allClosesUnfiltered.filter(e => Date.parse(e.timestamp || e.duration?.closed_at || 0) >= SINCE_MS)
  : allClosesUnfiltered;
const config = J("user-config.json");

const expPubkeys = new Set();
try {
  const exp = J("experiments.json");
  for (const id of Object.keys(exp.experiments || {})) {
    const e = exp.experiments[id];
    if (e.active_position) expPubkeys.add(e.active_position);
    for (const it of (e.iterations || [])) if (it.position) expPubkeys.add(it.position);
  }
} catch (_) {}

const enriched = [];
const drop = { exp: 0, extreme: 0, dust: 0, instant: 0, missing: 0, no_profile: 0 };
for (const c of allCloses) {
  if (expPubkeys.has(c.position)) { drop.exp++; continue; }
  if (!Number.isFinite(c.pnl_pct) || !Number.isFinite(c.initial_value_usd)) { drop.missing++; continue; }
  if (Math.abs(c.pnl_pct) > 30) { drop.extreme++; continue; }
  if (c.initial_value_usd < 10) { drop.dust++; continue; }
  if (Number.isFinite(c.minutes_held) && c.minutes_held < 2) { drop.instant++; continue; }
  if (!c.token_profile || typeof c.token_profile !== "object") { drop.no_profile++; continue; }

  const fees = c.fees_earned_usd || 0;
  const feeIncl = c.pnl_pct + (fees / c.initial_value_usd) * 100;
  enriched.push({
    pool: c.pool_name,
    feeIncl,
    pnlPct: c.pnl_pct,
    minutes: c.minutes_held,
    profile: c.token_profile,
  });
}

// ── Field definitions ─────────────────────────────────────────────────────
const FIELDS = [
  { key: "mcap",                    type: "continuous", parse: v => Number(v) },
  { key: "holders",                 type: "continuous", parse: v => Number(v) },
  { key: "volume",                  type: "continuous", parse: v => Number(v) },
  { key: "tvl",                     type: "continuous", parse: v => Number(v) },
  { key: "swap_count",              type: "continuous", parse: v => Number(v) },
  { key: "unique_traders",          type: "continuous", parse: v => Number(v) },
  { key: "top_10_pct",              type: "continuous", parse: v => parseFloat(v) },
  { key: "bundlers_pct",            type: "continuous", parse: v => parseFloat(v) },
  { key: "global_fees_sol",         type: "continuous", parse: v => Number(v) },
  { key: "smart_wallet_count",      type: "continuous", parse: v => Number(v) },
  { key: "smart_wallet_confidence", type: "continuous", parse: v => Number(v) },
  { key: "momentum_1h",             type: "continuous", parse: v => parseFloat(v) },
  { key: "momentum_buyers_1h",      type: "continuous", parse: v => Number(v) },
  { key: "momentum_net_buyers_1h",  type: "continuous", parse: v => Number(v) },
  { key: "bot_holders_pct",         type: "continuous", parse: v => parseFloat(v) },
  { key: "okx_smart_money_buy",     type: "categorical", parse: v => v == null ? null : String(v) },
  { key: "okx_risk_level",          type: "categorical", parse: v => v == null ? null : String(v) },
  { key: "okx_bundle_pct",          type: "continuous", parse: v => parseFloat(v) },
  { key: "okx_sniper_pct",          type: "continuous", parse: v => parseFloat(v) },
  { key: "okx_lp_burned_pct",       type: "continuous", parse: v => parseFloat(v) },
  { key: "okx_price_vs_ath_pct",    type: "continuous", parse: v => parseFloat(v) },
  { key: "okx_price_change_1h",     type: "continuous", parse: v => parseFloat(v) },
];

const agg = (arr) => {
  if (!arr.length) return null;
  const pnl = arr.map(x => x.feeIncl).sort((a, b) => a - b);
  const sum = pnl.reduce((a, b) => a + b, 0);
  const mean = sum / pnl.length;
  const med = pnl.length % 2 ? pnl[(pnl.length - 1) / 2] : (pnl[pnl.length / 2 - 1] + pnl[pnl.length / 2]) / 2;
  const p5 = pnl[Math.floor(pnl.length * 0.05)];
  const p95 = pnl[Math.min(pnl.length - 1, Math.floor(pnl.length * 0.95))];
  const wins = arr.filter(x => x.feeIncl > 0).length;
  return { n: arr.length, win_rate: wins / arr.length * 100, avg: mean, median: med, p5, p95 };
};

const fmtRange = (lo, hi, isPct) => {
  const f = (v) => v == null ? "∞" : isPct ? v.toFixed(2) + "%" : (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2));
  return `[${f(lo)}, ${f(hi)})`;
};

const isPctField = (k) => /pct|momentum_1h|price_change|price_vs_ath/.test(k);

// Quintile bucketing for continuous; reports null bucket separately
const bucketContinuous = (closes, key, parse) => {
  const valid = [];
  let nullCount = 0;
  for (const c of closes) {
    const raw = c.profile[key];
    const v = parse(raw);
    if (v == null || !Number.isFinite(v)) { nullCount++; continue; }
    valid.push({ ...c, _v: v });
  }
  if (valid.length < MIN_N_PER_BUCKET * 2) return { groups: [], nullCount, total: closes.length, valid: valid.length };

  const sorted = [...valid].sort((a, b) => a._v - b._v);
  const N = sorted.length;
  const buckets = [];
  for (let q = 0; q < 5; q++) {
    const lo = sorted[Math.floor(N * q / 5)]._v;
    const hi = q < 4 ? sorted[Math.floor(N * (q + 1) / 5)]._v : null;
    const arr = q < 4
      ? sorted.filter(c => c._v >= lo && c._v < hi)
      : sorted.filter(c => c._v >= lo);
    if (arr.length < MIN_N_PER_BUCKET) continue;
    buckets.push({ key: fmtRange(lo, hi, isPctField(key)), lo, hi, ...agg(arr) });
  }
  return { groups: buckets, nullCount, total: closes.length, valid: valid.length };
};

const bucketCategorical = (closes, key, parse) => {
  const map = new Map();
  let nullCount = 0;
  for (const c of closes) {
    const v = parse(c.profile[key]);
    if (v == null) { nullCount++; continue; }
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(c);
  }
  const groups = [];
  for (const [k, arr] of map) {
    if (arr.length < MIN_N_PER_BUCKET) continue;
    groups.push({ key: k, ...agg(arr) });
  }
  return { groups, nullCount, total: closes.length, valid: closes.length - nullCount };
};

// ── Per-field analysis ────────────────────────────────────────────────────
const results = {};
for (const f of FIELDS) {
  results[f.key] = f.type === "continuous"
    ? bucketContinuous(enriched, f.key, f.parse)
    : bucketCategorical(enriched, f.key, f.parse);
}

// ── Composite ideal profile ───────────────────────────────────────────────
const composite = [];
for (const f of FIELDS) {
  const r = results[f.key];
  if (!r.groups.length) continue;
  const sortedByAvg = [...r.groups].sort((a, b) => b.avg - a.avg);
  const best = sortedByAvg[0];
  const worst = sortedByAvg[sortedByAvg.length - 1];
  const gap = best.avg - worst.avg;
  if (gap >= MIN_GAP_PP && best.n >= MIN_BOTH_BUCKETS_N && worst.n >= MIN_BOTH_BUCKETS_N) {
    composite.push({
      field: f.key,
      best, worst, gap,
      direction: best.lo !== undefined && worst.lo !== undefined
        ? (best.lo > worst.lo ? "higher_is_better" : "lower_is_better")
        : "categorical",
    });
  }
}
composite.sort((a, b) => b.gap - a.gap);

// ── Report ────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const out = [];
const w = (s = "") => out.push(s);

w(`# Token-Parameter Screening Analysis — ${today}`);
w("");
w("## Coverage");
w(`- Total closes: ${allCloses.length}`);
w(`- Dropped: exp=${drop.exp}, extreme=${drop.extreme}, dust=${drop.dust}, instant=${drop.instant}, missing=${drop.missing}, no_profile=${drop.no_profile}`);
w(`- Analyzed: **${enriched.length}**`);
w(`- Bucketing: quintiles (continuous) / distinct values (categorical), min n=${MIN_N_PER_BUCKET} per bucket`);
w(`- Composite gate: best-vs-worst gap ≥ ${MIN_GAP_PP}pp AND both ends n ≥ ${MIN_BOTH_BUCKETS_N}`);
w("");

w("## Composite ideal token profile (most predictive parameters)");
w("Sorted by best-vs-worst gap (largest first). Each row = one parameter where data");
w("supports a directional rule.");
w("");
if (!composite.length) {
  w("_No parameter passed the gate._");
} else {
  w("| Parameter | Best bucket | Best avg / win / n | Worst bucket | Worst avg / win / n | Gap (pp) | Direction |");
  w("|---|---|---|---|---|---|---|");
  for (const c of composite) {
    const fmtBucket = (g) => `\`${g.key}\` → avg ${g.avg.toFixed(2)}% / win ${g.win_rate.toFixed(1)}% / n=${g.n}`;
    w(`| **${c.field}** | \`${c.best.key}\` | avg **${c.best.avg.toFixed(2)}%** / win ${c.best.win_rate.toFixed(1)}% / n=${c.best.n} | \`${c.worst.key}\` | avg **${c.worst.avg.toFixed(2)}%** / win ${c.worst.win_rate.toFixed(1)}% / n=${c.worst.n} | ${c.gap.toFixed(2)} | ${c.direction} |`);
  }
}
w("");

// ── Current screening config recap ───────────────────────────────────────
w("## Current screening config (user-config.json)");
const cfgKeys = ["minTvl","maxTvl","minHolders","minVolume","minMcap","maxMcap","minOrganic","minBinStep","maxBinStep","minTokenFeesSol","minFeeActiveTvlRatio","minFeeTvl24h","postLossCooldownPct","postLossCooldownMin","maxEffectiveConfidence"];
w("| Key | Value |");
w("|---|---|");
for (const k of cfgKeys) {
  const v = config[k];
  if (v !== undefined) w(`| \`${k}\` | ${typeof v === "object" ? JSON.stringify(v) : v} |`);
}
w("");

// ── Per-field breakdown ──────────────────────────────────────────────────
w("## Per-field breakdown (full tables)");
for (const f of FIELDS) {
  const r = results[f.key];
  w("");
  w(`### \`${f.key}\` (${f.type})`);
  w(`Valid: ${r.valid} / ${r.total} (null: ${r.nullCount})`);
  if (!r.groups.length) {
    w(`_Insufficient data — needs ≥${MIN_N_PER_BUCKET} per bucket × 2 buckets_`);
    continue;
  }
  w("| Bucket | n | Win % | Avg fee-incl % | Median | P5 | P95 |");
  w("|---|---|---|---|---|---|---|");
  // sort by avg desc for readability
  const sorted = [...r.groups].sort((a, b) => b.avg - a.avg);
  for (const g of sorted) {
    w(`| \`${g.key}\` | ${g.n} | ${g.win_rate.toFixed(1)}% | ${g.avg.toFixed(2)}% | ${g.median.toFixed(2)}% | ${g.p5.toFixed(2)}% | ${g.p95.toFixed(2)}% |`);
  }
}

// ── Translate composite into actionable config deltas ─────────────────────
w("");
w("## Recommended screening filter deltas");
w("");
const deltas = [];
for (const c of composite) {
  const k = c.field;
  if (k === "top_10_pct") {
    deltas.push(`- **\`top_10_pct\` filter**: best ${c.best.key} (${c.best.avg.toFixed(2)}%) vs worst ${c.worst.key} (${c.worst.avg.toFixed(2)}%). Currently no hard filter — consider adding pre-screening drop for top_10_pct in the worst bucket.`);
  }
  if (k === "bundlers_pct" && c.direction === "lower_is_better") {
    deltas.push(`- **\`bundlers_pct\` filter**: best ${c.best.key} (${c.best.avg.toFixed(2)}%) vs worst ${c.worst.key}. Add pre-screening: drop bundlers_pct above worst-bucket lower bound.`);
  }
  if (k === "mcap") {
    const cur = `minMcap=${config.minMcap}, maxMcap=${config.maxMcap}`;
    deltas.push(`- **\`mcap\` filter** (current ${cur}): best ${c.best.key} → consider tightening to that range (\`minMcap\` / \`maxMcap\`).`);
  }
  if (k === "smart_wallet_count" && c.direction === "higher_is_better") {
    deltas.push(`- **\`smart_wallet_count\` preference**: best ${c.best.key} avg ${c.best.avg.toFixed(2)}%. Add screener prompt rule: PREFER pools with smart_wallet_count in top bucket.`);
  }
  if (k === "global_fees_sol" && c.direction === "higher_is_better") {
    deltas.push(`- **\`global_fees_sol\` floor**: best ${c.best.key} avg ${c.best.avg.toFixed(2)}%. Currently \`minTokenFeesSol=${config.minTokenFeesSol}\` — consider raising.`);
  }
  if (k === "momentum_1h") {
    deltas.push(`- **\`momentum_1h\` filter**: best ${c.best.key} (${c.best.avg.toFixed(2)}%) vs worst ${c.worst.key}. ${c.direction === "higher_is_better" ? "Filter for positive momentum" : "Avoid extreme momentum"}.`);
  }
  if (k === "bot_holders_pct" && c.direction === "lower_is_better") {
    deltas.push(`- **\`bot_holders_pct\` cap**: best ${c.best.key} avg ${c.best.avg.toFixed(2)}%. Drop pools above worst-bucket lower bound at pre-screening.`);
  }
  if (k === "holders") {
    deltas.push(`- **\`holders\` floor** (current minHolders=${config.minHolders}): best ${c.best.key}. Consider tightening floor.`);
  }
  if (k === "tvl") {
    deltas.push(`- **\`tvl\` band** (current minTvl=${config.minTvl}, maxTvl=${config.maxTvl}): best ${c.best.key} → narrow to that range.`);
  }
  if (k === "okx_price_vs_ath_pct") {
    deltas.push(`- **ATH proximity**: best ${c.best.key} → ${c.direction === "higher_is_better" ? "PREFER tokens near ATH" : "AVOID tokens near ATH"} (add screener prompt rule).`);
  }
}
if (deltas.length) {
  for (const d of deltas) w(d);
} else {
  w("_No high-confidence filter delta — composite gate too strict or signal noisy._");
}

// ── SL vs Profit comparison ──────────────────────────────────────────────
// Uses the full journal (not window-scoped) for maximum sample size.
// SL = total_pct ≤ -3 (genuine stop-loss events). Profit = total_pct > 0.
w("");
w("## Stop-Loss vs Profit: parameter comparison (full journal)");
w("Which parameters predict SL exits? Uses ALL closes with token_profile (no window filter).");
w("SL = fee-inclusive total_pct ≤ −3%. Profit = total_pct > 0.");
w("");

const journalAll = J("journal.json");
const allClosesForSL = (journalAll.entries || []).filter(e => e.type === "close" && e.token_profile);
const withTotalPct = allClosesForSL.map(e => {
  const initial = e.initial_value_usd || 0;
  const fees = e.fees_earned_usd || 0;
  const feePct = initial > 0 ? (fees / initial) * 100 : 0;
  const total = (e.pnl_pct || 0) + feePct;
  return { ...e, total_pct: total };
}).filter(e => Number.isFinite(e.total_pct));

const slCloses = withTotalPct.filter(e => e.total_pct <= -3);
const profitCloses = withTotalPct.filter(e => e.total_pct > 0);

w(`- Total closes with token_profile: ${withTotalPct.length}`);
w(`- SL (total_pct ≤ −3%): **${slCloses.length}**`);
w(`- Profit (total_pct > 0): **${profitCloses.length}**`);
w("");

const slMedian = (key) => {
  const vals = slCloses.map(e => e.token_profile[key]).filter(v => v != null && Number.isFinite(+v)).map(Number).sort((a, b) => a - b);
  if (!vals.length) return null;
  const m = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
};
const profMedian = (key) => {
  const vals = profitCloses.map(e => e.token_profile[key]).filter(v => v != null && Number.isFinite(+v)).map(Number).sort((a, b) => a - b);
  if (!vals.length) return null;
  const m = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
};

const SL_PARAMS = [
  "global_fees_sol", "momentum_buyers_1h", "momentum_net_buyers_1h",
  "bot_holders_pct", "okx_price_change_1h", "okx_lp_burned_pct",
  "mcap", "holders", "volume", "tvl", "top_10_pct",
  "smart_wallet_confidence", "okx_bundle_pct",
];

const slRows = SL_PARAMS.map(k => {
  const slN = slCloses.filter(e => e.token_profile[k] != null && Number.isFinite(+e.token_profile[k])).length;
  const profN = profitCloses.filter(e => e.token_profile[k] != null && Number.isFinite(+e.token_profile[k])).length;
  const sm = slMedian(k);
  const pm = profMedian(k);
  if (slN < 5 || profN < 5 || sm == null || pm == null) return null;
  return { key: k, slN, profN, slMedian: sm, profMedian: pm, delta: pm - sm };
}).filter(Boolean).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

w("### Median comparison (SL vs Profit)");
w("Sorted by absolute delta — larger delta = more predictive.");
w("");
w("| Parameter | SL n | SL median | Profit n | Profit median | Delta | Danger direction |");
w("|---|---|---|---|---|---|---|");
for (const r of slRows) {
  const direction = r.delta > 0
    ? "SL has lower value — higher is safer"
    : "SL has higher value — lower is safer";
  w(`| **${r.key}** | ${r.slN} | ${r.slMedian.toFixed(2)} | ${r.profN} | ${r.profMedian.toFixed(2)} | ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)} | ${direction} |`);
}

// Bucket loss-rate table for highest-impact params
w("");
w("### Bucket loss-rate table (key parameters)");
w("Loss rate = SL_n / (SL_n + Profit_n) per bucket. High loss rate = avoid this range.");
w("");

const SL_BUCKET_DEFS = [
  { key: "global_fees_sol",        buckets: [[0,30],[30,80],[80,200],[200,null]] },
  { key: "momentum_buyers_1h",     buckets: [[0,5],[5,15],[15,30],[30,null]] },
  { key: "momentum_net_buyers_1h", buckets: [[0,50],[50,200],[200,null]] },
  { key: "bot_holders_pct",        buckets: [[0,15],[15,25],[25,40],[40,null]] },
  { key: "okx_price_change_1h",    buckets: [[-100,-20],[-20,-5],[-5,0],[0,10],[10,null]] },
  { key: "okx_lp_burned_pct",      buckets: [[0,50],[50,90],[90,98],[98,null]] },
];

for (const def of SL_BUCKET_DEFS) {
  const hasSLData = slCloses.some(e => e.token_profile[def.key] != null);
  const hasProfData = profitCloses.some(e => e.token_profile[def.key] != null);
  if (!hasSLData && !hasProfData) continue;

  w(`**\`${def.key}\`**`);
  w("");
  w("| Bucket | SL | Profit | Loss Rate |");
  w("|---|---|---|---|");
  for (const [lo, hi] of def.buckets) {
    const inBucket = (e) => {
      const v = e.token_profile[def.key];
      if (v == null || !Number.isFinite(+v)) return false;
      const n = Number(v);
      return n >= lo && (hi == null || n < hi);
    };
    const sn = slCloses.filter(inBucket).length;
    const pn = profitCloses.filter(inBucket).length;
    const tot = sn + pn;
    const lossRate = tot > 0 ? (sn / tot * 100).toFixed(1) + "%" : "-";
    const label = hi == null ? `≥ ${lo}` : `${lo}–${hi}`;
    const flag = tot >= 10 && sn / tot >= 0.15 ? " ⚠️" : "";
    w(`| ${label} | ${sn} | ${pn} | ${lossRate}${flag} |`);
  }
  w("");
}

// ── Write ──────────────────────────────────────────────────────────────────
const reportPath = path.join(LOGS_DIR, `token-param-analysis-${today}.md`);
fs.writeFileSync(reportPath, out.join("\n"));

// Console
const summary = [];
summary.push(`Token-Parameter Analysis — ${today}`);
summary.push(`Coverage: ${enriched.length}/${allCloses.length} closes after outlier exclusion`);
summary.push(``);
summary.push(`Most predictive parameters (gap ≥ ${MIN_GAP_PP}pp, n ≥ ${MIN_BOTH_BUCKETS_N} per end):`);
if (composite.length) {
  composite.slice(0, 10).forEach((c, i) => {
    summary.push(`  ${i + 1}. ${c.field}: best=${c.best.key} (${c.best.avg.toFixed(2)}%, n=${c.best.n}) vs worst=${c.worst.key} (${c.worst.avg.toFixed(2)}%, n=${c.worst.n}) [gap=${c.gap.toFixed(2)}pp]`);
  });
} else {
  summary.push(`  (none passed gate)`);
}
summary.push(``);
summary.push(`Full report: ${reportPath}`);
console.log(summary.join("\n"));
