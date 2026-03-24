/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { recordJournalClose } from "./journal.js";
import { notifyThresholdEvolved, isEnabled as telegramEnabled } from "./telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  const pnl_usd = perf.pnl_usd != null
    ? perf.pnl_usd
    : (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  // Use the API pnl_pct if passed in (matches what the agent saw and acted on),
  // otherwise fall back to reconstructing from state values.
  const pnl_pct = perf.pnl_pct != null
    ? perf.pnl_pct
    : (perf.initial_value_usd > 0 ? (pnl_usd / perf.initial_value_usd) * 100 : 0);
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const entry = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  // Record to trading journal with native pnl_sol from Meteora API
  try {
    recordJournalClose({
      position: entry.position,
      pool: entry.pool,
      pool_name: entry.pool_name,
      strategy: entry.strategy,
      amount_sol: entry.amount_sol,
      initial_value_usd: entry.initial_value_usd,
      final_value_usd: entry.final_value_usd,
      fees_earned_usd: entry.fees_earned_usd,
      pnl_usd: entry.pnl_usd,
      pnl_sol: perf.pnl_sol ?? null,
      pnl_pct: entry.pnl_pct,
      minutes_held: entry.minutes_held,
      range_efficiency: entry.range_efficiency,
      close_reason: entry.close_reason,
      bin_range: entry.bin_range ?? null,
      bin_step: entry.bin_step ?? null,
      variant: entry.variant || null,
    });
  } catch (e) {
    log("journal_error", `Failed to journal close: ${e.message}`);
  }

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    // Improvement 6: Deduplication — skip if a similar lesson exists within 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const duplicate = lesson.pool
      ? data.lessons.find(
          (l) =>
            l.outcome === lesson.outcome &&
            l.pool === lesson.pool &&
            l.created_at >= sevenDaysAgo
        )
      : null;

    if (duplicate) {
      // Update existing lesson's rule with the newer, more specific one
      duplicate.rule = lesson.rule;
      log("lessons", `Updated existing lesson (dedup): ${lesson.rule}`);
    } else {
      data.lessons.push(lesson);
      log("lessons", `New lesson: ${lesson.rule}`);
    }
  }

  save(data);

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }
  }
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  const tags = [];

  // Categorize outcome
  const outcome = perf.pnl_pct >= 5 ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  // Improvement 7: Cross-role learning — tag screener-catchable failures
  if (
    (outcome === "bad" || outcome === "poor") &&
    !tags.includes("screener") &&
    (
      rule.includes("OOR") ||
      rule.includes("went out of range") ||
      rule.includes("volume collapsed") ||
      rule.includes("yield dead") ||
      rule.includes("low fee")
    )
  ) {
    tags.push("screener");
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    context,
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers  = perfData.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  // ── 1. maxVolatility ─────────────────────────────────────────
  // If losers tend to cluster at higher volatility → tighten the ceiling.
  // If winners span higher volatility safely → we can loosen a bit.
  {
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const loserVols  = losers.map((p) => p.volatility).filter(isFiniteNum);
    const current    = config.screening.maxVolatility;

    if (loserVols.length >= 2) {
      // 25th percentile of loser volatilities — this is where things start going wrong
      const loserP25 = percentile(loserVols, 25);
      if (loserP25 < current) {
        // Tighten: new ceiling = loserP25 + a small buffer
        const target  = loserP25 * 1.15;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded < current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `Losers clustered at volatility ~${loserP25.toFixed(1)} — tightened from ${current} → ${rounded}`;
        }
      }
    } else if (winnerVols.length >= 3 && losers.length === 0) {
      // All winners so far — loosen conservatively so we don't miss good pools
      const winnerP75 = percentile(winnerVols, 75);
      if (winnerP75 > current * 1.1) {
        const target  = winnerP75 * 1.1;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded > current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `All ${winners.length} positions profitable — loosened from ${current} → ${rounded}`;
        }
      }
    }
  }

  // ── 2. minFeeTvlRatio ─────────────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeTvlRatio;

    if (winnerFees.length >= 2) {
      // Minimum fee/TVL among winners — we know pools below this don't work for us
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85; // stay slightly below min winner
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeTvlRatio = rounded;
          rationale.minFeeTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeTvlRatio) {
            changes.minFeeTvlRatio = rounded;
            rationale.minFeeTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 4. strategyRules (spot vs bid_ask per volatility bucket) ──
  {
    const buckets = { low: [], med: [], high: [] };
    for (const p of perfData) {
      if (!p.strategy || p.volatility == null) continue;
      const b = p.volatility >= 5 ? "high" : p.volatility >= 2 ? "med" : "low";
      buckets[b].push(p);
    }
    const ruleMap = { low: "lowVol", med: "medVol", high: "highVol" };
    const current = config.strategy.strategyRules;
    for (const [bk, trades] of Object.entries(buckets)) {
      if (trades.length < 3) continue;
      const spotTrades   = trades.filter(p => p.strategy === "spot");
      const bidAskTrades = trades.filter(p => p.strategy === "bid_ask");
      if (spotTrades.length < 2 || bidAskTrades.length < 2) continue;
      const spotWr   = spotTrades.filter(p => p.pnl_pct > 0).length / spotTrades.length;
      const bidAskWr = bidAskTrades.filter(p => p.pnl_pct > 0).length / bidAskTrades.length;
      const winner   = spotWr - bidAskWr >= 0.2 ? "spot" : bidAskWr - spotWr >= 0.2 ? "bid_ask" : null;
      if (!winner) continue;
      const key = ruleMap[bk];
      if (current[key] !== winner) {
        if (!changes.strategyRules) changes.strategyRules = { ...current };
        changes.strategyRules[key] = winner;
        rationale[`strategyRules.${key}`] = `${bk} vol: ${winner} win rate ${Math.round((winner === "spot" ? spotWr : bidAskWr) * 100)}% vs ${Math.round((winner === "spot" ? bidAskWr : spotWr) * 100)}%`;
      }
    }
  }

  // ── 5. binsBelow (bin range width) ──────────────────────────────
  {
    const withRange = perfData.filter(p => p.bin_range?.bins_below != null && p.range_efficiency != null);
    if (withRange.length >= 5) {
      const buckets = {};
      for (const p of withRange) {
        const bb = p.bin_range.bins_below;
        const bk = bb <= 40 ? "narrow" : bb <= 60 ? "med" : bb <= 80 ? "wide" : "xwide";
        if (!buckets[bk]) buckets[bk] = { efficiencies: [], bbValues: [] };
        buckets[bk].efficiencies.push(p.range_efficiency);
        buckets[bk].bbValues.push(bb);
      }
      let bestBk = null, bestEff = -1;
      for (const [bk, d] of Object.entries(buckets)) {
        if (d.efficiencies.length < 2) continue;
        const eff = avg(d.efficiencies);
        if (eff > bestEff) { bestEff = eff; bestBk = bk; }
      }
      if (bestBk) {
        const targetBb = Math.round(avg(buckets[bestBk].bbValues));
        const current  = config.strategy.binsBelow;
        const newVal   = clamp(Math.round(nudge(current, targetBb, MAX_CHANGE_PER_STEP)), 20, 100);
        if (newVal !== current) {
          changes.binsBelow = newVal;
          rationale.binsBelow = `Bucket '${bestBk}' has best avg range_efficiency ${bestEff.toFixed(0)}% — nudged binsBelow ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 6. TP/SL thresholds ─────────────────────────────────────────
  {
    const winnerPnls = winners.map(p => p.pnl_pct).filter(isFiniteNum);
    const loserPnls  = losers.map(p => p.pnl_pct).filter(isFiniteNum);

    if (winnerPnls.length >= 3) {
      const avgWin = avg(winnerPnls);
      const p90Win = percentile(winnerPnls, 90);

      // takeProfitFeePct — management cycle TP
      {
        const current = config.management.takeProfitFeePct;
        const target  = avgWin * 0.6;
        const newVal  = clamp(parseFloat(nudge(current, target, MAX_CHANGE_PER_STEP).toFixed(1)), 2, 20);
        if (newVal !== current) {
          changes.takeProfitFeePct = newVal;
          rationale.takeProfitFeePct = `Avg winner pnl ${avgWin.toFixed(1)}% — nudged TP ${current} → ${newVal}`;
        }
      }
      // fastTpPct — PnL checker hard TP
      {
        const current = config.management.fastTpPct;
        const target  = p90Win * 0.75;
        const newVal  = clamp(parseFloat(nudge(current, target, MAX_CHANGE_PER_STEP).toFixed(1)), 8, 30);
        if (newVal !== current) {
          changes.fastTpPct = newVal;
          rationale.fastTpPct = `p90 winner pnl ${p90Win.toFixed(1)}% — nudged fastTp ${current} → ${newVal}`;
        }
      }
      // trailingFloor — PnL checker trailing stop
      {
        const current = config.management.trailingFloor;
        const target  = avgWin * 0.4;
        const newVal  = clamp(parseFloat(nudge(current, target, MAX_CHANGE_PER_STEP).toFixed(1)), 2, 12);
        if (newVal !== current) {
          changes.trailingFloor = newVal;
          rationale.trailingFloor = `Avg winner pnl ${avgWin.toFixed(1)}% — nudged trailingFloor ${current} → ${newVal}`;
        }
      }
    }

    if (loserPnls.length >= 2) {
      const avgLoss = avg(loserPnls); // negative number
      const current = config.management.emergencyPriceDropPct; // negative number
      const target  = avgLoss * 1.3;
      const newVal  = clamp(parseFloat(nudge(current, target, MAX_CHANGE_PER_STEP).toFixed(1)), -80, -10);
      if (newVal !== current) {
        changes.emergencyPriceDropPct = newVal;
        rationale.emergencyPriceDropPct = `Avg loser pnl ${avgLoss.toFixed(1)}% — nudged SL ${current} → ${newVal}`;
      }
    }
  }

  // ── 7. positionSizePct (deploy sizing) ──────────────────────────
  {
    const recent = perfData.slice(-10);
    if (recent.length >= 5) {
      const recentWr = recent.filter(p => p.pnl_pct > 0).length / recent.length;
      const current  = config.management.positionSizePct;
      let target = current;
      if (recentWr > 0.7)      target = current * 1.1;
      else if (recentWr < 0.4) target = current * 0.9;
      if (target !== current) {
        const newVal = clamp(parseFloat(nudge(current, target, MAX_CHANGE_PER_STEP).toFixed(3)), 0.15, 0.5);
        if (newVal !== current) {
          changes.positionSizePct = newVal;
          rationale.positionSizePct = `Recent win rate ${Math.round(recentWr * 100)}% (last ${recent.length}) — nudged sizing ${current} → ${newVal}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  const s = config.screening;
  if (changes.maxVolatility    != null) {
    const oldVal = s.maxVolatility;
    s.maxVolatility = changes.maxVolatility;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "maxVolatility", oldVal, newVal: changes.maxVolatility, reason: rationale.maxVolatility }).catch(() => {});
  }
  if (changes.minFeeTvlRatio   != null) {
    const oldVal = s.minFeeTvlRatio;
    s.minFeeTvlRatio = changes.minFeeTvlRatio;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "minFeeTvlRatio", oldVal, newVal: changes.minFeeTvlRatio, reason: rationale.minFeeTvlRatio }).catch(() => {});
  }
  if (changes.minOrganic       != null) {
    const oldVal = s.minOrganic;
    s.minOrganic = changes.minOrganic;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "minOrganic", oldVal, newVal: changes.minOrganic, reason: rationale.minOrganic }).catch(() => {});
  }

  const m  = config.management;
  const st = config.strategy;
  if (changes.strategyRules != null) {
    st.strategyRules = changes.strategyRules;
    // Single notification summarizing all rule changes
    const ruleChanges = Object.entries(rationale).filter(([k]) => k.startsWith("strategyRules.")).map(([, v]) => v).join("; ");
    if (telegramEnabled() && ruleChanges) notifyThresholdEvolved({ field: "strategyRules", oldVal: null, newVal: JSON.stringify(changes.strategyRules), reason: ruleChanges }).catch(() => {});
  }
  if (changes.binsBelow != null) {
    const oldVal = st.binsBelow;
    st.binsBelow = changes.binsBelow;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "binsBelow", oldVal, newVal: changes.binsBelow, reason: rationale.binsBelow }).catch(() => {});
  }
  if (changes.takeProfitFeePct != null) {
    const oldVal = m.takeProfitFeePct;
    m.takeProfitFeePct = changes.takeProfitFeePct;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "takeProfitFeePct", oldVal, newVal: changes.takeProfitFeePct, reason: rationale.takeProfitFeePct }).catch(() => {});
  }
  if (changes.fastTpPct != null) {
    const oldVal = m.fastTpPct;
    m.fastTpPct = changes.fastTpPct;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "fastTpPct", oldVal, newVal: changes.fastTpPct, reason: rationale.fastTpPct }).catch(() => {});
  }
  if (changes.trailingFloor != null) {
    const oldVal = m.trailingFloor;
    m.trailingFloor = changes.trailingFloor;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "trailingFloor", oldVal, newVal: changes.trailingFloor, reason: rationale.trailingFloor }).catch(() => {});
  }
  if (changes.emergencyPriceDropPct != null) {
    const oldVal = m.emergencyPriceDropPct;
    m.emergencyPriceDropPct = changes.emergencyPriceDropPct;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "emergencyPriceDropPct", oldVal, newVal: changes.emergencyPriceDropPct, reason: rationale.emergencyPriceDropPct }).catch(() => {});
  }
  if (changes.positionSizePct != null) {
    const oldVal = m.positionSizePct;
    m.positionSizePct = changes.positionSizePct;
    if (telegramEnabled()) notifyThresholdEvolved({ field: "positionSizePct", oldVal, newVal: changes.positionSizePct, reason: rationale.positionSizePct }).catch(() => {});
  }

  // Log a lesson summarizing the evolution
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  });
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${rule}`);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  // No caps — inject all lessons so the agent always applies everything it has learned
  const PINNED_CAP  = Infinity;
  const ROLE_CAP    = Infinity;
  const RECENT_CAP  = maxLessons ?? Infinity;

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
  };
}
