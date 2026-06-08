/**
 * Report generation module.
 *
 * Generates daily/weekly/monthly plain-text reports from journal + lessons data.
 * Telegram 4096 char limit is respected via truncation.
 */

import fs from "fs";
import { log } from "./logger.js";
import { getJournalEntries } from "./journal.js";

const LESSONS_FILE = "./lessons.json";
const EXP_LESSONS_FILE = "./experiment-lessons.json";
const STATE_FILE = "./state.json";

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

/**
 * Generate a trading report for the given period.
 * @param {"daily"|"weekly"|"monthly"} period
 * @returns {string} plain-text report string
 */
export async function generateReport(period = "daily") {
  const now = new Date();
  let from, periodLabel, periodEmoji;

  if (period === "daily") {
    from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    periodLabel = "Last 24h";
    periodEmoji = "☀️";
  } else if (period === "weekly") {
    from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    periodLabel = "Last 7 Days";
    periodEmoji = "📅";
  } else if (period === "monthly") {
    from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    periodLabel = "Last 30 Days";
    periodEmoji = "📆";
  } else {
    from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    periodLabel = "Last 24h";
    periodEmoji = "☀️";
  }

  const fromISO = from.toISOString();
  const toISO = now.toISOString();

  // Pull entries from journal
  const opens  = getJournalEntries({ from: fromISO, to: toISO, type: "open" });
  const closes = getJournalEntries({ from: fromISO, to: toISO, type: "close" });
  const claims = getJournalEntries({ from: fromISO, to: toISO, type: "claim" });

  const positions_opened = opens.length;
  const positions_closed = closes.length;

  const total_pnl_usd = closes.reduce((s, e) => s + (e.pnl_usd || 0), 0);
  const total_pnl_sol = closes.reduce((s, e) => s + (e.pnl_sol || 0), 0);
  const total_fees_usd = claims.reduce((s, e) => s + (e.fees_usd || 0), 0)
    + closes.reduce((s, e) => s + (e.fees_earned_usd || 0), 0);

  const totalInitial = closes.reduce((s, e) => s + (e.initial_value_usd || 0), 0);
  const total_pnl_pct = totalInitial > 0
    ? (total_pnl_usd / totalInitial) * 100
    : 0;

  const wins   = closes.filter(e => (e.pnl_usd ?? 0) >= 0);
  const losses = closes.filter(e => (e.pnl_usd ?? 0) <  0);
  const win_rate = closes.length > 0 ? Math.round((wins.length / closes.length) * 100) : null;

  const avg_profit_pct = wins.length > 0
    ? wins.reduce((s, e) => s + (e.pnl_pct ?? 0), 0) / wins.length
    : null;
  const avg_loss_pct = losses.length > 0
    ? losses.reduce((s, e) => s + (e.pnl_pct ?? 0), 0) / losses.length
    : null;

  // Lessons from both regular + experiment files, filtered by created_at
  const regLessons = (loadJson(LESSONS_FILE) || { lessons: [] }).lessons || [];
  const expLessons = (loadJson(EXP_LESSONS_FILE) || { lessons: [] }).lessons || [];
  const lessonsInPeriod = [...regLessons, ...expLessons]
    .filter(l => l.created_at && l.created_at >= fromISO && l.created_at <= toISO)
    .slice(-5); // cap to last 5 for space

  // Current portfolio
  const state = loadJson(STATE_FILE) || { positions: {} };
  const allPositions = Object.values(state.positions || {});
  const openPositions = allPositions.filter(p => !p.closed);

  const allCloses = getJournalEntries({ type: "close" });
  const allTimePnlUsd = allCloses.reduce((s, e) => s + (e.pnl_usd || 0), 0);

  // ── Build report ─────────────────────────────────────────────

  const lines = [];

  lines.push(`${periodEmoji} Trading Report — ${periodLabel}`);
  lines.push("────────────────");

  lines.push(`*Activity:*`);
  lines.push(`📥 Positions Opened: ${positions_opened}`);
  lines.push(`📤 Positions Closed: ${positions_closed}`);
  lines.push("");

  lines.push(`*Performance:*`);
  const pnlSign = total_pnl_usd >= 0 ? "+" : "";
  const solPart = total_pnl_sol !== 0
    ? ` | ${total_pnl_sol >= 0 ? "+" : ""}${total_pnl_sol.toFixed(4)} SOL`
    : "";
  lines.push(`💰 Net PnL: ${pnlSign}$${total_pnl_usd.toFixed(2)}${solPart}`);
  lines.push(`📈 PnL %: ${pnlSign}${total_pnl_pct.toFixed(2)}%`);
  lines.push(`💎 Fees Earned: $${total_fees_usd.toFixed(2)}`);
  const total_combined_usd = total_pnl_usd + total_fees_usd;
  const combinedSign = total_combined_usd >= 0 ? "+" : "";
  lines.push(`💼 Total (PnL + Fees): ${combinedSign}$${total_combined_usd.toFixed(2)}`);
  lines.push(win_rate !== null
    ? `🎯 Win Rate: ${win_rate}% (${wins.length}/${closes.length})`
    : `🎯 Win Rate: N/A`);
  if (avg_profit_pct !== null) lines.push(`📈 Avg Profit: +${avg_profit_pct.toFixed(2)}%`);
  if (avg_loss_pct !== null)   lines.push(`📉 Avg Loss: ${avg_loss_pct.toFixed(2)}%`);
  lines.push("");

  if (period === "weekly" || period === "monthly") {
    if (closes.length > 0) {
      const best  = closes.reduce((b, e) => (e.pnl_usd ?? 0) > (b.pnl_usd ?? 0) ? e : b, closes[0]);
      const worst = closes.reduce((w, e) => (e.pnl_usd ?? 0) < (w.pnl_usd ?? 0) ? e : w, closes[0]);

      lines.push(`*Best Trade:* ${best.pool_name || "?"} +$${(best.pnl_usd ?? 0).toFixed(2)} (${(best.pnl_pct ?? 0).toFixed(1)}%)`);
      lines.push(`*Worst Trade:* ${worst.pool_name || "?"} $${(worst.pnl_usd ?? 0).toFixed(2)} (${(worst.pnl_pct ?? 0).toFixed(1)}%)`);
      lines.push("");

      const strategies = {};
      for (const e of closes) {
        const s = e.strategy || "unknown";
        if (!strategies[s]) strategies[s] = { wins: 0, total: 0 };
        strategies[s].total++;
        if ((e.pnl_usd ?? 0) >= 0) strategies[s].wins++;
      }
      if (Object.keys(strategies).length > 0) {
        lines.push(`*Strategy Breakdown:*`);
        for (const [strat, stats] of Object.entries(strategies)) {
          const wr = Math.round((stats.wins / stats.total) * 100);
          lines.push(`  • ${strat}: ${stats.total} trades, ${wr}% win rate`);
        }
        lines.push("");
      }

      const withVariant = closes.filter(e => e.variant);
      if (withVariant.length > 0) {
        const variants = {};
        for (const e of withVariant) {
          const v = e.variant;
          if (!variants[v]) variants[v] = { wins: 0, total: 0, pnl: 0 };
          variants[v].total++;
          if ((e.pnl_usd ?? 0) >= 0) variants[v].wins++;
          variants[v].pnl += (e.pnl_usd ?? 0);
        }
        lines.push(`*A/B Variant Results:*`);
        for (const [v, stats] of Object.entries(variants)) {
          const wr = Math.round((stats.wins / stats.total) * 100);
          lines.push(`  • ${v}: ${stats.total} trades, ${wr}% win, $${stats.pnl.toFixed(2)} PnL`);
        }
        lines.push("");
      }

      const avgHold = closes.reduce((s, e) => s + (e.minutes_held || 0), 0) / closes.length;
      lines.push(`⏱ Avg Hold Time: ${Math.round(avgHold)}m`);
      lines.push("");

      let maxConsecutiveLosses = 0, currentStreak = 0;
      let maxDrawdownUsd = 0, runningPnl = 0, peakPnl = 0;
      for (const e of closes) {
        const pnl = e.pnl_usd ?? 0;
        runningPnl += pnl;
        if (runningPnl > peakPnl) peakPnl = runningPnl;
        const dd = peakPnl - runningPnl;
        if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
        if (pnl < 0) { currentStreak++; maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentStreak); }
        else currentStreak = 0;
      }
      if (maxConsecutiveLosses > 0 || maxDrawdownUsd > 0) {
        lines.push(`*Risk:*`);
        if (maxDrawdownUsd > 0) lines.push(`📉 Max Drawdown: -$${maxDrawdownUsd.toFixed(2)}`);
        if (maxConsecutiveLosses > 0) lines.push(`🔻 Max Consecutive Losses: ${maxConsecutiveLosses}`);
        lines.push("");
      }
    }
  }

  // Lessons section
  lines.push(`*Lessons Learned:*`);
  if (lessonsInPeriod.length > 0) {
    for (const l of lessonsInPeriod) {
      const rule = l.rule.length > 100 ? l.rule.slice(0, 97) + "..." : l.rule;
      lines.push(`• ${rule}`);
    }
  } else {
    lines.push("• No new lessons recorded in this period.");
  }
  lines.push("");

  // Current portfolio
  lines.push(`*Current Portfolio:*`);
  lines.push(`📂 Open Positions: ${openPositions.length}`);
  lines.push(allCloses.length > 0
    ? `📊 All-time PnL: $${allTimePnlUsd.toFixed(2)}`
    : `📊 All-time PnL: $0.00`);
  lines.push("────────────────");

  const report = lines.join("\n");

  // Truncate to Telegram's 4096 limit
  if (report.length > 4000) {
    return report.slice(0, 3950) + "\n...(truncated)";
  }

  return report;
}
