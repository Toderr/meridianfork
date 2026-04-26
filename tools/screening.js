import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { getRiskFlags } from "./okx.js";
import { isInPostLossCooldown } from "../pool-memory.js";
import { appendDecision } from "../decision-log.js";
import { lookupStrategy, isMatrixEnabled } from "../strategy-matrix.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
  ].join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${s.timeframe}` +
    `&category=${s.category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const condensed = (data.data || []).map(condensePool);

  // Filter blacklisted base tokens and blocked deployers
  const pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (isDevBlocked(p.creator)) {
      log("dev_blocklist", `Filtered pool ${p.name} — deployer ${p.creator?.slice(0, 8)} is blocked`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) {
    log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens`);
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const { pools } = await discoverPools({ page_size: 50 });

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const positionsByMint = new Map(
    positions.filter((p) => p.base_mint).map((p) => [p.base_mint, p])
  );

  // Post-loss cooldown — block re-entry on pools/tokens that just lost ≤ -5%
  const cooldownMin = config.screening.postLossCooldownMin ?? 120;
  const cooldownThresholdPct = config.screening.postLossCooldownPct ?? -5;

  // Cross-pool uniqueness — block candidate if its base_mint is already open elsewhere.
  // Default true; set config.risk.uniqueTokenAcrossPools = false to allow same-token/different-pool.
  const uniqueTokenAcrossPools = config.risk?.uniqueTokenAcrossPools !== false;

  // HARDCODED: reject volatility > MAX_VOLATILITY_HARDCODED.
  // 2026-04-21: cap was 5 (vol 2-5 = +1.51% net wr 100%, vol 5-10 = +0.08%
  // marginal, vol >= 10 = -7.12% disastrous).
  // 2026-04-27: raised to 7 to capture the missing upside in [+1%, +3%]
  // PnL band — current distribution is collapsed at +0.2%. Trade-off
  // controlled by Layer A annotation below: any candidate with vol > 5 is
  // forced to strategy=bid_ask (asymmetric capture, single-sided when
  // matrix permits). vol >= 10 still rejected.
  const MAX_VOLATILITY_HARDCODED = 7;
  const HIGH_VOL_BID_ASK_THRESHOLD = 5;

  // HARDCODED: bin_step must be in [80, 125]. Restored 2026-04-24 after
  // PnL drop post-11 Apr — commit 9837502 relaxed this to configurable,
  // big-loss rate doubled. Original pre-9837502 constraint.
  const BIN_STEP_MIN_HARDCODED = 80;
  const BIN_STEP_MAX_HARDCODED = 125;

  const eligible = pools
    .filter((p) => {
      if (occupiedPools.has(p.pool)) return false;
      const mint = p.base?.mint;
      if (mint && uniqueTokenAcrossPools && occupiedMints.has(mint)) {
        const existing = positionsByMint.get(mint);
        log("screening", `Unique-token guard: ${p.name} blocked — base_mint already open in ${existing?.pool_name || existing?.pool?.slice(0, 8) || "another pool"}`);
        appendDecision({
          type: "skip",
          actor: "RULE_ENGINE",
          pool: p.pool,
          pool_name: p.name,
          summary: `Skipped ${p.name} — duplicate base_mint across pools`,
          reason: `uniqueTokenAcrossPools: base_mint ${mint.slice(0, 8)} already open in ${existing?.pool_name || existing?.pool?.slice(0, 8) || "another pool"}`,
          metrics: { base_mint: mint, existing_position: existing?.position || null, existing_pool: existing?.pool || null },
        });
        return false;
      }
      return true;
    })
    .filter((p) => {
      if (p.volatility != null && p.volatility > MAX_VOLATILITY_HARDCODED) {
        log("screening", `Volatility cap: ${p.name} blocked — volatility ${p.volatility} > ${MAX_VOLATILITY_HARDCODED}`);
        return false;
      }
      return true;
    })
    .filter((p) => {
      if (p.bin_step != null && (p.bin_step < BIN_STEP_MIN_HARDCODED || p.bin_step > BIN_STEP_MAX_HARDCODED)) {
        log("screening", `Bin-step gate: ${p.name} blocked — bin_step ${p.bin_step} outside [${BIN_STEP_MIN_HARDCODED}, ${BIN_STEP_MAX_HARDCODED}]`);
        return false;
      }
      return true;
    })
    .filter((p) => {
      const cd = isInPostLossCooldown(p.pool, p.base?.mint, cooldownMin, cooldownThresholdPct);
      if (cd.cooling) {
        log("screening", `Cooldown: ${p.name} blocked — last close ${cd.last_pnl_pct}% ${cd.minutes_since}m ago (scope=${cd.scope}, cooldown=${cd.cooldown_min}m)`);
        return false;
      }
      return true;
    })
    .slice(0, limit);

  // Enrich with OKX risk flags — parallel, fire-and-forget per candidate
  const enriched = await Promise.all(
    eligible.map(async (pool) => {
      const mint = pool.base?.mint;
      if (!mint) return pool;
      try {
        const flags = await getRiskFlags(mint);
        return { ...pool, is_rugpull: flags.is_rugpull, is_wash: flags.is_wash };
      } catch {
        return pool; // OKX unavailable — pass through without flags
      }
    })
  );

  // Hard-filter wash trading (always disqualifying)
  const filtered = enriched.filter(p => {
    if (p.is_wash === true) {
      log("screening", `Filtered wash-trading pool: ${p.name} (${p.pool?.slice(0, 8)})`);
      return false;
    }
    return true;
  });

  // ─── Layer A — Strategy Matrix annotation (data-derived hard gate, 2026-04-26) ──
  // Per-candidate lookup of forced (strategy, shape) from data/strategy-matrix.json.
  // Built from 2,108 outlier-filtered closes (|net%|>30 dropped). LLM sees these
  // as REQUIRED — Layer B in the executor enforces them with silent override.
  const matrixOn = isMatrixEnabled(config);
  const annotated = filtered.map(p => {
    if (!matrixOn) return p;
    const rec = lookupStrategy({
      volatility: p.volatility,
      bin_step: p.bin_step,
      fee_tvl_ratio: p.fee_tvl_ratio,
    });
    if (!rec) return p;
    // 2026-04-27: high-vol override — vol > HIGH_VOL_BID_ASK_THRESHOLD must
    // use bid_ask regardless of matrix recommendation. Asymmetric upside
    // capture is the only way these candidates earn their place above the
    // pre-2026-04-27 vol cap of 5.
    let strategy = rec.strategy;
    if (p.volatility != null && p.volatility > HIGH_VOL_BID_ASK_THRESHOLD && strategy !== "bid_ask") {
      log("screening", `High-vol override: ${p.name} (vol ${p.volatility}) — forcing strategy=bid_ask (matrix said ${strategy})`);
      strategy = "bid_ask";
    }
    return {
      ...p,
      forced_strategy: strategy,
      forced_bins_above_pct: rec.bins_above_pct,
      matrix_score: rec.score,
      matrix_level: rec.level,
      matrix_n: rec.n,
    };
  });

  return {
    candidates: annotated,
    total_screened: pools.length,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    creator: p.creator || p.creator_address || null,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

/**
 * Validates that pool data is still fresh before deployment.
 * Returns { ok: true } or { ok: false, reason: string }
 */
export async function validatePoolFresh(poolAddress, originalData = {}) {
  try {
    const fresh = await getPoolDetail({ pool_address: poolAddress, timeframe: "5m" });
    if (!fresh) return { ok: false, reason: "Pool data unavailable" };

    const checks = [];

    // Fee/TVL ratio dropped >50%
    if (originalData.fee_tvl_ratio != null && fresh.fee_active_tvl_ratio != null) {
      const drop = (originalData.fee_tvl_ratio - fresh.fee_active_tvl_ratio) / originalData.fee_tvl_ratio;
      if (drop > 0.5) checks.push(`fee/TVL dropped ${(drop * 100).toFixed(0)}% (${originalData.fee_tvl_ratio.toFixed(3)} → ${fresh.fee_active_tvl_ratio.toFixed(3)})`);
    }

    // TVL dropped >30%
    if (originalData.tvl != null && fresh.active_tvl != null) {
      const drop = (originalData.tvl - fresh.active_tvl) / originalData.tvl;
      if (drop > 0.30) checks.push(`TVL dropped ${(drop * 100).toFixed(0)}% ($${originalData.tvl.toFixed(0)} → $${fresh.active_tvl.toFixed(0)})`);
    }

    // Volume dropped >50%
    if (originalData.volume != null && fresh.volume != null) {
      const drop = (originalData.volume - fresh.volume) / originalData.volume;
      if (drop > 0.50) checks.push(`volume dropped ${(drop * 100).toFixed(0)}%`);
    }

    if (checks.length > 0) {
      return { ok: false, reason: checks.join("; ") };
    }
    return { ok: true, fresh };
  } catch (e) {
    // On error, allow deploy (don't block on validation failure)
    return { ok: true };
  }
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}
