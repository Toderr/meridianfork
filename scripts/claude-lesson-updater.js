/**
 * Claude Lesson Updater
 *
 * Runs every 5 closes (same trigger as evolveThresholds).
 * Uses `claude --print` to analyze recent performance, derive new lesson rules,
 * and suggest minor strategy config tweaks.
 *
 * Fire-and-forget from lessons.js — never throws past its own error boundary.
 *
 * Usage (standalone test):
 *   node scripts/claude-lesson-updater.js
 */

import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pickTargetPool, mapHorizon, runBacktestForPool } from "./autoresearch-bridge.js";
import { loadGoals, formatGoalsForPrompt, formatGoalsForNotification, loadPerformance } from "./goals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CLAUDE_BIN = "/home/ubuntu/.local/bin/claude";
const LESSONS_FILE = path.join(ROOT, "lessons.json");
const EXP_LESSONS_FILE = path.join(ROOT, "experiment-lessons.json");
const USER_CONFIG_FILE = path.join(ROOT, "user-config.json");
const SKILL_MD_PATH = path.join(
  process.env.HOME || "/home/ubuntu",
  ".claude/skills/meteora-dlmm-lp/SKILL.md"
);

function loadSkillPrompt() {
  if (!fs.existsSync(SKILL_MD_PATH)) return null;
  try {
    const raw = fs.readFileSync(SKILL_MD_PATH, "utf8");
    // Strip YAML frontmatter (--- ... ---) — keep only the knowledge body
    return raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
  } catch { return null; }
}

// Config keys Claude is allowed to update
// Screening params are fully tunable — the agent learns what works via token characteristic analysis.
// Only minTokenFeesSol is hardcoded at 30 and cannot be lowered (anti-scam gate).
const ALLOWED_CONFIG_KEYS = new Set([
  // Screening
  "minFeeActiveTvlRatio", "minTvl", "maxTvl", "minVolume", "minOrganic",
  "minHolders", "minMcap", "maxMcap", "minBinStep", "maxBinStep",
  "timeframe", "category", "maxBotHoldersPct",
  // Strategy
  "binsBelow", "strategyRules",
  // Management
  "minFeeTvl24h", "minAgeForYieldExit",
  "outOfRangeBinsToClose",
  // Risk/sizing
  "deployAmountSol", "positionSizePct", "maxDeployAmount",
]);

// ─── File helpers ─────────────────────────────────────────────────

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ─── Build prompt ─────────────────────────────────────────────────

