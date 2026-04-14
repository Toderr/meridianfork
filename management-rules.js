/**
 * Deterministic management rule engine.
 *
 * Evaluates each position against the same hard rules previously sent to the LLM,
 * returning { action, reason } per position. Falls back to LLM only when a position
 * has an unparseable natural-language instruction.
 */
import { config } from "./config.js";

/**
 * @param {Object} p  — enriched position (from positionData in index.js)
 * @returns {{ action: "close"|"claim"|"stay", reason: string, needsLlm?: boolean }}
 */
export function evaluatePosition(p) {
  const pnl     = p.pnl;
  const pnlPct  = pnl?.pnl_pct ?? null;
  const age     = p.age_minutes ?? 0;
  const feeTvl  = p.feeTvl24h;
  const bins    = p.binsAbove;
  const vol     = p.volatility ?? null;
  const fees    = parseFloat(pnl?.unclaimed_fee_usd) || 0;
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

  // ── Rule 3: Yield-exit ─────────────────────────────────────────────
  if (feeTvl !== null && age >= config.management.minAgeForYieldExit) {
    if (feeTvl < config.management.minFeeTvl24h) {
      // Skip if position is at a loss
      if (pnlPct !== null && pnlPct < 0) {
        // At loss — suppress yield-exit
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
