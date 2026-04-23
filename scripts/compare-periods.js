#!/usr/bin/env node
// Compare two trading periods side-by-side: headline metrics, per-dimension
// performance deltas, composition shift, environment timeline (git/lessons),
// and market regime (SOL price + activity + fee productivity).
//
// Usage:
//   node scripts/compare-periods.js
//   node scripts/compare-periods.js --a=2026-03-28..2026-04-07 --b=2026-04-08..2026-04-23
//
// Defaults: A=2026-03-28..2026-04-07, B=2026-04-08..(today).

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");

// ── CLI ───────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const argMap = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.+)$/); return m ? [m[1], m[2]] : [a, true];
}));
const parseRange = (s, fallback) => {
  if (!s) return fallback;
  const [from, to] = s.split("..");
  return { from: Date.parse(from + "T00:00:00Z"), to: Date.parse(to + "T23:59:59Z"), label: `${from}..${to}` };
};
const A = parseRange(argMap.a, { from: Date.parse("2026-03-28T00:00:00Z"), to: Date.parse("2026-04-07T23:59:59Z"), label: "2026-03-28..2026-04-07" });
const B = parseRange(argMap.b, { from: Date.parse("2026-04-08T00:00:00Z"), to: Date.parse(today + "T23:59:59Z"), label: `2026-04-08..${today}` });
const A_DAYS = (A.to - A.from) / 86400e3;
const B_DAYS = (B.to - B.from) / 86400e3;

// ── Load + outlier filter ─────────────────────────────────────────────────
const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "journal.json"), "utf8"));
const allCloses = (journal.entries || []).filter(e => e.type === "close");
const allDeploys = (journal.entries || []).filter(e => e.type === "deploy" || e.type === "open");

const expPubkeys = new Set();
try {
  const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
  for (const id of Object.keys(exp.experiments || {})) {
    const e = exp.experiments[id];
    if (e.active_position) expPubkeys.add(e.active_position);
    for (const it of (e.iterations || [])) if (it.position) expPubkeys.add(it.position);
  }
} catch (_) {}

const norm = v => v ? String(v).toLowerCase().replace(/[-_]/g, "_") : "(null)";
const closeReason = r => {
  if (!r) return "(null)";
  if (/^Yield-exit/.test(r)) return "yield_exit";
  if (/^Empty position/.test(r)) return "empty_position";
  if (/^OOR/.test(r) || /bins_above_range/.test(r)) return "oor";
  if (/Lesson rule/.test(r)) return "lesson_rule";
  if (/Stop[\s-]?loss/i.test(r) || /emergency/i.test(r)) return "stop_loss";
  if (/Take[\s-]?profit/i.test(r) || /TP/i.test(r) || /take_profit/.test(r)) return "take_profit";
  if (/^Hard hold cap/i.test(r)) return "hard_hold_cap";
  if (/^Hold-time cut/i.test(r)) return "hold_time_cut";
  if (/^Capital-recycle/i.test(r)) return "capital_recycle";
  if (/^agent decision$/i.test(r)) return "agent_decision";
  if (/age >=/.test(r)) return "age_cap";
  if (/Trailing/i.test(r)) return "trailing";
  if (/manual|user/i.test(r)) return "manual";
  return "other";
};

const enrich = c => {
  const ts = Date.parse(c.timestamp || c.duration?.closed_at);
  const fees = c.fees_earned_usd || 0;
  const init = c.initial_value_usd;
  const feeIncl = init > 0 ? c.pnl_pct + (fees / init) * 100 : c.pnl_pct;
  const feePerMin = init > 0 && c.minutes_held > 0 ? (fees / init) * 100 / c.minutes_held : null;
  return {
    ts, init, fees, feeIncl,
    pnlUsd: c.pnl_usd, pnlPct: c.pnl_pct, solPrice: c.sol_price,
    minutes: c.minutes_held, feePerMinPct: feePerMin,
    variant: norm(c.variant), strategy: c.strategy || "(null)",
    binStep: c.bin_step ?? null, reason: closeReason(c.close_reason),
    timeInRange: c.duration?.time_in_range_pct ?? c.range_efficiency ?? null,
  };
};

