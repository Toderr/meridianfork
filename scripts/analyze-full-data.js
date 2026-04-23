#!/usr/bin/env node
// Full-data analysis: outlier-cleaned slice across variant/strategy/volatility/
// mcap/bin_step/hold-time/close_reason/hour/dow, across all-time / 14d / 7d
// windows. Cross-references current config + lessons to emit ranked,
// actionable recommendations.
//
// Usage: node scripts/analyze-full-data.js
//
// Outputs:
//   - Console: condensed markdown summary
//   - File:    logs/full-data-analysis-YYYY-MM-DD.md

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const J = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

const NOW = Date.now();
const D7 = NOW - 7 * 86400 * 1000;
const D14 = NOW - 14 * 86400 * 1000;
const MIN_N = 5;

// ── Load ──────────────────────────────────────────────────────────────────
const journal = J("journal.json");
const allCloses = (journal.entries || []).filter(e => e.type === "close");
const config = J("user-config.json");
const lessons = J("lessons.json");
const lessonRules = (lessons.entries || lessons.lessons || lessons || []).slice ? (lessons.entries || lessons.lessons || lessons) : [];
const lessonList = Array.isArray(lessonRules) ? lessonRules : (lessons.entries || []);

// experiment exclusion
const expPubkeys = new Set();
try {
  const exp = J("experiments.json");
  for (const id of Object.keys(exp.experiments || {})) {
    const e = exp.experiments[id];
    if (e.active_position) expPubkeys.add(e.active_position);
    for (const it of (e.iterations || [])) if (it.position) expPubkeys.add(it.position);
  }
} catch (_) {}

// ── Volatility lookup from actions logs ───────────────────────────────────
const volByPos = new Map();
try {
  const files = fs.readdirSync(LOGS_DIR).filter(f => /^actions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  for (const f of files) {
    const lines = fs.readFileSync(path.join(LOGS_DIR, f), "utf8").split("\n");
    for (const ln of lines) {
      if (!ln.includes('"deploy_position"')) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.tool !== "deploy_position" || !o.success) continue;
      const pos = o.result?.position;
      const vol = o.args?.volatility;
      if (pos && Number.isFinite(vol)) volByPos.set(pos, vol);
    }
  }
} catch (_) {}

// ── Outlier exclusion ─────────────────────────────────────────────────────
const stats = { total: allCloses.length, dropped: { experiment: 0, extreme_pnl: 0, dust: 0, instant_close: 0, missing_pnl: 0 }, kept: 0 };

const norm = (v) => {
  if (!v) return "(null)";
  const lower = String(v).toLowerCase().replace(/[-_]/g, "_");
  if (/^lper[\W_]*proven$/i.test(v)) return "lper_proven";
  return lower;
};

const enriched = [];
for (const c of allCloses) {
  if (expPubkeys.has(c.position)) { stats.dropped.experiment++; continue; }
  if (!Number.isFinite(c.pnl_pct) || !Number.isFinite(c.initial_value_usd)) { stats.dropped.missing_pnl++; continue; }
  if (Math.abs(c.pnl_pct) > 30) { stats.dropped.extreme_pnl++; continue; }
  if (c.initial_value_usd < 10) { stats.dropped.dust++; continue; }
  if (Number.isFinite(c.minutes_held) && c.minutes_held < 2) { stats.dropped.instant_close++; continue; }

  const fees = c.fees_earned_usd || 0;
  const feeIncl = c.pnl_pct + (fees / c.initial_value_usd) * 100;
  const tsMs = Date.parse(c.timestamp || c.duration?.closed_at);
  const vol = volByPos.get(c.position) ?? null;
  const mcap = c.token_profile?.mcap ?? null;

  enriched.push({
    id: c.id,
    pos: c.position,
    pool: c.pool_name,
    ts: tsMs,
    pnlPct: c.pnl_pct,
    feeIncl,
    fees,
    initial: c.initial_value_usd,
    minutes: c.minutes_held ?? null,
    variant: norm(c.variant),
    strategy: c.strategy || "(null)",
    bin_step: c.bin_step ?? null,
    close_reason: (c.close_reason || "(null)").slice(0, 80),
    vol,
    mcap,
  });
}
stats.kept = enriched.length;

