import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);

// ─── SOL price cache (for SDK fee fallback USD estimation) ──────
let _solPrice = 0;
let _solPriceAt = 0;
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function getSolPrice() {
  if (_solPrice && Date.now() - _solPriceAt < 60_000) return _solPrice;
  try {
    const res = await fetch(`https://api.jup.ag/price/v3?ids=${SOL_MINT}`);
    if (!res.ok) return _solPrice || 0;
    const data = await res.json();
    _solPrice = data.data?.[SOL_MINT]?.usdPrice ?? 0;
    _solPriceAt = Date.now();
    return _solPrice;
  } catch {
    return _solPrice || 0;
  }
}

// ─── SDK fallback for single position ──────────────────────────
// Called when DLMM PnL API returns no data for a position.
// Returns bin range, in-range status, and fee estimate in USD.
async function fetchPositionSdkFallback(poolAddress, positionAddress, walletPubkey) {
  try {
    const pool = await getPool(poolAddress);
    const { userPositions, activeBin } = await pool.getPositionsByUserAndLbPair(walletPubkey);
    const found = userPositions?.find((p) => p.publicKey.toBase58() === positionAddress);
    if (!found) return null;

    const pd = found.positionData;
    const xDec = pool.tokenX.decimal ?? 9;
    const yDec = pool.tokenY.decimal ?? 9;
    const feeX = (pd.feeX?.toNumber() ?? 0) / Math.pow(10, xDec);
    const feeY = (pd.feeY?.toNumber() ?? 0) / Math.pow(10, yDec);

    // Convert feeX → Y using active bin price, then Y (SOL) → USD
    const priceXperY = pool.fromPricePerLamport(Number(activeBin.price)); // X per 1 Y
    const feeXinY = priceXperY > 0 ? feeX / priceXperY : 0;
    const totalFeeInY = feeY + feeXinY;
    const solPrice = await getSolPrice();

    const activeId = activeBin.binId;
    const inRange = activeId >= pd.lowerBinId && activeId <= pd.upperBinId;

    return {
      lowerBinId:      pd.lowerBinId,
      upperBinId:      pd.upperBinId,
      poolActiveBinId: activeId,
      isOutOfRange:    !inRange,
      unclaimedFeeUsd: Math.round(totalFeeInY * solPrice * 100) / 100,
    };
  } catch (e) {
    log("sdk_fallback", `${positionAddress.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
}) {
  const activeStrategy = strategy || config.strategy.strategy;
  
  if (activeStrategy !== "bid_ask") {
    throw new Error("Only 'bid_ask' strategy is allowed.");
  }

  const activeBinsBelow = bins_below ?? config.strategy.binsBelow;
  const activeBinsAbove = 0; // always single-sided SOL, never above active bin

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: amount_x || 0,
        amount_y: amount_y || amount_sol || 0
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const { StrategyType } = await getDLMM();
  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  // Range calculation
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = activeBin.binId + activeBinsAbove;

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (!strategyType) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If amount_y is not provided but amount_sol is, use amount_sol (for backward compatibility)
  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // For X, we assume it's also 9 decimals for now, or we'd need to fetch mint decimals.
  // Most Meteora pools base tokens are 6 or 9. To be safe, we should fetch.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId}`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: wallet.publicKey,
      totalXAmount: totalXLamports,
      totalYAmount: totalYLamports,
      strategy: { maxBinId, minBinId, strategyType },
      slippage: 1000, // 10% slippage in bps
    });

    const txHash = await sendAndConfirmTransaction(getConnection(), tx, [
      wallet,
      newPosition,
    ]);

    log("deploy", `SUCCESS tx: ${txHash}`);

    _positionsCacheAt = 0; // invalidate cache after deploy
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      strategy: activeStrategy,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      tx: txHash,
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  try {
    const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const byAddress = {};
    for (const p of (data.positions || [])) {
      if (p.positionAddress) byAddress[p.positionAddress] = p;
    }
    return byAddress;
  } catch {
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  const wallet = getWallet();
  const walletAddress = wallet.publicKey.toString();
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];

    if (p) {
      const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY || 0);
      const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
      return {
        pnl_usd:           Math.round((p.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:           Math.round((p.pnlPctChange ?? 0) * 100) / 100,
        current_value_usd: Math.round(currentValueUsd * 100) / 100,
        unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
        all_time_fees_usd: Math.round((parseFloat(p.allTimeFees?.amountUsd || p.allTimeFees || 0)) * 100) / 100,
        in_range:    !p.isOutOfRange,
        lower_bin:   p.lowerBinId       ?? null,
        upper_bin:   p.upperBinId       ?? null,
        active_bin:  p.poolActiveBinId  ?? null,
        age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
        source: "api",
      };
    }

    // API returned nothing — fall back to SDK
    log("pnl", `API miss for ${position_address.slice(0, 8)} — trying SDK fallback`);
    const fb = await fetchPositionSdkFallback(pool_address, position_address, wallet.publicKey);
    if (!fb) return { error: "Position not found in PnL API or SDK" };

    const tracked = getTrackedPosition(position_address);
    return {
      pnl_usd:           0,
      pnl_pct:           0,
      current_value_usd: 0,
      unclaimed_fee_usd: fb.unclaimedFeeUsd,
      all_time_fees_usd: 0,
      in_range:    !fb.isOutOfRange,
      lower_bin:   fb.lowerBinId,
      upper_bin:   fb.upperBinId,
      active_bin:  fb.poolActiveBinId,
      age_minutes: tracked?.deployed_at
        ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
        : null,
      source: "sdk_fallback",
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  // If a scan is already in progress, wait for it instead of starting another
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    log("positions", "Scanning positions via getProgramAccounts...");
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    const walletPubkey = new PublicKey(walletAddress);

    // Owner field sits at offset 40 (8 discriminator + 32 lb_pair)
    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: walletPubkey.toBase58() } }],
    });

    log("positions", `Found ${accounts.length} position account(s)`);

    // Collect raw (pool, position) pairs
    const raw = [];
    for (const acc of accounts) {
      const positionAddress = acc.pubkey.toBase58();
      const lbPairKey = new PublicKey(acc.account.data.slice(8, 40)).toBase58();
      // Pair name: use tracked state pool_name if available
      const tracked = getTrackedPosition(positionAddress);
      const pair = tracked?.pool_name || lbPairKey.slice(0, 8);
      raw.push({
        position: positionAddress,
        pool: lbPairKey,
        pair,
        base_mint: null, // enriched from PnL API below
        lower_bin: null,
        upper_bin: null,
      });
    }

    // Enrich with DLMM PnL API for each unique pool in parallel
    const uniquePools = [...new Set(raw.map((p) => p.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, walletAddress)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    // SDK fallback for positions the API missed
    const sdkFallbacks = {};
    const missing = raw.filter((r) => !pnlByPool[r.pool]?.[r.position]);
    if (missing.length > 0) {
      log("positions", `PnL API missing ${missing.length} position(s) — using SDK fallback`);
      await Promise.all(missing.map(async (r) => {
        const fb = await fetchPositionSdkFallback(r.pool, r.position, walletPubkey);
        if (fb) sdkFallbacks[r.position] = fb;
      }));
    }

    const positions = raw.map((r) => {
      const p  = pnlByPool[r.pool]?.[r.position] || null;
      const fb = sdkFallbacks[r.position] || null;

      const inRange = p ? !p.isOutOfRange : (fb ? !fb.isOutOfRange : true);
      if (inRange) markInRange(r.position);
      else markOutOfRange(r.position);

      const lowerBin  = p?.lowerBinId      ?? fb?.lowerBinId      ?? r.lower_bin;
      const upperBin  = p?.upperBinId      ?? fb?.upperBinId      ?? r.upper_bin;
      const activeBin = p?.poolActiveBinId ?? fb?.poolActiveBinId ?? null;

      const unclaimedFees = p
        ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY || 0))
        : (fb?.unclaimedFeeUsd ?? 0);
      const totalValue    = p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0;
      const collectedFees = p ? parseFloat(p.allTimeFees?.amountUsd || p.allTimeFees || 0) : 0;
      const pnlUsd        = p?.pnlUsd       ?? 0;
      const pnlPct        = p?.pnlPctChange ?? 0;

      const tracked = getTrackedPosition(r.position);
      const ageFromPnlApi = p?.createdAt
        ? Math.floor((Date.now() - p.createdAt * 1000) / 60000)
        : null;
      const ageFromState = tracked?.deployed_at
        ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
        : null;
      const ageMinutes = Math.max(ageFromPnlApi ?? 0, ageFromState ?? 0) || null;

      return {
        position: r.position,
        pool: r.pool,
        pair: r.pair,
        base_mint: r.base_mint,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        in_range: inRange,
        unclaimed_fees_usd: Math.round(unclaimedFees * 100) / 100,
        total_value_usd: Math.round(totalValue * 100) / 100,
        collected_fees_usd: Math.round(collectedFees * 100) / 100,
        pnl_usd: Math.round(pnlUsd * 100) / 100,
        pnl_pct: Math.round(pnlPct * 100) / 100,
        age_minutes: ageMinutes,
        minutes_out_of_range: minutesOutOfRange(r.position),
      };
    });

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    syncOpenPositions(positions.map((p) => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `SDK scan failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const walletPubkey = new PublicKey(wallet_address);
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: walletPubkey.toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    // SDK fallback for anything the API missed
    const missing = raw.filter((r) => !pnlByPool[r.pool]?.[r.position]);
    const sdkFallbacks = {};
    if (missing.length > 0) {
      await Promise.all(missing.map(async (r) => {
        const fb = await fetchPositionSdkFallback(r.pool, r.position, walletPubkey);
        if (fb) sdkFallbacks[r.position] = fb;
      }));
    }

    const positions = raw.map((r) => {
      const p  = pnlByPool[r.pool]?.[r.position] || null;
      const fb = sdkFallbacks[r.position] || null;

      const inRange    = p ? !p.isOutOfRange : (fb ? !fb.isOutOfRange : null);
      const lowerBin   = p?.lowerBinId      ?? fb?.lowerBinId      ?? null;
      const upperBin   = p?.upperBinId      ?? fb?.upperBinId      ?? null;
      const activeBin  = p?.poolActiveBinId ?? fb?.poolActiveBinId ?? null;
      const unclaimedFees = p
        ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY || 0))
        : (fb?.unclaimedFeeUsd ?? 0);

      return {
        position:          r.position,
        pool:              r.pool,
        lower_bin:         lowerBin,
        upper_bin:         upperBin,
        active_bin:        activeBin,
        in_range:          inRange,
        unclaimed_fees_usd: Math.round(unclaimedFees * 100) / 100,
        total_value_usd:   Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:           Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:           Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:       p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
        source:            p ? "api" : (fb ? "sdk_fallback" : "unknown"),
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const pool = await getPool(poolAddress);

    const tx = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: new PublicKey(position_address),
    });

    const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
    log("claim", `SUCCESS tx: ${txHash}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, tx: txHash };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address }) {
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);

    // Remove all liquidity, claim fees, and close the position account in one call
    const removeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId: -887272,   // min possible bin — SDK will clamp to actual range
      toBinId: 887272,      // max possible bin
      bps: new (await import("bn.js")).default(10000), // 100% = 10000 bps
      shouldClaimAndClose: true,
    });

    const txHashes = [];
    for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    recordClose(position_address, "agent decision");

    // Record performance for learning
    const tracked = getTrackedPosition(position_address);
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      // Snapshot PnL from cache BEFORE invalidating — this was the last known state before close
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
      if (cachedPos) {
        pnlUsd        = cachedPos.pnl_usd   ?? 0;
        pnlPct        = cachedPos.pnl_pct   ?? 0;
        finalValueUsd = cachedPos.total_value_usd ?? 0;
        feesUsd       = (cachedPos.collected_fees_usd || 0) + (cachedPos.unclaimed_fees_usd || 0);
      }

      _positionsCacheAt = 0; // invalidate cache after snapshotting PnL
      const initialUsd = tracked.initial_value_usd || 0;

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility || null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: "agent decision",
      });

      return { success: true, position: position_address, pool: poolAddress, txs: txHashes, pnl_usd: pnlUsd, pnl_pct: pnlPct };
    }

    return { success: true, position: position_address, pool: poolAddress, txs: txHashes };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