function buildPrompt(recentPerf, existingLessons, currentConfig, autoresearchData = null, goalsSection = "", tokenCharSummary = "") {
  const perfLines = recentPerf.map((p, i) => {
    const pct = p.pnl_pct ?? 0;
    const usd = p.pnl_usd ?? 0;
    const sign = pct >= 0 ? "+" : "";
    const tp = p.token_profile;
    const profileHint = tp
      ? ` | mcap=${tp.mcap ?? "?"} holders=${tp.holders ?? "?"} sw=${tp.smart_wallet_count ?? 0} sm_buy=${tp.okx_smart_money_buy ?? "?"} mom1h=${tp.momentum_1h ?? "?"}`
      : "";
    return `${i + 1}. ${p.pool_name || "?"} | ${p.strategy || "?"} | pnl=${sign}${pct.toFixed(2)}% ($${usd.toFixed(2)}) | held=${p.minutes_held || 0}m | range_eff=${(p.range_efficiency ?? 0).toFixed(0)}% | vol=${p.volatility ?? "?"}${profileHint} | reason=${p.close_reason || "?"}`;
  }).join("\n");

  const lessonLines = existingLessons.map(l => `- [${l.type || "?"}] ${l.rule}`).join("\n") || "none";

  const cfgSubset = {
    // Screening (all tunable — minTokenFeesSol=30 is hardcoded separately)
    minFeeActiveTvlRatio: currentConfig.minFeeActiveTvlRatio,
    minTvl: currentConfig.minTvl,
    maxTvl: currentConfig.maxTvl,
    minVolume: currentConfig.minVolume,
    minOrganic: currentConfig.minOrganic,
    minHolders: currentConfig.minHolders,
    minMcap: currentConfig.minMcap,
    maxMcap: currentConfig.maxMcap,
    minBinStep: currentConfig.minBinStep,
    maxBinStep: currentConfig.maxBinStep,
    maxBotHoldersPct: currentConfig.maxBotHoldersPct,
    // Strategy
    strategy: currentConfig.strategy,
    binsBelow: currentConfig.binsBelow,
    strategyRules: currentConfig.strategyRules,
    // Management
    minFeeTvl24h: currentConfig.minFeeTvl24h,
    minAgeForYieldExit: currentConfig.minAgeForYieldExit,
    outOfRangeBinsToClose: currentConfig.outOfRangeBinsToClose,
    // Risk/sizing
    deployAmountSol: currentConfig.deployAmountSol,
    positionSizePct: currentConfig.positionSizePct,
    maxDeployAmount: currentConfig.maxDeployAmount,
  };

  // Build optional autoresearch section
  let autoresearchSection = "";
  if (autoresearchData) {
    const m = autoresearchData.metrics || {};
    const metricsLines = Object.entries(m).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    autoresearchSection = `
BACKTEST ANALYSIS FOR ${autoresearchData.poolName || autoresearchData.pool} (horizon: ${autoresearchData.horizon}):
${metricsLines || "  No metrics parsed — see raw output below."}
${autoresearchData.rawOutput ? `\nRaw backtest output (last 1500 chars):\n${autoresearchData.rawOutput.slice(-1500)}` : ""}
${autoresearchData.benchmarkComparison ? `\nBENCHMARK VS TOP LPERS:\n${autoresearchData.benchmarkComparison}` : ""}
${autoresearchData.learningReport ? `\nLEARNING REPORT (prior experiments):\n${autoresearchData.learningReport}` : ""}

Use this backtest data to validate patterns from live performance.
If backtest shows a strategy/shape works better than what we're using, suggest it as a lesson.

`;
  }

  return `You are analyzing performance data for an autonomous Solana DLMM LP agent (Meteora).

RECENT PERFORMANCE (last ${recentPerf.length} closed positions):
${perfLines}

EXISTING LESSONS (do NOT repeat these):
${lessonLines}

CURRENT STRATEGY CONFIG:
${JSON.stringify(cfgSubset, null, 2)}
${goalsSection ? `\n${goalsSection}\n` : ""}${tokenCharSummary ? `\n${tokenCharSummary}\n\nUse the token characteristic analysis above to derive strategy-matching lessons.\nFor example: "PREFER: For <mcap range> tokens, use strategy=<best>" or "AVOID: Tokens with <characteristic> — avg PnL <negative>%".\n\n` : ""}${autoresearchSection}
TASK:
1. Identify 1-3 NEW patterns worth recording as lesson rules (only if genuinely new and backed by the data above).
2. Suggest minor config adjustments (optional, only if clearly supported by data). Allowed keys: ${[...ALLOWED_CONFIG_KEYS].join(", ")}.
3. Give a short rationale (1-2 sentences).

RULES:
- Lessons must be actionable rules for the screener or manager, not observations.
- Do NOT add lessons if the pattern is already covered by existing lessons.
- Do NOT suggest config changes unless >= 5 of the last 20 closes support it.
- Be conservative — omit lessons/config_updates entirely if the signal is weak.

LESSON FORMAT (CRITICAL — lessons are auto-enforced ONLY if they match these exact patterns):
Each lesson MUST start with a keyword: AVOID, NEVER, SKIP, DO NOT, or TAKE PROFIT.
Use these templates exactly — fuzzy phrasing will NOT be enforced by the system:

Screening rules (block bad deploys):
  "AVOID strategy=X"                     → block a strategy (X = spot, bid_ask, etc.)
  "AVOID strategy=X when volatility > Y" → block strategy for high-vol pools
  "AVOID volatility > X"                 → block pools above X volatility
  "SKIP: global_fees_sol < X"            → block pools with low fees
  "AVOID top_10_pct > X"                 → block concentrated holder pools
  "AVOID bundlers > X"                   → block high-bundler pools
  "NEVER deploy more than X SOL"         → cap max deploy size

Management rules (auto-close/hold positions):
  "DO NOT close OOR < Xm"               → grace period before closing out-of-range
  "NEVER hold position below -X%"        → stop loss at X%
  "TAKE PROFIT at X%"                    → auto take-profit at X%

Respond ONLY with valid JSON, no markdown, no explanation outside the JSON:
{
  "lessons": [],
  "config_updates": {},
  "rationale": ""
}`;
}

