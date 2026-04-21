/**
 * true_pnl — fee-inclusive PnL, the single user-facing PnL metric.
 *
 * Canonical formula (Meteora LP UI):
 *   PnL ($) = (Current Balance + All-time Withdraw + Claimable Fees + Claimed Fees)
 *           − All-time Deposits
 *
 * Meteora's datapi pre-computes this as `p.pnlUsd` / `p.pnlSol`. Meridian plumbs
 * those through as `pnl_usd_total` / `pnl_sol_total` / `pnl_pct_total` on both
 * live position snapshots and journal close entries (recorded post this change).
 *
 * `is_win` (true_win): `true_pnl_usd >= 0`. Replaces the old price-only win definition.
 */

/**
 * Compute fee-inclusive PnL for a journal close entry OR a live position object.
 *
 * Accepts either shape:
 *   - Journal close:  { pnl_usd_total, pnl_sol_total, pnl_pct_total, pnl_usd, pnl_sol,
 *                       pnl_pct, fees_earned_usd, initial_value_usd, sol_price }
 *   - Live position:  { pnl: { pnl_usd_total, pnl_sol_total, pnl_pct_total, pnl_usd,
 *                              pnl_sol, pnl_pct, unclaimed_fee_usd }, initial_value_usd, sol_price }
 *                     (also accepts canonical totals and flat unclaimed_fee_usd on the top level)
 *
 * Prefers Meteora's canonical totals when present. Falls back to
 * `pnl_usd + fees_earned_usd` for legacy entries written before the canonical
 * fields were plumbed through. Returns `null` when there isn't enough data.
 *
 * @param {Object} entry
 * @returns {{ usd:number, sol:number, pct:number, is_win:boolean, fees_usd:number }|null}
 */
export function computeTruePnl(entry) {
  if (!entry || typeof entry !== "object") return null;

  const live = entry.pnl && typeof entry.pnl === "object";
  const src  = live ? entry.pnl : entry;

  // Canonical totals (preferred — Meteora's pre-computed fee-inclusive PnL).
  // Check top-level first, then nested .pnl for live positions.
  const pnlUsdTotal = num(entry.pnl_usd_total ?? src.pnl_usd_total);
  const pnlSolTotal = num(entry.pnl_sol_total ?? src.pnl_sol_total);
  const pnlPctTotal = num(entry.pnl_pct_total ?? src.pnl_pct_total);

  // Price-only fallbacks + fees for legacy entries.
  const pnlUsd = num(src.pnl_usd);
  const pnlSol = num(src.pnl_sol);
  const pnlPct = num(src.pnl_pct);

  const feesUsd = num(
    entry.fees_earned_usd ??
    src.fees_earned_usd ??
    entry.unclaimed_fee_usd ??
    src.unclaimed_fee_usd ??
    entry.unclaimed_fees_usd ??
    src.unclaimed_fees_usd ??
    0
  ) ?? 0;

  const initialUsd = num(entry.initial_value_usd ?? src.initial_value_usd ?? 0) ?? 0;
  const solPrice   = num(entry.sol_price ?? src.sol_price ?? 0) ?? 0;

  // Nothing to compute — refuse to fabricate a zero.
  if (pnlUsdTotal === null && pnlUsd === null && feesUsd === 0) return null;

  // USD: canonical if available, else reconstruct from price-only + fees.
  const usd = pnlUsdTotal !== null ? pnlUsdTotal : (pnlUsd ?? 0) + feesUsd;

  // Pct: canonical if available, else reconstruct.
  let pct;
  if (pnlPctTotal !== null) {
    pct = pnlPctTotal;
  } else {
    const feesPct = initialUsd > 0 ? (feesUsd / initialUsd) * 100 : 0;
    pct = (pnlPct ?? 0) + feesPct;
  }

  // SOL: canonical if available, else reconstruct using sol_price.
  let sol;
  if (pnlSolTotal !== null) {
    sol = pnlSolTotal;
  } else {
    const feesSol = solPrice > 0 ? feesUsd / solPrice : 0;
    sol = (pnlSol ?? 0) + feesSol;
  }

  return {
    usd:      round2(usd),
    sol:      round4(sol),
    pct:      round2(pct),
    is_win:   usd >= 0,
    fees_usd: round2(feesUsd),
  };
}

/**
 * Aggregate true_pnl across a list of entries.
 * Skips entries where computeTruePnl returns null (not enough data).
 *
 * @param {Object[]} entries
 * @returns {{
 *   count:number, total_usd:number, avg_pct:number,
 *   true_win_rate_pct:number, true_wins:number, true_losses:number,
 *   best:{usd:number, pct:number, entry:Object}|null,
 *   worst:{usd:number, pct:number, entry:Object}|null,
 *   profit_factor:number|null
 * }}
 */
export function aggregateTruePnl(entries) {
  const rows = [];
  for (const e of entries || []) {
    const tp = computeTruePnl(e);
    if (tp) rows.push({ tp, entry: e });
  }

  const empty = {
    count: 0, total_usd: 0, avg_pct: 0,
    true_win_rate_pct: 0, true_wins: 0, true_losses: 0,
    best: null, worst: null, profit_factor: null,
  };
  if (rows.length === 0) return empty;

  let totalUsd = 0;
  let pctSum = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let best = rows[0];
  let worst = rows[0];

  for (const r of rows) {
    totalUsd += r.tp.usd;
    pctSum   += r.tp.pct;
    if (r.tp.is_win) { wins++;   grossProfit += r.tp.usd; }
    else             { losses++; grossLoss   += -r.tp.usd; }
    if (r.tp.usd > best.tp.usd)  best  = r;
    if (r.tp.usd < worst.tp.usd) worst = r;
  }

  return {
    count: rows.length,
    total_usd: round2(totalUsd),
    avg_pct: round2(pctSum / rows.length),
    true_win_rate_pct: Math.round((wins / rows.length) * 100),
    true_wins: wins,
    true_losses: losses,
    best:  { usd: best.tp.usd,  pct: best.tp.pct,  entry: best.entry },
    worst: { usd: worst.tp.usd, pct: worst.tp.pct, entry: worst.entry },
    profit_factor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
  };
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