const dropStats = { exp: 0, extreme: 0, dust: 0, instant: 0, missing: 0 };
const filtered = allCloses.filter(c => {
  if (expPubkeys.has(c.position)) { dropStats.exp++; return false; }
  if (!Number.isFinite(c.pnl_pct) || !Number.isFinite(c.initial_value_usd)) { dropStats.missing++; return false; }
  if (Math.abs(c.pnl_pct) > 30) { dropStats.extreme++; return false; }
  if (c.initial_value_usd < 10) { dropStats.dust++; return false; }
  if (Number.isFinite(c.minutes_held) && c.minutes_held < 2) { dropStats.instant++; return false; }
  return true;
}).map(enrich);

const inWindow = (e, w) => Number.isFinite(e.ts) && e.ts >= w.from && e.ts <= w.to;
const aSet = filtered.filter(e => inWindow(e, A));
const bSet = filtered.filter(e => inWindow(e, B));

// ── Stats helpers ─────────────────────────────────────────────────────────
const pct = (a, b) => b ? (a / b * 100) : 0;
const mean = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
const median = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quant = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const std = arr => {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
};
const maxDrawdown = arr => {
  if (arr.length < 2) return null;
  let peak = arr[0], maxDD = 0;
  for (const v of arr) { if (v > peak) peak = v; const dd = (peak - v) / peak * 100; if (dd > maxDD) maxDD = dd; }
  return maxDD;
};

const summarize = (closes, days) => {
  if (!closes.length) return null;
  const pnl = closes.map(c => c.feeIncl);
  const wins = closes.filter(c => c.feeIncl > 0).length;
  const totalUsd = closes.reduce((s, c) => s + (c.pnlUsd || 0) + (c.fees || 0), 0);
  return {
    n: closes.length,
    win_rate: wins / closes.length * 100,
    avg: mean(pnl), median: median(pnl), p5: quant(pnl, 0.05), p95: quant(pnl, 0.95),
    total_usd: totalUsd,
    avg_minutes: mean(closes.map(c => c.minutes).filter(Number.isFinite)),
    closes_per_day: closes.length / days,
    realized_per_day: totalUsd / days,
  };
};

// ── Per-dimension delta ───────────────────────────────────────────────────
const dimensions = {
  variant:      c => c.variant,
  strategy:     c => c.strategy,
  bin_step:     c => c.binStep == null ? "unknown" : c.binStep <= 25 ? "≤25" : c.binStep < 100 ? "50-99" : "≥100",
  hold_time:    c => c.minutes == null ? "unknown" : c.minutes < 15 ? "<15m" : c.minutes < 60 ? "15-60m" : c.minutes < 120 ? "60-120m" : "120m+",
  close_reason: c => c.reason,
  hour_utc:     c => Number.isFinite(c.ts) ? String(new Date(c.ts).getUTCHours()).padStart(2, "0") : "unknown",
  dow_utc:      c => Number.isFinite(c.ts) ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(c.ts).getUTCDay()] : "unknown",
};

const aggArr = arr => arr.length ? { n: arr.length, avg: mean(arr.map(x => x.feeIncl)), win: arr.filter(x => x.feeIncl > 0).length / arr.length * 100 } : null;

