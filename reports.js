/**
 * Report generation module.
 *
 * Generates daily/weekly/monthly HTML reports from journal + lessons data.
 * Telegram 4096 char limit is respected via truncation.
 */

import fs from "fs";
import { log } from "./logger.js";
import { getJournalEntries } from "./journal.js";

const LESSONS_FILE = "./lessons.json";
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
 * @returns {string} HTML-formatted report string
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

  // Compute period metrics
  const positions_opened = opens.length;
  const positions_closed = closes.length;

  const total_pnl_usd = closes.reduce((s, e) => s + (e.pnl_usd || 0), 0);
  const total_pnl_sol = closes.reduce((s, e) => s + (e.pnl_sol || 0), 0);
  const total_fees_usd = claims.reduce((s, e) => s + (e.fees_usd || 0), 0)
    + closes.reduce((s, e) => s + (e.fees_earned_usd || 0), 0);

  // Weighted PnL% by initial value
  const totalInitial = closes.reduce((s, e) => s + (e.initial_value_usd || 0), 0);
  const total_pnl_pct = totalInitial > 0
    ? (total_pnl_usd / totalInitial) * 100
    : 0;

  const wins = closes.filter(e => (e.pnl_usd || 0) > 0).length;
  const win_rate = closes.length > 0 ? Math.round((wins / closes.length) * 100) : null;

  // Lessons from lessons.json filtered by created_at
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [] };
  const lessonsInPeriod = (lessonsData.lessons || [])
    .filter(l => l.created_at && l.created_at >= fromISO && l.created_at <= toISO)
    .slice(-5); // cap to last 5 for space

  // Current portfolio
  const state = loadJson(STATE_FILE) || { positions: {} };
  const allPositions = Object.values(state.positions || {});
  const openPositions = allPositions.filter(p => !p.closed);

  // All-time PnL from all closes in journal
  const allCloses = getJournalEntries({ type: "close" });
  const allTimePnlUsd = allCloses.reduce((s, e) => s + (e.pnl_usd || 0), 0);

  // ── Build report ─────────────────────────────────────────────

  const lines = [];

  lines.push(`${periodEmoji} <b>Trading Report</b> — ${periodLabel}`);
  lines.push("────────────────");

  lines.push(`<b>Activity:</b>`);
  lines.push(`📥 Positions Opened: ${positions_opened}`);
  lines.push(`📤 Positions Closed: ${positions_closed}`);
  lines.push("");

  lines.push(`<b>Performance:</b>`);
  const pnlSign = total_pnl_usd >= 0 ? "+" : "";
  lines.push(`💰 Net PnL: ${pnlSign}$${total_pnl_usd.toFixed(2)} (${pnlSign}${total_pnl_sol.toFixed(4)} SOL)`);
  lines.push(`📈 PnL %: ${pnlSign}${total_pnl_pct.toFixed(2)}%`);
  lines.push(`💎 Fees Earned: $${total_fees_usd.toFixed(2)}`);
  lines.push(win_rate !== null
    ? `🎯 Win Rate: ${win_rate}% (${wins}/${closes.length})`
    : `🎯 Win Rate: N/A`);
  lines.push("");

  // Weekly/monthly extras
  if (period === "weekly" || period === "monthly") {
    if (closes.length > 0) {
      const bestTrade  = closes.reduce((best, e) => (e.pnl_usd || 0) > (best.pnl_usd || 0) ? e : best, closes[0]);
      const worstTrade = closes.reduce((worst, e) => (e.pnl_usd || 0) < (worst.pnl_usd || 0) ? e : worst, closes[0]);

      lines.push(`<b>Best Trade:</b> ${bestTrade.pool_name || "?"} +$${(bestTrade.pnl_usd || 0).toFixed(2)} (${(bestTrade.pnl_pct || 0).toFixed(1)}%)`);
      lines.push(`<b>Worst Trade:</b> ${worstTrade.pool_name || "?"} $${(worstTrade.pnl_usd || 0).toFixed(2)} (${(worstTrade.pnl_pct || 0).toFixed(1)}%)`);
      lines.push("");

      // Strategy breakdown
      const strategies = {};
      for (const e of closes) {
        const s = e.strategy || "unknown";
        if (!strategies[s]) strategies[s] = { wins: 0, total: 0 };
        strategies[s].total++;
        if ((e.pnl_usd || 0) > 0) strategies[s].wins++;
      }
      if (Object.keys(strategies).length > 0) {
        lines.push(`<b>Strategy Breakdown:</b>`);
        for (const [strat, stats] of Object.entries(strategies)) {
          const wr = Math.round((stats.wins / stats.total) * 100);
          lines.push(`  • ${strat}: ${stats.total} trades, ${wr}% win rate`);
        }
        lines.push("");
      }

      // Average hold time
      const avgHold = closes.reduce((s, e) => s + (e.minutes_held || 0), 0) / closes.length;
      lines.push(`⏱ Avg Hold Time: ${Math.round(avgHold)}m`);
      lines.push("");
    }
  }

  // Lessons section
  lines.push(`<b>Lessons Learned:</b>`);
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
  lines.push(`<b>Current Portfolio:</b>`);
  lines.push(`📂 Open Positions: ${openPositions.length}`);
  lines.push(allCloses.length > 0
    ? `📊 All-time PnL: $${allTimePnlUsd.toFixed(2)}`
    : `📊 All-time PnL: $0.00`);
  lines.push("────────────────");

  const report = lines.join("\n");

  // Truncate to Telegram's 4096 limit
  if (report.length > 4000) {
    return report.slice(0, 3950) + "\n...<i>(truncated)</i>";
  }

  return report;
}
