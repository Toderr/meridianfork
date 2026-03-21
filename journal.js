/**
 * Trading Journal — append-only event log.
 *
 * Records every open/close/claim event with full context.
 * Stored in journal.json as { entries: [...] }.
 */

import fs from "fs";
import { log } from "./logger.js";

const JOURNAL_FILE = "./journal.json";

function load() {
  if (!fs.existsSync(JOURNAL_FILE)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function save(data) {
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2));
}

function append(entry) {
  const data = load();
  data.entries.push(entry);
  save(data);
}

// ─── Record Events ──────────────────────────────────────────────

/**
 * Record a position open event.
 * @param {Object} d
 * @param {string} d.position
 * @param {string} d.pool
 * @param {string} d.pool_name
 * @param {string} d.strategy
 * @param {number} d.amount_sol
 * @param {number} d.initial_value_usd
 * @param {number} d.sol_price
 * @param {number} d.bin_step
 * @param {number} d.volatility
 * @param {number} d.fee_tvl_ratio
 * @param {number} d.organic_score
 * @param {*}      d.bin_range
 */
export function recordOpen(d) {
  try {
    append({
      id: Date.now(),
      type: "open",
      timestamp: new Date().toISOString(),
      position: d.position,
      pool: d.pool,
      pool_name: d.pool_name,
      strategy: d.strategy,
      amount_sol: d.amount_sol,
      initial_value_usd: d.initial_value_usd,
      sol_price: d.sol_price,
      bin_step: d.bin_step,
      volatility: d.volatility,
      fee_tvl_ratio: d.fee_tvl_ratio,
      organic_score: d.organic_score,
      bin_range: d.bin_range,
      variant: d.variant || null,
    });
    log("journal", `Recorded open: ${d.pool_name} pos=${d.position?.slice(0, 8)}`);
  } catch (e) {
    log("journal_error", `recordOpen failed: ${e.message}`);
  }
}

/**
 * Record a position close event.
 * @param {Object} d
 * @param {string} d.position
 * @param {string} d.pool
 * @param {string} d.pool_name
 * @param {string} d.strategy
 * @param {number} d.amount_sol
 * @param {number} d.initial_value_usd
 * @param {number} d.final_value_usd
 * @param {number} d.fees_earned_usd
 * @param {number} d.pnl_usd
 * @param {number} d.pnl_pct
 * @param {number} d.sol_price
 * @param {number} d.minutes_held
 * @param {number} d.range_efficiency
 * @param {string} d.close_reason
 */
export function recordJournalClose(d) {
  try {
    const pnl_sol = d.pnl_sol != null ? Math.round(d.pnl_sol * 10000) / 10000 : null;
    append({
      id: Date.now(),
      type: "close",
      timestamp: new Date().toISOString(),
      position: d.position,
      pool: d.pool,
      pool_name: d.pool_name,
      strategy: d.strategy,
      amount_sol: d.amount_sol,
      initial_value_usd: d.initial_value_usd,
      final_value_usd: d.final_value_usd,
      fees_earned_usd: d.fees_earned_usd,
      pnl_usd: Math.round(d.pnl_usd * 100) / 100,
      pnl_sol,
      pnl_pct: d.pnl_pct,
      minutes_held: d.minutes_held,
      range_efficiency: d.range_efficiency,
      close_reason: d.close_reason,
      variant: d.variant || null,
    });
    log("journal", `Recorded close: ${d.pool_name} pnl=$${d.pnl_usd?.toFixed(2)} (${pnl_sol != null ? pnl_sol.toFixed(4) : "?"} SOL)`);
  } catch (e) {
    log("journal_error", `recordJournalClose failed: ${e.message}`);
  }
}

/**
 * Record a fee claim event.
 * @param {Object} d
 * @param {string} d.position
 * @param {string} d.pool
 * @param {string} d.pool_name
 * @param {number} d.fees_usd
 * @param {number} d.sol_price
 */
