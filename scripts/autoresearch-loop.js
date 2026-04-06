/**
 * Autoresearch Daily Review
 *
 * Runs daily at 23:30 UTC+7 (before lesson summarizer at 23:59).
 * Analyzes today's biggest win and biggest loss — fetches historical
 * candle data + top LP benchmarks for both pools, then asks Claude
 * to derive actionable lessons from the contrast.
 *
 * Fire-and-forget from index.js — never throws past its own error boundary.
 *
 * Usage (standalone test):
 *   node scripts/autoresearch-loop.js
 */

import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runBacktestForPool, mapHorizon } from "./autoresearch-bridge.js";
import { loadGoals, formatGoalsForPrompt, formatGoalsForNotification, loadPerformance } from "./goals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const AUTORESEARCH_DIR = "/home/ubuntu/autoresearch-dlmm";
const CLAUDE_BIN = "/home/ubuntu/.local/bin/claude";
const LESSONS_FILE = path.join(ROOT, "lessons.json");
const SKILL_MD_PATH = path.join(
  process.env.HOME || "/home/ubuntu",
  ".claude/skills/meteora-dlmm-lp/SKILL.md"
);

const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── File helpers ────────────────────────────────────────────────

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function loadSkillPrompt() {
  if (!fs.existsSync(SKILL_MD_PATH)) return null;
  try {
    const raw = fs.readFileSync(SKILL_MD_PATH, "utf8");
    return raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
  } catch { return null; }
}

// ─── Pick biggest win and biggest loss from today ────────────────

function pickExtremes(perfRecords) {
  if (!perfRecords || perfRecords.length === 0) return null;

  // Filter to today's records (UTC+7 / Asia/Bangkok)
  const now = new Date();
  const todayStart = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  todayStart.setHours(0, 0, 0, 0);

  const todayRecords = perfRecords.filter(r => {
    if (!r.recorded_at) return false;
    return new Date(r.recorded_at) >= todayStart;
  });

  if (todayRecords.length < 2) return null;

  // Sort by pnl_pct
  const sorted = [...todayRecords].sort((a, b) => (a.pnl_pct ?? 0) - (b.pnl_pct ?? 0));

  const biggestLoss = sorted[0];
  const biggestWin = sorted[sorted.length - 1];

  // Need at least one win and one loss to contrast
  if ((biggestWin.pnl_pct ?? 0) <= 0 && (biggestLoss.pnl_pct ?? 0) <= 0) {
    // All losses — still analyze worst vs least-worst
  }

  return {
    win: biggestWin,
    loss: biggestLoss,
    totalCloses: todayRecords.length,
    winCount: todayRecords.filter(r => (r.pnl_pct ?? 0) > 0).length,
    lossCount: todayRecords.filter(r => (r.pnl_pct ?? 0) <= 0).length,
  };
}

// ─── Format trade for prompt ─────────────────────────────────────

function formatTrade(label, trade) {
  const sign = (trade.pnl_pct ?? 0) >= 0 ? "+" : "";
  return `${label}:
  Pool: ${trade.pool_name || "?"} (${trade.pool})
  Strategy: ${trade.strategy || "?"}
  Bin range: ${JSON.stringify(trade.bin_range || "?")}
  Bin step: ${trade.bin_step || "?"}
  Volatility: ${trade.volatility ?? "?"}
  Amount: ${trade.amount_sol ?? "?"} SOL ($${(trade.initial_value_usd ?? 0).toFixed(2)})
  PnL: ${sign}${(trade.pnl_pct ?? 0).toFixed(2)}% ($${(trade.pnl_usd ?? 0).toFixed(2)})
  Fees earned: $${(trade.fees_earned_usd ?? 0).toFixed(2)}
  Held: ${trade.minutes_held ?? 0}m | In range: ${trade.minutes_in_range ?? 0}m
  Close reason: ${trade.close_reason || "?"}
  Range efficiency: ${((trade.minutes_in_range ?? 0) / Math.max(trade.minutes_held ?? 1, 1) * 100).toFixed(0)}%`;
}

// ─── Derive lessons from comparative analysis ────────────────────