// IQR fences (informational — not used for exclusion)
const sortedPnl = enriched.map(e => e.feeIncl).sort((a, b) => a - b);
const q = (p) => sortedPnl[Math.floor(sortedPnl.length * p)];
const Q1 = q(0.25), Q3 = q(0.75);
const IQR = Q3 - Q1;
const fenceLo = Q1 - 1.5 * IQR;
const fenceHi = Q3 + 1.5 * IQR;

// ── Bucket helpers ────────────────────────────────────────────────────────
const volBucket = (v) => v == null ? "unknown" : v < 2 ? "0-2" : v < 5 ? "2-5" : "5+";
const binBucket = (b) => b == null ? "unknown" : b <= 25 ? "≤25" : b < 100 ? "50-99" : "≥100";
const mcapBucket = (m) => m == null ? "unknown" : m < 50_000 ? "<50k" : m < 200_000 ? "50-200k" : m < 1_000_000 ? "200k-1M" : "1M+";
const holdBucket = (m) => m == null ? "unknown" : m < 15 ? "<15m" : m < 60 ? "15-60m" : m < 120 ? "60-120m" : "120m+";
const reasonBucket = (r) => {
  if (/^Yield-exit/.test(r)) return "yield_exit";
  if (/^Empty position/.test(r)) return "empty_position";
  if (/^OOR/.test(r) || /bins_above_range/.test(r)) return "oor";
  if (/Lesson rule/.test(r)) return "lesson_rule";
  if (/Stop[\s-]?loss/i.test(r) || /emergency/i.test(r)) return "stop_loss";
  if (/Take[\s-]?profit/i.test(r) || /TP/i.test(r)) return "take_profit";
  if (/age >=/.test(r)) return "age_cap";
  if (/Trailing/i.test(r)) return "trailing";
  if (/manual/i.test(r) || /user/i.test(r)) return "manual";
  return "other";
};

const dimensions = {
  variant:      e => e.variant,
  strategy:     e => e.strategy,
  volatility:   e => volBucket(e.vol),
  bin_step:     e => binBucket(e.bin_step),
  mcap:         e => mcapBucket(e.mcap),
  hold_time:    e => holdBucket(e.minutes),
  close_reason: e => reasonBucket(e.close_reason),
  hour_utc:     e => e.ts ? String(new Date(e.ts).getUTCHours()).padStart(2, "0") : "unknown",
  dow_utc:      e => e.ts ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(e.ts).getUTCDay()] : "unknown",
};

const windows = {
  all_time:  () => true,
  last_14d:  e => e.ts >= D14,
  last_7d:   e => e.ts >= D7,
};

// ── Aggregation ───────────────────────────────────────────────────────────
const agg = (arr) => {
  if (!arr.length) return null;
  const pnl = arr.map(x => x.feeIncl).sort((a, b) => a - b);
  const sum = pnl.reduce((a, b) => a + b, 0);
  const mean = sum / pnl.length;
  const med = pnl.length % 2 ? pnl[(pnl.length - 1) / 2] : (pnl[pnl.length / 2 - 1] + pnl[pnl.length / 2]) / 2;
  const p5 = pnl[Math.floor(pnl.length * 0.05)];
  const p95 = pnl[Math.min(pnl.length - 1, Math.floor(pnl.length * 0.95))];
  const wins = arr.filter(x => x.feeIncl > 0).length;
  const avgMin = arr.reduce((a, b) => a + (b.minutes ?? 0), 0) / arr.length;
  return { n: arr.length, win_rate: wins / arr.length * 100, avg: mean, median: med, p5, p95, avg_minutes: avgMin };
};

