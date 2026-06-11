/**
 * Sends position-close reports to the shared journal bot used by the
 * other Meridian instance. Send-only — no polling here, since the other
 * instance already long-polls this bot's getUpdates.
 */

import { log } from "./logger.js";

const TOKEN  = process.env.TELEGRAM_JOURNAL_BOT_TOKEN || null;
const CHAT_ID = process.env.TELEGRAM_JOURNAL_CHAT_ID || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

export function isEnabled() {
  return !!(TOKEN && CHAT_ID);
}

async function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: String(text).slice(0, 4096),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("journal_bot_error", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("journal_bot_error", `sendMessage failed: ${e.message}`);
  }
}

function fmtBins(bin_range, bin_step) {
  if (bin_range == null || typeof bin_range !== "object") return null;
  const below = bin_range.bins_below ?? 0;
  const above = bin_range.bins_above ?? 0;
  const total = below + above;
  if (!total) return null;
  if (bin_step > 0) {
    const pBelow = Math.round(below * bin_step / 100);
    const pAbove = Math.round(above * bin_step / 100);
    return `${total} bins (-${pBelow}% / +${pAbove}%)`;
  }
  return `${total} bins`;
}

function fmtShape(bin_range) {
  if (!bin_range || typeof bin_range !== "object") return null;
  const below = bin_range.bins_below ?? 0;
  const above = bin_range.bins_above ?? 0;
  if (below + above === 0) return null;
  return (below === 0 || above === 0) ? "single-sided" : "double-sided";
}

export async function notifyJournalClose({ pool_name, strategy, bin_range, bin_step, amount_sol, initial_value_usd, pnl_usd, pnl_sol, pnl_pct, fees_earned_usd = 0, minutes_held, close_reason }) {
  if (!TOKEN || !CHAT_ID) return;
  const usdVal = +pnl_usd || 0;
  const solVal = +pnl_sol || 0;
  const pctVal = +pnl_pct || 0;
  const feesVal = +fees_earned_usd || 0;
  const su = usdVal >= 0 ? "+" : "";
  const ss = solVal >= 0 ? "+" : "";
  const sp = pctVal >= 0 ? "+" : "";
  const shape = fmtShape(bin_range);
  const stratHead = [strategy, shape].filter(Boolean).join(" · ");
  const stratLine = [stratHead, fmtBins(bin_range, bin_step)].filter(Boolean).join(" | ");
  const usdPart = (initial_value_usd > 0) ? ` ($${(+initial_value_usd).toFixed(2)})` : "";
  const netVal = usdVal + feesVal;
  const sn = netVal >= 0 ? "+" : "";
  await sendMessage(
    `📍 ${pool_name} [yunus0x]\n` +
    (feesVal > 0 ? `💼 Total (PnL + Fees): ${sn}$${netVal.toFixed(2)}\n` : ``) +
    `💰 ${sp}${pctVal.toFixed(2)}% | ${su}$${usdVal.toFixed(2)} | ${ss}${solVal.toFixed(4)} SOL\n` +
    (feesVal > 0 ? `🏦 Fees Earned: $${feesVal.toFixed(2)}\n` : ``) +
    `\n` +
    (stratLine ? `📊 ${stratLine}\n` : ``) +
    `💵 Invested: ${(amount_sol ?? 0).toFixed(4)} SOL${usdPart}\n` +
    (close_reason ? `💡 ${close_reason}\n` : ``) +
    (minutes_held != null ? `⏱️ Held: ${minutes_held}m\n` : ``) +
    `📖 POSITION CLOSED`
  );
}
