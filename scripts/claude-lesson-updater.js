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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CLAUDE_BIN = "/home/ubuntu/.local/bin/claude";
const LESSONS_FILE = path.join(ROOT, "lessons.json");
const USER_CONFIG_FILE = path.join(ROOT, "user-config.json");
const SKILL_MD_PATH = path.join(
  process.env.HOME || "/home/ubuntu",
  ".claude/plugins/cache/standalone/meteora-dlmm-lp/1.0.0/skills/meteora-dlmm-lp/SKILL.md"
);

function loadSkillPrompt() {
  if (!fs.existsSync(SKILL_MD_PATH)) return null;
  try {
    const raw = fs.readFileSync(SKILL_MD_PATH, "utf8");
    // Strip YAML frontmatter (--- ... ---) — keep only the knowledge body
    return raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
  } catch { return null; }
}

// Config keys Claude is allowed to update (safe subset only — no risk/structural keys)
const ALLOWED_CONFIG_KEYS = new Set([
  "binsBelow", "strategyRules",
  "minFeeTvl24h", "minAgeForYieldExit",
  "outOfRangeBinsToClose",
]);

// ─── File helpers ─────────────────────────────────────────────────

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ─── Build prompt ─────────────────────────────────────────────────

function buildPrompt(recentPerf, existingLessons, currentConfig) {
  const perfLines = recentPerf.map((p, i) => {
    const sign = (p.pnl_pct ?? 0) >= 0 ? "+" : "";
    return `${i + 1}. ${p.pool_name || "?"} | ${p.strategy || "?"} | pnl=${sign}${(p.pnl_pct ?? 0).toFixed(2)}% ($${(p.pnl_usd ?? 0).toFixed(2)}) | held=${p.minutes_held || 0}m | range_eff=${(p.range_efficiency ?? 0).toFixed(0)}% | vol=${p.volatility ?? "?"} | reason=${p.close_reason || "?"}`;
  }).join("\n");

  const lessonLines = existingLessons.map(l => `- [${l.type || "?"}] ${l.rule}`).join("\n") || "none";

  const cfgSubset = {
    strategy: currentConfig.strategy,
    binsBelow: currentConfig.binsBelow,
    strategyRules: currentConfig.strategyRules,
    minFeeTvl24h: currentConfig.minFeeTvl24h,
    minAgeForYieldExit: currentConfig.minAgeForYieldExit,
    outOfRangeBinsToClose: currentConfig.outOfRangeBinsToClose,
  };

  return `You are analyzing performance data for an autonomous Solana DLMM LP agent (Meteora).

RECENT PERFORMANCE (last ${recentPerf.length} closed positions):
${perfLines}

EXISTING LESSONS (do NOT repeat these):
${lessonLines}

CURRENT STRATEGY CONFIG:
${JSON.stringify(cfgSubset, null, 2)}

TASK:
1. Identify 1-3 NEW patterns worth recording as lesson rules (only if genuinely new and backed by the data above).
2. Suggest minor config adjustments (optional, only if clearly supported by data). Allowed keys: ${[...ALLOWED_CONFIG_KEYS].join(", ")}.
3. Give a short rationale (1-2 sentences).

RULES:
- Lessons must be actionable rules for the screener or manager, not observations.
- Do NOT add lessons if the pattern is already covered by existing lessons.
- Do NOT suggest config changes unless >= 5 of the last 20 closes support it.
- Be conservative — omit lessons/config_updates entirely if the signal is weak.

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

function buildReviewMessage(newLessons, appliedConfig, rationale) {
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
  return parts.join("\n");
}

async function notifyBots(newLessons, appliedConfig, rationale) {
  const msg = buildReviewMessage(newLessons, appliedConfig, rationale);

  // Notify main Telegram bot
  try {
    const { isEnabled, sendMessage } = await import("../telegram.js");
    if (isEnabled()) await sendMessage(msg);
  } catch { /* main bot not available */ }

  // Notify journal bot
  try {
    const { isEnabled, notifyClaudeReview } = await import("../telegram-journal.js");
    if (isEnabled()) await notifyClaudeReview({ newLessons, appliedConfig, rationale });
  } catch { /* journal bot not available */ }
}

// ─── Main ─────────────────────────────────────────────────────────

export async function claudeUpdateLessons() {
  const { log } = await import("../logger.js");

  try {
    // Load data
    const data = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
    const recentPerf = (data.performance || []).slice(-20);
    const existingLessons = (data.lessons || []).slice(-15);
    const currentConfig = loadJson(USER_CONFIG_FILE) || {};

    if (recentPerf.length < 5) {
      log("claude_review", "Skipping — fewer than 5 performance records");
      return;
    }

    const prompt = buildPrompt(recentPerf, existingLessons, currentConfig);
    const skillPrompt = loadSkillPrompt();
    const args = ["--print", "--output-format", "json", "--no-session-persistence", "--tools", ""];
    if (skillPrompt) args.push("--system-prompt", skillPrompt);

    log("claude_review", `Spawning claude CLI (${recentPerf.length} records, ${existingLessons.length} existing lessons${skillPrompt ? ", meteora-dlmm-lp skill active" : ""})`);

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
      setTimeout(() => { child.kill(); reject(new Error("claude subprocess timed out")); }, 5 * 60 * 1000);
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
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";

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
    }

    const hasChanges = newLessons.length > 0 || Object.keys(applied).length > 0;

    if (hasChanges) {
      await notifyBots(newLessons, applied, rationale);
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