const dimensionDelta = (aArr, bArr, dimFn) => {
  const aGroups = new Map(), bGroups = new Map();
  for (const c of aArr) { const k = dimFn(c); if (!aGroups.has(k)) aGroups.set(k, []); aGroups.get(k).push(c); }
  for (const c of bArr) { const k = dimFn(c); if (!bGroups.has(k)) bGroups.set(k, []); bGroups.get(k).push(c); }
  const keys = new Set([...aGroups.keys(), ...bGroups.keys()]);
  const rows = [];
  for (const k of keys) {
    if (k === "unknown" || k === "(null)") continue;
    const a = aggArr(aGroups.get(k) || []);
    const b = aggArr(bGroups.get(k) || []);
    if (!a || !b) continue;
    if (a.n < 5 || b.n < 5) continue;
    const delta = a.avg - b.avg;
    const minN = Math.min(a.n, b.n);
    rows.push({ key: k, a, b, delta, score: Math.abs(delta) * Math.log(minN + 1) });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
};

const compositionShift = (aArr, bArr, dimFn) => {
  const aGroups = new Map(), bGroups = new Map();
  for (const c of aArr) { const k = dimFn(c); aGroups.set(k, (aGroups.get(k) || 0) + 1); }
  for (const c of bArr) { const k = dimFn(c); bGroups.set(k, (bGroups.get(k) || 0) + 1); }
  const keys = new Set([...aGroups.keys(), ...bGroups.keys()]);
  const rows = [];
  for (const k of keys) {
    if (k === "unknown" || k === "(null)") continue;
    const aPct = pct(aGroups.get(k) || 0, aArr.length);
    const bPct = pct(bGroups.get(k) || 0, bArr.length);
    if (aPct < 1 && bPct < 1) continue;
    rows.push({ key: k, aPct, bPct, delta: bPct - aPct });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return rows;
};

// ── Market regime ─────────────────────────────────────────────────────────
const marketRegime = (closes, days, label) => {
  const sols = closes.map(c => c.solPrice).filter(Number.isFinite).sort((a, b) => closes.find(c => c.solPrice === a)?.ts - closes.find(c => c.solPrice === b)?.ts);
  // Build chronological SOL price series
  const series = closes.filter(c => Number.isFinite(c.solPrice) && Number.isFinite(c.ts))
    .sort((a, b) => a.ts - b.ts).map(c => c.solPrice);
  const ret = series.length >= 2 ? (series[series.length - 1] - series[0]) / series[0] * 100 : null;
  const fpm = closes.map(c => c.feePerMinPct).filter(Number.isFinite);
  const tir = closes.map(c => c.timeInRange).filter(Number.isFinite);
  return {
    label,
    days,
    closes_per_day: closes.length / days,
    sol_avg: mean(series), sol_std: std(series),
    sol_min: series.length ? Math.min(...series) : null, sol_max: series.length ? Math.max(...series) : null,
    sol_period_return_pct: ret,
    sol_max_drawdown_pct: maxDrawdown(series),
    avg_fee_yield_per_min_pct: mean(fpm),
    avg_time_in_range_pct: mean(tir),
    avg_initial_usd: mean(closes.map(c => c.init).filter(Number.isFinite)),
  };
};

// ── Environment timeline ──────────────────────────────────────────────────
const gitLog = (since, until) => {
  try {
    const out = execSync(`git -C "${ROOT}" log --since="${since}" --until="${until}" --pretty=format:"%h|%ai|%s" --no-merges`, { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
};
const commitsBoundary = gitLog("2026-04-06T00:00:00Z", "2026-04-09T23:59:59Z");
const commitsA = gitLog(new Date(A.from).toISOString(), new Date(A.to).toISOString());
const commitsB = gitLog(new Date(B.from).toISOString(), new Date(B.to).toISOString());

let lessonsList = [];
try {
  const l = JSON.parse(fs.readFileSync(path.join(ROOT, "lessons.json"), "utf8"));
  lessonsList = (l.lessons || []).filter(x => x && x.created_at);
} catch (_) {}
const lessonsInWindow = w => lessonsList.filter(x => {
  const t = Date.parse(x.created_at);
  return Number.isFinite(t) && t >= w.from && t <= w.to;
});
const lessonsA = lessonsInWindow(A);
const lessonsB = lessonsInWindow(B);

// ── Synthesize report ─────────────────────────────────────────────────────
const out = [];
const w = (s = "") => out.push(s);
const aSum = summarize(aSet, A_DAYS);
const bSum = summarize(bSet, B_DAYS);
const aMkt = marketRegime(aSet, A_DAYS, "A");
const bMkt = marketRegime(bSet, B_DAYS, "B");

w(`# Period Comparison — ${today}`);
w("");
w(`- **Period A:** ${A.label} (${A_DAYS.toFixed(1)} days)`);
w(`- **Period B:** ${B.label} (${B_DAYS.toFixed(1)} days)`);
w(`- **Outlier policy:** drop experiments, |pnl_pct|>30, init<$10, hold<2m, missing pnl`);
w(`- Drop counts: exp=${dropStats.exp}, extreme=${dropStats.extreme}, dust=${dropStats.dust}, instant=${dropStats.instant}, missing=${dropStats.missing}`);
w("");

w("## Headline (premise check)");
w("| Metric | Period A | Period B | Δ (A − B) |");
w("|---|---|---|---|");
if (aSum && bSum) {
  const dm = (a, b, sfx = "") => `${(a - b).toFixed(2)}${sfx}`;
  w(`| n closes | ${aSum.n} | ${bSum.n} | ${aSum.n - bSum.n} |`);
  w(`| Win rate | ${aSum.win_rate.toFixed(1)}% | ${bSum.win_rate.toFixed(1)}% | ${dm(aSum.win_rate, bSum.win_rate, "pp")} |`);
  w(`| Avg fee-incl % | ${aSum.avg.toFixed(2)}% | ${bSum.avg.toFixed(2)}% | ${dm(aSum.avg, bSum.avg, "pp")} |`);
  w(`| Median fee-incl % | ${aSum.median.toFixed(2)}% | ${bSum.median.toFixed(2)}% | ${dm(aSum.median, bSum.median, "pp")} |`);
  w(`| P5 (tail) | ${aSum.p5.toFixed(2)}% | ${bSum.p5.toFixed(2)}% | ${dm(aSum.p5, bSum.p5, "pp")} |`);
  w(`| P95 | ${aSum.p95.toFixed(2)}% | ${bSum.p95.toFixed(2)}% | ${dm(aSum.p95, bSum.p95, "pp")} |`);
  w(`| Total realized $ (incl fees) | $${aSum.total_usd.toFixed(2)} | $${bSum.total_usd.toFixed(2)} | $${(aSum.total_usd - bSum.total_usd).toFixed(2)} |`);
  w(`| Avg minutes held | ${aSum.avg_minutes.toFixed(1)} | ${bSum.avg_minutes.toFixed(1)} | ${(aSum.avg_minutes - bSum.avg_minutes).toFixed(1)} |`);
  w(`| Closes / day | ${aSum.closes_per_day.toFixed(1)} | ${bSum.closes_per_day.toFixed(1)} | ${(aSum.closes_per_day - bSum.closes_per_day).toFixed(1)} |`);
  w(`| Realized $ / day | $${aSum.realized_per_day.toFixed(2)} | $${bSum.realized_per_day.toFixed(2)} | $${(aSum.realized_per_day - bSum.realized_per_day).toFixed(2)} |`);
}
w("");

w("## Market regime (SOL price + activity + productivity)");
w("| Metric | Period A | Period B |");
w("|---|---|---|");
const f = (v, suf = "") => v == null ? "–" : v.toFixed(2) + suf;
w(`| SOL avg | $${f(aMkt.sol_avg)} | $${f(bMkt.sol_avg)} |`);
w(`| SOL min..max | $${f(aMkt.sol_min)}..$${f(aMkt.sol_max)} | $${f(bMkt.sol_min)}..$${f(bMkt.sol_max)} |`);
w(`| SOL std | $${f(aMkt.sol_std)} | $${f(bMkt.sol_std)} |`);
w(`| SOL period return | ${f(aMkt.sol_period_return_pct, "%")} | ${f(bMkt.sol_period_return_pct, "%")} |`);
w(`| SOL max drawdown | ${f(aMkt.sol_max_drawdown_pct, "%")} | ${f(bMkt.sol_max_drawdown_pct, "%")} |`);
w(`| Avg fee yield / min | ${f(aMkt.avg_fee_yield_per_min_pct, "%/min")} | ${f(bMkt.avg_fee_yield_per_min_pct, "%/min")} |`);
w(`| Avg time-in-range | ${f(aMkt.avg_time_in_range_pct, "%")} | ${f(bMkt.avg_time_in_range_pct, "%")} |`);
w(`| Avg initial value USD | $${f(aMkt.avg_initial_usd)} | $${f(bMkt.avg_initial_usd)} |`);
w("");

w("## Per-dimension performance delta (sorted by |Δ avg| × log(min n))");
for (const [dim, fn] of Object.entries(dimensions)) {
  const rows = dimensionDelta(aSet, bSet, fn);
  if (!rows.length) continue;
  w("");
  w(`### \`${dim}\``);
  w("| Group | A: n / win / avg | B: n / win / avg | Δ avg (pp) |");
  w("|---|---|---|---|");
  for (const r of rows.slice(0, 10)) {
    w(`| \`${r.key}\` | ${r.a.n} / ${r.a.win.toFixed(0)}% / ${r.a.avg.toFixed(2)}% | ${r.b.n} / ${r.b.win.toFixed(0)}% / ${r.b.avg.toFixed(2)}% | ${r.delta.toFixed(2)} |`);
  }
}
w("");

// Standalone per-period breakdown (no matched-pair requirement) — useful when
// a bucket has n=0 in one period (e.g. new variant label) so dimensionDelta skips it.
const standaloneBreakdown = (arr, dimFn) => {
  const groups = new Map();
  for (const c of arr) { const k = dimFn(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const rows = [];
  for (const [k, items] of groups.entries()) {
    if (k === "unknown" || k === "(null)") continue;
    if (items.length < 3) continue;
    const pnl = items.map(x => x.feeIncl);
    const wins = items.filter(x => x.feeIncl > 0).length;
    rows.push({ key: k, n: items.length, avg: mean(pnl), win: wins / items.length * 100, p5: quant(pnl, 0.05) });
  }
  rows.sort((a, b) => b.n - a.n);
  return rows;
};

w("## Per-variant breakdown (standalone, each period independent)");
w("");
const varA = standaloneBreakdown(aSet, dimensions.variant);
const varB = standaloneBreakdown(bSet, dimensions.variant);
w("### Period A");
w("| Variant | n | win | avg | P5 |");
w("|---|---|---|---|---|");
for (const r of varA) w(`| \`${r.key}\` | ${r.n} | ${r.win.toFixed(0)}% | ${r.avg.toFixed(2)}% | ${r.p5.toFixed(2)}% |`);
w("");
w("### Period B");
w("| Variant | n | win | avg | P5 |");
w("|---|---|---|---|---|");
for (const r of varB) w(`| \`${r.key}\` | ${r.n} | ${r.win.toFixed(0)}% | ${r.avg.toFixed(2)}% | ${r.p5.toFixed(2)}% |`);
w("");

w("## Composition shift (% of closes per bucket)");
for (const [dim, fn] of Object.entries(dimensions)) {
  const rows = compositionShift(aSet, bSet, fn);
  if (!rows.length) continue;
  w("");
  w(`### \`${dim}\``);
  w("| Group | A % | B % | Δ pp |");
  w("|---|---|---|---|");
  for (const r of rows.slice(0, 10)) {
    w(`| \`${r.key}\` | ${r.aPct.toFixed(1)}% | ${r.bPct.toFixed(1)}% | ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)} |`);
  }
}
w("");

w("## Environment timeline");
w("");
w(`### Boundary commits (2026-04-06 → 2026-04-09)`);
if (commitsBoundary.length) {
  for (const c of commitsBoundary) {
    const [h, t, s] = c.split("|");
    w(`- \`${h}\` ${t.slice(0, 10)} — ${s}`);
  }
} else {
  w(`_No commits in window._`);
}
w("");
w(`### Commits in Period A: ${commitsA.length} | Period B: ${commitsB.length}`);
w(`(See \`git log --since=${A.label.split("..")[0]} --until=${A.label.split("..")[1]}\` for full A history)`);
w("");

w(`### Lessons created in Period A: ${lessonsA.length}`);
for (const l of lessonsA.slice(0, 10)) w(`- ${l.created_at?.slice(0, 10) || "?"} — ${(l.rule || "").slice(0, 100)}`);
w("");
w(`### Lessons created in Period B: ${lessonsB.length}`);
for (const l of lessonsB.slice(0, 10)) w(`- ${l.created_at?.slice(0, 10) || "?"} — ${(l.rule || "").slice(0, 100)}`);
w("");

// ── Hypotheses ────────────────────────────────────────────────────────────
w("## Ranked hypotheses for the gap");
w("");
const hypotheses = [];

// H1: Composition shift toward worse buckets
const variantComp = compositionShift(aSet, bSet, dimensions.variant);
const variantsLost = variantComp.filter(r => r.delta < -2).slice(0, 3);
const variantsGained = variantComp.filter(r => r.delta > 2).slice(0, 3);
if (variantsLost.length || variantsGained.length) {
  hypotheses.push({
    name: "Variant mix shifted",
    confidence: "high",
    evidence: `Lost share: ${variantsLost.map(r => `${r.key} (-${(-r.delta).toFixed(0)}pp)`).join(", ") || "none"}. Gained share: ${variantsGained.map(r => `${r.key} (+${r.delta.toFixed(0)}pp)`).join(", ") || "none"}.`,
    fix: "Bias screener back toward the variants that shrank (if their per-bucket avg in A was higher).",
  });
}

// H2: Per-dimension perf shift
const reasonDelta = dimensionDelta(aSet, bSet, dimensions.close_reason);
const reasonWorst = reasonDelta.filter(r => r.delta > 0.5).slice(0, 3);
if (reasonWorst.length) {
  hypotheses.push({
    name: "Close-reason mix shifted toward worse-performing reasons",
    confidence: "medium",
    evidence: `Reasons where A outperformed B: ${reasonWorst.map(r => `${r.key} A=${r.a.avg.toFixed(2)}% vs B=${r.b.avg.toFixed(2)}% (Δ ${r.delta.toFixed(2)}pp)`).join("; ")}`,
    fix: "Investigate why each reason became less profitable in B (rule threshold drift? execution lag?).",
  });
}

// H3: Market regime (SOL)
if (aMkt.sol_period_return_pct != null && bMkt.sol_period_return_pct != null) {
  const aTrend = aMkt.sol_period_return_pct > 0 ? "up" : "down";
  const bTrend = bMkt.sol_period_return_pct > 0 ? "up" : "down";
  if (aTrend !== bTrend || Math.abs(aMkt.sol_period_return_pct - bMkt.sol_period_return_pct) > 5) {
    hypotheses.push({
      name: "SOL price regime shifted",
      confidence: "medium",
      evidence: `SOL return A=${aMkt.sol_period_return_pct.toFixed(1)}% (${aTrend}) vs B=${bMkt.sol_period_return_pct.toFixed(1)}% (${bTrend}); SOL std A=$${aMkt.sol_std?.toFixed(2)} vs B=$${bMkt.sol_std?.toFixed(2)}; max DD A=${aMkt.sol_max_drawdown_pct?.toFixed(1)}% vs B=${bMkt.sol_max_drawdown_pct?.toFixed(1)}%.`,
      fix: "Not directly fixable. If SOL is in chop/downtrend (B), consider tighter SL + smaller size; if uptrend (A), allow more upside.",
    });
  }
}

// H4: Fee productivity
if (aMkt.avg_fee_yield_per_min_pct != null && bMkt.avg_fee_yield_per_min_pct != null) {
  const drop = aMkt.avg_fee_yield_per_min_pct - bMkt.avg_fee_yield_per_min_pct;
  if (Math.abs(drop) > 0.005) {
    hypotheses.push({
      name: "Fee yield per minute changed",
      confidence: "medium",
      evidence: `Avg fee yield A=${aMkt.avg_fee_yield_per_min_pct.toFixed(4)}%/min vs B=${bMkt.avg_fee_yield_per_min_pct.toFixed(4)}%/min (Δ ${drop > 0 ? "+" : ""}${drop.toFixed(4)}).`,
      fix: drop > 0 ? "Pools were paying out more per minute in A — possible higher pool volume or fewer holders. Cross-check pool screening filter." : "B has higher fee yield but lower net — gap is from price drawdowns, not fee dilution.",
    });
  }
}

// H5: Hold time shift
if (aSum && bSum) {
  const dm = aSum.avg_minutes - bSum.avg_minutes;
  if (Math.abs(dm) > 10) {
    hypotheses.push({
      name: "Hold-time distribution shifted",
      confidence: "medium",
      evidence: `Avg hold A=${aSum.avg_minutes.toFixed(1)}m vs B=${bSum.avg_minutes.toFixed(1)}m (Δ ${dm > 0 ? "+" : ""}${dm.toFixed(1)}m).`,
      fix: dm < 0 ? "B holds longer — exposes positions to more price drawdown. Check if hold-cap rules loosened or instructions changed." : "B closes faster — may be cutting winners short.",
    });
  }
}

// H6: Activity / position count
if (aSum && bSum) {
  const dr = aSum.realized_per_day - bSum.realized_per_day;
  hypotheses.push({
    name: "Realized $/day delta",
    confidence: "high",
    evidence: `A: $${aSum.realized_per_day.toFixed(2)}/day, B: $${bSum.realized_per_day.toFixed(2)}/day (Δ $${dr.toFixed(2)}/day = ${(dr / aSum.realized_per_day * 100).toFixed(0)}% drop).`,
    fix: "If avg pnl % dropped AND closes/day dropped, both contribute. Decompose: avg pnl × n × position size.",
  });
}

// Display
hypotheses.forEach((h, i) => {
  w(`### ${i + 1}. ${h.name} *(${h.confidence})*`);
  w(`- **Evidence:** ${h.evidence}`);
  w(`- **Fix / interpretation:** ${h.fix}`);
  w("");
});

// ── Write ──────────────────────────────────────────────────────────────────
const reportPath = path.join(LOGS_DIR, `period-comparison-${today}.md`);
fs.writeFileSync(reportPath, out.join("\n"));

// Console
const summary = [];
summary.push(`Period Comparison — ${today}`);
summary.push(`A: ${A.label} (${A_DAYS}d) | B: ${B.label} (${B_DAYS.toFixed(0)}d)`);
summary.push(``);
if (aSum && bSum) {
  summary.push(`Headline:`);
  summary.push(`  A: n=${aSum.n}, win=${aSum.win_rate.toFixed(1)}%, avg=${aSum.avg.toFixed(2)}%, P5=${aSum.p5.toFixed(2)}%, $/day=$${aSum.realized_per_day.toFixed(2)}`);
  summary.push(`  B: n=${bSum.n}, win=${bSum.win_rate.toFixed(1)}%, avg=${bSum.avg.toFixed(2)}%, P5=${bSum.p5.toFixed(2)}%, $/day=$${bSum.realized_per_day.toFixed(2)}`);
  summary.push(`  Δ avg fee-incl: ${(aSum.avg - bSum.avg).toFixed(2)}pp (A ${aSum.avg > bSum.avg ? "better" : "worse"})`);
  summary.push(``);
}
summary.push(`Top hypotheses:`);
hypotheses.slice(0, 5).forEach((h, i) => summary.push(`  ${i + 1}. [${h.confidence}] ${h.name}`));
summary.push(``);
summary.push(`Boundary commits (Apr 6-9): ${commitsBoundary.length}`);
summary.push(`Lessons in A: ${lessonsA.length} | B: ${lessonsB.length}`);
summary.push(``);
summary.push(`Full report: ${reportPath}`);
console.log(summary.join("\n"));
