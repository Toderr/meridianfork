#!/usr/bin/env node
// Rebuild data/strategy-matrix.json from journal closes.
// Outlier filter: drop |net_pct|>30 and pnl_pct < -100 / > 1000 (data corruption).
// Score: avg_net_pct × win_rate − 0.5 × |worst_case_pct|.
// Min n=10 per cell with parent-bucket fallback (drop fee_tvl → bin_step → vol).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const JOURNAL_PATH = path.join(ROOT, "journal.json");
const OUT_PATH = path.join(ROOT, "data", "strategy-matrix.json");

const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));
const entries = journal.entries;

const opens = new Map();
for (const e of entries) {
  if (e.type === "open" && e.position) opens.set(e.position, e);
}
const closes = entries.filter(e => e.type === "close");

function volBucket(v) {
  if (v == null) return "vol_unk";
  if (v < 1) return "vol_low";
  if (v < 3) return "vol_med";
  if (v <= 5) return "vol_high";
  return "vol_extreme";
}
function binStepBucket(bs) {
  if (bs == null) return "bs_unk";
  if (bs <= 50) return "bs_tight";
  if (bs <= 100) return "bs_mid";
  if (bs <= 150) return "bs_wide";
  return "bs_xwide";
}
function feeTvlBucket(r) {
  if (r == null) return "ft_unk";
  if (r < 0.001) return "ft_low";
  if (r < 0.005) return "ft_mid";
  return "ft_high";
}
function shapeFor(bins_above) { return (bins_above === 0) ? "SINGLE" : "DOUBLE"; }
function normStrategy(s) {
  if (!s) return null;
  const t = String(s).toLowerCase().replace(/[\s\-_]/g, "");
  if (t === "spot") return "spot";
  if (t === "bidask") return "bidask";
  return null;
}

const samples = [];
const dropped = { no_open: 0, no_bin_range: 0, no_strategy: 0, bad_initial: 0, hard_outlier: 0, mag_outlier: 0 };

for (const c of closes) {
  let bins_above = null;
  if (c.bin_range && typeof c.bin_range.bins_above === "number") {
    bins_above = c.bin_range.bins_above;
  } else {
    const o = opens.get(c.position);
    if (!o) { dropped.no_open++; continue; }
    if (!o.bin_range || typeof o.bin_range.max !== "number" || typeof o.bin_range.active !== "number") {
      dropped.no_bin_range++; continue;
    }
    bins_above = o.bin_range.max - o.bin_range.active;
  }
  const o = opens.get(c.position) || {};
  const strategy = normStrategy(c.strategy || o.strategy);
  if (!strategy) { dropped.no_strategy++; continue; }
  let initial_value_usd = c.initial_value_usd || o.initial_value_usd;
  if (!initial_value_usd && c.pnl_pct && (c.pnl_usd_price_only != null || c.pnl_usd != null)) {
    const denom = c.pnl_usd_price_only ?? c.pnl_usd;
    if (c.pnl_pct !== 0) initial_value_usd = denom / (c.pnl_pct / 100);
  }
  if (!initial_value_usd || initial_value_usd <= 0) { dropped.bad_initial++; continue; }
  const pnl_pct = c.pnl_pct || 0;
  if (pnl_pct < -100 || pnl_pct > 1000) { dropped.hard_outlier++; continue; }
  const fees_usd = c.fees_earned_usd || 0;
  const fee_pct = (fees_usd / initial_value_usd) * 100;
  const net_pct = pnl_pct + fee_pct;
  if (Math.abs(net_pct) > 30) { dropped.mag_outlier++; continue; }

  samples.push({
    net_pct, strategy, shape: shapeFor(bins_above),
    vol_b: volBucket(o.volatility),
    bs_b: binStepBucket(o.bin_step ?? c.bin_step),
    ft_b: feeTvlBucket(o.fee_tvl_ratio),
  });
}

const COMBOS = [["spot","SINGLE"],["spot","DOUBLE"],["bidask","SINGLE"],["bidask","DOUBLE"]];
const MIN_N = 10;

function statsFor(arr) {
  const n = arr.length;
  if (!n) return { n: 0 };
  const net = arr.map(x => x.net_pct).sort((a,b)=>a-b);
  const sum = net.reduce((a,b)=>a+b,0);
  const avg = sum/n;
  const med = n%2 ? net[(n-1)/2] : (net[n/2-1]+net[n/2])/2;
  const wins = arr.filter(x => x.net_pct > 0).length;
  const wr = 100*wins/n;
  const worst = net[0];
  const score = (avg * wr) - 0.5 * Math.abs(worst);
  return { n, avg, med, wr, worst, score };
}
function bestCombo(arr) {
  const r = COMBOS.map(([strat, shape]) => ({ strat, shape, ...statsFor(arr.filter(x => x.strategy === strat && x.shape === shape)) }));
  r.sort((a,b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return r;
}
function bucketBy(axes, src) {
  const m = new Map();
  for (const s of src) {
    const key = axes.map(a => s[a + "_b"]).join("|");
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(s);
  }
  return m;
}
const lvl3 = bucketBy(["vol","bs","ft"], samples);
const lvl2 = bucketBy(["vol","bs"], samples);
const lvl1 = bucketBy(["vol"], samples);

function resolveCell(volB, bsB, ftB) {
  let arr = lvl3.get(`${volB}|${bsB}|${ftB}`) || [];
  let combos = bestCombo(arr); let w = combos.find(c => c.n >= MIN_N);
  if (w) return { level: "L3", winner: w, fallback: null };
  arr = lvl2.get(`${volB}|${bsB}`) || [];
  combos = bestCombo(arr); w = combos.find(c => c.n >= MIN_N);
  if (w) return { level: "L2", winner: w, fallback: "fee_tvl" };
  arr = lvl1.get(volB) || [];
  combos = bestCombo(arr); w = combos.find(c => c.n >= MIN_N);
  if (w) return { level: "L1", winner: w, fallback: "fee_tvl,bin_step" };
  combos = bestCombo(samples); w = combos.find(c => c.n >= MIN_N) || combos[0];
  return { level: "L0", winner: w, fallback: "fee_tvl,bin_step,volatility" };
}

const VOLS = ["vol_low","vol_med","vol_high","vol_unk"];
const BSS = ["bs_tight","bs_mid","bs_wide","bs_xwide","bs_unk"];
const FTS = ["ft_low","ft_mid","ft_high","ft_unk"];

const matrix = {};
for (const v of VOLS) for (const b of BSS) for (const f of FTS) {
  const r = resolveCell(v, b, f);
  if (!r.winner || r.winner.n === 0) continue;
  matrix[`${v}|${b}|${f}`] = {
    strategy: r.winner.strat,
    shape: r.winner.shape,
    bins_above_pct: r.winner.shape === "DOUBLE" ? 25 : 0,
    n: r.winner.n,
    avg_net_pct: r.winner.avg,
    win_rate: r.winner.wr,
    worst_pct: r.winner.worst,
    score: r.winner.score,
    level: r.level,
    fallback: r.fallback,
  };
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
const tmp = OUT_PATH + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(matrix, null, 2));
fs.renameSync(tmp, OUT_PATH);

console.log(`Built strategy matrix: ${Object.keys(matrix).length} cells from ${samples.length} clean samples (${closes.length} closes total).`);
console.log(`Dropped: ${JSON.stringify(dropped)}`);
console.log(`Output: ${OUT_PATH}`);
