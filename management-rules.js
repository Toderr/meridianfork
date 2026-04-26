/**
 * Deterministic management rule engine.
 *
 * Evaluates each position against the same hard rules previously sent to the LLM,
 * returning { action, reason } per position. Falls back to LLM only when a position
 * has an unparseable natural-language instruction.
 */
import { config } from "./config.js";
import { getRecentFeeRate } from "./pool-memory.js";

// HARDCODED: force-close at HARD_HOLD_CAP_MIN minutes hold unless fees are still
// accruing fast.
// History: original $2/hr backdoor allowed 4 worst stale positions (COPPERINU 1120m,
// Iroha 1815m, abcdefg 1472m, milkers 1015m) to bypass the cap; locked to 999 sentinel
// on 2026-04-23. Re-opened later same day to $4/hr after full-data audit confirmed
// the 120m+ bucket only loses on average — productive positions earning ≥$4/hr over
// the last 30m are still allowed to extend.
// 2026-04-27: tightened 120 → 90 after post-rebuild audit (n=108) showed `120m+`
// bucket = 30.8% wr / -0.26% avg (n=13) and `60-120m` = 93.1% wr / +0.21% avg
// (n=58). The fee-rate escape ($4/hr over last 30m) still permits genuine
// compounders to extend past 90m.
const HARD_HOLD_CAP_MIN = 90;
const HARD_HOLD_FEE_WINDOW_MIN = 30;
const HARD_HOLD_MIN_FEE_RATE_USD_HR = 4;

/**
 * @param {Object} p  — enriched position (from positionData in index.js)
 * @returns {{ action: "close"|"claim"|"stay", reason: string, needsLlm?: boolean }}
 */
