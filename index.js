import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getPositionPnl } from "./tools/dlmm.js";
import { getWalletBalances, sweepDustTokens } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadConfig, reloadScreeningThresholds, computeDeployAmount, USER_CONFIG_PATH } from "./config.js";
import fs from "fs";
import { evolveThresholds, getPerformanceSummary, addLesson } from "./lessons.js";
import { registerCronRestarter, executeTool } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, notifyGasLow, notifyMaxPositions, notifyInstructionClose, isEnabled as telegramEnabled } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { generateReport } from "./reports.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { formatPoolConsensusForPrompt, syncToHive, isEnabled as hiveEnabled } from "./hive-mind.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { studyTopLPers } from "./tools/study.js";
import { getTokenHolders, getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { _stats, _flags } from "./stats.js";
import { startDashboard } from "./dashboard/server.js";

// ─── PID lock — prevent multiple instances ───────────────────────
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(__dirname, ".agent.pid");

(function acquireLock() {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
    try {
      process.kill(existingPid, 0); // signal 0 = check if process exists
      console.error(`[STARTUP] Another instance is already running (PID ${existingPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Process not found — stale lock, overwrite it
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
})();

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Models: management=${config.llm.managementModel} | screening=${config.llm.screeningModel} | general=${config.llm.generalModel}`);

// ─── Hot-reload user-config.json on file change ─────────────────
fs.watchFile(USER_CONFIG_PATH, { interval: 2000 }, (curr, prev) => {
  if (curr.mtime > prev.mtime) {
    reloadConfig();
    log("config", "user-config.json changed — settings reloaded (restart required for: rpcUrl, walletKey, dryRun, schedule intervals)");
  }
});

const TP_PCT  = config.management.takeProfitFeePct;
const DEPLOY  = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt  = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn  = formatCountdown(nextRunIn(timers.screeningLastRun,  config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _earlyManagementTimer = null; // setTimeout handle for high-vol early re-run
let _pnlCheckerBusy = false;
let _pnlCheckerInterval = null;
// Map: position_address → { peak: number } — tracks peak PnL for trailing stop
const _trailingStops = new Map();

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendMessage(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  _cronTasks = [];
  if (_pnlCheckerInterval) {
    clearInterval(_pnlCheckerInterval);
    _pnlCheckerInterval = null;
  }
  _cronRunning = false;
}

/**
 * Run one management cycle. Shared by the cron schedule and the high-vol
 * early-trigger setTimeout so both paths use identical logic.
 */
async function runManagementCycle() {
  if (_managementBusy) return;
  _managementBusy = true;
  _stats.managementCycles++;
  timers.managementLastRun = Date.now();
  log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);
  let mgmtReport = null;
  let positions = [];
  let positionData = [];
  let instructionClosePrefix = [];
  try {
    // Pre-load all positions + PnL in parallel — LLM gets everything, no fetch steps needed
    const livePositions = await getMyPositions().catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0 && livePositions === null) {
      // Fetch failed — try using tracked positions from state as fallback
      const { getTrackedPositions } = await import("./state.js");
      const tracked = getTrackedPositions(true); // open only
      if (tracked.length > 0) {
        log("cron", `getMyPositions() failed — using ${tracked.length} state-tracked position(s) as fallback`);
        positions = tracked.map(t => ({ ...t, pair: t.pool_name, in_range: true, minutes_out_of_range: 0 }));
      } else {
        log("cron", "Management skipped — no open positions");
        return;
      }
    } else if (positions.length === 0) {
      log("cron", "Management skipped — no open positions");
      return;
    }

    // Snapshot + PnL fetch in parallel for all positions
    positionData = await Promise.all(positions.map(async (p) => {
      recordPositionSnapshot(p.pool, p);
      const pnl = await getPositionPnl({ pool_address: p.pool, position_address: p.position }).catch(() => null);
      const recall = recallForPool(p.pool);
      const tracked = getTrackedPosition(p.position);
      const instruction = tracked?.instruction || null;
      const feeTvl24h = (pnl && pnl.current_value_usd > 0 && (p.age_minutes || 0) > 0)
        ? ((pnl.all_time_fees_usd / pnl.current_value_usd) / ((p.age_minutes || 1) / 1440) * 100)
        : null;
      const binsAbove = (pnl && pnl.active_bin != null && pnl.upper_bin != null)
        ? Math.max(0, pnl.active_bin - pnl.upper_bin)
        : null;
      return { ...p, pnl, recall, instruction, feeTvl24h, binsAbove };
    }));

    // ── Pre-enforce instruction-based closes BEFORE the agent loop ──────────
    // Only handles "close at X%" patterns deterministically — no LLM involvement.
    instructionClosePrefix = [];
    const skippedByInstruction = new Set();
    for (const p of positionData) {
      if (!p.instruction) continue;
      const instr = p.instruction.toLowerCase();
      const pnlPct = p.pnl?.pnl_pct ?? null;

      // Parse "close at X% profit", "close at X% pnl", "close at X%"
      const profitMatch = instr.match(/close at ([+-]?\d+(?:\.\d+)?)\s*%/);
      if (!profitMatch) continue; // pattern not recognised — leave to agent

      if (pnlPct === null) {
        log("cron", `Instruction pre-check: ${p.pair} — pnl_pct unavailable, skipping auto-close`);
        continue;
      }

      const target = parseFloat(profitMatch[1]);
      if (pnlPct >= target) {
        const reason = `Instruction: "${p.instruction}" (pnl_pct=${pnlPct}%)`;
        log("cron", `Instruction pre-check: closing ${p.pair} (${p.position}) — ${reason}`);
        try {
          await executeTool("close_position", { position_address: p.position });
          skippedByInstruction.add(p.position);
          instructionClosePrefix.push(`Auto-closed by instruction: ${p.pair} — ${reason}`);
          if (telegramEnabled()) notifyInstructionClose({ pair: p.pair, instruction: p.instruction, pnlPct: p.pnl?.pnl_pct ?? 0 }).catch(() => {});
        } catch (err) {
          log("cron_error", `Instruction pre-check: failed to close ${p.pair} (${p.position}): ${err.message}`);
          // Do not skip — let the agent handle it as a fallback
        }
      }
    }

    // Remove auto-closed positions so the agent doesn't re-process them
    if (skippedByInstruction.size > 0) {
      positionData = positionData.filter(p => !skippedByInstruction.has(p.position));
    }

    // If all positions were auto-closed, skip the agent loop
    if (positionData.length === 0) {
      mgmtReport = instructionClosePrefix.join("\n");
      log("cron", "All positions closed by instruction pre-check — skipping agent loop");
      return;
    }

    // Log rule distances for each position (for debugging)
    for (const p of positionData) {
      const pnl = p.pnl?.pnl_pct ?? null;
      const oor = p.minutes_out_of_range ?? 0;
      const rules = [];

      if (pnl !== null) {
        const toSL = pnl - config.management.emergencyPriceDropPct;
        const toTP = config.management.takeProfitFeePct - pnl;
        rules.push(`SL: ${pnl.toFixed(1)}% (need ${config.management.emergencyPriceDropPct}%, gap ${toSL.toFixed(1)}%)`);
        rules.push(`TP: ${pnl.toFixed(1)}% (need ${config.management.takeProfitFeePct}%, gap ${toTP.toFixed(1)}%)`);
      }
      if (p.feeTvl24h !== null && (p.age_minutes || 0) >= config.management.minAgeForYieldExit) {
        const toYield = p.feeTvl24h - config.management.minFeeTvl24h;
        rules.push(`YIELD24H: ${p.feeTvl24h.toFixed(1)}% (min ${config.management.minFeeTvl24h}%, gap ${toYield.toFixed(1)}%)`);
      }
      if (p.binsAbove != null && p.binsAbove > 0) {
        const toBinExit = config.management.outOfRangeBinsToClose - p.binsAbove;
        rules.push(`BINS_ABOVE: ${p.binsAbove} (close at ${config.management.outOfRangeBinsToClose}, gap ${Math.max(0, toBinExit)})`);
      }
      log("mgmt_rules", `${p.pair}: ${rules.join(" | ")}`);
    }

    // Build pre-loaded position blocks for the LLM
    const positionBlocks = positionData.map((p) => {
      const pnl = p.pnl;
      const lines = [
        `POSITION: ${p.pair} (${p.position})`,
        `  pool: ${p.pool}`,
        `  age: ${p.age_minutes ?? "?"}m | in_range: ${p.in_range} | oor_minutes: ${p.minutes_out_of_range ?? 0}` +
          (p.binsAbove != null ? ` | bins_above_range: ${p.binsAbove}` : ""),
        pnl ? `  pnl_pct: ${pnl.pnl_pct}% | pnl_usd: $${pnl.pnl_usd} | fees: $${pnl.unclaimed_fee_usd} | value: $${pnl.current_value_usd}` : `  pnl: fetch failed`,
        pnl && p.feeTvl24h != null ? `  fee_tvl_24h: ${p.feeTvl24h.toFixed(1)}%${(p.age_minutes||0) < config.management.minAgeForYieldExit ? " (rule inactive — position too young)" : ""}` : null,
        pnl ? `  to_sl: ${(pnl.pnl_pct - config.management.emergencyPriceDropPct).toFixed(1)}% | to_tp: ${(config.management.takeProfitFeePct - pnl.pnl_pct).toFixed(1)}%` +
          (p.feeTvl24h != null && (p.age_minutes||0) >= config.management.minAgeForYieldExit ? ` | to_yield: ${(p.feeTvl24h - config.management.minFeeTvl24h).toFixed(1)}%` : "") +
          (p.binsAbove != null ? ` | to_bin_exit: ${Math.max(0, config.management.outOfRangeBinsToClose - p.binsAbove)}` : "") : null,
        p.instruction ? `  instruction: "${p.instruction}"` : null,
        p.recall ? `  memory: ${p.recall}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    }).join("\n\n");

    const { content } = await agentLoop(`
MANAGEMENT CYCLE — ${positionData.length} position(s)

PRE-LOADED POSITION DATA (no fetching needed):
${positionBlocks}

HARD CLOSE RULES — apply in order, first match wins:
1. instruction set AND condition met → CLOSE (highest priority)
2. instruction set AND condition NOT met → HOLD, skip remaining rules
3. pnl_pct <= ${config.management.emergencyPriceDropPct}% → CLOSE (stop loss)
4. pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE (take profit)
5. age >= ${config.management.minAgeForYieldExit}m AND fee_tvl_24h < ${config.management.minFeeTvl24h}% → CLOSE (yield too low)
6. bins_above_range >= ${config.management.outOfRangeBinsToClose} → CLOSE (price pumped above range)

CLAIM RULE: If unclaimed_fee_usd >= ${config.management.minClaimAmount}, call claim_fees. Do not use any other threshold.

INSTRUCTIONS:
All data is pre-loaded above — do NOT call get_my_positions or get_position_pnl.
Apply the rules to each position and write your report immediately.
Only call tools if a position needs to be CLOSED or fees need to be CLAIMED.
If all positions STAY and no fees to claim, just write the report with no tool calls.

REPORT FORMAT (one line per position, no markdown):
[PAIR]: STAY — [reason, max 10 words]
[PAIR]: CLOSE — [reason, max 10 words]

When calling close_position, set close_reason to the same short reason above.
    `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 4096);
    mgmtReport = content;
  } catch (error) {
    _stats.errors++;
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    // ── Adaptive management interval: if any open position has high volatility,
    //    schedule an early re-run in 3 minutes instead of waiting for the normal interval.
    const highVolPositions = positionData.filter(p => p.volatility != null && p.volatility >= 5);
    if (highVolPositions.length > 0 && !_earlyManagementTimer) {
      const pairs = highVolPositions.map(p => p.pair || p.pool?.slice(0, 8)).join(", ");
      const earlyMs = 3 * 60 * 1000;
      log("cron", `High-volatility position(s) detected (${pairs}) — scheduling early management check in 3m`);
      _earlyManagementTimer = setTimeout(async () => {
        _earlyManagementTimer = null;
        await runManagementCycle();
      }, earlyMs);
    }

    // Re-fetch position list after agent may have closed some — only show currently open ones.
    // Reuse pre-loaded PnL (positionData) to avoid re-fetching, ensuring consistency with agent report.
    let openPositions = [];
    let liveData = [];
    try {
      const livePositions = await getMyPositions().catch(() => null);
      openPositions = livePositions?.positions || [];
      const openSet = new Set(openPositions.map(p => p.position));
      liveData = positionData.filter(p => openSet.has(p.position));
    } catch { /* non-fatal */ }

    if (telegramEnabled()) {
      // Parse agent reasoning lines: "[PAIR]: STAY — reason" or "[PAIR]: CLOSE — reason"
      const reasonMap = new Map();
      for (const line of (mgmtReport || "").split("\n")) {
        const m = line.match(/^(.+?):\s*(STAY|CLOSE)\s*[—–-]\s*(.+)/i);
        if (m) reasonMap.set(m[1].trim().toUpperCase(), `${m[2].toUpperCase()} — ${m[3].trim()}`);
      }

      // Per-position blocks with inline reasoning
      const posBlocks = liveData.map(p => {
        const name  = p.pair || p.pool?.slice(0, 8) || "?";
        const pnl   = p.pnl;
        const lines = [`📍 ${name}`];

        if (pnl?.pnl_usd != null) {
          const su = pnl.pnl_usd >= 0 ? "+" : "";
          const ss = (pnl.pnl_sol ?? 0) >= 0 ? "+" : "";
          const sp = pnl.pnl_pct >= 0 ? "+" : "";
          lines.push(`💰 PnL: ${su}$${pnl.pnl_usd.toFixed(2)} | ${ss}${(pnl.pnl_sol ?? 0).toFixed(4)} SOL | ${sp}${pnl.pnl_pct.toFixed(2)}%`);
        }
        if (p.age_minutes != null) lines.push(`⏱️ Age: ${p.age_minutes}m`);

        if (pnl?.lower_bin != null) {
          const bar = formatRangeBar(pnl.lower_bin, pnl.upper_bin, pnl.active_bin);
          lines.push(`\n📊 Ranges:\n${name} ${bar}`);
        }

        const reasoning = reasonMap.get(name.toUpperCase());
        if (reasoning) lines.push(`💡 ${reasoning}`);

        return lines.join("\n");
      });

      // Instruction close prefix (positions auto-closed before agent loop)
      const prefixBlock = instructionClosePrefix.length > 0
        ? instructionClosePrefix.join("\n") + "\n\n———————————\n\n"
        : "";

      // Balance + next management run
      const nextMgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
      let walletSol = "";
      try {
        const wb = await import("./tools/wallet.js").then(m => m.getWalletBalances({})).catch(() => null);
        if (wb?.sol != null) walletSol = `💰 Balance: ${wb.sol.toFixed(2)} SOL | `;
      } catch { /* non-fatal */ }
      const footer = `\n———————————\n${walletSol}⏰ Next: ${nextMgmt}`;

      const body = posBlocks.length > 0
        ? prefixBlock + posBlocks.join("\n\n———————————\n\n") + footer
        : (mgmtReport || "No open positions.") + footer;

      if (mgmtReport || liveData.length > 0) sendMessage(`🔄 MANAGE\n\n${body}`).catch(() => {});
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
        }
      }
    }

    // If slots are available, trigger screening shortly after management finishes
    // (30s delay lets auto-swaps settle before screening evaluates wallet balance)
    if (openPositions.length < config.risk.maxPositions && !_screeningBusy) {
      log("cron", `Management done with ${openPositions.length}/${config.risk.maxPositions} positions — triggering screening in 30s`);
      setTimeout(() => { runScreeningCycle(); }, 30_000);
    }

    // Release the busy lock only after all async work (including Telegram sends) is complete.
    // Releasing it early (before the re-fetch and sendMessage) allowed the next cron tick to
    // start a second management cycle during the async gap, producing duplicate notifications.
    _managementBusy = false;
  }
}

/**
 * Study top LPers for each currently open position and save pool notes + screener lessons.
 * Runs hourly. No-ops if LPAGENT_API_KEY is not set.
 */
async function runLearningCycle() {
  if (!process.env.LPAGENT_API_KEY) return;
  log("cron", "Starting learning cycle (top LPers)");
  try {
    const { positions = [] } = await getMyPositions().catch(() => ({}));
    if (!positions.length) { log("cron", "Learning cycle: no open positions to study"); return; }

    for (const p of positions) {
      try {
        const result = await studyTopLPers({ pool_address: p.pool, limit: 4 });
        if (!result.patterns?.top_lper_count) continue;

        const { patterns } = result;
        const poolName = p.pair || p.pool.slice(0, 8);
        const winRatePct = Math.round((patterns.avg_win_rate ?? 0) * 100);
        const holdStyle = (patterns.avg_hold_hours ?? 0) < 2 ? "short holds (<2h)" : "long holds (>4h)";

        // Pool note: concise summary for this pool's top LP behavior
        const note = [
          `Top LPers (n=${patterns.top_lper_count}):`,
          `avg hold ${patterns.avg_hold_hours}h`,
          `win rate ${winRatePct}%`,
          `avg ROI ${(patterns.avg_roi_pct ?? 0).toFixed(1)}%`,
          patterns.scalper_count > patterns.holder_count ? "mostly scalpers (<1h)" : "mostly holders (>4h)",
        ].join(" | ");
        addPoolNote({ pool_address: p.pool, note });
        log("cron", `Learning cycle — ${poolName}: ${note}`);

        // Screener lesson if there's a clear signal
        if (patterns.avg_win_rate != null && patterns.avg_roi_pct != null) {
          const rule = `${poolName}: top LPers prefer ${holdStyle} with ${winRatePct}% win rate and ${(patterns.avg_roi_pct).toFixed(1)}% avg ROI. Match hold duration to this pattern.`;
          addLesson(rule, ["top_lpers", "strategy", p.pair?.split("-")[0]?.toLowerCase()].filter(Boolean), { role: "SCREENER" });
        }
      } catch (e) {
        log("cron_warn", `Learning cycle skipped ${p.pool.slice(0, 8)}: ${e.message}`);
      }
    }
    log("cron", "Learning cycle complete");
  } catch (e) {
    log("cron_error", `Learning cycle error: ${e.message}`);
  }
}

async function runScreeningCycle() {
  if (_screeningBusy) return;

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions(), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      if (telegramEnabled()) notifyMaxPositions({ count: prePositions.total_positions, max: config.risk.maxPositions }).catch(() => {});
      return;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    if (preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      if (telegramEnabled() && !_flags.gasLowNotified) {
        notifyGasLow({ solBalance: preBalance.sol, needed: minRequired }).catch(() => {});
        _flags.gasLowNotified = true;
      }
      return;
    }
    _flags.gasLowNotified = false; // SOL is sufficient — reset so next low triggers a fresh warning
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    return;
  }

  _screeningBusy = true;
  _stats.screeningCycles++;
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  let screenReport = null;
  try {
      // Reuse pre-fetched balance — no extra RPC call needed
      const currentBalance = preBalance;
      const deployAmount = computeDeployAmount(currentBalance.sol);
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

      // Load active strategy
      const activeStrategy = getActiveStrategy();
      const strategyBlock = activeStrategy
        ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy}, best for: ${activeStrategy.best_for}`
        : `No active strategy — use default bid_ask.`;

      // Pre-load top candidates + all recon data in parallel (saves 4-6 LLM steps)
      const topCandidates = await getTopCandidates({ limit: 5 }).catch(() => null);
      const candidates = topCandidates?.candidates || topCandidates?.pools || [];

      const candidateBlocks = await Promise.all(
        candidates.slice(0, 5).map(async (pool) => {
          const mint = pool.base?.mint;
          const [smartWallets, holders, narrative, tokenInfo, poolMemory] = await Promise.allSettled([
            checkSmartWalletsOnPool({ pool_address: pool.pool }),
            mint ? getTokenHolders({ mint, limit: 10 }) : Promise.resolve(null),
            mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
            mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
            Promise.resolve(recallForPool(pool.pool)),
          ]);

          const sw   = smartWallets.status === "fulfilled" ? smartWallets.value : null;
          const h    = holders.status === "fulfilled" ? holders.value : null;
          const n    = narrative.status === "fulfilled" ? narrative.value : null;
          const ti   = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
          const mem  = poolMemory.value;

          const momentum = ti?.stats_1h
            ? `1h: price${ti.stats_1h.price_change >= 0 ? "+" : ""}${ti.stats_1h.price_change}%, buyers=${ti.stats_1h.buyers}, net_buyers=${ti.stats_1h.net_buyers}`
            : null;

          // Build compact block
          const lines = [
            `POOL: ${pool.name} (${pool.pool})`,
            `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}`,
            `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
            h ? `  holders: top_10_pct=${h.top_10_real_holders_pct ?? "?"}%, bundlers_pct=${h.bundlers_pct_in_top_100 ?? "?"}%, global_fees_sol=${h.global_fees_sol ?? "?"}` : `  holders: fetch failed`,
            momentum ? `  momentum: ${momentum}` : null,
            n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
            mem ? `  memory: ${mem}` : null,
          ].filter(Boolean);

          return lines.join("\n");
        })
      );

      const candidateContext = candidateBlocks.length > 0
        ? `\nPRE-LOADED CANDIDATE ANALYSIS (smart wallets, holders, narrative already fetched):\n${candidateBlocks.join("\n\n")}\n`
        : "";

      // Hive Mind consensus — only shown if enabled and 3+ agents have data on a pool
      const poolAddresses = candidates.map(p => p.pool).filter(Boolean);
      const hiveConsensus = hiveEnabled() ? await formatPoolConsensusForPrompt(poolAddresses) : "";
      const hiveBlock = hiveConsensus ? `\n${hiveConsensus}\n` : "";

      const { content } = await agentLoop(`
SCREENING CYCLE — DEPLOY ONLY
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL
${candidateContext}${hiveBlock}
DECISION RULES (apply to the pre-loaded candidates above, no re-fetching needed):
- HARD SKIP if global_fees_sol < ${config.screening.minTokenFeesSol} SOL (bundled/scam)
- HARD SKIP if top_10_pct > 60% OR bundlers_pct > 30%
- SKIP if narrative is empty/null or pure hype with no specific story (unless smart wallets present)
- Bundlers 5–15% are normal, not a skip reason on their own
- Smart wallets present → strong confidence boost

STEPS:
1. Pick the best candidate from the pre-loaded analysis above. If none pass, stop.
2. deploy_position directly — it fetches the active bin internally, no separate get_active_bin needed.
   Use ${deployAmount} SOL. Do NOT use a smaller amount — this is compounded from your ${currentBalance.sol.toFixed(3)} SOL wallet.

REPORT FORMAT (strict, no markdown, no tables, no headers):
If deployed:
  [PAIR]: DEPLOY — [1 sentence why this was best pick]
If no deploy:
  NO DEPLOY — [1 sentence reason]
  Best candidate: [PAIR] — [why it didn't pass]
Do NOT write next steps, lessons, observations, or anything else.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 4096);
      screenReport = content;
    } catch (error) {
      _stats.errors++;
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
    } finally {
      _screeningBusy = false;
      if (telegramEnabled() && screenReport) {
        const nextScreen = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
        let screenWalletSol = "";
        try {
          const wb = await import("./tools/wallet.js").then(m => m.getWalletBalances({})).catch(() => null);
          if (wb?.sol != null) screenWalletSol = `💰 Balance: ${wb.sol.toFixed(2)} SOL | `;
        } catch { /* non-fatal */ }
        const screenFooter = `\n———————————\n${screenWalletSol}⏰ Next: ${nextScreen}`;
        sendMessage(`🔍 SCREEN\n\n💡 ${screenReport.trim()}${screenFooter}`).catch(() => {});
      }
    }
}

const FAST_TP_PCT       = 15;  // immediate take-profit threshold
const TRAILING_ACTIVATE = 6;   // trailing stop activates when PnL exceeds this
const TRAILING_FLOOR    = 5;   // close if PnL drops below this after activation

async function runPnlChecker() {
  if (_pnlCheckerBusy || _managementBusy) return;

  const openPositions = getTrackedPositions(true);
  if (openPositions.length === 0) {
    _trailingStops.clear();
    return;
  }

  // Clean stale trailing-stop entries (position was closed externally)
  const openAddresses = new Set(openPositions.map(p => p.position));
  for (const addr of _trailingStops.keys()) {
    if (!openAddresses.has(addr)) _trailingStops.delete(addr);
  }

  _pnlCheckerBusy = true;
  try {
    for (const tracked of openPositions) {
      // Respect position instructions — if one is set, let the management cycle handle it
      if (tracked.instruction) {
        log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: has instruction "${tracked.instruction}" — skipping pnl checker`);
        _trailingStops.delete(tracked.position); // clear any trailing stop too
        continue;
      }

      const pnl = await getPositionPnl({ pool_address: tracked.pool, position_address: tracked.position }).catch(() => null);
      if (!pnl || pnl.error || pnl.pnl_pct == null) continue;

      const pct = pnl.pnl_pct;

      // Rule 1: Hard take-profit
      if (pct >= FAST_TP_PCT) {
        log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: pnl ${pct}% >= ${FAST_TP_PCT}% — TAKE PROFIT`);
        _trailingStops.delete(tracked.position);
        await executeTool("close_position", { position_address: tracked.position, close_reason: `Fast TP: pnl ${pct}%` });
        continue;
      }

      // Rule 2: Trailing stop — activate above TRAILING_ACTIVATE, close below TRAILING_FLOOR
      if (pct > TRAILING_ACTIVATE) {
        const entry = _trailingStops.get(tracked.position);
        if (!entry) {
          _trailingStops.set(tracked.position, { peak: pct });
          log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: trailing stop activated at ${pct}%`);
        } else if (pct > entry.peak) {
          entry.peak = pct;
        }
      }

      const stop = _trailingStops.get(tracked.position);
      if (stop && pct < TRAILING_FLOOR) {
        log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: trailing stop — peak ${stop.peak}%, now ${pct}% < ${TRAILING_FLOOR}% — CLOSE`);
        _trailingStops.delete(tracked.position);
        await executeTool("close_position", { position_address: tracked.position, close_reason: `Trailing stop: peak ${stop.peak}%, dropped to ${pct}%` });
      }
    }
  } finally {
    _pnlCheckerBusy = false;
  }
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  // Cancel any pending early-trigger timer so it doesn't fire after a cron restart
  if (_earlyManagementTimer) {
    clearTimeout(_earlyManagementTimer);
    _earlyManagementTimer = null;
  }

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    await runScreeningCycle();
  });

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Weekly report — Sunday 1:00 AM UTC
  const weeklyTask = cron.schedule(`0 1 * * 0`, async () => {
    log("cron", "Sending weekly report");
    try {
      const report = await generateReport("weekly");
      if (telegramEnabled()) await sendMessage(report);
    } catch (e) {
      log("cron_error", `Weekly report failed: ${e.message}`);
    }
  }, { timezone: 'UTC' });

  // Monthly report — 1st of month 1:00 AM UTC
  const monthlyTask = cron.schedule(`0 1 1 * *`, async () => {
    log("cron", "Sending monthly report");
    try {
      const report = await generateReport("monthly");
      if (telegramEnabled()) await sendMessage(report);
    } catch (e) {
      log("cron_error", `Monthly report failed: ${e.message}`);
    }
  }, { timezone: 'UTC' });

  const dustTask = cron.schedule(`0 */6 * * *`, async () => {
    try {
      const swept = await sweepDustTokens();
      if (swept.length > 0) {
        log("cron", `Dust sweep: ${swept.length} token(s) swapped to SOL`);
      }
    } catch (e) {
      log("cron_error", `Dust sweep failed: ${e.message}`);
    }
  });

  // Hourly top-LPers learning cycle — studies open positions and saves pool notes + screener lessons
  const learnTask = cron.schedule("0 * * * *", () => runLearningCycle().catch(() => {}));
  runLearningCycle().catch(() => {}); // run once on start

  _pnlCheckerInterval = setInterval(() => runPnlChecker().catch(() => {}), 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog, weeklyTask, monthlyTask, dustTask, learnTask];
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m, pnl-check every 30s`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  RANGE BAR VISUALIZATION
// ═══════════════════════════════════════════
function formatRangeBar(lower, upper, active) {
  if (lower == null || upper == null || active == null) return "[no range data]";
  const width = 16;
  const range = upper - lower;
  if (range <= 0) return "[invalid range]";

  if (active < lower) {
    const dist = Math.min(3, Math.ceil(((lower - active) / range) * 3));
    return `${"·".repeat(dist)}● [━${"━".repeat(width - 1)}] ⚠️`;
  }
  if (active > upper) {
    const dist = Math.min(3, Math.ceil(((active - upper) / range) * 3));
    return `[━${"━".repeat(width - 1)}] ●${"·".repeat(dist)} ⚠️`;
  }

  // In range — place ● proportionally
  const pos = Math.round(((active - lower) / range) * (width - 1));
  const bar = "━".repeat(pos) + "●" + "━".repeat(width - 1 - pos);
  return `[${bar}] ✅`;
}

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name   = (p.name || "unknown").padEnd(20);
    const ftvl   = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol    = `$${((p.volume_24h || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org    = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let _cronRunning = false;
let busy = false;
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun  = Date.now();
      startCronJobs();
      _cronRunning = true;
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions(),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => {});
  if (config.dashboard.enabled) startDashboard(config.dashboard.port);

  // Telegram bot
  // Startup notification — helps detect duplicate instances
  if (telegramEnabled()) {
    const mode = process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE";
    sendMessage(`🚀 Bot started (PID: ${process.pid}, mode: ${mode}). If you see this twice, kill duplicate instances.`).catch(() => {});
  }

  startPolling(async (text) => {
    if (busy) {
      sendMessage("Agent is busy with another chat — try again in a moment.").catch(() => {});
      return;
    }

    if (text === "/start") {
      if (_cronRunning) {
        sendMessage("Agent is already running.").catch(() => {});
      } else {
        startCronJobs();
        _cronRunning = true;
        sendMessage("▶️ Agent started — cron cycles running.").catch(() => {});
      }
      return;
    }

    if (text === "/stop") {
      if (!_cronRunning) {
        sendMessage("Agent is already stopped.").catch(() => {});
      } else {
        stopCronJobs();
        sendMessage("⏹️ Agent stopped — cron cycles paused. Send /start to resume.").catch(() => {});
      }
      return;
    }

    if (text === "/stats") {
      const uptime = Math.floor((Date.now() - new Date(_stats.startedAt).getTime()) / 60000);
      const msg = `📊 Agent Stats\n\nUptime: ${uptime}m\nMgmt cycles: ${_stats.managementCycles}\nScreening cycles: ${_stats.screeningCycles}\nDeployed: ${_stats.positionsDeployed}\nClosed: ${_stats.positionsClosed}\nFees claimed: ${_stats.feesClaimed}\nErrors: ${_stats.errors}\nStarted: ${_stats.startedAt}`;
      sendMessage(msg).catch(() => {});
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendMessage(briefing);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (text.startsWith("/report")) {
      const parts = text.split(" ");
      const period = ["daily", "weekly", "monthly"].includes(parts[1]) ? parts[1] : "daily";
      try {
        const report = await generateReport(period);
        await sendMessage(report);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, config.llm.generalModel);
      const reply = content || "(Agent returned no response)";
      appendHistory(text, reply);
      await sendMessage(reply);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  });

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /report [daily|weekly|monthly]  Show trading report (default: daily)
  /stats         Show in-memory agent stats (cycles, deploys, errors)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /reconcile     Re-sync local state.json against on-chain positions
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/stats") {
      const uptime = Math.floor((Date.now() - new Date(_stats.startedAt).getTime()) / 60000);
      console.log(`\nAgent Stats`);
      console.log(`  Uptime:           ${uptime}m`);
      console.log(`  Mgmt cycles:      ${_stats.managementCycles}`);
      console.log(`  Screening cycles: ${_stats.screeningCycles}`);
      console.log(`  Deployed:         ${_stats.positionsDeployed}`);
      console.log(`  Closed:           ${_stats.positionsClosed}`);
      console.log(`  Fees claimed:     ${_stats.feesClaimed}`);
      console.log(`  Errors:           ${_stats.errors}`);
      console.log(`  Started:          ${_stats.startedAt}\n`);
      rl.prompt();
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input.startsWith("/report")) {
      const parts = input.split(" ");
      const period = ["daily", "weekly", "monthly"].includes(parts[1]) ? parts[1] : "daily";
      await runBusy(async () => {
        const report = await generateReport(period);
        console.log(`\n${report.replace(/<[^>]*>/g, "")}\n`);
        if (telegramEnabled()) sendMessage(report).catch(() => {});
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  maxVolatility:    ${s.maxVolatility}`);
      console.log(`  minFeeTvlRatio:   ${s.minFeeTvlRatio}`);
      console.log(`  minOrganic:       ${s.minOrganic}`);
      console.log(`  minHolders:       ${s.minHolders}`);
      console.log(`  maxPriceChangePct: ${s.maxPriceChangePct}`);
      console.log(`  timeframe:        ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    if (input === "/reconcile") {
      await runBusy(async () => {
        console.log("\nReconciling on-chain state with local state.json...\n");
        try {
          const livePositions = await getMyPositions();
          const { syncOpenPositions } = await import("./state.js");
          const addresses = (livePositions?.positions || []).map(p => p.position);
          syncOpenPositions(addresses);
          console.log(`Reconcile complete — ${addresses.length} open position(s) on-chain, state.json updated.\n`);
        } catch (e) {
          console.error(`Reconcile failed: ${e.message}\n`);
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => {});
  if (config.dashboard.enabled) startDashboard(config.dashboard.port);
  // Startup notification — helps detect duplicate instances
  if (telegramEnabled()) {
    const mode = process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE";
    sendMessage(`🚀 Bot started (PID: ${process.pid}, mode: ${mode}). If you see this twice, kill duplicate instances.`).catch(() => {});
  }

  // Telegram chat handler (non-TTY / VPS mode)
  startPolling(async (text) => {
    if (busy) {
      sendMessage("Agent is busy with another chat — try again in a moment.").catch(() => {});
      return;
    }

    if (text === "/start") {
      sendMessage("▶️ Cron cycles are already running.").catch(() => {});
      return;
    }

    if (text === "/stop") {
      stopCronJobs();
      sendMessage("⏹️ Agent stopped — cron cycles paused. Restart with PM2 to resume.").catch(() => {});
      return;
    }

    if (text === "/stats") {
      const uptime = Math.floor((Date.now() - new Date(_stats.startedAt).getTime()) / 60000);
      const msg = `📊 Agent Stats\n\nUptime: ${uptime}m\nMgmt cycles: ${_stats.managementCycles}\nScreening cycles: ${_stats.screeningCycles}\nDeployed: ${_stats.positionsDeployed}\nClosed: ${_stats.positionsClosed}\nFees claimed: ${_stats.feesClaimed}\nErrors: ${_stats.errors}\nStarted: ${_stats.startedAt}`;
      sendMessage(msg).catch(() => {});
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendMessage(briefing);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (text.startsWith("/report")) {
      const parts = text.split(" ");
      const period = ["daily", "weekly", "monthly"].includes(parts[1]) ? parts[1] : "daily";
      try {
        const report = await generateReport(period);
        await sendMessage(report);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, config.llm.generalModel);
      const reply = content || "(Agent returned no response)";
      appendHistory(text, reply);
      await sendMessage(reply);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
    }
  });

  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.generalModel);
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