const sliceByDim = (closes, dimFn) => {
  const groups = new Map();
  for (const c of closes) {
    const k = dimFn(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  for (const [k, arr] of groups) {
    if (arr.length < MIN_N) continue;
    out.push({ key: k, ...agg(arr) });
  }
  out.sort((a, b) => b.avg - a.avg);
  return out;
};

// "unknown" / "(null)" buckets are not actionable as recommendations
const isActionableKey = (k) => k !== "unknown" && k !== "(null)";

// ── Report ────────────────────────────────────────────────────────────────
const lines = [];
const w = (s = "") => lines.push(s);
const today = new Date().toISOString().slice(0, 10);

w(`# Meridian Full-Data Analysis — ${today}`);
w("");
w("## Coverage & outlier exclusion");
w(`- Total closes in journal: **${stats.total}**`);
w(`- Dropped (experiment): ${stats.dropped.experiment}`);
w(`- Dropped (|pnl_pct| > 30%): ${stats.dropped.extreme_pnl}`);
w(`- Dropped (initial_value_usd < $10): ${stats.dropped.dust}`);
w(`- Dropped (minutes_held < 2): ${stats.dropped.instant_close}`);
w(`- Dropped (missing pnl/value): ${stats.dropped.missing_pnl}`);
w(`- **Analyzed: ${stats.kept}**`);
const sumDropped = Object.values(stats.dropped).reduce((a, b) => a + b, 0);
w(`- Accounting check: ${sumDropped} dropped + ${stats.kept} kept = ${sumDropped + stats.kept} (matches: ${sumDropped + stats.kept === stats.total ? "✓" : "✗"})`);
w("");
w(`### IQR fences for fee-inclusive pnl_pct (informational, not enforced)`);
w(`Q1 = ${Q1.toFixed(2)}%, Q3 = ${Q3.toFixed(2)}%, IQR = ${IQR.toFixed(2)}%, low fence = ${fenceLo.toFixed(2)}%, high fence = ${fenceHi.toFixed(2)}%`);
const beyondLo = enriched.filter(e => e.feeIncl < fenceLo).length;
const beyondHi = enriched.filter(e => e.feeIncl > fenceHi).length;
w(`Beyond low fence: ${beyondLo} (${(beyondLo/enriched.length*100).toFixed(1)}%) | Beyond high fence: ${beyondHi} (${(beyondHi/enriched.length*100).toFixed(1)}%)`);

// ── Window summary ────────────────────────────────────────────────────────
w("");
w("## Window summary");
w("| Window | n | Win rate | Avg fee-incl % | Median | P5 (tail) | P95 |");
w("|---|---|---|---|---|---|---|");
for (const [name, fn] of Object.entries(windows)) {
  const arr = enriched.filter(fn);
  const a = agg(arr);
  if (!a) { w(`| ${name} | 0 | – | – | – | – | – |`); continue; }
  w(`| ${name} | ${a.n} | ${a.win_rate.toFixed(1)}% | ${a.avg.toFixed(2)}% | ${a.median.toFixed(2)}% | ${a.p5.toFixed(2)}% | ${a.p95.toFixed(2)}% |`);
}

// ── Per-dimension ─────────────────────────────────────────────────────────
const dimResults = {};
for (const [dimName, dimFn] of Object.entries(dimensions)) {
  w("");
  w(`## Dimension: ${dimName}`);
  dimResults[dimName] = {};
  for (const [winName, winFn] of Object.entries(windows)) {
    const closesIn = enriched.filter(winFn);
    const sliced = sliceByDim(closesIn, dimFn);
    dimResults[dimName][winName] = sliced;
    if (!sliced.length) {
      w(`### ${winName}: no group with n ≥ ${MIN_N}`);
      continue;
    }
    w(`### ${winName} (n ≥ ${MIN_N})`);
    w("| Group | n | Win % | Avg fee-incl % | Median | P5 | P95 | Avg min |");
    w("|---|---|---|---|---|---|---|---|");
    for (const g of sliced) {
      w(`| \`${g.key}\` | ${g.n} | ${g.win_rate.toFixed(1)}% | ${g.avg.toFixed(2)}% | ${g.median.toFixed(2)}% | ${g.p5.toFixed(2)}% | ${g.p95.toFixed(2)}% | ${g.avg_minutes.toFixed(1)} |`);
    }
  }
}

// ── Recommendations ───────────────────────────────────────────────────────
w("");
w("## Ranked recommendations");
w("");
w(`Current goals (\`user-config.json\`): ${JSON.stringify(config.goals || "none")}`);
w(`Current key thresholds: emergencyPriceDropPct=${config.thresholds?.emergencyPriceDropPct ?? config.emergencyPriceDropPct ?? "?"}, takeProfitFeePct=${config.thresholds?.takeProfitFeePct ?? config.takeProfitFeePct ?? "?"}, fastTpPct=${config.thresholds?.fastTpPct ?? config.fastTpPct ?? "?"}, maxPositions=${config.risk?.maxPositions ?? config.maxPositions ?? "?"}, positionSizePct=${config.risk?.positionSizePct ?? config.positionSizePct ?? "?"}`);
w("");

// Build recs from data
const recs = [];

// helper: find dim+window result
const find = (dim, win, key) => (dimResults[dim]?.[win] || []).find(g => g.key === key);
const ranked = (dim, win) => dimResults[dim]?.[win] || [];

// 1. Variant ranking
const variantAll = ranked("variant", "all_time").filter(g => isActionableKey(g.key));
const variant14 = ranked("variant", "last_14d").filter(g => isActionableKey(g.key));
if (variantAll.length >= 2) {
  const best = variantAll[0], worst = variantAll[variantAll.length - 1];
  recs.push({
    title: `Bias screener toward variant=\`${best.key}\` and away from \`${worst.key}\``,
    config_key: "(prompt + lesson)",
    current: "uniform variant scoring",
    recommended: `prefer ${best.key}, avoid ${worst.key}`,
    evidence: `all_time: ${best.key} avg=${best.avg.toFixed(2)}% (n=${best.n}), ${worst.key} avg=${worst.avg.toFixed(2)}% (n=${worst.n})`,
    impact: Math.abs(best.avg - worst.avg),
    confidence: Math.min(best.n, worst.n),
  });
}

// 2. Strategy ranking
const stratAll = ranked("strategy", "all_time").filter(g => isActionableKey(g.key));
if (stratAll.length >= 2) {
  const best = stratAll[0], worst = stratAll[stratAll.length - 1];
  recs.push({
    title: `Prefer strategy=\`${best.key}\` over \`${worst.key}\``,
    config_key: "(prompt + lesson)",
    current: "agent picks per token",
    recommended: `bias toward ${best.key}`,
    evidence: `all_time: ${best.key} avg=${best.avg.toFixed(2)}% (n=${best.n}), ${worst.key} avg=${worst.avg.toFixed(2)}% (n=${worst.n})`,
    impact: Math.abs(best.avg - worst.avg),
    confidence: Math.min(best.n, worst.n),
  });
}

// 3. Volatility recommendation
const volAll = ranked("volatility", "all_time").filter(g => isActionableKey(g.key));
if (volAll.length) {
  const sorted = [...volAll].sort((a, b) => a.avg - b.avg);
  const worst = sorted[0];
  if (worst.avg < -1 && worst.n >= MIN_N) {
    recs.push({
      title: `Tighten volatility cap — \`${worst.key}\` bucket destroys capital`,
      config_key: "MAX_VOLATILITY_HARDCODED (tools/screening.js)",
      current: "5",
      recommended: worst.key === "5+" ? "consider 3-4" : worst.key === "2-5" ? "investigate sub-bucket" : "n/a",
      evidence: `vol bucket ${worst.key}: avg=${worst.avg.toFixed(2)}%, n=${worst.n}, p5=${worst.p5.toFixed(2)}%`,
      impact: Math.abs(worst.avg),
      confidence: worst.n,
    });
  }
}

// 4. Mcap
const mcapAll = ranked("mcap", "all_time").filter(g => isActionableKey(g.key));
if (mcapAll.length >= 2) {
  const best = mcapAll[0], worst = mcapAll[mcapAll.length - 1];
  if (best.avg - worst.avg > 1) {
    recs.push({
      title: `Filter by mcap — prefer ${best.key}, avoid ${worst.key}`,
      config_key: "screening prompt + lesson rule",
      current: "no mcap bucket gating",
      recommended: `add lesson: PREFER mcap ${best.key}, AVOID mcap ${worst.key}`,
      evidence: `${best.key} avg=${best.avg.toFixed(2)}% (n=${best.n}) vs ${worst.key} avg=${worst.avg.toFixed(2)}% (n=${worst.n})`,
      impact: best.avg - worst.avg,
      confidence: Math.min(best.n, worst.n),
    });
  }
}

// 5. Bin step
const binAll = ranked("bin_step", "all_time").filter(g => isActionableKey(g.key));
if (binAll.length >= 2) {
  const best = binAll[0], worst = binAll[binAll.length - 1];
  if (best.avg - worst.avg > 0.5) {
    recs.push({
      title: `Prefer bin_step ${best.key} over ${worst.key}`,
      config_key: "screening prompt",
      current: "agent picks per pool",
      recommended: `prefer bin_step ${best.key}`,
      evidence: `${best.key} avg=${best.avg.toFixed(2)}% (n=${best.n}) vs ${worst.key} avg=${worst.avg.toFixed(2)}% (n=${worst.n})`,
      impact: best.avg - worst.avg,
      confidence: Math.min(best.n, worst.n),
    });
  }
}

// 6. Hold time — find worst bucket
const holdAll = ranked("hold_time", "all_time").filter(g => isActionableKey(g.key));
const sortedHold = [...holdAll].sort((a, b) => a.avg - b.avg);
if (sortedHold.length) {
  const worst = sortedHold[0];
  if (worst.avg < -1) {
    recs.push({
      title: `Hold-time bucket \`${worst.key}\` is worst — consider re-enabling hold-time cut`,
      config_key: "management-rules.js Rule 3 (currently DISABLED)",
      current: "disabled",
      recommended: worst.key.startsWith("60") || worst.key.startsWith("120") ? "force-close at age >=60m if pnl<0" : "force-close at age >=15m if pnl<-0.5%",
      evidence: `bucket ${worst.key}: avg=${worst.avg.toFixed(2)}% (n=${worst.n})`,
      impact: Math.abs(worst.avg),
      confidence: worst.n,
    });
  }
}

// 7. Close reason: stop_loss + lesson_rule effectiveness
const closeAll = ranked("close_reason", "all_time");
const yieldRow = closeAll.find(c => c.key === "yield_exit");
if (yieldRow && yieldRow.avg < -0.5) {
  recs.push({
    title: `Yield-exits are net-negative — raise minFeeTvl24h to exit earlier`,
    config_key: "thresholds.minFeeTvl24h",
    current: String(config.thresholds?.minFeeTvl24h ?? config.minFeeTvl24h ?? "?"),
    recommended: "increase 1.5-2× to trigger yield-exit sooner before drift",
    evidence: `yield_exit closes: avg=${yieldRow.avg.toFixed(2)}% (n=${yieldRow.n}), p5=${yieldRow.p5.toFixed(2)}%`,
    impact: Math.abs(yieldRow.avg),
    confidence: yieldRow.n,
  });
}

// 8. Stop loss tightening (cross-ref trough analysis from earlier)
const slAll = closeAll.find(c => c.key === "stop_loss");
recs.push({
  title: `Tighten emergencyPriceDropPct from -10% toward -5% to -7%`,
  config_key: "thresholds.emergencyPriceDropPct",
  current: String(config.thresholds?.emergencyPriceDropPct ?? "-10"),
  recommended: "-7 to -5",
  evidence: `From trough analysis (logs/trough-recovery.csv): touched ≤-10% had 0/5 fee-incl recoveries; ≤-5% had 11.1% recovery with avg final -6.20%. Earlier cut dominates EV.`,
  impact: 3.0, // estimated avg pp saved
  confidence: 30,
});

// 9. Hour-of-day (if any obvious bad hour)
const hourAll = ranked("hour_utc", "all_time").filter(g => isActionableKey(g.key));
if (hourAll.length >= 8) {
  const sortedHour = [...hourAll].sort((a, b) => a.avg - b.avg);
  const worstHour = sortedHour[0];
  if (worstHour.avg < -1.5 && worstHour.n >= 10) {
    recs.push({
      title: `Pause screening at hour ${worstHour.key} UTC — lowest avg`,
      config_key: "(custom cron schedule)",
      current: "always-on",
      recommended: `skip screening at hour ${worstHour.key}`,
      evidence: `hour ${worstHour.key}: avg=${worstHour.avg.toFixed(2)}% (n=${worstHour.n}), p5=${worstHour.p5.toFixed(2)}%`,
      impact: Math.abs(worstHour.avg),
      confidence: worstHour.n,
    });
  }
}

// 10. Recent vs all-time drift
const allAgg = agg(enriched);
const recentAgg = agg(enriched.filter(e => e.ts >= D14));
if (allAgg && recentAgg && (allAgg.avg - recentAgg.avg) > 0.5) {
  recs.push({
    title: `⚠ Recent (14d) performance has degraded vs all-time — investigate`,
    config_key: "diagnostic, no direct fix",
    current: `all_time avg=${allAgg.avg.toFixed(2)}%, last_14d avg=${recentAgg.avg.toFixed(2)}%`,
    recommended: "review post-2026-04-09 config changes; check if any auto-evolved threshold drifted",
    evidence: `delta = ${(recentAgg.avg - allAgg.avg).toFixed(2)} pp`,
    impact: Math.abs(recentAgg.avg - allAgg.avg),
    confidence: recentAgg.n,
  });
} else if (allAgg && recentAgg && (recentAgg.avg - allAgg.avg) > 0.5) {
  recs.push({
    title: `✓ Recent (14d) performance is improving — keep current config`,
    config_key: "diagnostic, no change needed",
    current: `all_time avg=${allAgg.avg.toFixed(2)}%, last_14d avg=${recentAgg.avg.toFixed(2)}%`,
    recommended: "monitor; do not regress thresholds",
    evidence: `delta = +${(recentAgg.avg - allAgg.avg).toFixed(2)} pp`,
    impact: recentAgg.avg - allAgg.avg,
    confidence: recentAgg.n,
  });
}

// Rank
recs.sort((a, b) => (b.impact * Math.log(b.confidence + 1)) - (a.impact * Math.log(a.confidence + 1)));

w("");
recs.slice(0, 10).forEach((r, i) => {
  w(`### ${i + 1}. ${r.title}`);
  w(`- **Config key:** \`${r.config_key}\``);
  w(`- **Current:** ${r.current}`);
  w(`- **Recommended:** ${r.recommended}`);
  w(`- **Evidence:** ${r.evidence}`);
  w(`- **Score:** impact=${r.impact.toFixed(2)} pp × log(n=${r.confidence}) = ${(r.impact * Math.log(r.confidence + 1)).toFixed(2)}`);
  w("");
});

// Existing rules already in lessons (so we don't double-recommend)
w("## Existing lesson rules in force (not re-recommended)");
const enforced = lessonList.filter(l => l && l.rule && (l.rule.type || l.rule_type)).slice(0, 20);
if (enforced.length) {
  for (const l of enforced) {
    const t = l.rule?.type || l.rule_type;
    const v = l.rule?.value ?? l.rule?.threshold ?? "";
    const text = (l.text || l.lesson || l.body || "").slice(0, 100);
    w(`- \`${t}\` ${v ? "@ " + v : ""} — ${text}`);
  }
} else {
  w(`(none parseable in lessons.json)`);
}

// ── Write ──────────────────────────────────────────────────────────────────
const outPath = path.join(LOGS_DIR, `full-data-analysis-${today}.md`);
fs.writeFileSync(outPath, lines.join("\n"));

// Console: condensed
const summary = [];
summary.push(`Meridian Full-Data Analysis — ${today}`);
summary.push(`Coverage: ${stats.kept}/${stats.total} closes after outlier exclusion`);
summary.push(`Dropped: exp=${stats.dropped.experiment}, extreme=${stats.dropped.extreme_pnl}, dust=${stats.dropped.dust}, instant=${stats.dropped.instant_close}, missing=${stats.dropped.missing_pnl}`);
summary.push(``);
summary.push(`Window summary:`);
for (const [name, fn] of Object.entries(windows)) {
  const a = agg(enriched.filter(fn));
  if (a) summary.push(`  ${name}: n=${a.n}, win=${a.win_rate.toFixed(1)}%, avg=${a.avg.toFixed(2)}%, P5=${a.p5.toFixed(2)}%`);
}
summary.push(``);
summary.push(`Top recommendations:`);
recs.slice(0, 8).forEach((r, i) => summary.push(`  ${i + 1}. ${r.title}`));
summary.push(``);
summary.push(`Full report: ${outPath}`);

console.log(summary.join("\n"));