// ─── Apply config updates ─────────────────────────────────────────

function applyConfigUpdates(updates) {
  if (!updates || typeof updates !== "object" || Object.keys(updates).length === 0) return {};

  const cfg = loadJson(USER_CONFIG_FILE) || {};
  const applied = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) continue; // safety guard
    applied[key] = { old: cfg[key], new: value };
    cfg[key] = value;
  }

  if (Object.keys(applied).length > 0) {
    cfg._lastClaudeReview = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }

  return applied;
}

// ─── Journal bot notification ─────────────────────────────────────

function buildReviewMessage(newLessons, appliedConfig, rationale, autoresearchData = null) {
  const parts = ["🧠 CLAUDE REVIEW"];
  if (newLessons.length > 0) {
    parts.push(`\n📚 New lessons (${newLessons.length}):`);
    for (const l of newLessons) parts.push(`• ${l}`);
  }
  const configKeys = Object.keys(appliedConfig);
  if (configKeys.length > 0) {
    parts.push(`\n⚙️ Config updates:`);
    for (const k of configKeys) {
      const { old: o, new: n } = appliedConfig[k];
      parts.push(`• ${k}: ${JSON.stringify(o)} → ${JSON.stringify(n)}`);
    }
  }
  if (rationale) parts.push(`\n💡 ${rationale}`);
  if (autoresearchData) {
    const m = autoresearchData.metrics || {};
    parts.push(`\n📊 Backtest: ${autoresearchData.poolName || autoresearchData.pool} (${autoresearchData.horizon})`);
    if (m.net_pnl_pct != null) parts.push(`• Net PnL: ${m.net_pnl_pct}%`);
    if (m.win_rate_pct != null) parts.push(`• Win rate: ${m.win_rate_pct}%`);
    if (m.time_in_range_pct != null) parts.push(`• Time in range: ${m.time_in_range_pct}%`);
    if (m.net_apr != null) parts.push(`• APR: ${m.net_apr}%`);
  }
  return parts.join("\n");
}

async function notifyBots(newLessons, appliedConfig, rationale, autoresearchData = null) {
  const msg = buildReviewMessage(newLessons, appliedConfig, rationale, autoresearchData);

  // Notify main Telegram bot
  try {
    const { isEnabled, sendMessage } = await import("../telegram.js");
    if (isEnabled()) await sendMessage(msg);
  } catch { /* main bot not available */ }

  // Notify journal bot
  try {
    const { isEnabled, notifyClaudeReview } = await import("../telegram-journal.js");
    if (isEnabled()) await notifyClaudeReview({ newLessons, appliedConfig, rationale, autoresearchData });
  } catch { /* journal bot not available */ }
}

// ─── Main ─────────────────────────────────────────────────────────

