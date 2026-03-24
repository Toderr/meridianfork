import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { getJournalEntries } from "./journal.js";
import { listLessons } from "./lessons.js";

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

// ─── Notification ────────────────────────────────────────────────
export async function notifyJournalClose({ pool_name, strategy, bin_range, amount_sol, initial_value_usd, pnl_usd, pnl_sol, pnl_pct, minutes_held, close_reason }) {
  if (!TOKEN || !chatId) return;
  const su = (pnl_usd ?? 0) >= 0 ? "+" : "";
  const ss = (pnl_sol ?? 0) >= 0 ? "+" : "";
  const sp = (pnl_pct ?? 0) >= 0 ? "+" : "";
  const stratLine = [strategy, bin_range != null ? `${bin_range} bins` : null].filter(Boolean).join(" | ");
  await sendMessage(
    `📖 JOURNAL — CLOSE\n\n` +
    `📍 ${pool_name}\n` +
    (stratLine ? `📊 ${stratLine}\n` : ``) +
    `💵 Invested: ${(amount_sol ?? 0).toFixed(4)} SOL ($${(initial_value_usd ?? 0).toFixed(2)})\n` +
    `💰 PnL: ${su}$${(pnl_usd ?? 0).toFixed(2)} | ${ss}${(pnl_sol ?? 0).toFixed(4)} SOL | ${sp}${(pnl_pct ?? 0).toFixed(2)}%` +
    (close_reason ? `\n💡 ${close_reason}` : ``) +
    (minutes_held != null ? `\n⏱️ Held: ${minutes_held}m` : ``)
  );
}

