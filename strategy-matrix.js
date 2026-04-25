// Strategy Decision Matrix — data-derived hard gate.
//
// Maps (volatility, bin_step, fee_tvl_ratio) → (strategy, bins_above_pct).
// Built from journal close history with outlier filter (|net%|>30 dropped).
// Score formula: avg_net_pct × win_rate − 0.5 × |worst_case_pct|.
//
// MIN_N=10 per cell with parent-bucket fallback (drop fee_tvl → bin_step → vol).
// Re-derive with `node scripts/build-strategy-matrix.js`.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = path.join(__dirname, "data", "strategy-matrix.json");

let _cache = null;
let _cacheMtime = 0;

export function volBucket(v) {
  if (v == null) return "vol_unk";
  if (v < 1) return "vol_low";
  if (v < 3) return "vol_med";
  if (v <= 5) return "vol_high";
  return "vol_extreme";
}
export function binStepBucket(bs) {
  if (bs == null) return "bs_unk";
  if (bs <= 50) return "bs_tight";
  if (bs <= 100) return "bs_mid";
  if (bs <= 150) return "bs_wide";
  return "bs_xwide";
}
export function feeTvlBucket(r) {
  if (r == null) return "ft_unk";
  if (r < 0.001) return "ft_low";
  if (r < 0.005) return "ft_mid";
  return "ft_high";
}

function loadMatrix() {
  try {
    const stat = fs.statSync(MATRIX_PATH);
    if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
    _cache = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
    _cacheMtime = stat.mtimeMs;
    return _cache;
  } catch {
    return null;
  }
}

/**
 * Look up the matrix-recommended (strategy, shape) for a pool's characteristics.
 * Returns null when matrix is missing or no fallback applies.
 *
 * @param {object} args
 * @param {number|null} args.volatility
 * @param {number|null} args.bin_step
 * @param {number|null} args.fee_tvl_ratio
 * @returns {{strategy: string, bins_above_pct: number, shape: string, level: string, n: number, score: number, source_key: string}|null}
 */
export function lookupStrategy({ volatility, bin_step, fee_tvl_ratio }) {
  const m = loadMatrix();
  if (!m) return null;
  const volB = volBucket(volatility);
  const bsB = binStepBucket(bin_step);
  const ftB = feeTvlBucket(fee_tvl_ratio);
  const key = `${volB}|${bsB}|${ftB}`;
  const cell = m[key];
  if (!cell) return null;
  return {
    strategy: cell.strategy === "bidask" ? "bid_ask" : cell.strategy,
    bins_above_pct: cell.bins_above_pct,
    shape: cell.shape,
    level: cell.level,
    n: cell.n,
    score: cell.score,
    source_key: key,
    fallback_axes: cell.fallback || null,
  };
}

/**
 * Resolve concrete bins_above given a recommendation and bins_below count.
 * bins_above_pct=25 means double-sided 75/25 (downside-weighted).
 */
export function resolveBinsAbove({ bins_above_pct, bins_below }) {
  if (!bins_above_pct || bins_above_pct === 0) return 0;
  if (!bins_below || bins_below <= 0) return 0;
  // 75/25 split: bins_below stays as authored, bins_above = bins_below * (pct/(100-pct))
  // For pct=25: bins_above = bins_below * (25/75) = bins_below / 3
  const ratio = bins_above_pct / Math.max(1, 100 - bins_above_pct);
  return Math.max(1, Math.round(bins_below * ratio));
}

export function isMatrixEnabled(config) {
  return config?.strategy?.strategyMatrixEnabled !== false;
}

export function getMatrixSummary() {
  const m = loadMatrix();
  if (!m) return { available: false };
  const cells = Object.entries(m);
  return {
    available: true,
    total_cells: cells.length,
    by_level: cells.reduce((acc, [_, v]) => { acc[v.level] = (acc[v.level] || 0) + 1; return acc; }, {}),
    sample_total: cells.reduce((s, [_, v]) => s + (v.n || 0), 0),
  };
}
