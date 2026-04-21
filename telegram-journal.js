import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { log } from "./logger.js";
import { getJournalEntries } from "./journal.js";
import { computeTruePnl, aggregateTruePnl } from "./true-pnl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_JOURNAL_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = null;
let _offset  = 0;
let _polling = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramJournalChatId) chatId = cfg.telegramJournalChatId;
    }
  } catch { /**/ }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramJournalChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("journal_bot_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

// ─── Timezone (UTC+7) ────────────────────────────────────────────
const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Current date string YYYY-MM-DD in UTC+7 */
function todayUtc7() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight of a YYYY-MM-DD date in UTC+7, returned as UTC ISO string */
function midnightUtc7(dateLabel) {
  return new Date(new Date(dateLabel + "T00:00:00.000Z").getTime() - TZ_OFFSET_MS).toISOString();
}

/** Format a UTC ISO timestamp as HH:MM in UTC+7 */
function fmtTime(isoStr) {
  if (!isoStr) return "?";
  return new Date(new Date(isoStr).getTime() + TZ_OFFSET_MS).toISOString().slice(11, 16);
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
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

// ─── bin_range helper ────────────────────────────────────────────
function fmtBins(bin_range, bin_step) {
  if (bin_range == null) return null;
  if (typeof bin_range === "object") {
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
  return `${bin_range} bins`;
}

// ─── Notification ────────────────────────────────────────────────
export async function notifyJournalClose({ pool_name, strategy, bin_range, bin_step, amount_sol, initial_value_usd, final_value_usd, pnl_usd, pnl_sol, pnl_pct, fees_earned_usd = 0, sol_price = 0, minutes_held, close_reason }) {
  if (!TOKEN || !chatId) return;
  // Display numbers are fee-inclusive (true_pnl) — canonical Meteora UI formula.
  // final_value_usd MUST be forwarded so computeTruePnl takes the main path
  // (value + fees − initial); without it we fall back to pnl_usd + fees which
  // drifts from the UI because pnl_usd is datapi's IL-adjusted price delta.
  const tp = computeTruePnl({ pnl_usd, pnl_sol, pnl_pct, fees_earned_usd, initial_value_usd, final_value_usd, sol_price }) || { usd: 0, sol: 0, pct: 0, fees_usd: fees_earned_usd || 0 };
  const su = tp.usd >= 0 ? "+" : "";
  const ss = tp.sol >= 0 ? "+" : "";
  const sp = tp.pct >= 0 ? "+" : "";
  const stratLine = [strategy, fmtBins(bin_range, bin_step)].filter(Boolean).join(" | ");
  const usdPart = (initial_value_usd > 0) ? ` ($${(+initial_value_usd).toFixed(2)})` : "";
  await sendMessage(
    `📍 ${pool_name}\n` +
    `💰 ${sp}${tp.pct.toFixed(2)}% | ${su}$${tp.usd.toFixed(2)} | ${ss}${tp.sol.toFixed(4)} SOL\n` +
    (tp.fees_usd > 0 ? `🏦 Fees Included: $${tp.fees_usd.toFixed(2)}\n` : ``) +
    `\n` +
    (stratLine ? `📊 ${stratLine}\n` : ``) +
    `💵 Invested: ${(amount_sol ?? 0).toFixed(4)} SOL${usdPart}\n` +
    (close_reason ? `💡 ${close_reason}\n` : ``) +
    (minutes_held != null ? `⏱️ Held: ${minutes_held}m\n` : ``) +
    `📖 POSITION CLOSED`
  );
}

export async function notifyJournalExperimentIteration({ poolName, experimentId, iteration, prevResult, params, analysis, deploySuccess }) {
  if (!TOKEN || !chatId) return;
  const pnl = prevResult?.pnl_pct ?? null;
  const sp  = pnl != null ? (pnl >= 0 ? "+" : "") : "";
  const eff = prevResult?.range_efficiency != null ? `${prevResult.range_efficiency.toFixed(0)}%` : "?";
  await sendMessage(
    `🧪 EXPERIMENT #${iteration - 1} → #${iteration}\n\n` +
    `📍 ${poolName}\n` +
    (pnl != null ? `💰 Last: ${sp}${pnl.toFixed(1)}% | range_eff ${eff}\n` : ``) +
    `📊 Next: ${params.strategy} bins↓${params.bins_below} bins↑${params.bins_above}\n` +
    `💡 ${analysis}\n` +
    (deploySuccess ? `✅ Iteration ${iteration} deployed` : `⚠️ Deploy failed — experiment paused`) +
    `\n\n🔖 ${experimentId}`
  );
}

export async function notifyJournalExperimentConverged({ poolName, experimentId, bestParams, bestPnlPct, bestRangeEff, totalIterations, convergenceReason, report }) {
  if (!TOKEN || !chatId) return;
  const sp = (bestPnlPct ?? 0) >= 0 ? "+" : "";
  await sendMessage(
    `🧪 EXPERIMENT CONVERGED\n\n` +
    `📍 ${poolName}\n` +
    `✅ ${convergenceReason}\n` +
    `📊 ${totalIterations} iterations\n\n` +
    (bestParams ? `Best: ${bestParams.strategy} bins↓${bestParams.bins_below} bins↑${bestParams.bins_above}\n` : ``) +
    (bestPnlPct != null ? `💰 Best pnl: ${sp}${bestPnlPct.toFixed(1)}%` : ``) +
    (bestRangeEff != null ? ` | range_eff: ${bestRangeEff.toFixed(0)}%` : ``) +
    `\n\n${report}\n\n🔖 ${experimentId}`
  );
}

export async function notifyClaudeReview({ newLessons = [], appliedConfig = {}, rationale = "", autoresearchData = null }) {
  if (!TOKEN || !chatId) return;
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

  await sendMessage(parts.join("\n"));
}

// ─── Config change notification ─────────────────────────────────

/**
 * Notify journal bot when screening/config parameters are changed by the agent.
 * @param {Object} applied - key→value of applied changes
 * @param {Object} before  - key→previousValue
 * @param {string} reason  - why the change was made
 * @param {string} source  - who made the change ("agent", "claude-review", "user")
 */
export async function notifyConfigChange({ applied = {}, before = {}, reason = "", source = "agent" }) {
  if (!TOKEN || !chatId) return;
  const keys = Object.keys(applied);
  if (keys.length === 0) return;
  const lines = [`⚙️ CONFIG CHANGED (${source})`];
  for (const k of keys) {
    const prev = before[k] !== undefined ? JSON.stringify(before[k]) : "?";
    lines.push(`• ${k}: ${prev} → ${JSON.stringify(applied[k])}`);
  }
  if (reason) lines.push(`\n💡 ${reason}`);
  await sendMessage(lines.join("\n"));
}

// ─── Error notification (throttled: same source once per 15 min) ─
const _errorNotifiedAt = new Map();

export async function notifyError(source, message) {
  if (!TOKEN || !chatId) return;
  const now = Date.now();
  const last = _errorNotifiedAt.get(source) || 0;
  if (now - last < 15 * 60_000) return; // 15 min throttle per source
  _errorNotifiedAt.set(source, now);
  await sendMessage(
    `🚨 ERROR — ${source}\n\n${String(message).slice(0, 3800)}`
  );
}

// ─── RPC limit notice (throttled: once per hour) ─────────────────
let _rpcLimitNotifiedAt = 0;

export async function notifyRpcLimit() {
  if (!TOKEN || !chatId) return;
  if (Date.now() - _rpcLimitNotifiedAt < 60 * 60_000) return; // 1h throttle
  _rpcLimitNotifiedAt = Date.now();
  await sendMessage(
    `⚠️ HELIUS RATE LIMIT\n\n` +
    `Wallet balance API returning 429.\n` +
    `Token balances unavailable — using RPC fallback (SOL only).\n` +
    `Post-close swaps may use direct RPC token lookup.`
  );
}

// ─── Shared report builder ───────────────────────────────────────
function buildSummaryReport(closes, header) {
  if (!closes.length) return `${header}\n\nNo closed positions.`;

  // All aggregates are fee-inclusive (true_pnl).
  const rows = closes.map(e => ({ e, tp: computeTruePnl(e) })).filter(x => x.tp !== null);
  if (!rows.length) return `${header}\n\nNo closed positions.`;

  const wins   = rows.filter(x => x.tp.is_win);
  const losses = rows.filter(x => !x.tp.is_win);
  const totalUsd = rows.reduce((s, x) => s + x.tp.usd, 0);
  const totalSol = rows.reduce((s, x) => s + x.tp.sol, 0);
  const totalInvested = rows.reduce((s, x) => s + (x.e.initial_value_usd ?? 0), 0);
  const totalPct = totalInvested > 0 ? (totalUsd / totalInvested) * 100 : 0;
  const winRate = Math.round((wins.length / rows.length) * 100);
  const avgProfit = wins.length  > 0 ? wins.reduce((s, x)   => s + x.tp.pct, 0) / wins.length   : 0;
  const avgLoss   = losses.length > 0 ? losses.reduce((s, x) => s + x.tp.pct, 0) / losses.length : 0;

  const suT = totalUsd >= 0 ? "+" : "";
  const ssT = totalSol >= 0 ? "+" : "";
  const spT = totalPct >= 0 ? "+" : "";

  const stratMap = {};
  for (const x of rows) {
    const s = x.e.strategy ?? "unknown";
    if (!stratMap[s]) stratMap[s] = [];
    stratMap[s].push(x.tp.pct);
  }
  let bestStrat = null, bestStratAvg = -Infinity;
  for (const [s, pcts] of Object.entries(stratMap)) {
    const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    if (avg > bestStratAvg) { bestStratAvg = avg; bestStrat = s; }
  }
  const bestStratLine = bestStrat
    ? `🎯 Best: ${bestStrat} (avg ${bestStratAvg >= 0 ? "+" : ""}${bestStratAvg.toFixed(2)}%, ${stratMap[bestStrat].length} trade${stratMap[bestStrat].length > 1 ? "s" : ""})`
    : null;

  return [
    `${header}\n`,
    `📊 ${rows.length} trades | ${wins.length}W ${losses.length}L`,
    `💰 PnL: ${suT}$${totalUsd.toFixed(2)} | ${ssT}${totalSol.toFixed(4)} SOL | ${spT}${totalPct.toFixed(2)}%`,
    `📈 Win rate: ${winRate}%`,
    `✅ Avg profit: ${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(2)}%`,
    `❌ Avg loss: ${avgLoss.toFixed(2)}%`,
    bestStratLine,
  ].filter(Boolean).join("\n");
}

// ─── Command handlers ────────────────────────────────────────────
function fmtEntry(e) {
  const t = fmtTime(e.timestamp);
  if (e.type === "open") {
    return `📗 [${t}] OPEN ${e.pool_name} — ${(e.amount_sol ?? 0).toFixed(4)} SOL`;
  }
  if (e.type === "close") {
    const tp = computeTruePnl(e) || { usd: 0, pct: 0 };
    const sp = tp.pct >= 0 ? "+" : "";
    const su = tp.usd >= 0 ? "+" : "";
    return `📕 [${t}] CLOSE ${e.pool_name} — ${su}$${tp.usd.toFixed(2)} (${sp}${tp.pct.toFixed(2)}%) ${e.close_reason ? `· ${e.close_reason}` : ""}`;
  }
  if (e.type === "claim") {
    return `💸 [${t}] CLAIM ${e.pool_name} — $${(e.fees_usd ?? 0).toFixed(2)}`;
  }
  return `? ${e.type} ${e.pool_name}`;
}

async function handleCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);

  if (cmd === "/recent") {
    const n = Math.min(parseInt(args[0]) || 5, 20);
    const entries = getJournalEntries();
    const recent = entries.slice(-n).reverse();
    if (!recent.length) return sendMessage("No journal entries yet.");
    return sendMessage(`📖 Last ${recent.length} entries:\n\n` + recent.map(fmtEntry).join("\n"));
  }

  if (cmd === "/today") {
    const dateLabel = todayUtc7();
    const closes = getJournalEntries({ from: midnightUtc7(dateLabel), type: "close" });
    return sendMessage(buildSummaryReport(closes, `📖 TODAY — ${dateLabel}`));
  }

  if (cmd === "/closes") {
    const entries = getJournalEntries({ type: "close" });
    const recent = entries.slice(-10).reverse();
    if (!recent.length) return sendMessage("No close entries yet.");
    return sendMessage(`📕 Recent closes (${recent.length}):\n\n` + recent.map(fmtEntry).join("\n"));
  }

  if (cmd === "/stats") {
    const closes = getJournalEntries({ type: "close" });
    if (!closes.length) return sendMessage("No closed positions yet.");
    // Fee-inclusive (true_pnl) stats
    const rows = closes.map(e => computeTruePnl(e)).filter(tp => tp !== null);
    if (!rows.length) return sendMessage("No closed positions yet.");
    const wins = rows.filter(tp => tp.is_win).length;
    const totalPnlUsd = rows.reduce((s, tp) => s + tp.usd, 0);
    const totalPnlSol = rows.reduce((s, tp) => s + tp.sol, 0);
    const winRate = ((wins / rows.length) * 100).toFixed(0);
    const su = totalPnlUsd >= 0 ? "+" : "";
    const ss = totalPnlSol >= 0 ? "+" : "";
    return sendMessage(
      `📊 Journal Stats\n\n` +
      `Trades: ${rows.length} | Win rate: ${winRate}%\n` +
      `Total PnL: ${su}$${totalPnlUsd.toFixed(2)} | ${ss}${totalPnlSol.toFixed(4)} SOL`
    );
  }

  // Default help
  return sendMessage(
    `📖 Journal Bot\n\n` +
    `/recent [N] — last N entries (default 5)\n` +
    `/today — daily recap with lessons & action plan\n` +
    `/closes — last 10 closed positions\n` +
    `/stats — all-time win rate and PnL`
  );
}

// ─── Long polling ────────────────────────────────────────────────
async function poll() {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const incomingChatId = String(msg.chat.id);

        if (!chatId) {
          chatId = incomingChatId;
          saveChatId(chatId);
          log("journal_bot", `Registered chat ID: ${chatId}`);
          await sendMessage("Journal bot connected. Use /recent, /today, /closes, or /stats.");
          continue;
        }

        if (incomingChatId !== chatId) continue;

        await handleCommand(msg.text);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("journal_bot_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

// ─── Scheduled reports ───────────────────────────────────────────
async function sendDailyReport() {
  const dateLabel = todayUtc7();
  const closes = getJournalEntries({ from: midnightUtc7(dateLabel), type: "close" });
  await sendMessage(buildSummaryReport(closes, `📖 DAILY — ${dateLabel}`));
}

async function sendWeeklyReport() {
  const dateLabel = todayUtc7();
  // 7 days back: midnight of (today - 6 days) in UTC+7
  const sevenDaysAgo = new Date(new Date(dateLabel + "T00:00:00.000Z").getTime() - TZ_OFFSET_MS - 6 * 24 * 60 * 60 * 1000).toISOString();
  const closes = getJournalEntries({ from: sevenDaysAgo, type: "close" });
  // Week label: "Mon DD – Mon DD"
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const endDate = new Date(Date.now() + TZ_OFFSET_MS);
  const startDate = new Date(endDate.getTime() - 6 * 24 * 60 * 60 * 1000);
  const fmtDate = (d) => `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
  const weekLabel = `${fmtDate(startDate)} – ${fmtDate(endDate)}`;
  await sendMessage(buildSummaryReport(closes, `📅 WEEKLY — ${weekLabel}`));
}

async function sendMonthlyReport() {
  const dateLabel = todayUtc7(); // YYYY-MM-DD
  const [year, month] = dateLabel.split("-").map(Number);
  // First day of this month midnight UTC+7 expressed as UTC
  const firstOfMonth = new Date(new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`).getTime() - TZ_OFFSET_MS).toISOString();
  const closes = getJournalEntries({ from: firstOfMonth, type: "close" });
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  await sendMessage(buildSummaryReport(closes, `📆 MONTHLY — ${MONTH_NAMES[month - 1]} ${year}`));
}

export function startJournalPolling() {
  if (!TOKEN) return;
  _polling = true;
  poll();
  log("journal_bot", "Journal bot polling started");
}

export function startJournalCrons() {
  if (!TOKEN) return;

  // Daily at 23:59 UTC+7
  cron.schedule("59 23 * * *", () => {
    sendDailyReport().catch(e => log("journal_bot_error", `Daily report failed: ${e.message}`));
  }, { timezone: "Asia/Bangkok" });

  // Weekly Sunday at 23:59 UTC+7
  cron.schedule("59 23 * * 0", () => {
    sendWeeklyReport().catch(e => log("journal_bot_error", `Weekly report failed: ${e.message}`));
  }, { timezone: "Asia/Bangkok" });

  // Monthly: last day of month at 23:59 UTC+7 — run on 28-31, send only on last day
  cron.schedule("59 23 28-31 * *", () => {
    const now7 = new Date(Date.now() + TZ_OFFSET_MS);
    const tomorrow7 = new Date(now7.getTime() + 24 * 60 * 60 * 1000);
    if (tomorrow7.getUTCDate() === 1) {
      sendMonthlyReport().catch(e => log("journal_bot_error", `Monthly report failed: ${e.message}`));
    }
  }, { timezone: "Asia/Bangkok" });

  log("journal_bot", "Journal report crons scheduled (daily/weekly/monthly at 23:59 UTC+7)");
}

export function stopJournalPolling() {
  _polling = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
