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
const EXPERIMENT_LESSONS_FILE = "./experiment-lessons.json";
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once

// ─── Dual-file I/O ───────────────────────────────────────────

function loadRegular() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [], performance: [] };
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); }
  catch { return { lessons: [], performance: [] }; }
}

function saveRegular(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

function loadExperiment() {
  if (!fs.existsSync(EXPERIMENT_LESSONS_FILE)) return { lessons: [] };
  try { return JSON.parse(fs.readFileSync(EXPERIMENT_LESSONS_FILE, "utf8")); }
  catch { return { lessons: [] }; }
}

function saveExperiment(data) {
  fs.writeFileSync(EXPERIMENT_LESSONS_FILE, JSON.stringify(data, null, 2));
}

/** Merge both stores — lessons combined, performance from regular only. */
function loadAll() {
  const reg = loadRegular();
  const exp = loadExperiment();
  return { lessons: [...reg.lessons, ...exp.lessons], performance: reg.performance };
}

// Back-compat aliases used by a handful of call-sites that don't care about source
function load() { return loadRegular(); }
function save(data) { saveRegular(data); }

// ─── One-time migration: split experiment lessons into own file ──
(function migrateExperimentLessons() {
  if (fs.existsSync(EXPERIMENT_LESSONS_FILE)) return;
  const reg = loadRegular();
  const expLessons = reg.lessons.filter(l => l.source === "experiment");
  if (expLessons.length === 0) return;
  saveExperiment({ lessons: expLessons });
  reg.lessons = reg.lessons.filter(l => l.source !== "experiment");
  saveRegular(reg);
  log("lessons", `Migrated ${expLessons.length} experiment lessons → ${EXPERIMENT_LESSONS_FILE}`);
})();

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
  const data = loadRegular();

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

  // Derive and store a lesson — route to correct file by source
  const lesson = derivLesson(entry);
  if (lesson) {
    const isExp = lesson.source === "experiment";
    const targetData = isExp ? loadExperiment() : data;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const duplicate = lesson.pool
      ? targetData.lessons.find(
          (l) =>
            l.outcome === lesson.outcome &&
            l.pool === lesson.pool &&
            l.created_at >= sevenDaysAgo
        )
      : null;

    if (duplicate) {
      duplicate.rule = lesson.rule;
      log("lessons", `Updated existing lesson (dedup): ${lesson.rule}`);
    } else {
      targetData.lessons.push(lesson);
      log("lessons", `New lesson [${lesson.source}]: ${lesson.rule}`);
    }
    if (isExp) saveExperiment(targetData);
  }

  saveRegular(data);

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

    // Claude lesson updater — fire-and-forget, runs after evolveThresholds
    import("./scripts/claude-lesson-updater.js")
      .then(m => m.claudeUpdateLessons())
      .catch(e => log("claude_review_error", `claudeUpdateLessons failed: ${e.message}`));
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

  // Cross-role learning — tag screener-catchable failures
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

  const isExperiment = perf.variant?.startsWith("exp_");
  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    context,
    category: inferCategory({ rule, tags, perf }),
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    pool: perf.pool,
    source: isExperiment ? "experiment" : "regular",
    experiment_id: isExperiment ? perf.variant : null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Infer lesson category from rule text, tags, and performance data.
 * Categories: "sizing" | "taking_profit" | "stop_loss" | "strategy" | "general"
 */
function inferCategory({ rule = "", tags, perf = {} } = {}) {
  const r = rule.toLowerCase();
  const t = (Array.isArray(tags) ? tags : []).map(s => s.toLowerCase());

  if (t.includes("sizing") || t.includes("position_size") || r.includes("position size") || r.includes("amount_sol") || r.includes("deploy amount") || r.includes("size"))
    return "sizing";

  const isBadPnl = typeof perf.pnl_pct === "number" && perf.pnl_pct < -3;
  const isGoodPnl = typeof perf.pnl_pct === "number" && perf.pnl_pct > 3;

  if (t.some(x => ["tp", "take_profit", "profit", "yield-exit"].includes(x)) || r.includes("take profit") || r.includes("yield exit") || r.includes("exit at") || (isGoodPnl && (r.includes("close") || r.includes("exit"))))
    return "taking_profit";

  if (t.some(x => ["sl", "stop_loss", "stop loss", "emergency", "oor", "volume_collapse", "failed"].includes(x)) || r.includes("stop loss") || r.includes("emergency") || r.includes("oor") || r.includes("out of range") || r.includes("volume collapse") || (isBadPnl && r.includes("close")))
    return "stop_loss";

  if (t.some(x => ["strategy", "bid_ask", "spot", "curve", "bins", "efficient"].includes(x)) || r.includes("strategy") || r.includes("bin_range") || r.includes("bin_step") || r.includes("bid_ask") || r.includes("in-range efficiency") || r.includes("volatility"))
    return "strategy";

  return "general";
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
  // Exclude experiment positions — they use different TP/SL rules and would skew evolution
  if (perfData) perfData = perfData.filter(p => !p.variant?.startsWith("exp_"));
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
    category: "general",
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
 * Extract a structural similarity key from a rule text.
 * Used by addLesson() to detect same-type lessons that should update in place
 * rather than accumulate as conflicting duplicates.
 *
 * Returns a string key like "max_loss_pct" or "block_strategy:bid_ask", or null
 * if the rule doesn't match any extractable pattern.
 *
 * Mirrors the regex patterns in lesson-rules.js extractRules().
 */
export function getLessonRuleType(rule) {
  if (!rule) return null;
  const upper = rule.toUpperCase();

  // block_strategy — discriminated by strategy name (check before block_high_volatility)
  const strategyMatch = rule.match(/strategy[=:"'\s]+(spot|bid_ask|fee_compounding|multi_layer|partial_harvest|custom_ratio_spot)/i);
  if (strategyMatch && (upper.includes("AVOID") || upper.includes("NEVER") || upper.includes("FAILED"))) {
    return `block_strategy:${strategyMatch[1].toLowerCase().trim()}`;
  }

  // block_high_volatility
  if (rule.match(/volatility[=\s]*[>≥]\s*\d+/i) && (upper.includes("AVOID") || upper.includes("SKIP") || upper.includes("NEVER"))) {
    return "block_high_volatility";
  }

  // block_low_fees
  if (rule.match(/global_fees_sol\s*[<≤]\s*\d+/i)) return "block_low_fees";

  // block_concentration — discriminated by field
  if (rule.match(/top_10[_\w]*\s*[>≥]\s*\d+/i) && (upper.includes("AVOID") || upper.includes("SKIP") || upper.includes("HARD SKIP"))) {
    return "block_concentration:top_10_pct";
  }
  if (rule.match(/bundlers?\s*[>≥]\s*\d+/i) && (upper.includes("AVOID") || upper.includes("SKIP") || upper.includes("HARD SKIP"))) {
    return "block_concentration:bundlers_pct";
  }

  // max_deploy_sol
  if (
    rule.match(/(?:more\s+than|cap(?:ped)?\s+(?:sizing|deploy)?\s*at|max(?:imum)?\s+(?:deploy\s+)?|deploy\s+max\s+)\s*\d+(?:\.\d+)?\s*sol/i) &&
    (upper.includes("NEVER") || upper.includes("AVOID") || upper.includes("DO NOT") || upper.includes("CAP") || upper.includes("MAX"))
  ) {
    return "max_deploy_sol";
  }

  // force_close_aged_losing
  if (
    rule.match(/(?:holding|hold).*?\d+\s*m(?:in)?/i) &&
    rule.match(/pnl[_\w]*\s*[<≤]\s*[+-]?\d+/i) &&
    (upper.includes("AVOID") || upper.includes("NEVER"))
  ) {
    return "force_close_aged_losing";
  }

  // oor_grace_period
  if (
    rule.match(/(?:oor|out.of.range)[^<>]*[<≤]\s*\d+\s*m(?:in)?/i) &&
    (upper.includes("DO NOT") || upper.includes("AVOID CLOS") || upper.includes("NOT AUTO-CLOSE") || upper.includes("OFTEN RECOVERS"))
  ) {
    return "oor_grace_period";
  }

  // max_loss_pct
  if (
    rule.match(/(?:hold(?:ing)?\s+(?:a\s+)?positions?\s+below\s+[-−]?|stop\s+loss\s+at\s+[-−]?|cut\s+(?:the\s+)?losses?\s+(?:at\s+)?[-−]?)\d+(?:\.\d+)?\s*%/i) &&
    (upper.includes("NEVER") || upper.includes("AVOID") || upper.includes("DO NOT") || upper.includes("STOP LOSS") || upper.includes("CUT LOSS"))
  ) {
    return "max_loss_pct";
  }

  // min_profit_pct
  if (
    rule.match(/(?:take[\s-]*profit|tp)\s+(?:at\s+|when\s+pnl[_\s]*[>≥]=?\s*)?[+]?\d+(?:\.\d+)?\s*%/i) ||
    rule.match(/(?:close|exit)\s+(?:at\s+)?[+]?\d+(?:\.\d+)?\s*%\s*profit/i)
  ) {
    return "min_profit_pct";
  }

  // protect_null_volatility
  if (
    (upper.includes("NULL") || upper.includes("VOLATILITY=NULL")) &&
    (upper.includes("AVOID CLOS") || upper.includes("DO NOT CLOSE"))
  ) {
    return "protect_null_volatility";
  }

  // reserve_slot — discriminated by token name
  const reserveSlotMatch = rule.match(/(?:spare|reserve|keep|hold)\s+\d+\s+slots?\s+(?:for|to deploy)\s+([\w][\w-]*)/i);
  if (reserveSlotMatch) {
    return `reserve_slot:${reserveSlotMatch[1].toUpperCase().trim()}`;
  }

  return null;
}

/**
 * Add a manual lesson (e.g. from operator observation).
 * If an existing lesson of the same structural type already exists, it is
 * updated in place instead of appending a duplicate (prevents conflicting rules).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null, category = null, source = "regular" } = {}) {
  const src = source || "regular";

  // For regular lessons, check if a same-type lesson already exists and update it
  if (src !== "experiment") {
    const newKey = getLessonRuleType(rule);
    if (newKey) {
      const data = loadRegular();
      const idx = data.lessons.findIndex((l) => getLessonRuleType(l.rule) === newKey);
      if (idx !== -1) {
        const prev = data.lessons[idx].rule;
        data.lessons[idx].rule = rule;
        data.lessons[idx].updated_at = new Date().toISOString();
        saveRegular(data);
        log("lessons", `Lesson updated in place [${src}] (${newKey}): "${prev}" → "${rule}"`);
        return;
      }
    }
  }

  const lesson = {
    id: Date.now(),
    rule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    category: category || inferCategory({ rule, tags }),
    source: src,
    created_at: new Date().toISOString(),
  };
  if (src === "experiment") {
    const data = loadExperiment();
    data.lessons.push(lesson);
    saveExperiment(data);
  } else {
    const data = loadRegular();
    data.lessons.push(lesson);
    saveRegular(data);
  }
  log("lessons", `Manual lesson added [${src}]${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${rule}`);
}

/**
 * Get lessons derived from experiment positions.
 * @param {string} [experimentId] - Filter to a specific experiment (e.g. "exp_12345")
 * @returns {Object[]}
 */
export function getExperimentLessons(experimentId = null) {
  let lessons = loadExperiment().lessons;
  if (experimentId) lessons = lessons.filter(l => l.experiment_id === experimentId);
  return lessons;
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  // Search both files
  const reg = loadRegular();
  let lesson = reg.lessons.find((l) => l.id === id);
  if (lesson) {
    const pinnedCount = reg.lessons.filter((l) => l.pinned && l.id !== id).length;
    if (pinnedCount >= 10) return { found: true, pinned: false, id, rule: lesson.rule, error: "Max 10 pinned lessons reached" };
    lesson.pinned = true;
    saveRegular(reg);
    log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
    return { found: true, pinned: true, id, rule: lesson.rule };
  }
  const exp = loadExperiment();
  lesson = exp.lessons.find((l) => l.id === id);
  if (lesson) {
    lesson.pinned = true;
    saveExperiment(exp);
    log("lessons", `Pinned experiment lesson ${id}: ${lesson.rule.slice(0, 60)}`);
    return { found: true, pinned: true, id, rule: lesson.rule };
  }
  return { found: false };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const reg = loadRegular();
  let lesson = reg.lessons.find((l) => l.id === id);
  if (lesson) { lesson.pinned = false; saveRegular(reg); return { found: true, pinned: false, id, rule: lesson.rule }; }
  const exp = loadExperiment();
  lesson = exp.lessons.find((l) => l.id === id);
  if (lesson) { lesson.pinned = false; saveExperiment(exp); return { found: true, pinned: false, id, rule: lesson.rule }; }
  return { found: false };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, source = null, limit = 30 } = {}) {
  const data = source === "experiment" ? loadExperiment()
             : source === "regular"   ? loadRegular()
             : loadAll();
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
  const reg = loadRegular();
  const regBefore = reg.lessons.length;
  reg.lessons = reg.lessons.filter((l) => l.id !== id);
  if (reg.lessons.length < regBefore) { saveRegular(reg); return regBefore - reg.lessons.length; }
  const exp = loadExperiment();
  const expBefore = exp.lessons.length;
  exp.lessons = exp.lessons.filter((l) => l.id !== id);
  if (exp.lessons.length < expBefore) { saveExperiment(exp); return expBefore - exp.lessons.length; }
  return 0;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const kw = keyword.toLowerCase();
  const reg = loadRegular();
  const exp = loadExperiment();
  const regBefore = reg.lessons.length;
  const expBefore = exp.lessons.length;
  reg.lessons = reg.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  exp.lessons = exp.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  saveRegular(reg);
  saveExperiment(exp);
  return (regBefore - reg.lessons.length) + (expBefore - exp.lessons.length);
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const reg = loadRegular();
  const exp = loadExperiment();
  const count = reg.lessons.length + exp.lessons.length;
  reg.lessons = [];
  exp.lessons = [];
  saveRegular(reg);
  saveExperiment(exp);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = loadRegular();
  const count = data.performance.length;
  data.performance = [];
  saveRegular(data);
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

  const data = loadRegular();
  const allLessons = data.lessons;
  if (allLessons.length === 0) return null;

  // No caps — inject all lessons so the agent always applies everything it has learned
  const PINNED_CAP  = Infinity;
  const ROLE_CAP    = Infinity;
  const RECENT_CAP  = maxLessons ?? Infinity;

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = allLessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = allLessons
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
    ? allLessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  // Split into HARD RULES (enforceable, blocking) and GUIDANCE (preferences)
  const HARD_KEYWORDS = ["AVOID:", "AVOID ", "NEVER ", "NEVER:", "SKIP:", "SKIP ", "HARD SKIP", "HARD RULE", "DO NOT ", "MUST NOT", "BLOCKED", "FAILED:", "FAILED "];
  const isHard = (l) => HARD_KEYWORDS.some((kw) => (l.rule || "").toUpperCase().includes(kw));

  const hardRules = selected.filter(isHard);
  const guidanceRules = selected.filter((l) => !isHard(l));

  const sections = [];

  // ── HARD RULES section (numbered checklist — these are enforced by the system) ──
  if (hardRules.length > 0) {
    const hardLines = hardRules.map((l, i) => {
      const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
      const pin  = l.pinned ? "📌 " : "";
      return `${i + 1}. ${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
    }).join("\n");
    sections.push(
      `── HARD RULES (${hardRules.length}) — SYSTEM-ENFORCED: violations are BLOCKED ──\n` +
      `These rules are checked by the executor before any tool call executes.\n` +
      `❌ VIOLATION = ACTION BLOCKED. No exceptions.\n\n` +
      hardLines
    );
  }

  // ── GUIDANCE section grouped by category ──
  if (guidanceRules.length > 0) {
    const CATEGORY_META = {
      sizing:        { label: "SIZING",        when: "CHECK BEFORE: deploy_position (determines position size)" },
      taking_profit:{ label: "TAKING PROFIT", when: "CHECK BEFORE: close_position on TP / yield-exit decisions" },
      stop_loss:    { label: "STOP LOSS",      when: "CHECK BEFORE: close_position on loss / OOR / emergency decisions" },
      strategy:     { label: "STRATEGY",      when: "CHECK BEFORE: deploy_position (strategy, bin_range, bin_step choices)" },
      general:      { label: "GENERAL",       when: "ALWAYS APPLY" },
    };

    const byCategory = {};
    for (const l of guidanceRules) {
      const cat = l.category || inferCategory({ rule: l.rule, tags: l.tags });
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(l);
    }

    const ORDER = ["sizing", "taking_profit", "stop_loss", "strategy", "general"];
    for (const cat of ORDER) {
      const group = byCategory[cat];
      if (!group?.length) continue;
      const meta = CATEGORY_META[cat];
      sections.push(`── GUIDANCE: ${meta.label} (${group.length}) — ${meta.when} ──\n` + fmt(group));
    }
    for (const [cat, group] of Object.entries(byCategory)) {
      if (!ORDER.includes(cat) && group.length) {
        sections.push(`── GUIDANCE: ${cat.toUpperCase()} (${group.length}) ──\n` + fmt(group));
      }
    }
  }

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