export function evaluatePosition(p) {
  const pnl     = p.pnl;
  const pnlPctPrice = pnl?.pnl_pct ?? null;  // price-only %
  const initUsd = p.initial_value_usd || p.initial_value_usd_api || 0;
  const fees    = parseFloat(pnl?.unclaimed_fee_usd) || 0;
  const feePct  = (initUsd > 0 && fees > 0) ? fees / initUsd * 100 : 0;
  const pnlPct  = pnlPctPrice !== null ? pnlPctPrice + feePct : null;  // fee-inclusive for threshold comparisons
  const age     = p.age_minutes ?? 0;
  const feeTvl  = p.feeTvl24h;
  const bins    = p.binsAbove;
  const vol     = p.volatility ?? null;
  const instr   = p.instruction;

  // ── Rule 0: Lesson force-hold — overrides everything ───────────────
  if (p._lesson_force_hold) {
    return { action: "stay", reason: `Lesson force-hold: ${p._lesson_force_hold}` };
  }

  // ── Rule 1 & 2: Instruction handling ───────────────────────────────
  if (instr) {
    // Manual management — skip all rules, no LLM fallback
    if (/\b(manual|do not (close|manage)|hands.off)\b/i.test(instr)) {
      return { action: "stay", reason: `Manual management: "${instr}"` };
    }
    // Try to parse deterministically: "close at X%"
    const profitMatch = instr.toLowerCase().match(/close at ([+-]?\d+(?:\.\d+)?)\s*%/);
    if (profitMatch) {
      const target = parseFloat(profitMatch[1]);
      if (pnlPct !== null && pnlPct >= target) {
        return { action: "close", reason: `Instruction: "${instr}" (pnl_pct=${pnlPct}%)` };
      }
      // Condition not met → HOLD, skip remaining rules
      return { action: "stay", reason: `Instruction pending: "${instr}" (pnl_pct=${pnlPct}%)` };
    }
    // Unparseable instruction → needs LLM interpretation
    return { action: "stay", reason: `Unparseable instruction: "${instr}"`, needsLlm: true };
  }

  // ── Rule 3: Hold-time cut — DISABLED (30-Mar baseline restore) ──────
  // Original hold-time cut rules (age>=30 & pnl<0; age>=15 & pnl<-0.3)
  // disabled per user request to match March 30 behavior.

  // ── Rule 3b: HARDCODED 120m hold cap with fee-rate escape ─────────
  // After HARD_HOLD_CAP_MIN minutes, force-close unless fees are still
  // accruing above HARD_HOLD_MIN_FEE_RATE_USD_HR in the last
  // HARD_HOLD_FEE_WINDOW_MIN minutes. Data-driven from fee-inclusive audit.
  if (age >= HARD_HOLD_CAP_MIN && p.pool && p.position) {
    const rate = getRecentFeeRate(p.pool, p.position, HARD_HOLD_FEE_WINDOW_MIN);
    if (rate !== null && rate >= HARD_HOLD_MIN_FEE_RATE_USD_HR) {
      // Still fee-productive — let it run, but mark the decision
      // (fall through to other rules)
    } else {
      const reasonRate = rate === null ? "insufficient snapshot history" : `${rate.toFixed(2)} $/hr`;
      return {
        action: "close",
        reason: `Hard hold cap: ${age}m >= ${HARD_HOLD_CAP_MIN}m and last-${HARD_HOLD_FEE_WINDOW_MIN}m fee rate ${reasonRate} < $${HARD_HOLD_MIN_FEE_RATE_USD_HR}/hr`,
      };
    }
  }

  // ── Rule 4: Yield-exit ─────────────────────────────────────────────
  if (feeTvl !== null && age >= config.management.minAgeForYieldExit) {
    if (feeTvl < config.management.minFeeTvl24h) {
      // Skip if position is at a loss
      if (pnlPct !== null && pnlPct < 0) {
        // At loss — suppress yield-exit
      } else if (pnlPct !== null && pnlPct >= 0.5) {
        // 2026-04-27 audit (n=108): yield_exit fired on 50% of closes at
        // avg +0.32% while peak_avg was +0.48%. Profitable positions are
        // being cut at half their peak. Skip yield_exit entirely while
        // pnl_pct ≥ +0.5% — let TP / soft-peak / hard-hold cap handle exit.
        // (Subsumes the older "+30m runway" grace.)
      } else {
        // Grace zone: within 1% of threshold and profitable → hold
        const gap = config.management.minFeeTvl24h - feeTvl;
        if (gap > 1) {
          return { action: "close", reason: `Yield-exit: fee_tvl ${feeTvl.toFixed(1)}% < ${config.management.minFeeTvl24h}% min` };
        }
        // Within 1% grace — stay
      }
    }
  }

  // ── Rule 4: Out-of-range (bins above) ──────────────────────────────
  if (bins !== null && bins > 0) {
    let threshold = config.management.outOfRangeBinsToClose;
    // High-volatility young positions get +2 bins tolerance
    if (vol !== null && vol >= 5 && age < 60) {
      threshold += 2;
    }
    // 2026-04-27 audit: oor fired on 30% of closes at avg +0.31% while
    // peak_avg was +0.44%. Profitable positions need 2x more drift before
    // OOR cuts them — same peak-preservation principle as yield_exit grace.
    if (pnlPct !== null && pnlPct >= 0.5) {
      threshold *= 2;
    }
    if (bins >= threshold) {
      return { action: "close", reason: `OOR ${bins} bins above range (threshold ${threshold})` };
    }
  }

  // ── Claim rule ─────────────────────────────────────────────────────
  if (fees >= config.management.minClaimAmount) {
    return { action: "claim", reason: `Unclaimed fees $${fees.toFixed(2)} >= $${config.management.minClaimAmount}` };
  }

  // ── Default: stay ──────────────────────────────────────────────────
  return { action: "stay", reason: "No rules triggered" };
}

/**
 * Run the rule engine on all positions.
 * @param {Array} positionData
 * @returns {{ closes: Array, claims: Array, stays: Array, needsLlm: Array, report: string }}
 */
export function evaluateAll(positionData) {
  const closes = [];
  const claims = [];
  const stays  = [];
  const needsLlm = [];
  const reportLines = [];

  for (const p of positionData) {
    const result = evaluatePosition(p);
    const pair = p.pair || p.pool_address?.slice(0, 8) || "?";

    if (result.needsLlm) {
      needsLlm.push({ ...p, _ruleResult: result });
      reportLines.push(`${pair}: LLM — ${result.reason}`);
    } else if (result.action === "close") {
      closes.push({ ...p, _ruleResult: result });
      reportLines.push(`${pair}: CLOSE — ${result.reason}`);
    } else if (result.action === "claim") {
      claims.push({ ...p, _ruleResult: result });
      reportLines.push(`${pair}: CLAIM — ${result.reason}`);
    } else {
      stays.push({ ...p, _ruleResult: result });
      reportLines.push(`${pair}: STAY — ${result.reason}`);
    }
  }

  return { closes, claims, stays, needsLlm, report: reportLines.join("\n") };
}