export async function claudeUpdateLessons() {
  const { log } = await import("../logger.js");

  // Check freeze flag
  try {
    const uc = loadJson(USER_CONFIG_FILE) || {};
    if (uc.freezeLessons) {
      log("claude_review", "Skipping — lessons are frozen");
      return;
    }
  } catch { /* not frozen if unreadable */ }

  try {
    // Load data
    const data = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
    const expData = loadJson(EXP_LESSONS_FILE) || { lessons: [] };
    const recentPerf = (data.performance || []).slice(-20);
    const allLessons = [...(data.lessons || []), ...(expData.lessons || [])];
    const existingLessons = allLessons.slice(-15);
    const currentConfig = loadJson(USER_CONFIG_FILE) || {};

    if (recentPerf.length < 5) {
      log("claude_review", "Skipping — fewer than 5 performance records");
      return;
    }

    // Run autoresearch backtest for the most-traded recent pool
    let autoresearchData = null;
    try {
      const last5 = recentPerf.slice(-5);
      const target = pickTargetPool(last5);
      if (target) {
        const hz = mapHorizon(target.avgMinutesHeld);
        log("claude_review", `Running autoresearch for ${target.poolName} (${hz})`);
        autoresearchData = await runBacktestForPool(target.poolAddress, hz);
        if (autoresearchData) autoresearchData.poolName = target.poolName;
      }
    } catch (e) {
      log("claude_review", `Autoresearch skipped: ${e.message}`);
    }

    // Build goals section
    const goals = loadGoals();
    const allPerf = loadPerformance();
    const goalsSection = goals ? formatGoalsForPrompt(goals, allPerf) : "";

    // Build token characteristic analysis from all performance data
    let tokenCharSummary = "";
    try {
      const { analyzeTokenCharacteristics } = await import("../lessons.js");
      const { summary } = analyzeTokenCharacteristics(data.performance || []);
      tokenCharSummary = summary || "";
    } catch { /* non-fatal */ }

    const prompt = buildPrompt(recentPerf, existingLessons, currentConfig, autoresearchData, goalsSection, tokenCharSummary);
    const skillPrompt = loadSkillPrompt();
    const args = ["--print", "--output-format", "json", "--no-session-persistence", "--tools", ""];
    if (skillPrompt) args.push("--system-prompt", skillPrompt);

    log("claude_review", `Spawning claude CLI (${recentPerf.length} records, ${existingLessons.length} existing lessons${skillPrompt ? ", meteora-dlmm-lp skill active" : ""}${goals ? ", goals active" : ""})`);

    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, { env: { ...process.env } });
      let out = "";
      let err = "";
      child.stdout.on("data", d => { out += d; });
      child.stderr.on("data", d => { err += d; });
      child.on("close", code => {
        if (code !== 0) reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
        else resolve(out);
      });
      child.on("error", reject);
      child.stdin.write(prompt);
      child.stdin.end();
      setTimeout(() => { child.kill(); reject(new Error("claude subprocess timed out")); }, 8 * 60 * 1000);
    });

    // Parse outer claude JSON envelope
    let envelope;
    try { envelope = JSON.parse(stdout.trim()); } catch {
      throw new Error(`Non-JSON output from claude: ${stdout.slice(0, 200)}`);
    }
    if (envelope.is_error) throw new Error(`Claude error: ${envelope.result}`);

    // Parse inner response JSON (Claude's actual answer)
    let parsed;
    const raw = (envelope.result || "").trim();
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try { parsed = JSON.parse(cleaned); } catch {
      throw new Error(`Claude returned non-JSON content: ${raw.slice(0, 200)}`);
    }

    const newLessons = Array.isArray(parsed.lessons) ? parsed.lessons.filter(l => typeof l === "string" && l.trim()) : [];
    const configUpdates = (typeof parsed.config_updates === "object" && parsed.config_updates) ? parsed.config_updates : {};
    let rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";

    // Add new lessons
    if (newLessons.length > 0) {
      const { addLesson } = await import("../lessons.js");
      for (const rule of newLessons) {
        addLesson(rule, ["claude-review"], { role: null, category: "general" });
      }
      log("claude_review", `Added ${newLessons.length} lesson(s): ${newLessons.map(l => l.slice(0, 60)).join(" | ")}`);
    }

    // Apply config updates
    const applied = applyConfigUpdates(configUpdates);
    if (Object.keys(applied).length > 0) {
      const { reloadConfig } = await import("../config.js");
      reloadConfig();
      log("claude_review", `Config updates applied: ${JSON.stringify(applied)}`);

      // Dedicated config change notification to journal bot
      try {
        const beforeValues = {};
        const appliedValues = {};
        for (const [k, v] of Object.entries(applied)) {
          beforeValues[k] = v.old;
          appliedValues[k] = v.new;
        }
        const { notifyConfigChange } = await import("../telegram-journal.js");
        await notifyConfigChange({ applied: appliedValues, before: beforeValues, reason: rationale, source: "claude-review" });
      } catch { /* journal bot not available */ }
    }

    const hasChanges = newLessons.length > 0 || Object.keys(applied).length > 0;

    if (hasChanges) {
      // Append goals progress to rationale for notification
      if (goals) {
        const goalsNotif = formatGoalsForNotification(goals, allPerf);
        if (goalsNotif) rationale = rationale ? rationale + goalsNotif : goalsNotif;
      }
      await notifyBots(newLessons, applied, rationale, autoresearchData);
      log("claude_review", `Done — ${newLessons.length} lesson(s), ${Object.keys(applied).length} config change(s)`);
    } else {
      log("claude_review", "Done — no changes (no new patterns found)");
    }

  } catch (e) {
    const { log } = await import("../logger.js");
    log("claude_review_error", `claudeUpdateLessons failed: ${e.message}`);
  }
}

// ─── Standalone run ───────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  claudeUpdateLessons().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
