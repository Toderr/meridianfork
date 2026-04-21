/**
 * true_pnl — Meteora UI fee-inclusive PnL, the single user-facing PnL metric.
 *
 * Formula (matches what Meteora LP UI displays):
 *   PnL ($) = (Current Balance + All-time Withdraw + Claimable Fees + Claimed Fees)
 *           − All-time Deposits
 *
 * For Meridian's data shapes this reduces to:
 *   closed:    final_value_usd + fees_earned_usd − initial_value_usd
 *   live:      total_value_usd + (unclaimed_fees_usd + collected_fees_usd) − initial_value_usd
 *
 * Note: Meteora datapi's `p.pnlUsd` is an IL-adjusted value that differs from the
 * UI display (datapi reprices the initial deposit at current token prices). We
 * ignore it for display; the UI formula above is what users see in Meteora.
 *
 * `is_win` (true_win): `true_pnl_usd >= 0`.
 */

/**
 * Compute fee-inclusive PnL for a journal close entry OR a live position object.
 *
 * Accepts these shapes:
 *   - Journal close (flat):
 *       { initial_value_usd, final_value_usd, fees_earned_usd, sol_price, ... }
 *   - Live position from positions builder (flat):
 *       { initial_value_usd, total_value_usd, unclaimed_fees_usd, collected_fees_usd, ... }
 *   - getPositionPnl wrapped (nested .pnl):
 *       { pnl: { current_value_usd, unclaimed_fee_usd, initial_value_usd, ... }, sol_price }
 *
 * Returns `null` when there isn't enough data to compute (refuses to fabricate zero).
 *
 * @param {Object} entry
 * @returns {{ usd:number, sol:number, pct:number, is_win:boolean, fees_usd:number }|null}
 */
export function computeTruePnl(entry) {
  if (!entry || typeof entry !== "object") return null;

  const src = entry.pnl && typeof entry.pnl === "object" ? entry.pnl : entry;

  // Value: prefer closed final, else live current/total.
  const value = firstNum([
    entry.final_value_usd,
    src.final_value_usd,
    entry.total_value_usd,
    src.total_value_usd,
    entry.current_value_usd,
    src.current_value_usd,
  ]);

  // Fees: prefer explicit fees_earned_usd (closed total). Otherwise sum live split
  // (unclaimed_fees_usd = Claimable + collected_fees_usd = Claimed mid-life).
  let fees = firstNum([entry.fees_earned_usd, src.fees_earned_usd]);
  if (fees === null) {
    const unclaimed = firstNum([
      entry.unclaimed_fees_usd,
      src.unclaimed_fees_usd,
      entry.unclaimed_fee_usd,
      src.unclaimed_fee_usd,
    ]) ?? 0;
    const collected = firstNum([
      entry.collected_fees_usd,
      src.collected_fees_usd,
      entry.all_time_fees_usd,
      src.all_time_fees_usd,
    ]) ?? 0;
    fees = unclaimed + collected;
  }

  const initial = firstNum([
    entry.initial_value_usd,
    src.initial_value_usd,
    entry.initial_value_usd_api,
    src.initial_value_usd_api,
  ]);

  const solPrice = firstNum([entry.sol_price, src.sol_price]) ?? 0;

  let usd, pct, sol;

  if (value !== null && initial !== null) {
    // Primary path — Meteora UI formula.
    usd = value + (fees ?? 0) - initial;
    pct = initial > 0 ? (usd / initial) * 100 : 0;
    sol = solPrice > 0 ? usd / solPrice : 0;
  } else {
    // Legacy fallback for ancient entries missing final/current value.
    // Reconstruct via pnl_usd (price-only) + fees (still approximates UI).
    const pnlUsd = firstNum([src.pnl_usd]);
    if (pnlUsd === null && (fees ?? 0) === 0) return null;
    usd = (pnlUsd ?? 0) + (fees ?? 0);
    const pnlPct = firstNum([src.pnl_pct]);
    const feesPct = initial && initial > 0 ? ((fees ?? 0) / initial) * 100 : 0;
    pct = (pnlPct ?? 0) + feesPct;
    const pnlSol = firstNum([src.pnl_sol]);
    const feesSol = solPrice > 0 ? (fees ?? 0) / solPrice : 0;
    sol = (pnlSol ?? 0) + feesSol;
  }

  return {
    usd:      round2(usd),
    sol:      round4(sol),
    pct:      round2(pct),
    is_win:   usd >= 0,
    fees_usd: round2(fees ?? 0),
  };
}

/**
 * Aggregate true_pnl across a list of entries.
 * Skips entries where computeTruePnl returns null.
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
function firstNum(candidates) {
  for (const c of candidates) {
    const n = num(c);
    if (n !== null) return n;
  }
  return null;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
