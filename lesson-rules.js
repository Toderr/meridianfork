/**
 * Lesson rule extractor and compliance checker.
 *
 * Parses freeform lesson text into structured, code-enforceable rules.
 * These rules are used in three places:
 *   1. Pre-agent filtering in screening cycle (filter bad candidates)
 *   2. Pre-agent enforcement in management cycle (force close/hold)
 *   3. Executor safety checks (last line of defense before on-chain action)
 */

import fs from "fs";
import { log } from "./logger.js";

const LESSONS_FILE = "./lessons.json";

/** Load regular lessons only — experiment lessons use different TP/SL context. */
function loadLessons() {
  if (!fs.existsSync(LESSONS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    return data.lessons || [];
  } catch {
    return [];
  }
}

// ─── Rule Extraction ──────────────────────────────────────────

/**
 * Determine if a lesson is a HARD RULE (must be enforced) vs GUIDANCE (prefer/consider).
 * HARD RULES contain action-blocking keywords.
 */
export function isHardRule(rule) {
  if (!rule) return false;
  const upper = rule.toUpperCase();
  return (
    upper.includes("AVOID:") ||
    upper.includes("AVOID ") ||
    upper.includes("NEVER ") ||
    upper.includes("NEVER:") ||
    upper.includes("SKIP:") ||
    upper.includes("SKIP ") ||
    upper.includes("HARD SKIP") ||
    upper.includes("HARD RULE") ||
    upper.includes("DO NOT ") ||
    upper.includes("MUST NOT") ||
    upper.includes("BLOCKED") ||
    upper.includes("FAILED:") ||
    upper.includes("FAILED ")
  );
}

/**
 * Extract structured rules from all lessons for a given agent type.
 *
 * @param {string} agentType - "SCREENER" | "MANAGER" | "GENERAL"
 * @returns {{ screening: Rule[], management: Rule[], unmatched: string[] }}
 */
export function extractRules(agentType = "GENERAL") {
  const lessons = loadLessons(); // regular file only — experiments already separated
  const hardLessons = lessons.filter((l) => isHardRule(l.rule));

  const screening = [];
  const management = [];
  const unmatched = [];

  for (const lesson of hardLessons) {
    const rule = lesson.rule || "";
    const upper = rule.toUpperCase();
    let matched = false;

    // ── Screening rules ──────────────────────────────────────

    // AVOID strategy="X" — block specific strategy (only known strategy names)
    const KNOWN_STRATEGIES = ["spot", "bid_ask", "fee_compounding", "multi_layer", "partial_harvest", "custom_ratio_spot"];
    const strategyMatch = rule.match(/strategy[=:"'\s]+(spot|bid_ask|fee_compounding|multi_layer|partial_harvest|custom_ratio_spot)/i);
    if (strategyMatch && (upper.includes("AVOID") || upper.includes("NEVER") || upper.includes("FAILED"))) {
      const strategy = strategyMatch[1].toLowerCase().trim();
      // Extract volatility condition if present
      const volMatch = rule.match(/volatility[=<>\s]+(\d+(?:\.\d+)?)/i);
      const volOp = volMatch ? (rule.includes("volatility<") || rule.includes("volatility <") ? "lt" : rule.includes("volatility>") || rule.includes("volatility >") ? "gt" : "eq") : null;
      const volVal = volMatch ? parseFloat(volMatch[1]) : null;

      screening.push({
        type: "block_strategy",
        strategy,
        volatility_op: volOp,
        volatility_val: volVal,
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    // AVOID high volatility deploys — block pool with volatility above threshold
    const highVolMatch = rule.match(/volatility[=\s]*([>≥])\s*(\d+(?:\.\d+)?)/i);
    if (highVolMatch && (upper.includes("AVOID") || upper.includes("SKIP") || upper.includes("NEVER"))) {
      const threshold = parseFloat(highVolMatch[2]);
      screening.push({
        type: "block_high_volatility",
        threshold,
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    // SKIP: global_fees_sol < X
    const feesMatch = rule.match(/global_fees_sol\s*[<≤]\s*(\d+(?:\.\d+)?)/i);
    if (feesMatch) {
      const threshold = parseFloat(feesMatch[1]);
      screening.push({
        type: "block_low_fees",
        threshold,
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    // AVOID top_10_pct > X OR bundlers > Y
    const top10Match = rule.match(/top_10[_\w]*[_pct]*\s*[>≥]\s*(\d+(?:\.\d+)?)/i);
    if (top10Match && (upper.includes("AVOID") || upper.includes("SKIP") || upper.includes("HARD SKIP"))) {
      const threshold = parseFloat(top10Match[1]);
      screening.push({
        type: "block_concentration",
        field: "top_10_pct",
        threshold,
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    const bundlerMatch = rule.match(/bundlers?[_pct]*\s*[>≥]\s*(\d+(?:\.\d+)?)/i);
    if (bundlerMatch && (upper.includes("AVOID") || upper.includes("SKIP") || upper.includes("HARD SKIP"))) {
      const threshold = parseFloat(bundlerMatch[1]);
      screening.push({
        type: "block_concentration",
        field: "bundlers_pct",
        threshold,
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    // NEVER deploy more than X SOL / cap sizing at X SOL
    const maxSolMatch = rule.match(/(?:more\s+than|cap(?:ped)?\s+(?:sizing|deploy)?\s*at|max(?:imum)?\s+(?:deploy\s+)?|deploy\s+max\s+)\s*(\d+(?:\.\d+)?)\s*sol/i);
    if (maxSolMatch && (upper.includes("NEVER") || upper.includes("AVOID") || upper.includes("DO NOT") || upper.includes("CAP") || upper.includes("MAX"))) {
      const maxSol = parseFloat(maxSolMatch[1]);
      if (!isNaN(maxSol) && maxSol > 0) {
        screening.push({
          type: "max_deploy_sol",
          max_sol: maxSol,
          source: rule,
          lesson_id: lesson.id,
        });
        matched = true;
      }
    }

    // ── Management rules ─────────────────────────────────────

    // AVOID holding ... > Xm/Xmin ... pnl < 0  →  force close
    const holdAgeMatch = rule.match(/(?:holding|hold).*?(\d+)\s*m(?:in)?/i);
    const holdPnlMatch = rule.match(/pnl[_\w]*\s*[<≤]\s*([+-]?\d+(?:\.\d+)?)/i);
    if (holdAgeMatch && holdPnlMatch && (upper.includes("AVOID") || upper.includes("NEVER"))) {
      const maxAge = parseInt(holdAgeMatch[1]);
      const maxPnl = parseFloat(holdPnlMatch[1]);
      management.push({
        type: "force_close_aged_losing",
        max_age_minutes: maxAge,
        max_pnl_pct: maxPnl,
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    // OOR < Xm ... do NOT close / AVOID closing OOR < Xm
    const oorGraceMatch = rule.match(/(?:oor|out.of.range)[^<>]*[<≤]\s*(\d+)\s*m(?:in)?/i);
    if (oorGraceMatch && (upper.includes("DO NOT") || upper.includes("AVOID CLOS") || upper.includes("NOT AUTO-CLOSE") || upper.includes("OFTEN RECOVERS"))) {
      const graceMinutes = parseInt(oorGraceMatch[1]);
      management.push({
        type: "oor_grace_period",
        grace_minutes: graceMinutes,
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    // NEVER hold position below -X% pnl / stop loss at X%
    // Only match explicit stop-loss intent — not incidental "pnl < X%" in descriptions
    const stopLossMatch = rule.match(/(?:hold(?:ing)?\s+(?:a\s+)?position[s]?\s+below\s+[-−]?|stop\s+loss\s+at\s+[-−]?|cut\s+(?:the\s+)?losses?\s+(?:at\s+)?[-−]?)(\d+(?:\.\d+)?)\s*%/i);
    if (stopLossMatch && (upper.includes("NEVER") || upper.includes("DO NOT") || upper.includes("STOP LOSS") || upper.includes("CUT LOSS"))) {
      const threshold = -Math.abs(parseFloat(stopLossMatch[1]));
      if (!isNaN(threshold)) {
        management.push({
          type: "max_loss_pct",
          threshold_pct: threshold,
          source: rule,
          lesson_id: lesson.id,
        });
        matched = true;
      }
    }

    // TAKE PROFIT at X% / TP at X% / close at X% profit
    const takeProfitMatch = rule.match(/(?:take[\s-]*profit|tp)\s+(?:at\s+|when\s+pnl[_\s]*[>≥]=?\s*)?[+]?(\d+(?:\.\d+)?)\s*%/i)
      || rule.match(/(?:close|exit)\s+(?:at\s+)?[+]?(\d+(?:\.\d+)?)\s*%\s*profit/i);
    if (takeProfitMatch) {
      const threshold = parseFloat(takeProfitMatch[1]);
      if (!isNaN(threshold) && threshold > 0) {
        management.push({
          type: "min_profit_pct",
          threshold_pct: threshold,
          source: rule,
          lesson_id: lesson.id,
        });
        matched = true;
      }
    }

    // AVOID closing null-volatility positions / positions with volatility=null
    if ((upper.includes("NULL") || upper.includes("VOLATILITY=NULL")) &&
        (upper.includes("AVOID CLOS") || upper.includes("DO NOT CLOSE"))) {
      management.push({
        type: "protect_null_volatility",
        source: rule,
        lesson_id: lesson.id,
      });
      matched = true;
    }

    if (!matched) {
      unmatched.push(rule);
    }
  }

  // reserve_slot parsed from ALL lessons (no HARD keyword required — it's a user directive, not a performance lesson)
  for (const lesson of lessons) {
    const rule = lesson.rule || "";
    const reserveSlotMatch = rule.match(/(?:spare|reserve|keep|hold)\s+(\d+)\s+slot[s]?\s+(?:for|to deploy)\s+([\w][\w-]*)/i);
    if (reserveSlotMatch) {
      const count = parseInt(reserveSlotMatch[1]);
      const token = reserveSlotMatch[2].toUpperCase().trim();
      if (count > 0 && token) {
        screening.push({
          type: "reserve_slot",
          count,
          token,
          source: rule,
          lesson_id: lesson.id,
        });
      }
    }
  }

  // Deduplicate by type+key fields
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter((r) => {
      const key = JSON.stringify({ type: r.type, strategy: r.strategy, threshold: r.threshold, max_age_minutes: r.max_age_minutes, threshold_pct: r.threshold_pct, max_sol: r.max_sol, token: r.token });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    screening: dedup(screening),
    management: dedup(management),
    unmatched,
  };
}

// ─── Compliance Checkers ──────────────────────────────────────

/**
 * Check if a deploy_position call complies with extracted screening rules.
 *
 * @param {Object} args - deploy_position args (strategy, bin_step, pool info from context)
 * @param {Object} poolData - optional pool metadata (volatility, global_fees_sol, top_10_pct, bundlers_pct)
 * @param {Rule[]} rules - from extractRules().screening
 * @returns {{ pass: boolean, violations: string[] }}
 */
export function checkDeployCompliance(args, poolData, rules) {
  const violations = [];
  const strategy = (args.strategy || "").toLowerCase();
  const volatility = poolData?.volatility ?? args.volatility ?? null;
  const globalFeesSol = poolData?.global_fees_sol ?? args.global_fees_sol ?? null;
  const top10Pct = poolData?.top_10_pct ?? args.top_10_pct ?? null;
  const bundlersPct = poolData?.bundlers_pct ?? args.bundlers_pct ?? null;

  for (const rule of rules) {
    switch (rule.type) {
      case "block_strategy":
        if (strategy && strategy === rule.strategy) {
          // Only enforce when there's a specific volatility condition — otherwise
          // the rule is too context-specific to enforce blindly in code.
          if (rule.volatility_val !== null && volatility !== null) {
            let conditionMet = false;
            if (rule.volatility_op === "lt" && volatility < rule.volatility_val) conditionMet = true;
            else if (rule.volatility_op === "gt" && volatility > rule.volatility_val) conditionMet = true;
            else if (rule.volatility_op === "eq" && Math.abs(volatility - rule.volatility_val) < 0.5) conditionMet = true;
            if (conditionMet) {
              violations.push(`Strategy "${strategy}" blocked by lesson rule (volatility=${volatility} matches condition): ${rule.source}`);
            }
          }
          // No volatility condition or unknown volatility → prompt-only, not enforced in code
        }
        break;

      case "block_high_volatility":
        if (volatility !== null && volatility > rule.threshold) {
          violations.push(`Volatility ${volatility} exceeds lesson limit (>${rule.threshold}): ${rule.source}`);
        }
        break;

      case "block_low_fees":
        if (globalFeesSol !== null && globalFeesSol < rule.threshold) {
          violations.push(`global_fees_sol ${globalFeesSol} below lesson minimum (${rule.threshold}): ${rule.source}`);
        }
        break;

      case "block_concentration":
        if (rule.field === "top_10_pct" && top10Pct !== null && top10Pct > rule.threshold) {
          violations.push(`top_10_pct ${top10Pct}% exceeds lesson limit (${rule.threshold}%): ${rule.source}`);
        }
        if (rule.field === "bundlers_pct" && bundlersPct !== null && bundlersPct > rule.threshold) {
          violations.push(`bundlers_pct ${bundlersPct}% exceeds lesson limit (${rule.threshold}%): ${rule.source}`);
        }
        break;

      case "max_deploy_sol": {
        const sol = args.amount_y ?? args.amount_sol ?? 0;
        if (sol > rule.max_sol) {
          violations.push(`Deploy amount ${sol} SOL exceeds lesson cap (${rule.max_sol} SOL): ${rule.source}`);
        }
        break;
      }
      // reserve_slot is enforced in executor.js (needs live positions list)
    }
  }

  return { pass: violations.length === 0, violations };
}

/**
 * Check if a position should be force-closed or force-held based on management rules.
 *
 * @param {Object} position - position data with pnl, age_minutes, minutes_out_of_range, volatility
 * @param {Rule[]} rules - from extractRules().management
 * @returns {{ action: "force_close"|"force_hold"|null, reason: string|null }}
 */
export function checkPositionCompliance(position, rules) {
  const pnlPct = position.pnl?.pnl_pct ?? null;
  const ageMinutes = position.age_minutes ?? 0;
  const minutesOOR = position.minutes_out_of_range ?? 0;
  const volatility = position.volatility ?? null;
  const inRange = position.in_range ?? true;

  for (const rule of rules) {
    switch (rule.type) {
      case "force_close_aged_losing":
        if (
          pnlPct !== null &&
          ageMinutes > rule.max_age_minutes &&
          pnlPct <= rule.max_pnl_pct
        ) {
          return {
            action: "force_close",
            reason: `Lesson rule: ${rule.source}`,
          };
        }
        break;

      case "oor_grace_period":
        if (!inRange && minutesOOR > 0 && minutesOOR < rule.grace_minutes) {
          return {
            action: "force_hold",
            reason: `OOR grace period (${minutesOOR}m < ${rule.grace_minutes}m minimum): ${rule.source}`,
          };
        }
        break;

      case "protect_null_volatility":
        if (volatility === null && pnlPct !== null && pnlPct < 0) {
          return {
            action: "force_hold",
            reason: `Lesson rule protects null-volatility position from close: ${rule.source}`,
          };
        }
        break;

      case "max_loss_pct":
        if (pnlPct !== null && pnlPct < rule.threshold_pct) {
          return {
            action: "force_close",
            reason: `Lesson stop-loss: pnl ${pnlPct.toFixed(2)}% < ${rule.threshold_pct}%: ${rule.source}`,
          };
        }
        break;

      case "min_profit_pct":
        if (pnlPct !== null && pnlPct >= rule.threshold_pct) {
          return {
            action: "force_close",
            reason: `Lesson take-profit: pnl ${pnlPct.toFixed(2)}% >= ${rule.threshold_pct}%: ${rule.source}`,
          };
        }
        break;
    }
  }

  return { action: null, reason: null };
}

/**
 * Filter a list of pool candidates against screening rules.
 * Returns candidates that pass all rules, logging violations.
 *
 * @param {Object[]} candidates - pool candidate objects
 * @param {Rule[]} rules - from extractRules().screening
 * @returns {Object[]} filtered candidates
 */
export function filterCandidatesByRules(candidates, rules) {
  if (!rules.length) return candidates;

  return candidates.filter((pool) => {
    const poolData = {
      volatility: pool.volatility,
      global_fees_sol: pool.global_fees_sol,
      top_10_pct: pool.top_10_pct,
      bundlers_pct: pool.bundlers_pct_in_top_100 ?? pool.bundlers_pct,
    };
    // For pre-filter, we don't know strategy yet — only filter on pool-level rules
    const poolOnlyRules = rules.filter((r) => r.type !== "block_strategy");
    const { pass, violations } = checkDeployCompliance({}, poolData, poolOnlyRules);
    if (!pass) {
      log("lesson_enforce", `Filtered ${pool.name || pool.pool} — lesson violations: ${violations.join("; ")}`);
    }
    return pass;
  });
}
