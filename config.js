import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 10,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? null, // null = disabled; set to e.g. 30 to hard-filter bot-heavy tokens
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 5,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    emergencyPriceDropPct: u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeeTvl24h:          u.minFeeTvl24h          ?? 7,
    minAgeForYieldExit:    u.minAgeForYieldExit    ?? 60,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    fastTpPct:             u.fastTpPct             ?? 15,
    trailingActivate:      u.trailingActivate      ?? 6,
    trailingFloor:         u.trailingFloor         ?? 5,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
    strategyRules: u.strategyRules ?? {
      highVol: "bid_ask",   // volatility >= 5
      medVol:  "bid_ask",   // volatility 2-5
      lowVol:  "spot",      // volatility < 2
    },
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    managementTiers: u.managementTiers ?? {
      high: { minVol: 5, intervalMin: 3  },   // volatility >= 5
      med:  { minVol: 2, intervalMin: 5  },   // volatility 2–5 (or null)
      low:  { minVol: 0, intervalMin: 10 },   // volatility < 2
    },
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "minimax/minimax-m2.7",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free",
  },

  // ─── RPC Fallbacks ────────────────────
  fallbackRpcUrls: u.fallbackRpcUrls ?? [],

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── Web Dashboard ─────────────────────
  dashboard: {
    port:     u.dashboardPort     ?? 3000,
    enabled:  u.dashboardEnabled  !== false, // default: true
    password: u.dashboardPassword ?? null,   // null = no auth
  },

  // ─── Experiment Settings ────────────────
  experiment: {
    defaultDeployAmount:      u.experimentDeployAmount      ?? 0.3,
    defaultMaxIterations:     u.experimentMaxIterations     ?? 20,
    convergenceWindow:        u.experimentConvergenceWindow ?? 3,
    maxConcurrentExperiments: u.maxConcurrentExperiments    ?? 2,
    defaultRules: {
      takeProfitFeePct:      3,
      fastTpPct:             8,
      emergencyPriceDropPct: -30,
      maxMinutesHeld:        120,
      trailingActivate:      4,
      trailingFloor:         3,
    },
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 * Optionally scales down for high-volatility pools.
 *
 * Formula: clamp(deployable × positionSizePct × volatilityMultiplier, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Volatility multipliers:
 *   volatility >= 5: × 0.6 (smaller position for very volatile pools)
 *   volatility >= 2: × 0.8
 *   volatility < 2 or null: × 1.0 (no change)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol, volatility = null) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;

  // Apply volatility multiplier before clamping
  let volMultiplier = 1.0;
  if (volatility != null) {
    if (volatility >= 5) {
      volMultiplier = 0.6;
    } else if (volatility >= 2) {
      volMultiplier = 0.8;
    }
  }

  const result = Math.min(ceil, Math.max(floor, dynamic * volMultiplier));
  return parseFloat(result.toFixed(2));
}

/**
 * Resolve the LP strategy type based on pool volatility.
 * Uses strategyRules from config to pick bid_ask vs spot.
 * Falls back to the configured default strategy if volatility is unknown.
 */
export function resolveStrategy(volatility) {
  const rules = config.strategy.strategyRules || {};
  if (volatility == null) return config.strategy.strategy; // fallback to default
  if (volatility >= 5)  return rules.highVol || "bid_ask";
  if (volatility >= 2)  return rules.medVol  || "bid_ask";
  return rules.lowVol || "spot";
}

export { USER_CONFIG_PATH };

/**
 * Reload user-config.json and apply all hot-reloadable settings to the
 * in-memory config object without a restart.
 *
 * NOT reloaded (require restart): rpcUrl, walletKey, dryRun, schedule intervals.
 */
export function reloadConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const f = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));

    const s = config.screening;
    if (f.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = f.minFeeActiveTvlRatio;
    if (f.minOrganic     != null) s.minOrganic     = f.minOrganic;
    if (f.minHolders     != null) s.minHolders     = f.minHolders;
    if (f.minMcap        != null) s.minMcap        = f.minMcap;
    if (f.maxMcap        != null) s.maxMcap        = f.maxMcap;
    if (f.minTvl         != null) s.minTvl         = f.minTvl;
    if (f.maxTvl         != null) s.maxTvl         = f.maxTvl;
    if (f.minVolume      != null) s.minVolume      = f.minVolume;
    if (f.minBinStep     != null) s.minBinStep     = f.minBinStep;
    if (f.maxBinStep     != null) s.maxBinStep     = f.maxBinStep;
    if (f.timeframe      != null) s.timeframe      = f.timeframe;
    if (f.category       != null) s.category       = f.category;
    if (f.minTokenFeesSol   != null) s.minTokenFeesSol   = f.minTokenFeesSol;
    if (f.maxBotHoldersPct  != null) s.maxBotHoldersPct  = f.maxBotHoldersPct;

    const m = config.management;
    if (f.minClaimAmount        != null) m.minClaimAmount        = f.minClaimAmount;
    if (f.outOfRangeBinsToClose != null) m.outOfRangeBinsToClose = f.outOfRangeBinsToClose;
    if (f.outOfRangeWaitMinutes != null) m.outOfRangeWaitMinutes = f.outOfRangeWaitMinutes;
    if (f.minVolumeToRebalance  != null) m.minVolumeToRebalance  = f.minVolumeToRebalance;
    if (f.emergencyPriceDropPct != null) m.emergencyPriceDropPct = f.emergencyPriceDropPct;
    if (f.takeProfitFeePct      != null) m.takeProfitFeePct      = f.takeProfitFeePct;
    if (f.minSolToOpen          != null) m.minSolToOpen          = f.minSolToOpen;
    if (f.deployAmountSol       != null) m.deployAmountSol       = f.deployAmountSol;
    if (f.gasReserve            != null) m.gasReserve            = f.gasReserve;
    if (f.positionSizePct       != null) m.positionSizePct       = f.positionSizePct;
    if (f.minFeeTvl24h          != null) m.minFeeTvl24h          = f.minFeeTvl24h;
    if (f.minAgeForYieldExit    != null) m.minAgeForYieldExit    = f.minAgeForYieldExit;
    if (f.fastTpPct             != null) m.fastTpPct             = f.fastTpPct;
    if (f.trailingActivate      != null) m.trailingActivate      = f.trailingActivate;
    if (f.trailingFloor         != null) m.trailingFloor         = f.trailingFloor;

    const r = config.risk;
    if (f.maxPositions    != null) r.maxPositions    = f.maxPositions;
    if (f.maxDeployAmount != null) r.maxDeployAmount = f.maxDeployAmount;

    const st = config.strategy;
    if (f.strategy      != null) st.strategy      = f.strategy;
    if (f.binsBelow     != null) st.binsBelow     = f.binsBelow;
    if (f.strategyRules != null) st.strategyRules = f.strategyRules;

    const l = config.llm;
    if (f.managementModel != null) l.managementModel = f.managementModel;
    if (f.screeningModel  != null) l.screeningModel  = f.screeningModel;
    if (f.generalModel    != null) l.generalModel    = f.generalModel;
    if (f.temperature     != null) l.temperature     = f.temperature;
    if (f.maxTokens       != null) l.maxTokens       = f.maxTokens;
    if (f.maxSteps        != null) l.maxSteps        = f.maxSteps;
  } catch { /* ignore */ }
}

// Keep old name as alias for backward compatibility
export const reloadScreeningThresholds = reloadConfig;

