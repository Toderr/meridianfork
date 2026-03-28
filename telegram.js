import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch { /**/ }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

export async function sendMessage(text) {
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
      log("telegram_error", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendMessage failed: ${e.message}`);
  }
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html.slice(0, 4096),
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendHTML ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendHTML failed: ${e.message}`);
  }
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
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

        // Auto-register first sender as the owner
        if (!chatId) {
          chatId = incomingChatId;
          saveChatId(chatId);
          log("telegram", `Registered chat ID: ${chatId}`);
          await sendMessage("Connected! I'm your LP agent. Ask me anything or use commands like /status.");
        }

        // Only accept messages from the registered chat
        if (incomingChatId !== chatId) continue;

        await onMessage(msg.text);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, strategy, position, tx }) {
  await sendMessage(
    `✅ DEPLOY\n\n` +
    `📍 ${pair}\n` +
    `📊 Strategy: ${strategy || "?"}\n` +
    `💰 Amount: ${amountSol} SOL\n` +
    `📄 Position: ${position?.slice(0, 8)}...\n` +
    `🔗 Tx: ${tx?.slice(0, 16)}...`
  );
}

export async function notifyClose({ pair, strategy, pnlUsd, pnlSol, pnlPct, reason }) {
  const su = (pnlUsd ?? 0) >= 0 ? "+" : "";
  const ss = (pnlSol ?? 0) >= 0 ? "+" : "";
  const sp = (pnlPct ?? 0) >= 0 ? "+" : "";
  await sendMessage(
    `🔒 CLOSE\n\n` +
    `📍 ${pair}\n` +
    (strategy ? `📊 Strategy: ${strategy}\n` : ``) +
    `💰 PnL: ${su}$${(pnlUsd ?? 0).toFixed(2)} | ${ss}${(pnlSol ?? 0).toFixed(4)} SOL | ${sp}${(pnlPct ?? 0).toFixed(2)}%` +
    (reason ? `\n💡 ${reason}` : "")
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  await sendMessage(
    `⚠️ OUT OF RANGE\n\n` +
    `📍 ${pair}\n` +
    `⏱️ OOR for ${minutesOOR}m`
  );
}

export async function notifyCycleSummary({ cycleType, positions, walletSol }) {
  await sendMessage(
    `🔄 ${cycleType === "management" ? "MANAGE" : "SCREEN"}\n\n` +
    `Positions: ${positions} open | SOL: ${walletSol}`
  );
}

export async function notifySwap({ pair, tokenSymbol, usdValue }) {
  await sendMessage(
    `💱 SWAP\n\n` +
    `📍 ${pair}\n` +
    `${tokenSymbol} → SOL\n` +
    `💰 Value: $${(usdValue || 0).toFixed(2)}`
  );
}

export async function notifySwapFailed({ pair, tokenSymbol, usdValue, error }) {
  await sendMessage(
    `⚠️ SWAP FAILED\n\n` +
    `📍 ${pair}\n` +
    `${tokenSymbol} ($${(usdValue || 0).toFixed(2)})\n` +
    `Reason: ${error?.slice(0, 80) || "unknown"}`
  );
}

export async function notifyGasLow({ solBalance, needed }) {
  await sendMessage(
    `⛽ LOW GAS\n\n` +
    `Balance: ${solBalance.toFixed(3)} SOL\n` +
    `Needed: ${needed.toFixed(3)} SOL\n` +
    `Screening paused until topped up.`
  );
}

export async function notifyMaxPositions({ count, max }) {
  await sendMessage(
    `📵 MAX POSITIONS\n\n` +
    `${count}/${max} open — screening skipped.`
  );
}

export async function notifyThresholdEvolved({ field, oldVal, newVal, reason }) {
  await sendMessage(
    `🧠 THRESHOLD EVOLVED\n\n` +
    `${field}: ${oldVal} → ${newVal}\n` +
    `${reason?.slice(0, 120) || "performance data"}`
  );
}

export async function notifyInstructionClose({ pair, instruction, pnlPct }) {
  const sp = (pnlPct ?? 0) >= 0 ? "+" : "";
  await sendMessage(
    `📋 INSTRUCTION CLOSE\n\n` +
    `📍 ${pair}\n` +
    `💡 "${instruction}"\n` +
    `💰 PnL: ${sp}${(pnlPct || 0).toFixed(2)}%`
  );
}

export async function notifyExperimentIteration({ experimentId, poolName, iteration, prevResult, params, analysis, deploySuccess }) {
  const pnl = prevResult?.pnl_pct ?? null;
  const sp  = pnl != null ? (pnl >= 0 ? "+" : "") : "";
  const eff = prevResult?.range_efficiency != null ? `${prevResult.range_efficiency.toFixed(0)}%` : "?";
  await sendMessage(
    `🧪 EXPERIMENT #${iteration - 1} → #${iteration}\n\n` +
    `📍 ${poolName}\n` +
    (pnl != null ? `💰 Last: ${sp}${pnl.toFixed(1)}% | range_eff ${eff}\n` : "") +
    `📊 Next: ${params.strategy} bins_below=${params.bins_below} bins_above=${params.bins_above}\n` +
    `💡 ${analysis}\n` +
    (deploySuccess ? `✅ Iteration ${iteration} deployed` : `⚠️ Deploy failed — experiment paused`)
  );
}

export async function notifyExperimentConverged({ experimentId, poolName, bestParams, bestPnlPct, bestRangeEff, totalIterations, convergenceReason, report }) {
  const sp = (bestPnlPct ?? 0) >= 0 ? "+" : "";
  await sendMessage(
    `🧪 EXPERIMENT CONVERGED\n\n` +
    `📍 ${poolName}\n` +
    `✅ ${convergenceReason}\n` +
    `📊 ${totalIterations} iterations\n\n` +
    (bestParams ? `Best: ${bestParams.strategy} bins_below=${bestParams.bins_below} bins_above=${bestParams.bins_above}\n` : "") +
    (bestPnlPct != null ? `💰 Best pnl: ${sp}${bestPnlPct.toFixed(1)}%` : "") +
    (bestRangeEff != null ? ` | range_eff: ${bestRangeEff.toFixed(0)}%` : "") +
    `\n\n${report}`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