async function deriveLessons(extremes, winBacktest, lossBacktest, goalsSection = "") {
  const winTrade = formatTrade("BIGGEST WIN", extremes.win);
  const lossTrade = formatTrade("BIGGEST LOSS", extremes.loss);

  // Format backtest context
  let winContext = "";
  if (winBacktest) {
    const m = winBacktest.metrics || {};
    winContext = `\nBACKTEST CONTEXT FOR WIN POOL (${winBacktest.horizon}):
  Backtest Net PnL: ${m.net_pnl_pct ?? "?"}% | Win rate: ${m.win_rate_pct ?? "?"}% | Time in range: ${m.time_in_range_pct ?? "?"}%
  ${winBacktest.benchmarkComparison ? `Top LP benchmark:\n${winBacktest.benchmarkComparison}` : ""}`;
  }

  let lossContext = "";
  if (lossBacktest) {
    const m = lossBacktest.metrics || {};
    lossContext = `\nBACKTEST CONTEXT FOR LOSS POOL (${lossBacktest.horizon}):
  Backtest Net PnL: ${m.net_pnl_pct ?? "?"}% | Win rate: ${m.win_rate_pct ?? "?"}% | Time in range: ${m.time_in_range_pct ?? "?"}%
  ${lossBacktest.benchmarkComparison ? `Top LP benchmark:\n${lossBacktest.benchmarkComparison}` : ""}`;
  }

  const prompt = `You are reviewing today's trading performance for an autonomous Solana DLMM LP agent (Meteora).

TODAY'S SUMMARY:
  Total closes: ${extremes.totalCloses} | Wins: ${extremes.winCount} | Losses: ${extremes.lossCount}

${winTrade}
${winContext}

${lossTrade}
${lossContext}
${goalsSection ? `\n${goalsSection}\n` : ""}
TASK:
Compare the biggest win vs biggest loss. Analyze:
1. What made the win successful? (pool characteristics, strategy choice, timing, range efficiency)
2. What went wrong with the loss? (wrong strategy, bad timing, pool red flags missed, held too long/short)
3. What pattern can be applied to future trades?

Derive 1-4 actionable lessons. Focus on what generalizes — not pool-specific advice.

RULES:
- Each lesson MUST start with: AVOID, NEVER, SKIP, DO NOT, PREFER, or TAKE PROFIT.
- Be specific with numbers (volatility thresholds, hold times, PnL cutoffs) when the data supports it.
- If both win and loss used the same strategy, focus on WHAT DIFFERED (pool characteristics, timing, range).
- If win rate is very lopsided, address why (systematic issue vs bad luck).
- Omit lessons if the signal is too weak or the sample is one-off noise.

LESSON FORMAT (CRITICAL — lessons are auto-enforced ONLY if they match these exact patterns):
Screening rules:
  "AVOID strategy=X"                     → block a strategy
  "AVOID strategy=X when volatility > Y" → block strategy for high-vol pools
  "AVOID volatility > X"                 → block pools above X volatility
  "SKIP: global_fees_sol < X"            → block pools with low fees
  "NEVER deploy more than X SOL"         → cap max deploy size
  "PREFER strategy=X when volatility < Y" → favor a strategy for conditions

Management rules:
  "AVOID holding > Xm when pnl < Y%"    → force-close aged losing positions
  "DO NOT close OOR < Xm"               → grace period before closing out-of-range
  "NEVER hold position below -X%"        → stop loss at X%
  "TAKE PROFIT at X%"                    → auto take-profit at X%

Respond ONLY with valid JSON:
{
  "lessons": [],
  "rationale": ""
}`;

  const skillPrompt = loadSkillPrompt();
  const args = ["--print", "--output-format", "json", "--no-session-persistence", "--tools", ""];
  if (skillPrompt) args.push("--system-prompt", skillPrompt);

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
    setTimeout(() => { child.kill(); reject(new Error("claude timed out")); }, CLAUDE_TIMEOUT_MS);
  });

  const envelope = JSON.parse(stdout.trim());
  if (envelope.is_error) throw new Error(`Claude error: ${envelope.result}`);

  const raw = (envelope.result || "").trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

// ─── Notification ────────────────────────────────────────────────

function buildNotificationMessage(extremes, newLessons, rationale) {
  const w = extremes.win;
  const l = extremes.loss;
  const wSign = (w.pnl_pct ?? 0) >= 0 ? "+" : "";
  const lSign = (l.pnl_pct ?? 0) >= 0 ? "+" : "";

  const parts = [`🔬 DAILY RESEARCH`];
  parts.push(`Closes: ${extremes.totalCloses} | W ${extremes.winCount} / L ${extremes.lossCount}`);
  parts.push(`\n🏆 Best: ${w.pool_name} ${wSign}${(w.pnl_pct ?? 0).toFixed(2)}% (${w.strategy}, ${w.minutes_held}m)`);
  parts.push(`💀 Worst: ${l.pool_name} ${lSign}${(l.pnl_pct ?? 0).toFixed(2)}% (${l.strategy}, ${l.minutes_held}m)`);

  if (newLessons.length > 0) {
    parts.push(`\n📚 Lessons (${newLessons.length}):`);
    for (const lesson of newLessons) parts.push(`• ${lesson}`);
  } else {
    parts.push("\nNo new lessons derived.");
  }

  if (rationale) parts.push(`\n💡 ${rationale}`);
  return parts.join("\n");
}

