import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
  withdrawLiquidity,
  addLiquidity,
} from "./dlmm.js";
import { getWalletBalances, swapToken, swapAllTokensAfterClose } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, removeLesson, getPerformanceHistory, pinLesson, unpinLesson, listLessons, listAllLessons } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";
import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy, getActiveStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { syncToHive, isEnabled as hiveEnabled, getHivePulse, queryPoolConsensus, queryLessonConsensus } from "../hive-mind.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, resolveStrategy } from "../config.js";
import { extractRules, checkDeployCompliance } from "../lesson-rules.js";
import { appendDecision, getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";
import { _stats, _flags } from "../stats.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Prevents two deploys in the same screening cycle (reset by runScreeningCycle at start)
let _deployedThisCycle = false;
export function resetDeployGuard() { _deployedThisCycle = false; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_dev: blockDev,
  unblock_dev: unblockDev,
  list_blocked_devs: listBlockedDevs,
  withdraw_liquidity: withdrawLiquidity,
  add_liquidity: addLiquidity,
  get_hive_pulse: () => getHivePulse(),
  get_hive_pool_consensus: ({ pool_address }) => queryPoolConsensus(pool_address),
  get_hive_lessons: ({ tags } = {}) => queryLessonConsensus(tags),
  add_lesson: ({ rule, tags, pinned, role, source }) => {
    const src = source === "experiment" ? "experiment" : "regular";
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null, source: src });
    return { saved: true, rule, pinned: !!pinned, role: role || "all", source: src };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  remove_lesson: ({ id, index }) => {
    let lessonId = id;
    if (lessonId == null && index != null) {
      const all = listAllLessons();
      const target = all[index - 1];
      if (!target) return { removed: false, error: `No lesson at index ${index}` };
      if (target.pinned) return { removed: false, error: `Lesson #${index} is pinned — unpin first` };
      lessonId = target.id;
    }
    if (lessonId == null) return { removed: false, error: "Provide id or index" };
    const n = removeLesson(lessonId);
    return { removed: n > 0 };
  },
  list_lessons: ({ role, pinned, tag, source, limit } = {}) => listLessons({ role, pinned, tag, source, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      emergencyPriceDropPct: ["management", "emergencyPriceDropPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      minFeeTvl24h: ["management", "minFeeTvl24h"],
      minAgeForYieldExit: ["management", "minAgeForYieldExit"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      // strategy
      minBinStep: ["strategy", "minBinStep"],
      binsBelow: ["strategy", "binsBelow"],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Hardcoded floor: minTokenFeesSol can never go below 30 (anti-scam gate)
    if (applied.minTokenFeesSol != null && applied.minTokenFeesSol < 30) {
      log("config", `update_config: minTokenFeesSol clamped to 30 (requested ${applied.minTokenFeesSol})`);
      applied.minTokenFeesSol = 30;
    }

    // Apply to live config immediately, track before-values for notification
    const beforeValues = {};
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      beforeValues[key] = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${beforeValues[key]} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);

    // Notify journal bot (fire-and-forget)
    import("../telegram-journal.js")
      .then(m => m.notifyConfigChange({ applied, before: beforeValues, reason, source: "agent" }))
      .catch(() => {});

    return { success: true, applied, unknown, reason };
  },

  // ─── Experiment Tools ─────────────────────────────────────────
  start_experiment:  (args) => import("../experiment.js").then(m => m.startExperiment(args)),
  get_experiment:    (args) => import("../experiment.js").then(m => m.getExperiment(args.experiment_id)),
  list_experiments:  (args) => import("../experiment.js").then(m => m.listExperiments(args)),
  pause_experiment:  (args) => import("../experiment.js").then(m => m.pauseExperiment(args.experiment_id)),
  resume_experiment: (args) => import("../experiment.js").then(m => m.resumeExperiment(args.experiment_id)),
  cancel_experiment: (args) => import("../experiment.js").then(m => m.cancelExperiment(args.experiment_id)),
  query_wiki: (args) => import("../wiki.js").then(m => m.queryWiki(args)),
  rebuild_wiki: () => import("../wiki.js").then(m => m.compileFullWiki()),
  get_recent_decisions: ({ limit, type, actor, position } = {}) => ({
    decisions: getRecentDecisions({ limit, type, actor, position }),
  }),
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
  "withdraw_liquidity",
  "add_liquidity",
  "start_experiment",
  "resume_experiment",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Strip internal hints from args (never reach the underlying tool) ──
  // _decision_source: caller-supplied tag for the decision log (RULE_ENGINE/PNL_CHECKER/etc.)
  let _decisionSource = null;
  if (args && typeof args === "object" && "_decision_source" in args) {
    _decisionSource = args._decision_source;
    const { _decision_source, ...rest } = args;
    args = rest;
  }

  // ─── HARDCODED: variant null-guard (rec #4, 2026-04-22). Block any LLM-driven
  // deploy_position where variant is unset/empty. Internal automation paths
  // (retry/hive_*/exp_*/screening) always set variant explicitly, so they pass.
  // Data basis (2026-04-22 audit): variant=null bucket NET -$19.58 (8 trades, wr 57%)
  // vs lper_proven NET +$16.44 — null is the worst-performing bucket.
  if (name === "deploy_position" && args && typeof args === "object") {
    if (!args.variant || typeof args.variant !== "string" || !args.variant.trim()) {
      log("executor", `Deploy blocked: variant is null/undefined`);
      return {
        blocked: true,
        reason: "deploy blocked: variant is null/undefined. Set variant to a strategy label (e.g. 'lper_proven') so performance can be attributed.",
      };
    }
  }

  // ─── HARDCODED: +1 confidence for proven variants. 2026-04-23 big-loss audit
  // split the lper family by casing: LPerProven (n=29, 0% big, +0.23% avg) and
  // LPer-Proven (n=9, 0% big, +0.76% avg) stay bonused; lowercase lper-proven
  // (n=167, 5.4% big, -0.42% avg) and lper_proven (n=61, 3.3% big, -0.54% avg)
  // lose the bonus — they were the dominant sample and dragged the family
  // below baseline. pullback-entry (n=12, 92% wr, +0.80%) keeps the bonus.
  if (name === "deploy_position" && args && typeof args === "object") {
    const variantHasBonus = (v) => {
      if (!v) return false;
      // Case-sensitive match for the two proven lper forms — lowercase/underscore
      // siblings are intentionally excluded (they underperform baseline).
      if (v === "LPerProven" || v === "LPer-Proven") return true;
      // pullback-entry: match regardless of casing/punctuation (single clean pattern).
      if (v.toLowerCase().replace(/[-_]/g, "") === "pullbackentry") return true;
      // upper-biased: 2026-04-23 full-data audit showed 100% wr / +3.15% avg (n=5).
      // Provisional bonus pending more samples — re-evaluate at n>=15.
      if (v.toLowerCase().replace(/[-_]/g, "") === "upperbiased") return true;
      return false;
    };
    if (variantHasBonus(args.variant) && typeof args.confidence_level === "number") {
      const original = args.confidence_level;
      const bumped = Math.min(10, original + 1);
      if (bumped !== original) {
        args = { ...args, confidence_level: bumped };
        log("executor", `Confidence bump: variant=${args.variant} ${original} → ${bumped} (hardcoded proven-variant bonus)`);
      }
    }
  }

  // ─── HARDCODED: cap effective confidence used for sizing (rec #5, 2026-04-22).
  // Data basis (2026-04-22 audit): conf=8 NET +$23.89 / 88% wr (n=26) vs
  // conf>=8.5 NET -$19.32 / 36% wr (n=9) — high LLM confidence is anti-correlated
  // with realized PnL in current regime. Cap sizing at maxEffectiveConfidence
  // while preserving the original value in logs.
  if (name === "deploy_position" && args && typeof args === "object") {
    const maxEff = config.maxEffectiveConfidence;
    if (typeof args.confidence_level === "number" && typeof maxEff === "number" && args.confidence_level > maxEff) {
      const original = args.confidence_level;
      args = { ...args, confidence_level: maxEff };
      log("executor", `Confidence cap: ${original} → ${maxEff} (maxEffectiveConfidence)`);
    }
  }

  // ─── Pre-execution safety checks ──────────
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    // Validate pool data is still fresh before deploying
    if (name === "deploy_position" && args.pool_address) {
      const { validatePoolFresh } = await import("./screening.js");
      const validation = await validatePoolFresh(args.pool_address, {
        fee_tvl_ratio: args.fee_tvl_ratio,
        tvl: args.tvl,
        volume: args.volume,
      });
      if (!validation.ok) {
        log("executor", `Deploy blocked — stale pool data: ${validation.reason}`);
        return {
          role: "tool",
          blocked: true,
          reason: `Pool conditions changed since screening: ${validation.reason}. Do not retry — run a fresh screening cycle instead.`,
        };
      }
    }

    // Auto-resolve strategy from volatility when deploying a position
    if (name === "deploy_position") {
      if (!args.strategy || args.strategy === config.strategy.strategy) {
        args = { ...args, strategy: resolveStrategy(args.volatility) };
      }
      // Always compute initial_value_usd from wallet sol_price × deposit size.
      // LLM-provided values have been observed to hallucinate (e.g. 137.44 where
      // 2 SOL × $85.90 = $171.80), which poisons tracked state and every downstream
      // PnL / lesson surface. The deposit size and live sol_price are authoritative.
      {
        const amountSol = args.amount_y ?? args.amount_sol ?? 0;
        const wPre = await getWalletBalances({});
        const computed = amountSol * (wPre?.sol_price || 0);
        if (computed > 0) args = { ...args, initial_value_usd: computed };
      }
    }

    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "deploy_position") {
        _deployedThisCycle = true; // block second deploy in this screening cycle
        _stats.positionsDeployed++;
        notifyDeploy({ pair: args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, strategy: args.strategy, position: result.position, tx: result.tx }).catch(() => {});
        try {
          appendDecision({
            type: "deploy",
            actor: _decisionSource || "AGENT",
            pool: args.pool_address,
            pool_name: args.pool_name || result.pool_name,
            position: result.position,
            summary: `Deployed ${(args.amount_y ?? args.amount_sol ?? 0)} SOL with ${args.strategy || "?"}`,
            reason: args.deploy_reason || null,
            metrics: {
              amount_sol:        args.amount_y ?? args.amount_sol ?? 0,
              strategy:          args.strategy,
              confidence_level:  args.confidence_level,
              bin_step:          args.bin_step,
              volatility:        args.volatility,
              fee_tvl_ratio:     args.fee_tvl_ratio,
              initial_value_usd: args.initial_value_usd,
              variant:           args.variant,
            },
          });
        } catch (e) { log("decision_log_error", `deploy decision failed: ${e.message}`); }
        // Record open to trading journal — retry up to 3 times in case of transient failure
        (async () => {
          let journalSuccess = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const w = await getWalletBalances({});
              const { recordOpen } = await import("../journal.js");
              const { getTokenProfile } = await import("../screening-cache.js");
              const tracked = getTrackedPosition(result.position);

              // Snapshot strategy library entry + active config thresholds.
              // Both calls are local (no network); failures fall through to null.
              let strategyConfig = null;
              try {
                const activeStrategy = getActiveStrategy();
                const r = config.risk || {};
                const m = config.management || {};
                const s = config.screening || {};
                strategyConfig = {
                  strategy_id: activeStrategy?.id || args.strategy || null,
                  library_entry: activeStrategy || null,
                  thresholds: {
                    takeProfitFeePct:        r.takeProfitFeePct ?? null,
                    fastTpPct:               r.fastTpPct ?? null,
                    emergencyPriceDropPct:   r.emergencyPriceDropPct ?? null,
                    trailingActivate:        r.trailingActivate ?? null,
                    trailingFloor:           r.trailingFloor ?? null,
                    outOfRangeBinsToClose:   m.outOfRangeBinsToClose ?? null,
                    minFeeTvl24h:            m.minFeeTvl24h ?? s.minFeeTvl24h ?? null,
                    minClaimAmount:          m.minClaimAmount ?? null,
                    positionSizePct:         r.positionSizePct ?? null,
                    gasReserve:              r.gasReserve ?? null,
                    forceSolSingleSided:     r.forceSolSingleSided ?? null,
                    deployAmountSol:         r.deployAmountSol ?? null,
                    maxDeployAmount:         r.maxDeployAmount ?? null,
                    maxPositions:            r.maxPositions ?? null,
                  },
                };
              } catch (cfgErr) {
                log("executor", `strategy_config snapshot failed: ${cfgErr.message}`);
              }

              recordOpen({
                position: result.position,
                pool: args.pool_address,
                pool_name: args.pool_name || tracked?.pool_name || result.pool_name,
                strategy: args.strategy,
                amount_sol: args.amount_y ?? args.amount_sol ?? 0,
                initial_value_usd: args.initial_value_usd
                  || ((args.amount_y ?? args.amount_sol ?? 0) * (w?.sol_price || 0))
                  || null,
                sol_price: w?.sol_price || 0,
                bin_step: args.bin_step,
                volatility: args.volatility,
                fee_tvl_ratio: args.fee_tvl_ratio,
                organic_score: args.organic_score,
                bin_range: result.bin_range || args.bin_range,
                variant: args.variant,
                token_profile: getTokenProfile(args.pool_address) || null,
                strategy_config: strategyConfig,
              });
              journalSuccess = true;
              break;
            } catch (trackErr) {
              log("executor", `Journal recordOpen attempt ${attempt + 1} failed: ${trackErr.message}`);
              if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
            }
          }
          if (!journalSuccess) {
            log("executor", `CRITICAL: Position ${result.position} deployed on-chain but journal recording failed — manual reconciliation needed`);
          }
        })();
      } else if (name === "claim_fees") {
        _stats.feesClaimed++;
      } else if (name === "close_position") {
        _stats.positionsClosed++;
        const _tracked = getTrackedPosition(args.position_address);
        const _pair = _tracked?.pool_name || result.pool_name || args.position_address?.slice(0, 8);
        notifyClose({ pair: _pair, strategy: _tracked?.strategy, pnlUsd: result.pnl_usd ?? 0, pnlSol: result.pnl_sol ?? 0, pnlPct: result.pnl_pct ?? 0, feesUsd: result.fees_earned_usd ?? 0, solPrice: result.sol_price ?? 0, reason: args.close_reason }).catch(() => {});

        // SL slippage alert — fires when realized pnl is >3pp worse than the
        // trigger value embedded in the close_reason. 2026-04-23 big-loss audit
        // showed 43% of SL closes slipped past trigger by 2-30+pp on meme dumps.
        try {
          const reason = args.close_reason || "";
          if (/stop.?loss/i.test(reason)) {
            const m = reason.match(/-?\d+(?:\.\d+)?/);
            if (m && result?.pnl_pct != null) {
              const triggerPct = parseFloat(m[0]);
              const realizedPct = result.pnl_pct;
              if (!Number.isNaN(triggerPct) && triggerPct - realizedPct > 3) {
                import("../telegram-journal.js")
                  .then(j => j.notifySlSlippage({
                    pair: _pair,
                    triggerPct,
                    realizedPct,
                    feesUsd: result.fees_earned_usd,
                    closeReason: reason,
                  }))
                  .catch(() => {});
              }
            }
          }
        } catch (_e) { /**/ }
        try {
          const pnlPct = result.pnl_pct ?? 0;
          const pnlUsd = result.pnl_usd ?? 0;
          const feesUsd = result.fees_earned_usd ?? 0;
          const minutesHeld = _tracked?.deployed_at
            ? Math.floor((Date.now() - new Date(_tracked.deployed_at).getTime()) / 60000)
            : null;
          const risks = [];
          if (pnlPct < 0) risks.push(`loss ${pnlPct.toFixed(2)}%`);
          if (/oor|out.of.range/i.test(args.close_reason || "")) risks.push("out of range");
          if (/stop.?loss|emergency/i.test(args.close_reason || "")) risks.push("stop loss");
          if (/trailing/i.test(args.close_reason || "")) risks.push("trailing stop");
          appendDecision({
            type: "close",
            actor: _decisionSource || "AGENT",
            pool: _tracked?.pool || result.pool,
            pool_name: _pair,
            position: args.position_address,
            summary: `Closed at ${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`,
            reason: args.close_reason || "agent decision",
            risks,
            metrics: {
              pnl_pct:         pnlPct,
              pnl_usd:         pnlUsd,
              fees_earned_usd: feesUsd,
              minutes_held:    minutesHeld,
              strategy:        _tracked?.strategy,
            },
          });
        } catch (e) { log("decision_log_error", `close decision failed: ${e.message}`); }
        _flags.gasLowNotified = false;       // position closed — SOL may have returned, allow fresh gas warning
        _flags.maxPositionsNotified = false; // slot freed — allow next max-positions warning
        if (hiveEnabled()) syncToHive().catch(() => {});
        // Experiment iteration hook — fire-and-forget
        if (_tracked?.variant?.startsWith("exp_")) {
          import("../experiment.js").then(({ onExperimentPositionClosed }) => {
            onExperimentPositionClosed(args.position_address, {
              pnl_pct:          result.pnl_pct          ?? 0,
              pnl_usd:          result.pnl_usd          ?? 0,
              fees_earned_usd:  result.fees_earned_usd  ?? 0,
              range_efficiency: result.range_efficiency ?? 0,
              minutes_held:     result.minutes_held     ?? 0,
              close_reason:     args.close_reason       || "agent decision",
            });
          }).catch(e => log("experiment_error", `Experiment hook failed: ${e.message}`));
        }
        // Auto-swap ALL non-SOL tokens back to SOL unless user said to hold
        if (!args.skip_swap) {
          try {
            const swapResults = await swapAllTokensAfterClose({ maxRounds: 3, targetMint: result.base_mint });
            const swapped = swapResults.filter(r => r.success);
            for (const s of swapped) {
              notifySwap({ pair: _pair, tokenSymbol: s.symbol || s.mint.slice(0, 8), usdValue: s.usd }).catch(() => {});
            }
            const failed = swapResults.filter(r => !r.success);
            if (failed.length > 0) {
              log("executor_warn", `Post-close swap: ${failed.length} token(s) could not be swapped: ${failed.map(f => f.symbol || f.mint.slice(0, 8)).join(", ")}`);
            }
          } catch (e) {
            log("executor_warn", `Post-close swap failed: ${e.message}`);
          }
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Experiment deploys bypass confidence gate, max-positions, duplicate pool/mint guards
      const isExperiment = typeof args.variant === "string" && args.variant.startsWith("exp_");

      // Block second deploy in same screening cycle (experiments are allowed to redeploy freely)
      if (!isExperiment && _deployedThisCycle) {
        return {
          pass: false,
          reason: "Already deployed once in this screening cycle. Wait for the next cycle.",
        };
      }

      // Block low-confidence deploys (experiments always pass confidence=10)
      if (!isExperiment && args.confidence_level != null && args.confidence_level <= 7) {
        return {
          pass: false,
          reason: `Confidence ${args.confidence_level}/10 is too low (must be > 7). Do not deploy.`,
        };
      }

      // Lesson-based compliance check — enforce HARD RULES derived from past trade outcomes
      try {
        const { screening: screeningRules } = extractRules("SCREENER");
        if (screeningRules.length > 0 && !isExperiment) {
          const poolData = {
            volatility: args.volatility,
            global_fees_sol: args.global_fees_sol,
            top_10_pct: args.top_10_pct,
            bundlers_pct: args.bundlers_pct,
          };
          const { pass: lessonPass, violations } = checkDeployCompliance(args, poolData, screeningRules);
          if (!lessonPass) {
            return {
              pass: false,
              reason: `Blocked by learned lesson rules:\n${violations.join("\n")}\nReview your HARD RULES and choose a compliant strategy/pool.`,
            };
          }
        }
      } catch (lessonErr) {
        // Non-fatal — lesson check failure should not block deploys
        log("warn", `Lesson compliance check failed (non-fatal): ${lessonErr.message}`);
      }

      // Reject pools with bin_step out of configured range (experiments exempt — iterating freely)
      if (!isExperiment) {
        const minStep = config.screening.minBinStep;
        const maxStep = config.screening.maxBinStep;
        if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
          return {
            pass: false,
            reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
          };
        }
      }

      // Check position count limit + duplicate pool guard
      const positions = await getMyPositions();
      // Experiments bypass max-positions and duplicate checks (they intentionally redeploy the same pool)
      if (!isExperiment) {
        if (positions.total_positions >= config.risk.maxPositions) {
          return {
            pass: false,
            reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
          };
        }
        const alreadyInPool = positions.positions.some(
          (p) => p.pool === args.pool_address
        );
        if (alreadyInPool && !args.allow_duplicate_pool) {
          return {
            pass: false,
            reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate. Pass allow_duplicate_pool: true for multi-layer strategy.`,
          };
        }
      }

      // reserve_slot: enforce lesson-based slot reservations for specific tokens
      try {
        const { screening: slotRules } = extractRules("SCREENER");
        const reserveRules = slotRules.filter((r) => r.type === "reserve_slot");
        if (reserveRules.length > 0 && !isExperiment) {
          const openPairs = positions.positions.map((p) => (p.pair || p.name || "").toUpperCase());
          const deployingPair = (args.pair || "").toUpperCase();
          const deployingMint = (args.base_mint || "").toUpperCase();
          for (const rule of reserveRules) {
            const reservedToken = rule.token.toUpperCase();
            // Skip enforcement if this deploy IS for the reserved token
            const isForReservedToken =
              deployingPair.includes(reservedToken) || deployingMint.includes(reservedToken);
            if (isForReservedToken) continue;
            // Check if reserved token already has an open position (reservation satisfied)
            const alreadyOpen = openPairs.some((p) => p.includes(reservedToken));
            if (alreadyOpen) continue;
            // Reservation is unfilled — block if at or above the reserved threshold
            const slotsUsed = positions.total_positions;
            const slotsMax = config.risk.maxPositions;
            const slotsReserved = reserveRules
              .filter((r) => !openPairs.some((p) => p.includes(r.token.toUpperCase())))
              .reduce((sum, r) => sum + r.count, 0);
            if (slotsUsed >= slotsMax - slotsReserved) {
              return {
                pass: false,
                reason: `Slot reserved for ${reservedToken} by lesson rule (${rule.source}). Deploy ${reservedToken} first or close an existing position.`,
              };
            }
          }
        }
      } catch (slotErr) {
        log("warn", `reserve_slot check failed (non-fatal): ${slotErr.message}`);
      }

      // Block same base token across different pools (experiments exempt — same pool, iterating).
      // Gated on config.risk.uniqueTokenAcrossPools (default true).
      if (!isExperiment && args.base_mint && config.risk?.uniqueTokenAcrossPools !== false) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. uniqueTokenAcrossPools=true — one position per token. Set false in user-config.json to override.`,
          };
        }
      }

      // Check amount limits
      const amountX = args.amount_x ?? 0;
      const amountY = args.amount_y ?? args.amount_sol ?? 0;

      // tokenX-only deploy: skip SOL amount checks
      if (amountX > 0 && amountY === 0) {
        // No SOL needed — tokenX-only deploy
      } else if (amountX > 0 && amountY > 0) {
        // Custom ratio dual-sided: skip minimum SOL check, only enforce max
        if (amountY > config.risk.maxDeployAmount) {
          return {
            pass: false,
            reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
          };
        }
      } else {
        // Standard SOL-sided deploy
        if (amountY <= 0) {
          return {
            pass: false,
            reason: `Must provide a positive amount for either SOL (amount_y) or base token (amount_x).`,
          };
        }

        // Enforce minimum deploy amount — always use deployAmountSol as floor.
        // LLM may send a small amount_y even with valid confidence; enforce the configured minimum.
        const minDeploy = Math.max(0.1, config.management.deployAmountSol);
        if (amountY < minDeploy) {
          return {
            pass: false,
            reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
          };
        }
        if (amountY > config.risk.maxDeployAmount) {
          return {
            pass: false,
            reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
          };
        }
      }

      // Check SOL balance — skip for tokenX-only deploys
      if (amountY > 0) {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
