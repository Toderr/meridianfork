import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log, logSnapshot } from "./logger.js";
import { getMyPositions, getPositionPnl } from "./tools/dlmm.js";
import { getWalletBalances, sweepDustTokens, sweepAllTokensToSol } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadConfig, reloadScreeningThresholds, computeDeployAmount, USER_CONFIG_PATH } from "./config.js";
import fs from "fs";
import { evolveThresholds, getPerformanceSummary, addLesson, updateLesson, listAllLessons, removeLesson } from "./lessons.js";
import { registerCronRestarter, executeTool, resetDeployGuard } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, notifyGasLow, notifyMaxPositions, notifyInstructionClose, isEnabled as telegramEnabled } from "./telegram.js";
import { startJournalPolling, stopJournalPolling, startJournalCrons, notifyError } from "./telegram-journal.js";
import { generateBriefing } from "./briefing.js";
import { generateReport } from "./reports.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions } from "./state.js";
import { getActiveStrategy, getStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { formatPoolConsensusForPrompt, syncToHive, isEnabled as hiveEnabled } from "./hive-mind.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { studyTopLPers } from "./tools/study.js";
import { getFullTokenAnalysis } from "./tools/okx.js";
import { evaluateAll } from "./management-rules.js";
import { getTokenHolders, getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { _stats, _flags, recordPeak } from "./stats.js";
import { startDashboard } from "./dashboard/server.js";
import { extractRules, checkPositionCompliance, filterCandidatesByRules } from "./lesson-rules.js";
import { cacheTokenProfile } from "./screening-cache.js";
import { appendDecision, getRecentDecisions } from "./decision-log.js";

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

// Compile knowledge wiki on startup (fire-and-forget)
import("./wiki.js").then(m => {
  const r = m.compileFullWiki();
  log("startup", `Wiki compiled: ${r.tokens} tokens, ${r.strategies} strategies, regime=${r.regime || "unknown"}`);
}).catch(e => log("wiki_error", `Startup wiki compile failed: ${e.message}`));

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
  managementLastRun: { high: null, med: null, low: null },
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

function nextManagementCountdown() {
  const tiers = config.schedule.managementTiers;
  const secs = ["high", "med", "low"].map(t => {
    const lastRun = timers.managementLastRun[t];
    if (!lastRun) return 0;
    const intervalSec = tiers[t].intervalMin * 60;
    const elapsed = (Date.now() - lastRun) / 1000;
    return Math.max(0, intervalSec - elapsed);
  });
  return Math.min(...secs);
}

function buildPrompt() {
  const mgmt = formatCountdown(nextManagementCountdown());
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _mgmtDispatcher = null;  // setInterval handle for tiered management dispatcher
let _pnlCheckerBusy = false;
let _pnlCheckerInterval = null;
let _dustSweepInterval = null;
// Map: position_address → { peak: number } — tracks peak PnL for trailing stop
const _trailingStops = new Map();
// Map: position_address → { last_pct: number, last_check_ts: number } — used by the
// tiered PnL checker to poll hurt/volatile positions at the full 5s tick and
// cool positions at ~15s (every 3rd tick). 2026-04-23 big-loss audit showed
// 43% of SL closes realized past their trigger — tighter cadence on at-risk
// positions narrows the slippage window.
const _pnlPollState = new Map();
const PNL_TICK_MS = 5_000;
const PNL_COLD_INTERVAL_MS = 15_000;
const PNL_HOT_PCT_THRESHOLD = -2;
const PNL_HOT_VOLATILITY_THRESHOLD = 3;
// 2026-04-27: post-rebuild audit showed `<15m` close bucket = 57.1% wr / -0.43%
// avg (n=14, includes 6 stop_loss @ -4.39% avg). Some early SL fires crystallize
// a loss that may have stabilized — give the position MIN_HOLD_BEFORE_SL_MIN
// minutes to settle before any SL fires. Cap is intentionally short so genuine
// crashes still cut quickly. Only applies to non-experiment positions.
const MIN_HOLD_BEFORE_SL_MIN = 5;

// 2026-04-27 give-back analysis: positions with peak in [1%, 2%) realized only
// +0.36% (give back 71% of peak). Trailing stop only activates above
// `trailingActivate` (config), which is too high to capture peaks of +1.5%.
// Soft-peak guard: if pnl ever crossed SOFT_PEAK_THRESHOLD and has fallen back
// to ≤ SOFT_PEAK_GIVE_BACK_RATIO × peak after SOFT_PEAK_DELAY_MS, exit before
// yield_exit/oor cut at +0.20%. Non-experiment only.
const _softPeakTracker = new Map(); // position → { peak, peak_ts }
const SOFT_PEAK_THRESHOLD = 1.5;
const SOFT_PEAK_GIVE_BACK_RATIO = 0.5;
const SOFT_PEAK_DELAY_MS = 10 * 60 * 1000;

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
    notifyError("Briefing", error.message);
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
  if (_mgmtDispatcher) {
    clearInterval(_mgmtDispatcher);
    _mgmtDispatcher = null;
  }
  if (_pnlCheckerInterval) {
    clearInterval(_pnlCheckerInterval);
    _pnlCheckerInterval = null;
  }
  if (_dustSweepInterval) {
    clearInterval(_dustSweepInterval);
    _dustSweepInterval = null;
  }
  _cronRunning = false;
}

/**
 * Classify a position's volatility into a management tier name.
 * null volatility (old deploys without volatility stored) → "med".
 */
function classifyVolatilityTier(volatility) {
  if (volatility == null) return "med";
  if (volatility >= 5) return "high";
  if (volatility >= 2) return "med";
  return "low";
}

/**
 * Run one management cycle for a specific volatility tier.
 * Called by dispatchManagement() — each tier runs independently on its own interval.
 * @param {Object|null} tier - { name: "high"|"med"|"low", minVol, intervalMin } or null for legacy
 */
async function runManagementCycle(tier = null) {
  if (_managementBusy) return;
  _managementBusy = true;
  _stats.managementCycles++;
  const tierName = tier?.name ?? "med";
  timers.managementLastRun[tierName] = Date.now();
  const tierLabel = tier ? ` [${tier.name.toUpperCase()}]` : "";
  log("cron", `Starting management cycle${tierLabel} [model: ${config.llm.managementModel}]`);
  // Hard 10-minute cap — prevents a stuck cycle from blocking all future management + screening
  const _mgmtTimeout = setTimeout(() => {
    if (_managementBusy) {
      log("cron_error", `Management cycle${tierLabel} exceeded 10-minute timeout — force-releasing lock`);
      _managementBusy = false;
    }
  }, 10 * 60_000);
  let mgmtReport = null;
  let positions = [];
  let positionData = [];
  let allPositionData = [];
  let tierFilteredToEmpty = false;
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

    // Build lightweight metadata from state only (no API calls) — used for tier filter + screening trigger
    allPositionData = positions.map(p => {
      const tracked = getTrackedPosition(p.position);
      return { ...p, volatility: tracked?.volatility ?? null };
    });

    // Apply tier filter BEFORE expensive PnL API calls — avoids wasted requests on empty tiers
    if (tier) {
      const tierPositions = positions.filter(p => {
        const tracked = getTrackedPosition(p.position);
        return classifyVolatilityTier(tracked?.volatility ?? null) === tier.name;
      });
      if (tierPositions.length === 0) {
        log("cron", `Management${tierLabel}: no ${tier.name}-volatility positions — skipping`);
        tierFilteredToEmpty = true;
        return;
      }
      positions = tierPositions;
      log("cron", `Management${tierLabel}: ${positions.length} position(s) in this tier`);
    }

    // Snapshot + PnL fetch in parallel — only for this tier's positions
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
      const strategy = p.strategy || tracked?.strategy || null;
      const invested_sol = tracked?.amount_sol ?? p.amount_sol_api ?? null;
      const initial_value_usd = tracked?.initial_value_usd ?? pnl?.initial_value_usd ?? p.initial_value_usd_api ?? null;
      const volatility = tracked?.volatility ?? null;
      const variant = tracked?.variant ?? null;
      const bin_range = tracked?.bin_range ?? null;
      return { ...p, pnl, recall, instruction, feeTvl24h, binsAbove, strategy, invested_sol, initial_value_usd, volatility, variant, bin_range };
    }));

    // Log portfolio snapshot for equity curve tracking
    try {
      const totalValueUsd = positionData.reduce((s, p) => s + (p.pnl?.current_value_usd ?? 0), 0);
      const totalPnlUsd = positionData.reduce((s, p) => s + (p.pnl?.pnl_usd ?? 0), 0);
      const totalFeesUsd = positionData.reduce((s, p) => s + (p.pnl?.unclaimed_fee_usd ?? 0), 0);
      // sol_price — try cheapest sources first, fall back to wallet balance fetch
      let solPrice = positionData.find(p => p.pnl?.sol_price != null)?.pnl?.sol_price ?? null;
      if (solPrice == null) {
        try {
          const { getWalletBalances } = await import("./tools/wallet.js");
          const w = await getWalletBalances({});
          solPrice = w?.sol_price ?? null;
        } catch { /* fallback: null */ }
      }
      logSnapshot({
        positions: positionData.length,
        total_value_usd: Math.round(totalValueUsd * 100) / 100,
        total_pnl_usd: Math.round(totalPnlUsd * 100) / 100,
        total_unclaimed_fees_usd: Math.round(totalFeesUsd * 100) / 100,
        sol_price: solPrice,
        tier: tier?.name ?? "all",
      });
    } catch { /* non-fatal */ }

    // ── Pre-enforce instruction-based closes BEFORE the agent loop ──────────
    // Only handles "close at X%" patterns deterministically — no LLM involvement.
    instructionClosePrefix = [];
    const skippedByInstruction = new Set();
    for (const p of positionData) {
      if (!p.instruction) continue;
      const instr = p.instruction.toLowerCase();
      const pnlPctRaw = p.pnl?.pnl_pct ?? null;

      // Parse "close at X% profit", "close at X% pnl", "close at X%"
      const profitMatch = instr.match(/close at ([+-]?\d+(?:\.\d+)?)\s*%/);
      if (!profitMatch) continue; // pattern not recognised — leave to agent

      if (pnlPctRaw === null) {
        log("cron", `Instruction pre-check: ${p.pair} — pnl_pct unavailable, skipping auto-close`);
        continue;
      }

      // pnl_pct is price-only; add fee % for total return comparison
      const instrInitUsd = p.initial_value_usd || p.initial_value_usd_api || 0;
      const instrFeePct = (instrInitUsd > 0 && p.unclaimed_fees_usd > 0)
        ? p.unclaimed_fees_usd / instrInitUsd * 100 : 0;
      const pnlPct = pnlPctRaw + instrFeePct;

      const target = parseFloat(profitMatch[1]);
      if (pnlPct >= target) {
        const reason = `Instruction: "${p.instruction}" (pnl_pct=${pnlPct}%)`;
        log("cron", `Instruction pre-check: closing ${p.pair} (${p.position}) — ${reason}`);
        try {
          await executeTool("close_position", { position_address: p.position, close_reason: reason, _decision_source: "RULE_ENGINE" });
          skippedByInstruction.add(p.position);
          instructionClosePrefix.push(`Auto-closed by instruction: ${p.pair} — ${reason}`);
          if (telegramEnabled()) notifyInstructionClose({ pair: p.pair, instruction: p.instruction, pnlPct }).catch(() => {});
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

    // ── Pre-enforce lesson-based close/hold rules BEFORE the agent loop ─────────
    // These are HARD RULES derived from past performance — enforced in code, not by LLM.
    const lessonForceHoldSet = new Set();
    try {
      const { management: mgmtRules } = extractRules("MANAGER");
      if (mgmtRules.length > 0) {
        for (const p of positionData) {
          if (skippedByInstruction.has(p.position)) continue;
          if (p.variant?.startsWith("exp_")) continue;  // experiments use own rules
          // Respect manual management — skip lesson enforcement
          if (p.instruction && /\b(manual|do not (close|manage)|hands.off)\b/i.test(p.instruction)) continue;
          const { action, reason } = checkPositionCompliance(p, mgmtRules);
          if (action === "force_close") {
            log("lesson_enforce", `Force-closing ${p.pair} (${p.position}) — ${reason}`);
            try {
              await executeTool("close_position", { position_address: p.position, close_reason: `Lesson rule: ${reason}`, _decision_source: "RULE_ENGINE" });
              skippedByInstruction.add(p.position);
              instructionClosePrefix.push(`Lesson-enforced close: ${p.pair} — ${reason}`);
            } catch (err) {
              log("cron_error", `Lesson force-close failed for ${p.pair}: ${err.message}`);
              // Don't skip — let agent handle it as fallback
            }
          } else if (action === "force_hold") {
            log("lesson_enforce", `Force-holding ${p.pair} (${p.position}) — ${reason}`);
            lessonForceHoldSet.add(p.position);
            // Mark in positionData so agent sees it
            p._lesson_force_hold = reason;
          }
        }
        positionData = positionData.filter(p => !skippedByInstruction.has(p.position));
      }
    } catch (lessonErr) {
      log("cron_error", `Lesson management enforcement failed (non-fatal): ${lessonErr.message}`);
    }

    // If all positions were auto-closed, skip the agent loop
    if (positionData.length === 0) {
      mgmtReport = instructionClosePrefix.join("\n");
      log("cron", "All positions closed by pre-check — skipping agent loop");
      return;
    }

    // Log rule distances for each position (for debugging)
    for (const p of positionData) {
      const pnl = p.pnl?.pnl_pct ?? null;
      const oor = p.minutes_out_of_range ?? 0;
      const rules = [];

      if (pnl !== null && pnl !== undefined) {
        // SL/TP handled by pnl_checker — only log yield exit distance here
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

    // ── Deterministic rule engine — replaces LLM for management decisions ──
    const ruleResult = evaluateAll(positionData);
    const reportParts = [instructionClosePrefix.length > 0 ? instructionClosePrefix.join("\n") : null];

    // Execute closes
    for (const p of ruleResult.closes) {
      const reason = p._ruleResult.reason;
      try {
        await executeTool("close_position", { position_address: p.position, close_reason: reason, _decision_source: "RULE_ENGINE" });
        log("mgmt_rule", `CLOSE ${p.pair}: ${reason}`);
      } catch (err) {
        log("cron_error", `Rule-engine close failed for ${p.pair}: ${err.message}`);
      }
    }

    // Execute fee claims
    for (const p of ruleResult.claims) {
      try {
        await executeTool("claim_fees", { position_address: p.position, _decision_source: "RULE_ENGINE" });
        log("mgmt_rule", `CLAIM ${p.pair}: ${p._ruleResult.reason}`);
      } catch (err) {
        log("cron_error", `Rule-engine claim failed for ${p.pair}: ${err.message}`);
      }
    }

    // Fall back to LLM ONLY for positions with unparseable instructions
    if (ruleResult.needsLlm.length > 0) {
      const llmPositions = ruleResult.needsLlm;
      const positionBlocks = llmPositions.map((p) => {
        const pnl = p.pnl;
        const lines = [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  strategy: ${p.strategy ?? "?"} | volatility: ${p.volatility ?? "?"}`,
          `  age: ${p.age_minutes ?? "?"}m | in_range: ${p.in_range} | oor_minutes: ${p.minutes_out_of_range ?? 0}` +
            (p.binsAbove != null ? ` | bins_above_range: ${p.binsAbove}` : ""),
          pnl ? `  pnl_pct: ${pnl.pnl_pct}% | pnl_usd: $${pnl.pnl_usd} | fees: $${pnl.unclaimed_fee_usd} | value: $${pnl.current_value_usd}` : `  pnl: fetch failed`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean);
        return lines.join("\n");
      }).join("\n\n");

      try {
        const { content: llmReport } = await agentLoop(`
MANAGEMENT — ${llmPositions.length} position(s) with custom instructions needing interpretation.

${positionBlocks}

These positions have instructions that couldn't be parsed automatically.
Evaluate each instruction against the position's current state.
If the instruction's condition is met → call close_position with a descriptive close_reason.
If not met → STAY.

REPORT FORMAT (one line per position, no markdown):
[PAIR]: STAY — [reason]
[PAIR]: CLOSE — [reason]
        `, 3, [], "MANAGER", config.llm.managementModel, 2048);
        reportParts.push(llmReport);
      } catch (err) {
        log("cron_error", `LLM fallback for instructions failed: ${err.message}`);
        reportParts.push(ruleResult.needsLlm.map(p => `${p.pair}: STAY — LLM fallback failed`).join("\n"));
      }
    }

    reportParts.push(ruleResult.report);
    mgmtReport = reportParts.filter(Boolean).join("\n");
  } catch (error) {
    _stats.errors++;
    log("cron_error", `Management cycle failed: ${error.message}`);
    notifyError("Management", error.message);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    clearTimeout(_mgmtTimeout);
    try {
    // If tier filter left no matching positions, skip report and screening — just release lock
    if (tierFilteredToEmpty) {
      return;
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
      try {
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

        if (p.invested_sol != null) {
          const ivUsd = p.initial_value_usd != null ? ` | $${p.initial_value_usd.toFixed(2)}` : "";
          lines.push(`💵 Invested: ${p.invested_sol} SOL${ivUsd}`);
        } else if (p.initial_value_usd != null && p.initial_value_usd > 0) {
          lines.push(`💵 Invested: ~$${p.initial_value_usd.toFixed(2)}`);
        }
        if (pnl?.pnl_usd != null) {
          const usd = pnl.pnl_usd;
          const sol = pnl.pnl_sol ?? 0;
          const pct = pnl.pnl_pct ?? 0;
          const fees = pnl.unclaimed_fee_usd ?? 0;
          const su = usd >= 0 ? "+" : "";
          const ss = sol >= 0 ? "+" : "";
          const sp = pct >= 0 ? "+" : "";
          lines.push(`💰 PnL: ${su}$${usd.toFixed(2)} | ${ss}${sol.toFixed(4)} SOL | ${sp}${pct.toFixed(2)}%`);
          if (fees > 0) lines.push(`💸 Unclaimed fees: $${fees.toFixed(2)}`);
        }
        if (p.age_minutes != null) {
          let stratPart = "";
          if (p.strategy) {
            const br = p.bin_range;
            const below = br?.bins_below ?? 0;
            const above = br?.bins_above ?? 0;
            const shape = (below + above) > 0
              ? ((below === 0 || above === 0) ? "single-sided" : "double-sided")
              : null;
            stratPart = ` | 🎯 ${p.strategy}${shape ? ` · ${shape}` : ""}`;
          }
          lines.push(`⏱️ Age: ${p.age_minutes}m${stratPart}`);
        }

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

      // Next management run
      const nextMgmt = formatCountdown(nextManagementCountdown());
      const footer = `\n———————————\n⏰ Next: ${nextMgmt}`;

      const body = posBlocks.length > 0
        ? prefixBlock + posBlocks.join("\n\n———————————\n\n") + footer
        : (mgmtReport || "No open positions.") + footer;

      if (mgmtReport || liveData.length > 0) sendMessage(`🔄 MANAGE${tierLabel}\n\n${body}`).catch(() => {});
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
        }
      }
      } catch (notifyErr) {
        log("cron_error", `Management notification failed (non-fatal): ${notifyErr.message}`);
      }
    }

    // Trigger screening only from the lowest-frequency active tier (prefer low > med > high).
    // This prevents redundant screening triggers every 3m when only high-vol positions exist.
    // (30s delay lets auto-swaps settle before screening evaluates wallet balance)
    const screeningTierMatch = !tier
      || tier.name === "low"
      || (tier.name === "med" && !allPositionData.some(p => classifyVolatilityTier(p.volatility) === "low"))
      || (tier.name === "high" && !allPositionData.some(p => ["med", "low"].includes(classifyVolatilityTier(p.volatility))));

    if (screeningTierMatch && openPositions.length < config.risk.maxPositions && !_screeningBusy) {
      log("cron", `Management${tierLabel} done with ${openPositions.length}/${config.risk.maxPositions} positions — triggering screening in 30s`);
      setTimeout(() => { runScreeningCycle(); }, 30_000);
    }
    } finally {
      // ALWAYS release the busy lock — even if notification/screening code throws
      _managementBusy = false;
    }
  }
}

/**
 * Study top LPers for each currently open position and save pool notes + screener lessons.
 * Runs hourly. No-ops if LPAGENT_API_KEY is not set.
 */

async function runScreeningCycle() {
  if (_screeningBusy) return;
  _screeningBusy = true; // set immediately to prevent race condition with overlapping cron ticks
  resetDeployGuard();    // allow one deploy per screening cycle

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  try {
    [prePositions, preBalance] = await Promise.race([
      Promise.all([getMyPositions(), getWalletBalances()]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("pre-check timeout (30s)")), 30_000)),
    ]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      if (telegramEnabled() && !_flags.maxPositionsNotified) {
        notifyMaxPositions({ count: prePositions.total_positions, max: config.risk.maxPositions }).catch(() => {});
        _flags.maxPositionsNotified = true;
      }
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
        metrics: { positions_open: prePositions.total_positions, max_positions: config.risk.maxPositions },
      });
      _screeningBusy = false;
      return;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    if (preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      // Re-send gas-low notification every 30 min so the user doesn't miss it
      const gasLowStale = !_flags.gasLowNotifiedAt || (Date.now() - _flags.gasLowNotifiedAt > 30 * 60_000);
      if (telegramEnabled() && (!_flags.gasLowNotified || gasLowStale)) {
        notifyGasLow({ solBalance: preBalance.sol, needed: minRequired }).catch(() => {});
        _flags.gasLowNotified = true;
        _flags.gasLowNotifiedAt = Date.now();
      }
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL: ${preBalance.sol.toFixed(3)} < ${minRequired} required`,
        metrics: { sol_balance: preBalance.sol, sol_required: minRequired },
      });
      _screeningBusy = false;
      return;
    }
    _flags.gasLowNotified = false; // SOL is sufficient — reset so next low triggers a fresh warning
    _flags.gasLowNotifiedAt = null;
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    notifyError("Screening pre-check", e.message);
    _screeningBusy = false;
    return;
  }
  _stats.screeningCycles++;
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  let screenReport = null;
  // Hard 5-minute cap — prevents a single screening cycle from blocking all future cycles
  const _screeningTimeout = setTimeout(() => {
    if (_screeningBusy) {
      log("cron_error", "Screening cycle exceeded 5-minute timeout — force-releasing lock");
      _screeningBusy = false;
    }
  }, 5 * 60_000);
  try {
      // Reuse pre-fetched balance — no extra RPC call needed
      const currentBalance = preBalance;
      const deployAmount = computeDeployAmount(currentBalance.sol);
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

      // Load active strategy — include full metadata so agent can enforce entry/exit rules
      const activeStrategy = getActiveStrategy();
      let strategyBlock;
      if (activeStrategy) {
        const parts = [`ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy}, best for: ${activeStrategy.best_for}`];
        if (activeStrategy.token_criteria?.notes) parts.push(`Token criteria: ${activeStrategy.token_criteria.notes}`);
        if (activeStrategy.entry?.condition) parts.push(`Entry: ${activeStrategy.entry.condition}`);
        if (activeStrategy.entry?.single_side) parts.push(`Side: ${activeStrategy.entry.single_side}-only`);
        if (activeStrategy.range?.notes) parts.push(`Range: ${activeStrategy.range.notes}`);
        if (activeStrategy.exit?.take_profit_pct) parts.push(`Exit TP: ${activeStrategy.exit.take_profit_pct}%`);
        if (activeStrategy.exit?.notes) parts.push(`Exit notes: ${activeStrategy.exit.notes}`);
        strategyBlock = parts.join("\n");
      } else {
        strategyBlock = `No active strategy — use default bid_ask.`;
      }

      // Pre-load top candidates + all recon data in parallel (saves 4-6 LLM steps)
      const topCandidates = await getTopCandidates({ limit: 5 }).catch(() => null);
      let candidates = topCandidates?.candidates || topCandidates?.pools || [];

      // Pre-filter candidates against lesson HARD RULES before passing to agent
      try {
        const { screening: screeningRules } = extractRules("SCREENER");
        if (screeningRules.length > 0) {
          const before = candidates.length;
          candidates = filterCandidatesByRules(candidates, screeningRules);
          if (candidates.length < before) {
            log("lesson_enforce", `Filtered ${before - candidates.length} candidate(s) by lesson rules — ${candidates.length} remain`);
          }
        }
      } catch (lessonErr) {
        log("cron_error", `Lesson screening filter failed (non-fatal): ${lessonErr.message}`);
      }

      const candidateResults = await Promise.all(
        candidates.slice(0, 5).map(async (pool) => {
          const mint = pool.base?.mint;
          const [smartWallets, holders, narrative, tokenInfo, poolMemory, topLPers, okxAnalysis] = await Promise.allSettled([
            checkSmartWalletsOnPool({ pool_address: pool.pool }),
            mint ? getTokenHolders({ mint, limit: 10 }) : Promise.resolve(null),
            mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
            mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
            Promise.resolve(recallForPool(pool.pool)),
            studyTopLPers({ pool_address: pool.pool, limit: 3 }),
            mint ? getFullTokenAnalysis(mint) : Promise.resolve(null),
          ]);

          const sw   = smartWallets.status === "fulfilled" ? smartWallets.value : null;
          const h    = holders.status === "fulfilled" ? holders.value : null;
          const n    = narrative.status === "fulfilled" ? narrative.value : null;
          const ti   = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
          const mem  = poolMemory.value;
          const lps  = topLPers.status === "fulfilled" ? topLPers.value : null;
          const okx  = okxAnalysis.status === "fulfilled" ? okxAnalysis.value : null;

          const momentum = ti?.stats_1h
            ? `1h: price${ti.stats_1h.price_change >= 0 ? "+" : ""}${ti.stats_1h.price_change}%, buyers=${ti.stats_1h.buyers}, net_buyers=${ti.stats_1h.net_buyers}`
            : null;

          // Build compact block
          const lines = [
            `POOL: ${pool.name} (${pool.pool})`,
            `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}`,
            pool.is_rugpull != null ? `  rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
            pool.is_wash    != null ? `  wash=${pool.is_wash ? "YES" : "NO"}`       : null,
            `  smart_wallets: ${sw?.in_pool?.length ?? 0}/${sw?.tracked_wallets ?? 0} present${sw?.in_pool?.length ? ` → confidence ${((sw.confidence_score ?? 0) * 100).toFixed(0)}% (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
            h ? `  holders: top_10_pct=${h.top_10_real_holders_pct ?? "?"}%, bundlers_pct=${h.bundlers_pct_in_top_100 ?? "?"}%, global_fees_sol=${h.global_fees_sol ?? "?"}` : `  holders: fetch failed`,
            momentum ? `  momentum: ${momentum}` : null,
            n?.narrative ? `  narrative: ${n.narrative.slice(0, 500)}` : `  narrative: none`,
            mem ? `  memory: ${mem}` : null,
            lps?.patterns?.top_lper_count > 0
              ? `  top_lpers: ${lps.patterns.top_lper_count} credible LPers — avg_hold=${lps.patterns.avg_hold_hours}h, win_rate=${Math.round(lps.patterns.avg_win_rate * 100)}%, avg_roi=${lps.patterns.avg_roi_pct}%, fee_pct=${lps.patterns.avg_fee_pct_of_capital}%, best_roi=${lps.patterns.best_roi}, scalpers=${lps.patterns.scalper_count}, holders=${lps.patterns.holder_count}`
              : lps?.message ? `  top_lpers: ${lps.message}` : `  top_lpers: no data`,
            // OKX advanced token intelligence
            okx?.advanced ? `  okx_token: smart_money_buy=${okx.advanced.smart_money_buy}, dev_rug_count=${okx.advanced.dev_rug_count}, dev_sold_all=${okx.advanced.dev_sold_all}, dev_buying_more=${okx.advanced.dev_buying_more}, honeypot=${okx.advanced.is_honeypot}, bundle_pct=${okx.advanced.bundle_pct}%, sniper_pct=${okx.advanced.sniper_pct}%, lp_burned_pct=${okx.advanced.lp_burned_pct != null ? okx.advanced.lp_burned_pct.toFixed(1) : "?"}%, risk_level=${okx.advanced.risk_level}` : null,
            okx?.price?.price_vs_ath_pct != null ? `  okx_price: price_vs_ath=${okx.price.price_vs_ath_pct}%, price_change_5m=${okx.price.price_change_5m ?? "?"}%, price_change_1h=${okx.price.price_change_1h ?? "?"}%` : null,
            okx?.clusters?.length > 0 ? `  okx_clusters: ${okx.clusters.slice(0, 3).map(c => `[${c.trend ?? "?"} hold=${c.avg_hold_days}d pnl=${c.pnl_pct}%${c.has_kol ? " KOL" : ""}]`).join(", ")}` : null,
          ].filter(Boolean);

          // Cache token characteristics for lesson derivation at close time
          cacheTokenProfile(pool.pool, {
            mcap: pool.mcap ?? null,
            holders: pool.holders ?? null,
            volume: pool.volume_window ?? null,
            tvl: pool.active_tvl ?? null,
            swap_count: pool.swap_count ?? null,
            unique_traders: pool.unique_traders ?? null,
            top_10_pct: h?.top_10_real_holders_pct ?? null,
            bundlers_pct: h?.bundlers_pct_in_top_100 ?? null,
            global_fees_sol: h?.global_fees_sol ?? null,
            smart_wallet_count: sw?.in_pool?.length ?? 0,
            smart_wallet_confidence: sw?.confidence_score ?? null,
            momentum_1h: ti?.stats_1h?.price_change ?? null,
            momentum_buyers_1h: ti?.stats_1h?.buyers ?? null,
            momentum_net_buyers_1h: ti?.stats_1h?.net_buyers ?? null,
            bot_holders_pct: ti?.audit?.bot_holders_pct ?? null,
            okx_smart_money_buy: okx?.advanced?.smart_money_buy ?? null,
            okx_risk_level: okx?.advanced?.risk_level ?? null,
            okx_bundle_pct: okx?.advanced?.bundle_pct ?? null,
            okx_sniper_pct: okx?.advanced?.sniper_pct ?? null,
            okx_lp_burned_pct: okx?.advanced?.lp_burned_pct ?? null,
            okx_price_vs_ath_pct: okx?.price?.price_vs_ath_pct ?? null,
            okx_price_change_1h: okx?.price?.price_change_1h ?? null,
            narrative: n?.narrative?.slice(0, 200) ?? null,
          });

          return {
            block: lines.join("\n"),
            pool: pool.pool,
            poolName: pool.name,
            botHoldersPct: ti?.audit?.bot_holders_pct ?? null,
            okxAdvanced: okx?.advanced ?? null,
            priceVsAthPct: okx?.price?.price_vs_ath_pct ?? null,
            momentum1h: ti?.stats_1h?.price_change ?? null,
            topPct: h?.top_10_real_holders_pct != null ? Number(h.top_10_real_holders_pct) : null,
            bundlersPct: h?.bundlers_pct_in_top_100 != null ? Number(h.bundlers_pct_in_top_100) : null,
            lperCount: lps?.patterns?.top_lper_count ?? null,
            lperWinRate: lps?.patterns?.avg_win_rate ?? null,
            lperDisabled: lps?.message?.includes("LPAGENT_API_KEY not set") || false,
          };
        })
      );

      // Hard-filter bot-heavy, honeypot, dev-rugger, active-drawdown, and
      // pump-chasing tokens before they reach the screener LLM.
      const maxBotPct = config.screening.maxBotHoldersPct;
      // 2026-04-23 big-loss audit: price_vs_ATH 30-60% bucket = 36.4% big-loss
      // rate / 9.1% win rate / -3.98% avg (tokens in active downtrend keep falling).
      // momentum_1h >= 20% = 20% big-loss rate / -1.99% avg (buying local blow-off top).
      const ATH_REJECT_MIN = 30;
      const ATH_REJECT_MAX = 60;
      const MOMENTUM_1H_REJECT = 20;
      // HARDCODED gates restored 2026-04-24 (pre-9837502 values):
      const TOP10_REJECT = 60;
      const BUNDLERS_REJECT = 30;
      // LPAgent top-LPer hard gate restored 2026-04-24:
      // commit f6cd32a (11 Apr) removed LPAgent from live-pnl pipeline but
      // kept study_top_lpers for screening as SOFT signal. We promote it back
      // to HARD gate — proven pools only. Skipped if API not configured.
      const LPER_MIN_COUNT = 3;      // need >= 3 credible LPers for pattern to be meaningful
      const LPER_MIN_WIN_RATE = 0.50; // >= 50% — prompt already says "<50% pool is hard even for pros"
      const candidateBlocks = candidateResults
        .filter(r => {
          if (maxBotPct != null && r.botHoldersPct != null && r.botHoldersPct > maxBotPct) {
            log("lesson_enforce", `Filtered candidate — bot_holders_pct ${r.botHoldersPct}% > ${maxBotPct}%`);
            return false;
          }
          if (r.okxAdvanced?.is_honeypot) {
            log("lesson_enforce", `Filtered candidate — OKX honeypot detected`);
            return false;
          }
          if (r.okxAdvanced?.dev_rug_count > 0) {
            log("lesson_enforce", `Filtered candidate — dev has ${r.okxAdvanced.dev_rug_count} prior rug(s)`);
            return false;
          }
          if (r.priceVsAthPct != null && r.priceVsAthPct >= ATH_REJECT_MIN && r.priceVsAthPct <= ATH_REJECT_MAX) {
            log("screening", `Filtered ${r.poolName} — price_vs_ATH ${r.priceVsAthPct}% in drop-zone [${ATH_REJECT_MIN}-${ATH_REJECT_MAX}%]`);
            try {
              appendDecision({
                type: "skip",
                actor: "RULE_ENGINE",
                pool: r.pool,
                pool_name: r.poolName,
                summary: `Skipped ${r.poolName} — in ATH drop-zone`,
                reason: `price_vs_ATH ${r.priceVsAthPct}% in [${ATH_REJECT_MIN}-${ATH_REJECT_MAX}%] — historical 36.4% big-loss rate in this bucket`,
                metrics: { price_vs_ath_pct: r.priceVsAthPct },
              });
            } catch { /**/ }
            return false;
          }
          if (r.momentum1h != null && r.momentum1h >= MOMENTUM_1H_REJECT) {
            log("screening", `Filtered ${r.poolName} — momentum_1h ${r.momentum1h}% >= ${MOMENTUM_1H_REJECT}%`);
            try {
              appendDecision({
                type: "skip",
                actor: "RULE_ENGINE",
                pool: r.pool,
                pool_name: r.poolName,
                summary: `Skipped ${r.poolName} — pump-chase`,
                reason: `momentum_1h ${r.momentum1h}% >= ${MOMENTUM_1H_REJECT}% — historical 20% big-loss rate in this bucket`,
                metrics: { momentum_1h: r.momentum1h },
              });
            } catch { /**/ }
            return false;
          }
          if (r.topPct != null && r.topPct > TOP10_REJECT) {
            log("screening", `Filtered ${r.poolName} — top_10_pct ${r.topPct}% > ${TOP10_REJECT}%`);
            try {
              appendDecision({
                type: "skip",
                actor: "RULE_ENGINE",
                pool: r.pool,
                pool_name: r.poolName,
                summary: `Skipped ${r.poolName} — concentration`,
                reason: `top_10_pct ${r.topPct}% > ${TOP10_REJECT}% (hardcoded, restored 2026-04-24)`,
                metrics: { top_10_pct: r.topPct },
              });
            } catch { /**/ }
            return false;
          }
          if (r.bundlersPct != null && r.bundlersPct > BUNDLERS_REJECT) {
            log("screening", `Filtered ${r.poolName} — bundlers_pct ${r.bundlersPct}% > ${BUNDLERS_REJECT}%`);
            try {
              appendDecision({
                type: "skip",
                actor: "RULE_ENGINE",
                pool: r.pool,
                pool_name: r.poolName,
                summary: `Skipped ${r.poolName} — bundlers`,
                reason: `bundlers_pct ${r.bundlersPct}% > ${BUNDLERS_REJECT}% (hardcoded, restored 2026-04-24)`,
                metrics: { bundlers_pct: r.bundlersPct },
              });
            } catch { /**/ }
            return false;
          }
          // LPAgent HARD gate — only enforce when API returned data. If API not
          // configured (lperDisabled=true), this gate is bypassed so the system
          // degrades gracefully without blocking all deploys.
          if (!r.lperDisabled) {
            if (r.lperCount != null && r.lperCount < LPER_MIN_COUNT) {
              log("screening", `Filtered ${r.poolName} — top_lper_count ${r.lperCount} < ${LPER_MIN_COUNT}`);
              try {
                appendDecision({
                  type: "skip",
                  actor: "RULE_ENGINE",
                  pool: r.pool,
                  pool_name: r.poolName,
                  summary: `Skipped ${r.poolName} — too few credible LPers`,
                  reason: `top_lper_count ${r.lperCount} < ${LPER_MIN_COUNT} (LPAgent hard gate, restored 2026-04-24)`,
                  metrics: { top_lper_count: r.lperCount },
                });
              } catch { /**/ }
              return false;
            }
            if (r.lperWinRate != null && r.lperWinRate < LPER_MIN_WIN_RATE) {
              log("screening", `Filtered ${r.poolName} — avg_win_rate ${(r.lperWinRate*100).toFixed(0)}% < ${(LPER_MIN_WIN_RATE*100).toFixed(0)}%`);
              try {
                appendDecision({
                  type: "skip",
                  actor: "RULE_ENGINE",
                  pool: r.pool,
                  pool_name: r.poolName,
                  summary: `Skipped ${r.poolName} — top LPers losing on this pool`,
                  reason: `avg_win_rate ${(r.lperWinRate*100).toFixed(1)}% < ${(LPER_MIN_WIN_RATE*100).toFixed(0)}% (LPAgent hard gate, restored 2026-04-24)`,
                  metrics: { avg_win_rate: r.lperWinRate },
                });
              } catch { /**/ }
              return false;
            }
          }
          return true;
        })
        .map(r => r.block);

      const candidateContext = candidateBlocks.length > 0
        ? `\nPRE-LOADED CANDIDATE ANALYSIS (smart wallets, holders, narrative, top LPers, OKX token intel already fetched):\n${candidateBlocks.join("\n\n")}\n`
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
- HARD SKIP if global_fees_sol < 30 SOL (bundled/scam) — this is the ONLY hardcoded gate, non-negotiable
- All other thresholds (top_10_pct, bundlers, organic, mcap, bin_step, etc.) are soft — use learned lessons and token characteristic data to decide. Penalize confidence proportionally, don't hard-skip.
- rugpull=YES → default to SKIP; treat as disqualifying unless overwhelming evidence otherwise
- wash=YES → treat as disqualifying even if other metrics look attractive
- SKIP if narrative is empty/null or pure hype with no specific story (unless smart wallets present)
- Smart wallets present → strong confidence boost

OKX TOKEN INTELLIGENCE (pre-loaded per candidate):
- smart_money_buy=true → strong confidence boost (+1), smart money is accumulating this token globally
- dev_sold_all=true → bearish, dev dumped — penalize confidence by -2
- dev_buying_more=true → bullish, dev has skin in the game
- price_vs_ath > 90% → near ATH, high risk of retracement — penalize confidence by -1
- price_vs_ath < 30% → far from ATH, recovery play or dead — check volume + narrative
- sniper_pct > 10% → heavy sniper presence, dump risk — penalize confidence by -1
- lp_burned_pct > 50% → safer, dev can't rug liquidity
- okx_clusters: check if top holder clusters are buying or selling. Majority selling = distribution phase, avoid.

TOP LPER INTELLIGENCE (pre-loaded per candidate):
- top_lpers data shows how the best LPers perform on each pool. USE THIS to guide your strategy and bin choices.
- If avg_win_rate < 50% → pool is hard even for pros → penalize confidence by -2
- If scalpers > holders → pool favors short holds → use tighter bins, expect fast TP
- If holders > scalpers → pool rewards patience → wider bins OK
- Match your strategy to what top LPers are actually doing profitably
- No credible LPers found → pool is unproven → penalize confidence by -1

CONFIDENCE-BASED SIZING:
- Rate your confidence 0-10 for the best candidate based on all signals (smart wallets, narrative, holders, momentum, fees)
- Only deploy if confidence > 7. If confidence <= 7, write NO DEPLOY with your confidence score.
- Scale the amount: amount_y = ${deployAmount} × (confidence / 10), rounded to 2 decimals, minimum 0.1 SOL
  confidence 8 → ${(deployAmount * 0.8).toFixed(2)} SOL | confidence 9 → ${(deployAmount * 0.9).toFixed(2)} SOL | confidence 10 → ${deployAmount} SOL
- Always pass confidence_level as a parameter to deploy_position.

ACTION REQUIRED:
1. Pick the best candidate from the pre-loaded analysis above. Rate your confidence (0-10). If none pass or confidence <= 7, write NO DEPLOY and stop.
2. YOU MUST CALL deploy_position NOW. Do not write any text before calling the tool.
   Use the confidence-scaled amount above. Pass confidence_level in the call.
   deploy_position fetches the active bin internally — no separate get_active_bin call needed.
3. After the tool returns, write your one-line report.

CRITICAL: Writing "DEPLOY" without calling deploy_position is WRONG. The tool call IS the deploy.

REPORT FORMAT (strict, one line only, no markdown):
If deploy_position succeeded: [PAIR]: DEPLOY (X/10) — [1 sentence why this was best pick]
If deploy_position was blocked/failed: [PAIR]: BLOCKED — [reason from tool response]
If no candidate passed rules or confidence <= 7: NO DEPLOY — [1 sentence reason, include confidence score]
Do NOT write next steps, lessons, observations, or anything else.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 4096);
      screenReport = content;
      // If the screener chose not to deploy, record the reasoning so the user (and future cycles) can see it.
      // The deploy success path is already logged inside the executor — only NO DEPLOY needs explicit tagging here.
      if (/\bNO DEPLOY\b/i.test(content || "")) {
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Screener chose not to deploy",
          reason: (content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 500),
          metrics: { candidates_evaluated: candidates.length },
        });
      }
    } catch (error) {
      _stats.errors++;
      log("cron_error", `Screening cycle failed: ${error.message}`);
      notifyError("Screening", error.message);
      screenReport = `Screening cycle failed: ${error.message}`;
    } finally {
      clearTimeout(_screeningTimeout);
      _screeningBusy = false;
      if (telegramEnabled() && screenReport) {
        const nextScreen = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
        const screenFooter = `\n———————————\n⏰ Next: ${nextScreen}`;
        sendMessage(`🔍 SCREEN\n\n💡 ${screenReport.trim()}${screenFooter}`).catch(() => {});
      }
    }
}

async function runPnlChecker() {
  if (_pnlCheckerBusy || _managementBusy) return;

  const FAST_TP_PCT       = config.management.fastTpPct;
  const TRAILING_ACTIVATE = config.management.trailingActivate;
  const TRAILING_FLOOR    = config.management.trailingFloor;

  const { management: pnlCheckerRules } = extractRules("MANAGER");
  const lessonTpRules = pnlCheckerRules.filter(r => r.type === "min_profit_pct");

  const openPositions = getTrackedPositions(true);
  if (openPositions.length === 0) {
    _trailingStops.clear();
    return;
  }

  // Clean stale trailing-stop + poll-state entries (position was closed externally)
  const openAddresses = new Set(openPositions.map(p => p.position));
  for (const addr of _trailingStops.keys()) {
    if (!openAddresses.has(addr)) _trailingStops.delete(addr);
  }
  for (const addr of _pnlPollState.keys()) {
    if (!openAddresses.has(addr)) _pnlPollState.delete(addr);
  }
  for (const addr of _softPeakTracker.keys()) {
    if (!openAddresses.has(addr)) _softPeakTracker.delete(addr);
  }

  _pnlCheckerBusy = true;
  try {
    for (const tracked of openPositions) {
      // Respect position instructions — if one is set, let the management cycle handle it
      if (tracked.instruction) {
        log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: has instruction "${tracked.instruction}" — skipping pnl checker`);
        _trailingStops.delete(tracked.position); // clear any trailing stop too
        _pnlPollState.delete(tracked.position);
        continue;
      }

      // Tiered cadence: hot positions (last pnl ≤ -2% or volatility ≥ 3) check
      // every tick (~5s). Cold positions check every PNL_COLD_INTERVAL_MS (~15s).
      const pollNow = Date.now();
      const pollSt  = _pnlPollState.get(tracked.position);
      const volHot  = (tracked.volatility ?? 0) >= PNL_HOT_VOLATILITY_THRESHOLD;
      const pctHot  = pollSt && pollSt.last_pct != null && pollSt.last_pct <= PNL_HOT_PCT_THRESHOLD;
      const elapsed = pollSt ? pollNow - pollSt.last_check_ts : Infinity;
      if (!volHot && !pctHot && elapsed < PNL_COLD_INTERVAL_MS) continue;

      // Resolve thresholds — experiment positions use their own rules
      let SL_PCT           = config.management.emergencyPriceDropPct;
      let TP_PCT           = config.management.takeProfitFeePct;
      let expFastTp        = FAST_TP_PCT;
      let expTrailActivate = TRAILING_ACTIVATE;
      let expTrailFloor    = TRAILING_FLOOR;
      let maxMinutesHeld   = null;

      if (tracked.variant?.startsWith("exp_")) {
        try {
          const { getExperimentByPosition } = await import("./experiment.js");
          const expRules = getExperimentByPosition(tracked.position)?.rules;
          if (expRules) {
            SL_PCT           = expRules.emergencyPriceDropPct ?? SL_PCT;
            TP_PCT           = expRules.takeProfitFeePct      ?? TP_PCT;
            expFastTp        = expRules.fastTpPct             ?? expFastTp;
            expTrailActivate = expRules.trailingActivate      ?? expTrailActivate;
            expTrailFloor    = expRules.trailingFloor         ?? expTrailFloor;
            maxMinutesHeld   = expRules.maxMinutesHeld        ?? null;
          }
        } catch {}
      } else if (tracked.strategy) {
        // Per-strategy TP override from strategy library (non-experiment positions)
        try {
          const strat = getStrategy({ id: tracked.strategy });
          if (strat && !strat.error && strat.exit?.take_profit_pct != null) {
            TP_PCT = strat.exit.take_profit_pct;
          }
        } catch {}
      }

      // Experiment time-limit: force-close to keep the iteration loop moving
      if (maxMinutesHeld != null && tracked.deployed_at) {
        const minutesHeld = Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000);
        if (minutesHeld >= maxMinutesHeld) {
          log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: experiment time limit ${minutesHeld}m >= ${maxMinutesHeld}m — closing`);
          _trailingStops.delete(tracked.position);
          await executeTool("close_position", { position_address: tracked.position, close_reason: `Experiment time limit: ${minutesHeld}m`, _decision_source: "PNL_CHECKER" });
          continue;
        }
      }

      const pnl = await getPositionPnl({ pool_address: tracked.pool, position_address: tracked.position }).catch(() => null);

      // Rule 0: Close if position value is zero (empty/drained)
      if (pnl && !pnl.error && pnl.current_value_usd === 0 && (pnl.unclaimed_fee_usd ?? 0) === 0) {
        log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: current value = 0 — CLOSE (empty position)`);
        _trailingStops.delete(tracked.position);
        await executeTool("close_position", { position_address: tracked.position, close_reason: "Empty position: current value = 0", _decision_source: "PNL_CHECKER" });
        continue;
      }

      if (!pnl || pnl.error || pnl.pnl_pct == null) continue;

      // pnl_pct is price-only; add fee % for TP/SL threshold comparisons (total return)
      const feePct = pnl.initial_value_usd > 0
        ? (pnl.unclaimed_fee_usd ?? 0) / pnl.initial_value_usd * 100 : 0;
      const pct = pnl.pnl_pct + feePct;

      // Update tiered-cadence state so hurt positions get the fast tick
      _pnlPollState.set(tracked.position, { last_pct: pct, last_check_ts: Date.now() });

      // Track peak for journal duration metrics (cleared at close in lessons.js)
      recordPeak(tracked.position, pct);

      // Rule 1: Stop loss
      if (pct <= SL_PCT) {
        // Min-hold guard (non-experiment only): defer SL for the first
        // MIN_HOLD_BEFORE_SL_MIN minutes after deploy. Audit showed early SL
        // fires (<15m) realized -4.39% avg with no recovery upside — but
        // settling time often saves marginal dips.
        const isExp = tracked.variant?.startsWith("exp_");
        const minutesHeld = tracked.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : Infinity;
        if (!isExp && minutesHeld < MIN_HOLD_BEFORE_SL_MIN) {
          log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: pnl ${pct}% <= ${SL_PCT}% but age ${minutesHeld}m < ${MIN_HOLD_BEFORE_SL_MIN}m — SL deferred`);
        } else {
          log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: pnl ${pct}% <= ${SL_PCT}% — STOP LOSS`);
          _trailingStops.delete(tracked.position);
          await executeTool("close_position", { position_address: tracked.position, close_reason: `Stop loss: pnl ${pct}%`, _decision_source: "PNL_CHECKER" });
          continue;
        }
      }

      // Rule 2: Hard take-profit (fast TP)
      if (pct >= expFastTp) {
        log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: pnl ${pct}% >= ${expFastTp}% — FAST TAKE PROFIT`);
        _trailingStops.delete(tracked.position);
        await executeTool("close_position", { position_address: tracked.position, close_reason: `Fast TP: pnl ${pct}%`, _decision_source: "PNL_CHECKER" });
        continue;
      }

      // Rule 3: Regular take-profit
      if (pct >= TP_PCT) {
        log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: pnl ${pct}% >= ${TP_PCT}% — TAKE PROFIT`);
        _trailingStops.delete(tracked.position);
        await executeTool("close_position", { position_address: tracked.position, close_reason: `Take profit: pnl ${pct}%`, _decision_source: "PNL_CHECKER" });
        continue;
      }

      // Rule 3.5: Soft-peak give-back (non-experiment only). Captures peaks in
      // the [1.5%, trailingActivate) zone that today get given back via
      // yield_exit/oor at +0.20%.
      if (!tracked.variant?.startsWith("exp_")) {
        if (pct >= SOFT_PEAK_THRESHOLD) {
          const cur = _softPeakTracker.get(tracked.position);
          if (!cur || pct > cur.peak) {
            _softPeakTracker.set(tracked.position, { peak: pct, peak_ts: Date.now() });
          }
        }
        const soft = _softPeakTracker.get(tracked.position);
        if (soft) {
          const elapsed = Date.now() - soft.peak_ts;
          const giveBackThresh = soft.peak * SOFT_PEAK_GIVE_BACK_RATIO;
          if (elapsed >= SOFT_PEAK_DELAY_MS && pct <= giveBackThresh) {
            log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: soft-peak give-back — peak ${soft.peak.toFixed(2)}%, now ${pct.toFixed(2)}% ≤ ${giveBackThresh.toFixed(2)}% (${Math.floor(elapsed/60000)}m since peak) — CLOSE`);
            _softPeakTracker.delete(tracked.position);
            _trailingStops.delete(tracked.position);
            await executeTool("close_position", { position_address: tracked.position, close_reason: `Soft-peak give-back: peak ${soft.peak.toFixed(2)}%, dropped to ${pct.toFixed(2)}%`, _decision_source: "PNL_CHECKER" });
            continue;
          }
        }
      }

      // Rule 4: Lesson-based take-profit (skip for experiment positions — they use experiment rules)
      if (lessonTpRules.length > 0 && !tracked.variant?.startsWith("exp_")) {
        const hit = lessonTpRules.find(r => pct >= r.threshold_pct);
        if (hit) {
          log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: pnl ${pct}% >= ${hit.threshold_pct}% — LESSON TP`);
          _trailingStops.delete(tracked.position);
          await executeTool("close_position", { position_address: tracked.position, close_reason: `Lesson TP: pnl ${pct}% >= ${hit.threshold_pct}%`, _decision_source: "PNL_CHECKER" });
          continue;
        }
      }

      // Rule 5: Trailing stop — activate above expTrailActivate, close below expTrailFloor
      if (pct > expTrailActivate) {
        const entry = _trailingStops.get(tracked.position);
        if (!entry) {
          _trailingStops.set(tracked.position, { peak: pct });
          log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: trailing stop activated at ${pct}%`);
        } else if (pct > entry.peak) {
          entry.peak = pct;
        }
      }

      const stop = _trailingStops.get(tracked.position);
      if (stop) {
        // 2026-04-23 big-loss audit: 2 trailing closes realized -13%/-15%
        // after peaks of +6.46% / +6.33% (≈19% drop from peak). A flat floor
        // lets gains evaporate once peak gets meaningful. Once peak > +4%,
        // lock in at least 50% of the peak — trailing floor can never dip
        // below that. Below +4% peak we keep the configured behaviour.
        let effectiveFloor = expTrailFloor;
        if (stop.peak > 4) {
          const peakRatchet = stop.peak * 0.5;
          if (peakRatchet > effectiveFloor) effectiveFloor = peakRatchet;
        }
        if (pct < effectiveFloor) {
          log("pnl_check", `${tracked.pool_name || tracked.position.slice(0, 8)}: trailing stop — peak ${stop.peak}%, now ${pct}% < ${effectiveFloor}% (base ${expTrailFloor}%) — CLOSE`);
          _trailingStops.delete(tracked.position);
          await executeTool("close_position", { position_address: tracked.position, close_reason: `Trailing stop: peak ${stop.peak}%, dropped to ${pct}% (floor ${effectiveFloor}%)`, _decision_source: "PNL_CHECKER" });
        }
      }
    }
  } finally {
    _pnlCheckerBusy = false;
  }
}

/**
 * Tiered management dispatcher — fires every minute, checks which tiers are due,
 * and runs the highest-priority due tier. Only one tier runs at a time (_managementBusy mutex).
 * If a tier is due while another is running, it's skipped and retried on the next tick.
 */
function dispatchManagement() {
  if (_managementBusy) return;
  const tiers = config.schedule.managementTiers;
  const now = Date.now();
  for (const tierName of ["high", "med", "low"]) {
    const tierCfg = tiers[tierName];
    const lastRun = timers.managementLastRun[tierName];
    const intervalMs = tierCfg.intervalMin * 60 * 1000;
    if (!lastRun || now - lastRun >= intervalMs) {
      runManagementCycle({ name: tierName, ...tierCfg }).catch(e => {
        log("cron_error", `Management dispatch [${tierName}] error: ${e.message}`);
        notifyError(`Management [${tierName}]`, e.message);
      });
      return; // one tier per dispatcher tick
    }
  }
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  // Tiered management dispatcher — 1-minute resolution, runs all tiers independently
  _mgmtDispatcher = setInterval(dispatchManagement, 60_000);
  dispatchManagement(); // run immediately on startup

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    await runScreeningCycle();
  });

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check (deterministic)");
    try {
      const positions = await getMyPositions({ force: true });
      if (!positions?.length) { log("health", "No open positions"); return; }
      const wallet = await getWalletBalances();
      let totalValue = 0, totalFees = 0, totalPnlUsd = 0;
      const lines = [];
      for (const p of positions) {
        try {
          const pnl = await getPositionPnl({ pool_address: p.pool_address, position_address: p.position_address });
          if (pnl) {
            const val = parseFloat(pnl.current_value_usd) || 0;
            const fees = parseFloat(pnl.unclaimed_fee_usd) || 0;
            const pctVal = parseFloat(pnl.pnl_pct) || 0;
            const usdVal = parseFloat(pnl.pnl_usd) || 0;
            totalValue += val; totalFees += fees; totalPnlUsd += usdVal;
            lines.push(`${p.pair || p.pool_address.slice(0,8)}: $${val.toFixed(2)} | pnl ${pctVal.toFixed(2)}% ($${usdVal.toFixed(2)}) | unclaimed fees $${fees.toFixed(2)}`);
          }
        } catch { /* skip failed pnl fetch */ }
      }
      const solBal = wallet?.sol?.toFixed(3) ?? "?";
      const summary = [
        `Health Check — ${positions.length} positions`,
        `SOL: ${solBal} | Total value: $${totalValue.toFixed(2)} | PnL: $${totalPnlUsd.toFixed(2)} | Unclaimed fees: $${totalFees.toFixed(2)}`,
        ...lines,
      ].join("\n");
      log("health", summary);
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
      notifyError("Health check", error.message);
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
      notifyError("Weekly report", e.message);
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
      notifyError("Monthly report", e.message);
    }
  }, { timezone: 'UTC' });

  // Daily autoresearch optimization — 23:30 UTC+7, before lesson summarizer
  const autoresearchTask = cron.schedule("30 23 * * *", () => {
    import("./scripts/autoresearch-loop.js")
      .then(m => m.runDailyAutoresearch())
      .catch(e => { log("autoresearch_error", e.message); notifyError("Autoresearch", e.message); });
  }, { timezone: "Asia/Bangkok" });

  // Daily lesson cleanup — 23:59 UTC+7 (Asia/Bangkok), same time as journal daily report
  const lessonSummarizerTask = cron.schedule("59 23 * * *", () => {
    import("./scripts/claude-lesson-summarizer.js")
      .then(m => m.claudeSummarizeLessons())
      .catch(e => { log("lesson_summarizer_error", e.message); notifyError("Lesson summarizer", e.message); });
  }, { timezone: "Asia/Bangkok" });

  _pnlCheckerInterval = setInterval(() => runPnlChecker().catch(e => {
    log("cron_error", `PnL checker failed: ${e.message}`);
    notifyError("PnL checker", e.message);
  }), PNL_TICK_MS);

  // Periodic dust sweep — every 10 minutes, retry any tokens still in wallet
  _dustSweepInterval = setInterval(async () => {
    try {
      const swept = await sweepDustTokens();
      if (swept.length > 0) {
        log("cron", `Dust sweep: ${swept.length} token(s) swapped to SOL`);
      }
    } catch (e) {
      log("cron_error", `Dust sweep failed: ${e.message}`);
      notifyError("Dust sweep", e.message);
    }
  }, 10 * 60 * 1000);

  _cronTasks = [screenTask, healthTask, briefingTask, briefingWatchdog, weeklyTask, monthlyTask, autoresearchTask, lessonSummarizerTask];
  const t = config.schedule.managementTiers;
  log("cron", `Cycles started — management: high=${t.high.intervalMin}m, med=${t.med.intervalMin}m, low=${t.low.intervalMin}m | screening every ${config.schedule.screeningIntervalMin}m | pnl-check every 15s`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopCronJobs();
  stopPolling();
  stopJournalPolling();
  try {
    const positions = await getMyPositions();
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } catch { /* non-fatal */ }
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

// ── Shared Telegram command handler ──────────────────────────────────────────
// Called from both TTY and non-TTY polling handlers to keep commands in sync.
// Returns true if the command was handled, false to fall through to agent loop.
async function handleTelegramCommand(rawText, sendMessage, opts = {}) {
  // Strip @botname suffix, zero-width/invisible Unicode, and trim
  const text = rawText
    .replace(/@\S+/, "")
    .replace(/[\u200B-\u200D\uFEFF\u00A0\u200E\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069]/g, "")
    .trim();
  const cmd = text.toLowerCase(); // for case-insensitive command matching
  const { onStart, onStop } = opts;

  // Debug: log command matching for slash commands
  if (cmd.startsWith("/")) {
    log("telegram", `Command: "${text}" cmd="${cmd}" raw=${JSON.stringify(rawText)} bytes=${[...rawText].map(c=>c.charCodeAt(0).toString(16)).join(",").slice(0,120)}`);
  }

  if (cmd === "/help") {
    sendMessage([
      "🤖 Meridian Commands",
      "",
      "── Agent Control ──",
      "/start          Resume cron cycles",
      "/stop           Pause cron cycles",
      "/stats          Agent uptime, cycle counts, errors",
      "/status         Wallet balance + open positions",
      "/withdraw       Close all positions, swap to SOL",
      "",
      "── Reports ──",
      "/briefing       Last 24h trading summary",
      "/report         Daily report (default)",
      "/report weekly  Weekly report",
      "/report monthly Monthly report",
      "",
      "── Screening ──",
      "/screen         Manual screening cycle now",
      "/candidates     Refresh top pool candidates",
      "/thresholds     Current screening thresholds + perf stats",
      "/evolve         Trigger threshold evolution",
      "",
      "── Lessons ──",
      "/update_lesson              List all lessons with index numbers",
      "/update_lesson <N> <rule>   Edit lesson #N",
      "/del_lesson <N>             Delete lesson #N",
      "/review                     Claude lesson review (last 20 closes)",
      "/freeze                     Stop all auto-lesson generation",
      "/unfreeze                   Resume auto-lesson generation",
      "",
      "── Goals ──",
      "/goals               Show current goals + progress",
      "/goals win_rate=80 max_loss=-10 profit_factor=2",
      "                     Set trading goals",
      "/goals clear         Remove all goals",
      "",
      "── Decisions ──",
      "/decisions [N]       Last N decisions (default 10) — why deploys/closes/skips happened",
      "",
      "── Claude AI ──",
      "/claude <question>   Ask Claude about positions, lessons, journal",
      "",
      "── Reconcile ──",
      "/reconcile      Re-sync state.json with on-chain positions",
    ].join("\n")).catch(() => {});
    return true;
  }

  if (cmd === "/start") {
    if (onStart) { onStart(); }
    else { sendMessage("▶️ Cron cycles are already running.").catch(() => {}); }
    return true;
  }

  if (cmd === "/stop") {
    if (onStop) { onStop(); }
    else {
      stopCronJobs();
      sendMessage("⏹️ Agent stopped — cron cycles paused. Restart with PM2 to resume.").catch(() => {});
    }
    return true;
  }

  if (cmd === "/stats") {
    const uptime = Math.floor((Date.now() - new Date(_stats.startedAt).getTime()) / 60000);
    const msg = `📊 Agent Stats\n\nUptime: ${uptime}m\nMgmt cycles: ${_stats.managementCycles}\nScreening cycles: ${_stats.screeningCycles}\nDeployed: ${_stats.positionsDeployed}\nClosed: ${_stats.positionsClosed}\nFees claimed: ${_stats.feesClaimed}\nErrors: ${_stats.errors}\nStarted: ${_stats.startedAt}`;
    sendMessage(msg).catch(() => {});
    return true;
  }

  if (cmd === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
      const lines = [`💰 Wallet: ${wallet.sol.toFixed(4)} SOL ($${wallet.sol_usd?.toFixed(2) ?? "?"})`, `📂 Positions: ${positions.total_positions}`, ""];
      for (const p of (positions.positions || []).slice(0, 10)) {
        const status = p.in_range ? "✅" : "⚠️ OOR";
        lines.push(`${p.pair} ${status} | fees: $${(p.unclaimed_fees_usd ?? 0).toFixed(2)}`);
      }
      if (positions.total_positions === 0) lines.push("No open positions.");
      sendMessage(lines.join("\n")).catch(() => {});
    } catch (e) {
      sendMessage(`Status error: ${e.message}`).catch(() => {});
    }
    return true;
  }

  if (cmd === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendMessage(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return true;
  }

  if (cmd.startsWith("/report")) {
    const parts = text.split(" ");
    const period = ["daily", "weekly", "monthly"].includes(parts[1]) ? parts[1] : "daily";
    try {
      const report = await generateReport(period);
      await sendMessage(report);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return true;
  }

  if (cmd === "/review") {
    sendMessage("🧠 Starting Claude review... (may take ~2 min)").catch(() => {});
    import("./scripts/claude-lesson-updater.js")
      .then(m => m.claudeUpdateLessons())
      .catch(e => sendMessage(`Review error: ${e.message}`).catch(() => {}));
    return true;
  }

  if (cmd.startsWith("/update_lesson")) {
    const args = text.slice("/update_lesson".length).trim();
    if (!args) {
      const lessons = listAllLessons();
      if (lessons.length === 0) {
        sendMessage("No lessons found.").catch(() => {});
      } else {
        function fmtLesson(l) {
          const badges = [l.outcome];
          if (l.pinned) badges.push("PINNED");
          if (l.source === "experiment") badges.push("EXP");
          const header = `#${l.index}  ${badges.join("  ")}` +
            (l.tags?.length ? `  |  ${l.tags.slice(0, 4).join(", ")}` : "");
          const ruleText = l.rule.length > 120 ? l.rule.slice(0, 117) + "..." : l.rule;
          return `${header}\n${ruleText}`;
        }
        let chunk = `📚 Lessons — ${lessons.length} total\n/update_lesson <N> <new rule>\n\n`;
        for (const l of lessons) {
          const card = fmtLesson(l) + "\n\n";
          if (chunk.length + card.length > 4000) {
            sendMessage(chunk.trimEnd()).catch(() => {});
            chunk = "";
          }
          chunk += card;
        }
        if (chunk.trim()) sendMessage(chunk.trimEnd()).catch(() => {});
      }
      return true;
    }
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) {
      sendMessage("Usage: /update_lesson <N> <new rule text>").catch(() => {});
      return true;
    }
    const n = parseInt(args.slice(0, spaceIdx), 10);
    const newRule = args.slice(spaceIdx + 1).trim();
    if (!n || n < 1 || !newRule) {
      sendMessage("Usage: /update_lesson <N> <new rule text>").catch(() => {});
      return true;
    }
    const lessons = listAllLessons();
    const target = lessons[n - 1];
    if (!target) {
      sendMessage(`No lesson at index ${n}. There are ${lessons.length} lessons total.`).catch(() => {});
      return true;
    }
    const result = updateLesson(target.id, newRule);
    if (result.found) {
      sendMessage(`✅ Lesson ${n} updated.\n\nOld: ${result.old_rule.slice(0, 200)}\n\nNew: ${result.new_rule.slice(0, 200)}`).catch(() => {});
    } else {
      sendMessage(`❌ Failed to update lesson ${n}.`).catch(() => {});
    }
    return true;
  }

  if (cmd.startsWith("/del_lesson")) {
    const arg = text.slice("/del_lesson".length).trim();
    const n = parseInt(arg, 10);
    if (!n || n < 1) {
      sendMessage("Usage: /del_lesson <N>  — use /update_lesson to list lessons with their numbers").catch(() => {});
      return true;
    }
    const lessons = listAllLessons();
    const target = lessons[n - 1];
    if (!target) {
      sendMessage(`No lesson at index ${n}. There are ${lessons.length} lessons total.`).catch(() => {});
      return true;
    }
    if (target.pinned) {
      sendMessage(`❌ Lesson #${n} is pinned — unpin it first via the dashboard before deleting.`).catch(() => {});
      return true;
    }
    const removed = removeLesson(target.id);
    if (removed) {
      sendMessage(`🗑️ Lesson #${n} deleted.\n\n${target.rule.slice(0, 200)}`).catch(() => {});
    } else {
      sendMessage(`❌ Failed to delete lesson ${n}.`).catch(() => {});
    }
    return true;
  }

  if (cmd.startsWith("/decisions")) {
    const arg = text.slice("/decisions".length).trim();
    const n = arg ? Math.max(1, Math.min(50, parseInt(arg, 10) || 10)) : 10;
    try {
      const decisions = getRecentDecisions({ limit: n });
      if (!decisions.length) {
        sendMessage("📓 No decisions recorded yet. They'll appear here as the agent deploys, closes, skips, or no-deploys.").catch(() => {});
        return true;
      }
      const lines = [`📓 Last ${decisions.length} decision(s) — newest first`, ""];
      for (let i = 0; i < decisions.length; i++) {
        const d = decisions[i];
        const ts = d.ts ? d.ts.slice(5, 16).replace("T", " ") : "—";
        const where = d.pool_name || (d.pool ? d.pool.slice(0, 8) : "—");
        lines.push(`${i + 1}. ${ts} [${d.actor}] ${d.type.toUpperCase()} ${where}`);
        if (d.summary) lines.push(`   ${d.summary}`);
        if (d.reason)  lines.push(`   why: ${d.reason}`);
        if (d.risks?.length) lines.push(`   risks: ${d.risks.join(", ")}`);
        lines.push("");
      }
      // Telegram caps at 4096 chars; chunk by message if needed
      let buf = "";
      for (const line of lines) {
        if (buf.length + line.length + 1 > 3800) {
          sendMessage(buf.trimEnd()).catch(() => {});
          buf = "";
        }
        buf += line + "\n";
      }
      if (buf.trim()) sendMessage(buf.trimEnd()).catch(() => {});
    } catch (e) {
      sendMessage(`Error reading decisions: ${e.message}`).catch(() => {});
    }
    return true;
  }

  if (cmd === "/freeze" || cmd === "/unfreeze") {
    try {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      const newState = cmd === "/freeze";
      cfg.freezeLessons = newState;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
      reloadConfig();
      const icon = newState ? "🧊" : "🔓";
      const label = newState ? "Lessons FROZEN — no new auto-lessons will be generated" : "Lessons UNFROZEN — auto-lesson generation resumed";
      sendMessage(`${icon} ${label}`).catch(() => {});
    } catch (e) {
      log("telegram_error", `freeze/unfreeze failed: ${e.message}`);
      sendMessage(`❌ Failed to ${text.slice(1)}: ${e.message}`).catch(() => {});
    }
    return true;
  }

  if (cmd === "/withdraw") {
    busy = true;
    sendMessage("🏧 WITHDRAW — closing all positions and converting to SOL...").catch(() => {});
    (async () => {
      try {
        if (_cronRunning) {
          stopCronJobs();
          sendMessage("⏹️ Cron paused for withdrawal.").catch(() => {});
        }

        const positions = getTrackedPositions(true);
        if (positions.length === 0) {
          await sendMessage("No open positions. Sweeping remaining tokens...");
        } else {
          await sendMessage(`Closing ${positions.length} position(s)...`);
        }

        const closeResults = [];
        for (const pos of positions) {
          try {
            const result = await executeTool("close_position", {
              position_address: pos.position,
              close_reason: "withdraw — zap out all to SOL",
              _decision_source: "USER",
            });
            closeResults.push({ pair: pos.pool_name || pos.position.slice(0, 8), success: result?.success, pnl_pct: result?.pnl_pct });
            if (result?.success) {
              log("withdraw", `Closed ${pos.pool_name || pos.position.slice(0, 8)}`);
            } else {
              log("withdraw_warn", `Failed to close ${pos.pool_name}: ${result?.error}`);
            }
          } catch (e) {
            closeResults.push({ pair: pos.pool_name || pos.position.slice(0, 8), success: false, error: e.message });
            log("withdraw_error", `Error closing ${pos.pool_name}: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 2000));
        }

        await new Promise(r => setTimeout(r, 3000));
        const sweepResults = await sweepAllTokensToSol({ bypassAllowlist: true });

        const closedOk = closeResults.filter(r => r.success).length;
        const closedFail = closeResults.filter(r => !r.success).length;
        const swappedOk = sweepResults.filter(r => r.success).length;
        const swappedFail = sweepResults.filter(r => !r.success).length;

        const bal = await getWalletBalances({});
        let msg = `🏧 WITHDRAW COMPLETE\n\n`;
        msg += `📍 Positions: ${closedOk} closed`;
        if (closedFail > 0) msg += `, ${closedFail} failed`;
        msg += `\n`;
        if (sweepResults.length > 0) {
          msg += `💱 Swaps: ${swappedOk} tokens → SOL`;
          if (swappedFail > 0) msg += `, ${swappedFail} failed`;
          msg += `\n`;
        }
        msg += `\n💰 Final balance: ${bal.sol?.toFixed(4) || "?"} SOL`;
        if (bal.sol_usd) msg += ` ($${bal.sol_usd.toFixed(2)})`;

        const failures = closeResults.filter(r => !r.success);
        if (failures.length > 0) {
          msg += `\n\n⚠️ Failed closes:`;
          for (const f of failures) msg += `\n- ${f.pair}: ${f.error || "unknown error"}`;
        }
        const swapFails = sweepResults.filter(r => !r.success);
        if (swapFails.length > 0) {
          msg += `\n\n⚠️ Failed swaps:`;
          for (const f of swapFails) msg += `\n- ${f.symbol || f.mint?.slice(0, 8)}: ${f.error || "unknown error"}`;
        }

        await sendMessage(msg);
      } catch (e) {
        await sendMessage(`❌ Withdraw error: ${e.message}`).catch(() => {});
      } finally {
        busy = false;
      }
    })();
    return true;
  }

  if (cmd.startsWith("/goals")) {
    const arg = text.slice("/goals".length).trim();
    const { loadGoals, calculateProgress, loadPerformance } = await import("./scripts/goals.js");
    if (!arg) {
      const goals = loadGoals();
      if (!goals) {
        sendMessage("No goals set. Usage:\n/goals win_rate=80 max_loss=-10 profit_factor=2\n/goals clear").catch(() => {});
        return true;
      }
      const perf = loadPerformance();
      const result = calculateProgress(goals, perf);
      if (!result) {
        sendMessage(`📎 Goals: ${JSON.stringify(goals)}\n\nNot enough data to calculate progress.`).catch(() => {});
        return true;
      }
      const lines = ["📎 Trading Goals"];
      for (const [key, data] of Object.entries(result.progress)) {
        const icon = data.met ? "✅" : "❌";
        const label = key.replace(/_/g, " ");
        lines.push(`${icon} ${label}: ${data.actual} / ${data.target}`);
      }
      lines.push(`\nLookback: ${result.sampleSize} trades`);
      sendMessage(lines.join("\n")).catch(() => {});
      return true;
    }
    if (arg === "clear") {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      delete cfg.goals;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
      sendMessage("🗑️ Goals cleared.").catch(() => {});
      return true;
    }
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const goals = cfg.goals || {};
    const keyMap = { win_rate: "win_rate_pct", max_loss: "max_loss_pct", profit_factor: "profit_factor", lookback: "lookback" };
    for (const part of arg.split(/\s+/)) {
      const [k, v] = part.split("=");
      if (!k || v == null) continue;
      const configKey = keyMap[k] || k;
      goals[configKey] = parseFloat(v);
    }
    cfg.goals = goals;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
    const perf = loadPerformance();
    const result = calculateProgress(goals, perf);
    const lines = ["✅ Goals updated"];
    if (result) {
      for (const [key, data] of Object.entries(result.progress)) {
        const icon = data.met ? "✅" : "❌";
        const label = key.replace(/_/g, " ");
        lines.push(`${icon} ${label}: ${data.actual} / ${data.target}`);
      }
    }
    sendMessage(lines.join("\n")).catch(() => {});
    return true;
  }

  if (cmd.startsWith("/claude ")) {
    const query = text.slice(8).trim();
    if (!query) { sendMessage("Usage: /claude <question>").catch(() => {}); return true; }
    sendMessage("🤖 Thinking... (~30s)").catch(() => {});
    import("./scripts/claude-ask.js")
      .then(m => m.claudeAsk(query))
      .then(reply => sendMessage(reply.slice(0, 4096)).catch(() => {}))
      .catch(e => sendMessage(`Claude error: ${e.message}`).catch(() => {}));
    return true;
  }

  if (cmd === "/reconcile") {
    try {
      sendMessage("🔄 Reconciling on-chain state...").catch(() => {});
      const livePositions = await getMyPositions();
      const { syncOpenPositions } = await import("./state.js");
      const addresses = (livePositions?.positions || []).map(p => p.position);
      syncOpenPositions(addresses);
      sendMessage(`✅ Reconcile complete — ${addresses.length} open position(s) on-chain, state.json updated.`).catch(() => {});
    } catch (e) {
      sendMessage(`❌ Reconcile failed: ${e.message}`).catch(() => {});
    }
    return true;
  }

  // Log when a slash command falls through (unrecognized)
  if (cmd.startsWith("/")) {
    log("telegram", `⚠️ Unrecognized command fell through: "${cmd}" (text="${text}")`);
  }
  return false; // not a known command — fall through to agent loop
}

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
  if (config.dashboard.enabled) startDashboard(config.dashboard.port, config.dashboard.password);

  // Telegram bot
  // Startup notification — helps detect duplicate instances
  if (telegramEnabled()) {
    const mode = process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE";
    sendMessage(`🚀 Bot started (PID: ${process.pid}, mode: ${mode}). If you see this twice, kill duplicate instances.`).catch(() => {});
  }

  startJournalPolling();
  startJournalCrons();

  startPolling(async (text) => {
    if (busy) {
      sendMessage("Agent is busy with another chat — try again in a moment.").catch(() => {});
      return;
    }

    const handled = await handleTelegramCommand(text, sendMessage, {
      onStart() {
        if (_cronRunning) {
          sendMessage("Agent is already running.").catch(() => {});
        } else {
          startCronJobs();
          _cronRunning = true;
          sendMessage("▶️ Agent started — cron cycles running.").catch(() => {});
        }
      },
      onStop() {
        if (!_cronRunning) {
          sendMessage("Agent is already stopped.").catch(() => {});
        } else {
          stopCronJobs();
          sendMessage("⏹️ Agent stopped — cron cycles paused. Send /start to resume.").catch(() => {});
        }
      },
    });
    if (handled) return;


    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel);
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
  /review        Trigger Claude lesson review (analyzes last 20 closes)
  /claude <q>    Ask Claude anything about positions, lessons, journal
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

    if (input === "/freeze" || input === "/unfreeze") {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      const newState = input === "/freeze";
      cfg.freezeLessons = newState;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
      reloadConfig();
      console.log(newState ? "\nLessons FROZEN — no new auto-lessons will be generated\n" : "\nLessons UNFROZEN — auto-lesson generation resumed\n");
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
  if (config.dashboard.enabled) startDashboard(config.dashboard.port, config.dashboard.password);
  // Startup notification — helps detect duplicate instances
  if (telegramEnabled()) {
    const mode = process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE";
    sendMessage(`🚀 Bot started (PID: ${process.pid}, mode: ${mode}). If you see this twice, kill duplicate instances.`).catch(() => {});
  }

  startJournalPolling();
  startJournalCrons();

  // Telegram chat handler (non-TTY / VPS mode)
  startPolling(async (text) => {
    if (busy) {
      sendMessage("Agent is busy with another chat — try again in a moment.").catch(() => {});
      return;
    }

    const handled = await handleTelegramCommand(text, sendMessage);
    if (handled) return;

    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel);
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