async function notifyBots(message) {
  // Send via main Telegram bot
  try {
    const { isEnabled, sendMessage } = await import("../telegram.js");
    if (isEnabled()) await sendMessage(message);
  } catch { /* main bot not available */ }

  // Send via journal bot (direct API call — sendMessage is not exported)
  const token = process.env.TELEGRAM_JOURNAL_BOT_TOKEN;
  if (!token) return;
  let journalChatId = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "user-config.json"), "utf8"));
    journalChatId = cfg.telegramJournalChatId;
  } catch { /* ignore */ }
  if (!journalChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: journalChatId, text: message.slice(0, 4096) }),
    });
  } catch { /* ignore */ }
}

// ─── Main ────────────────────────────────────────────────────────

export async function runDailyAutoresearch() {
  const { log } = await import("../logger.js");

  try {
    // Load performance data
    const data = loadJson(LESSONS_FILE) || { performance: [] };
    const extremes = pickExtremes(data.performance || []);

    if (!extremes) {
      log("autoresearch", "Skipped — fewer than 2 closes today");
      return;
    }

    log("autoresearch", `Daily review: ${extremes.totalCloses} closes | best: ${extremes.win.pool_name} +${(extremes.win.pnl_pct ?? 0).toFixed(1)}% | worst: ${extremes.loss.pool_name} ${(extremes.loss.pnl_pct ?? 0).toFixed(1)}%`);

    // Fetch backtest context for both pools (parallel, best-effort)
    const winHz = mapHorizon(extremes.win.minutes_held ?? 15);
    const lossHz = mapHorizon(extremes.loss.minutes_held ?? 15);

    const [winBacktest, lossBacktest] = await Promise.all([
      runBacktestForPool(extremes.win.pool, winHz).catch(() => null),
      runBacktestForPool(extremes.loss.pool, lossHz).catch(() => null),
    ]);

    if (winBacktest) winBacktest.poolName = extremes.win.pool_name;
    if (lossBacktest) lossBacktest.poolName = extremes.loss.pool_name;

    log("autoresearch", `Backtest context: win=${winBacktest ? "OK" : "skip"}, loss=${lossBacktest ? "OK" : "skip"}`);

    // Build goals section
    const goals = loadGoals();
    const allPerf = loadPerformance();
    const goalsSection = goals ? formatGoalsForPrompt(goals, allPerf) : "";

    // Derive lessons via Claude
    let newLessons = [];
    let rationale = "";
    try {
      const result = await deriveLessons(extremes, winBacktest, lossBacktest, goalsSection);
      newLessons = Array.isArray(result.lessons) ? result.lessons.filter(l => typeof l === "string" && l.trim()) : [];
      rationale = typeof result.rationale === "string" ? result.rationale.trim() : "";
    } catch (e) {
      log("autoresearch", `Lesson derivation failed (non-fatal): ${e.message}`);
    }

    // Add lessons
    if (newLessons.length > 0) {
      const { addLesson } = await import("../lessons.js");
      for (const rule of newLessons) {
        addLesson(rule, ["autoresearch", "daily"], { role: null, category: "general" });
      }
      log("autoresearch", `Added ${newLessons.length} lesson(s): ${newLessons.map(l => l.slice(0, 60)).join(" | ")}`);
    }

    // Notify (append goals progress)
    const goalsNotif = goals ? formatGoalsForNotification(goals, allPerf) : "";
    const msg = buildNotificationMessage(extremes, newLessons, rationale) + goalsNotif;
    await notifyBots(msg);
    log("autoresearch", "Daily review complete");

  } catch (e) {
    const { log: logErr } = await import("../logger.js");
    logErr("autoresearch_error", `runDailyAutoresearch failed: ${e.message}`);
    try {
      const { notifyError } = await import("../telegram-journal.js");
      await notifyError("Autoresearch", e.message);
    } catch { /* ignore */ }
  }
}

// ─── Standalone run ──────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runDailyAutoresearch().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