// ─── Command handlers ────────────────────────────────────────────
function fmtEntry(e) {
  if (e.type === "open") {
    return `📗 OPEN ${e.pool_name} — ${(e.amount_sol ?? 0).toFixed(4)} SOL`;
  }
  if (e.type === "close") {
    const sp = (e.pnl_pct ?? 0) >= 0 ? "+" : "";
    const su = (e.pnl_usd ?? 0) >= 0 ? "+" : "";
    return `📕 CLOSE ${e.pool_name} — ${su}$${(e.pnl_usd ?? 0).toFixed(2)} (${sp}${(e.pnl_pct ?? 0).toFixed(2)}%) ${e.close_reason ? `· ${e.close_reason}` : ""}`;
  }
  if (e.type === "claim") {
    return `💸 CLAIM ${e.pool_name} — $${(e.fees_usd ?? 0).toFixed(2)}`;
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
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString();
    const dateLabel = todayStart.toISOString().slice(0, 10);

    const closes = getJournalEntries({ from: todayStr, type: "close" });
    if (!closes.length) return sendMessage(`📖 TODAY — ${dateLabel}\n\nNo closed positions yet.`);

    // ── Per-position lines ────────────────────────────────────────
    const posLines = closes.map((e) => {
      const sp = (e.pnl_pct ?? 0) >= 0 ? "+" : "";
      const su = (e.pnl_usd ?? 0) >= 0 ? "+" : "";
      const icon = (e.pnl_pct ?? 0) >= 0 ? "📗" : "📕";
      return `${icon} ${e.pool_name} | ${su}$${(e.pnl_usd ?? 0).toFixed(2)} | ${sp}${(e.pnl_pct ?? 0).toFixed(2)}% | ${e.strategy ?? "?"} | ${e.minutes_held ?? "?"}m | ${e.close_reason ?? "-"}`;
    });

    // ── Stats ────────────────────────────────────────────────────
    const wins   = closes.filter(e => (e.pnl_pct ?? 0) >= 0);
    const losses = closes.filter(e => (e.pnl_pct ?? 0) < 0);
    const totalUsd = closes.reduce((s, e) => s + (e.pnl_usd ?? 0), 0);
    const totalSol = closes.reduce((s, e) => s + (e.pnl_sol ?? 0), 0);
    const totalInvested = closes.reduce((s, e) => s + (e.initial_value_usd ?? 0), 0);
    const totalPct = totalInvested > 0 ? (totalUsd / totalInvested) * 100 : 0;
    const winRate = Math.round((wins.length / closes.length) * 100);
    const avgProfit = wins.length  > 0 ? wins.reduce((s, e)   => s + (e.pnl_pct ?? 0), 0) / wins.length   : 0;
    const avgLoss   = losses.length > 0 ? losses.reduce((s, e) => s + (e.pnl_pct ?? 0), 0) / losses.length : 0;

    const suT = totalUsd >= 0 ? "+" : "";
    const ssT = totalSol >= 0 ? "+" : "";
    const spT = totalPct >= 0 ? "+" : "";

    // ── Best strategy ─────────────────────────────────────────────
    const stratMap = {};
    for (const e of closes) {
      const s = e.strategy ?? "unknown";
      if (!stratMap[s]) stratMap[s] = [];
      stratMap[s].push(e.pnl_pct ?? 0);
    }
    let bestStrat = null, bestStratAvg = -Infinity;
    for (const [s, pcts] of Object.entries(stratMap)) {
      const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      if (avg > bestStratAvg) { bestStratAvg = avg; bestStrat = s; }
    }
    const bestStratLine = bestStrat
      ? `🎯 Best strategy: ${bestStrat} (avg ${bestStratAvg >= 0 ? "+" : ""}${bestStratAvg.toFixed(2)}%, ${stratMap[bestStrat].length} trade${stratMap[bestStrat].length > 1 ? "s" : ""})`
      : null;

    // ── Lessons derived today ─────────────────────────────────────
    const allLessons = listLessons({ limit: 200 }).lessons;
    const todayLessons = allLessons.filter(l => l.created_at >= dateLabel);
    const lessonLines = todayLessons.length > 0
      ? todayLessons.map(l => `• ${l.rule.slice(0, 100)}`).join("\n")
      : "• No new lessons derived today";

    // ── Action plan ───────────────────────────────────────────────
    const actions = [];
    if (bestStrat && bestStratAvg > 0)
      actions.push(`Prioritize ${bestStrat} strategy — best performer today`);
    if (winRate < 40)
      actions.push("Win rate low (<40%) — review entry criteria before next deploy");
    else if (winRate >= 70)
      actions.push("Strong win rate — current screening criteria is working well");
    if (losses.length > 0) {
      const emergencyLosses = losses.filter(e => (e.close_reason ?? "").toLowerCase().includes("emergency") || (e.close_reason ?? "").toLowerCase().includes("stop"));
      if (emergencyLosses.length > 0)
        actions.push(`${emergencyLosses.length} stop-loss trigger(s) — consider tightening entry criteria for volatile pools`);
      const avgLossHeld = losses.reduce((s, e) => s + (e.minutes_held ?? 0), 0) / losses.length;
      if (avgLossHeld < 20)
        actions.push("Losing positions closed quickly (<20m avg) — may indicate bad entries, not bad management");
    }
    const oorLosses = closes.filter(e => (e.close_reason ?? "").toLowerCase().includes("oor") || (e.close_reason ?? "").toLowerCase().includes("range"));
    if (oorLosses.length > 0)
      actions.push(`${oorLosses.length} OOR close(s) — consider wider bin range or more volatile-tolerant strategy`);
    if (actions.length === 0)
      actions.push("Performance within normal range — maintain current settings");

    const actionLines = actions.map(a => `• ${a}`).join("\n");

    // ── Assemble ──────────────────────────────────────────────────
    const parts = [
      `📖 TODAY — ${dateLabel}\n`,
      posLines.join("\n"),
      `\n——————————————`,
      `📊 ${closes.length} trades | ${wins.length}W ${losses.length}L`,
      `💰 PnL: ${suT}$${totalUsd.toFixed(2)} | ${ssT}${totalSol.toFixed(4)} SOL | ${spT}${totalPct.toFixed(2)}%`,
      `📈 Win rate: ${winRate}%`,
      `✅ Avg profit: ${avgProfit >= 0 ? "+" : ""}${avgProfit.toFixed(2)}%`,
      `❌ Avg loss: ${avgLoss.toFixed(2)}%`,
      bestStratLine,
      `\n——————————————`,
      `🧠 Lessons today:\n${lessonLines}`,
      `\n——————————————`,
      `📋 Action plan:\n${actionLines}`,
    ].filter(Boolean).join("\n");

    return sendMessage(parts);
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
    const wins = closes.filter(e => (e.pnl_pct ?? 0) >= 0).length;
    const totalPnlUsd = closes.reduce((s, e) => s + (e.pnl_usd ?? 0), 0);
    const totalPnlSol = closes.reduce((s, e) => s + (e.pnl_sol ?? 0), 0);
    const winRate = ((wins / closes.length) * 100).toFixed(0);
    const su = totalPnlUsd >= 0 ? "+" : "";
    const ss = totalPnlSol >= 0 ? "+" : "";
    return sendMessage(
      `📊 Journal Stats\n\n` +
      `Trades: ${closes.length} | Win rate: ${winRate}%\n` +
      `Total PnL: ${su}$${totalPnlUsd.toFixed(2)} | ${ss}${totalPnlSol.toFixed(4)} SOL`
    );
  }

  // Default help
  return sendMessage(
    `📖 Journal Bot\n\n` +
    `/recent [N] — last N entries (default 5)\n` +
    `/today — all entries today\n` +
    `/closes — last 10 closed positions\n` +
    `/stats — win rate and total PnL`
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

export function startJournalPolling() {
  if (!TOKEN) return;
  _polling = true;
  poll();
  log("journal_bot", "Journal bot polling started");
}

export function stopJournalPolling() {
  _polling = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