export function recordJournalClaim(d) {
  try {
    const fees_sol = d.sol_price > 0 ? d.fees_usd / d.sol_price : 0;
    append({
      id: Date.now(),
      type: "claim",
      timestamp: new Date().toISOString(),
      position: d.position,
      pool: d.pool,
      pool_name: d.pool_name,
      fees_usd: Math.round(d.fees_usd * 100) / 100,
      fees_sol: Math.round(fees_sol * 10000) / 10000,
      sol_price: d.sol_price,
    });
    log("journal", `Recorded claim: ${d.pool_name} fees=$${d.fees_usd?.toFixed(2)}`);
  } catch (e) {
    log("journal_error", `recordJournalClaim failed: ${e.message}`);
  }
}

// ─── Query ─────────────────────────────────────────────────────

/**
 * Get journal entries filtered by date range and/or type.
 * @param {Object} opts
 * @param {string} [opts.from]  - ISO timestamp lower bound (inclusive)
 * @param {string} [opts.to]    - ISO timestamp upper bound (inclusive)
 * @param {string} [opts.type]  - "open" | "close" | "claim"
 * @returns {Array}
 */
export function getJournalEntries({ from, to, type } = {}) {
  const data = load();
  let entries = data.entries;
  if (from)  entries = entries.filter(e => e.timestamp >= from);
  if (to)    entries = entries.filter(e => e.timestamp <= to);
  if (type)  entries = entries.filter(e => e.type === type);
  return entries;
}

// ─── Backfill ──────────────────────────────────────────────────

/**
 * One-time migration: populate journal.json from existing state.json + lessons.json.
 * Safe to run multiple times — skips positions already in the journal.
 */
export function backfillFromExisting() {
  const STATE_FILE = "./state.json";
  const LESSONS_FILE = "./lessons.json";

  let state = { positions: {} };
  let lessonsData = { performance: [] };

  try {
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(LESSONS_FILE)) lessonsData = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch { /* ignore */ }

  const data = load();
  const existingIds = new Set(data.entries.map(e => `${e.type}:${e.position}`));

  let added = 0;

  // Backfill opens from state.json positions
  for (const pos of Object.values(state.positions || {})) {
    const key = `open:${pos.position}`;
    if (!existingIds.has(key) && pos.position && pos.deployed_at) {
      data.entries.push({
        id: new Date(pos.deployed_at).getTime(),
        type: "open",
        timestamp: pos.deployed_at,
        position: pos.position,
        pool: pos.pool,
        pool_name: pos.pool_name,
        strategy: pos.strategy,
        amount_sol: pos.amount_sol,
        initial_value_usd: pos.initial_value_usd,
        sol_price: null, // unknown at backfill time
        bin_step: pos.bin_step,
        volatility: pos.volatility,
        fee_tvl_ratio: pos.fee_tvl_ratio,
        organic_score: pos.organic_score,
        bin_range: pos.bin_range,
        _backfilled: true,
      });
      existingIds.add(key);
      added++;
    }
  }

  // Backfill closes from lessons.json performance
  for (const perf of lessonsData.performance || []) {
    const key = `close:${perf.position}`;
    if (!existingIds.has(key) && perf.position && perf.recorded_at) {
      data.entries.push({
        id: new Date(perf.recorded_at).getTime(),
        type: "close",
        timestamp: perf.recorded_at,
        position: perf.position,
        pool: perf.pool,
        pool_name: perf.pool_name,
        strategy: perf.strategy,
        amount_sol: perf.amount_sol,
        initial_value_usd: perf.initial_value_usd,
        final_value_usd: perf.final_value_usd,
        fees_earned_usd: perf.fees_earned_usd,
        pnl_usd: perf.pnl_usd,
        pnl_sol: null, // sol_price unknown at backfill time
        pnl_pct: perf.pnl_pct,
        sol_price: null,
        minutes_held: perf.minutes_held,
        range_efficiency: perf.range_efficiency,
        close_reason: perf.close_reason,
        _backfilled: true,
      });
      existingIds.add(key);
      added++;
    }
  }

  // Sort chronologically
  data.entries.sort((a, b) => a.id - b.id);
  save(data);
  log("journal", `Backfill complete: added ${added} entries`);
  return added;
}
