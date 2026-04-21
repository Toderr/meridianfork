/**
 * Goals System
 *
 * Loads trading goals from user-config.json, calculates current performance
 * against those goals, and formats them for injection into review prompts.
 *
 * Goals are hot-reloadable via user-config.json:
 *   "goals": {
 *     "win_rate_pct": 80,
 *     "max_loss_pct": -10,
 *     "profit_factor": 2,
 *     "lookback": 50
 *   }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeTruePnl } from "../true-pnl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const USER_CONFIG_FILE = path.join(ROOT, "user-config.json");
const LESSONS_FILE = path.join(ROOT, "lessons.json");

// ─── Load goals from config ─────────────────────────────────────

export function loadGoals() {
  try {
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, "utf8"));
    return cfg.goals || null;
  } catch { return null; }
}

// ─── Calculate current performance vs goals ──────────────────────

export function calculateProgress(goals, perfRecords) {
  if (!goals || !perfRecords || perfRecords.length === 0) return null;

  const lookback = goals.lookback || 50;
  const recent = perfRecords.slice(-lookback);
  if (recent.length < 5) return null;

  // Goals evaluate against fee-inclusive (true_pnl) outcomes.
  const tps = recent.map(p => computeTruePnl(p)).filter(tp => tp !== null);
  if (tps.length === 0) return null;

  const wins = tps.filter(tp => tp.is_win);
  const losses = tps.filter(tp => !tp.is_win);
  const winPnlSum = wins.reduce((s, tp) => s + tp.pct, 0);
  const lossPnlSum = losses.reduce((s, tp) => s + tp.pct, 0);

  const current = {
    win_rate_pct: tps.length > 0 ? (wins.length / tps.length) * 100 : 0,
    max_loss_pct: tps.length > 0 ? Math.min(...tps.map(tp => tp.pct)) : 0,
    profit_factor: lossPnlSum !== 0 ? winPnlSum / Math.abs(lossPnlSum) : (winPnlSum > 0 ? Infinity : 0),
    avg_pnl_pct: tps.reduce((s, tp) => s + tp.pct, 0) / tps.length,
    sample_size: tps.length,
  };

  // Compare each goal
  const progress = {};
  for (const [key, target] of Object.entries(goals)) {
    if (key === "lookback") continue;
    if (current[key] == null) continue;

    const actual = current[key];
    let met = false;

    if (key === "max_loss_pct") {
      // max_loss is a floor — actual should be >= target (less negative)
      met = actual >= target;
    } else {
      // Other goals — actual should be >= target
      met = actual >= target;
    }

    const gap = key === "max_loss_pct"
      ? actual - target  // positive = safe margin, negative = breached
      : actual - target; // positive = exceeding goal, negative = falling short

    progress[key] = { target, actual: Math.round(actual * 100) / 100, met, gap: Math.round(gap * 100) / 100 };
  }

  return { current, progress, lookback, sampleSize: recent.length };
}

// ─── Format for prompt injection ─────────────────────────────────

export function formatGoalsForPrompt(goals, perfRecords) {
  const result = calculateProgress(goals, perfRecords);
  if (!result) return "";

  const lines = [`TRADING GOALS (last ${result.sampleSize} trades):`];

  for (const [key, data] of Object.entries(result.progress)) {
    const icon = data.met ? "✅" : "❌";
    const label = key.replace(/_/g, " ");
    const gapStr = data.gap >= 0 ? `+${data.gap}` : `${data.gap}`;
    lines.push(`  ${icon} ${label}: ${data.actual} (target: ${data.target}, gap: ${gapStr})`);
  }

  lines.push("");
  lines.push("IMPORTANT: Prioritize lessons that close the gap on UNMET goals (❌).");
  lines.push("Do NOT suggest lessons that would hurt goals already being met (✅).");

  return lines.join("\n");
}

// ─── Format for Telegram notification ────────────────────────────

export function formatGoalsForNotification(goals, perfRecords) {
  const result = calculateProgress(goals, perfRecords);
  if (!result) return "";

  const lines = [`\n📎 Goals (last ${result.sampleSize}):`];

  for (const [key, data] of Object.entries(result.progress)) {
    const icon = data.met ? "✅" : "❌";
    const label = key.replace(/_/g, " ");
    lines.push(`${icon} ${label}: ${data.actual} / ${data.target}`);
  }

  return lines.join("\n");
}

// ─── Load performance data ───────────────────────────────────────

export function loadPerformance() {
  try {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    return data.performance || [];
  } catch { return []; }
}
