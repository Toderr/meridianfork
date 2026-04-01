import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
// Dynamic import to avoid circular dependency (dlmm.js ↔ wallet.js)
async function _checkRpcHealth() {
  const { checkRpcHealth } = await import("./dlmm.js");
  return checkRpcHealth();
}

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_ULTRA_API = "https://api.jup.ag/ultra/v1";
const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

// ─── Helius API Key Rotation ───────────────────────────────────
// Supports HELIUS_API_KEY and HELIUS_API_KEY_2 — switches on 429.
const _heliusKeys = [process.env.HELIUS_API_KEY, process.env.HELIUS_API_KEY_2].filter(Boolean);
let _heliusKeyIndex = _heliusKeys.length > 1 ? 1 : 0; // start on key 2 to spread load

function getHeliusKey() {
  if (_heliusKeys.length === 0) return null;
  return _heliusKeys[_heliusKeyIndex % _heliusKeys.length];
}

function rotateHeliusKey() {
  if (_heliusKeys.length <= 1) return false;
  const prev = _heliusKeyIndex;
  _heliusKeyIndex = (_heliusKeyIndex + 1) % _heliusKeys.length;
  log("wallet", `Helius key rotated: key ${prev + 1} → key ${_heliusKeyIndex + 1}`);
  return true;
}

// ─── Swap Failure Tracking ─────────────────────────────────────
// Tracks tokens that repeatedly fail swaps to skip them temporarily.
const _swapFailures = new Map(); // mint → { count, lastFailedAt }

function isConnectionError(msg) {
  return (
    msg.includes("failed to fetch") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("503")
  );
}

/**
 * Internal: perform a single Ultra → quote-fallback swap attempt with a given slippageBps.
 * Returns the result object on success, throws on failure.
 */
async function _attemptSwap({ wallet, connection, input_mint, output_mint, amountStr, slippageBps }) {
  // ─── Get Ultra order ──────────────────────────────────────────
  const orderUrl =
    `${JUPITER_ULTRA_API}/order` +
    `?inputMint=${input_mint}` +
    `&outputMint=${output_mint}` +
    `&amount=${amountStr}` +
    `&taker=${wallet.publicKey.toString()}`;

  const orderRes = await fetch(orderUrl, {
    headers: { "x-api-key": JUPITER_API_KEY },
  });

  if (!orderRes.ok) {
    const body = await orderRes.text();
    if (orderRes.status === 500) {
      log("swap", `Ultra failed for ${input_mint}, falling back to regular swap API`);
      return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, slippageBps });
    }
    throw new Error(`Ultra order failed: ${orderRes.status} ${body}`);
  }

  const order = await orderRes.json();
  if (order.errorCode || order.errorMessage) {
    log("swap", `Ultra error for ${input_mint}, falling back to regular swap API`);
    return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, slippageBps });
  }

  const { transaction: unsignedTx, requestId } = order;

  // ─── Deserialize and sign ─────────────────────────────────
  const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
  tx.sign([wallet]);
  const signedTx = Buffer.from(tx.serialize()).toString("base64");

  // ─── Execute ───────────────────────────────────────────────
  const execRes = await fetch(`${JUPITER_ULTRA_API}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": JUPITER_API_KEY,
    },
    body: JSON.stringify({ signedTransaction: signedTx, requestId }),
  });
  if (!execRes.ok) {
    throw new Error(`Ultra execute failed: ${execRes.status} ${await execRes.text()}`);
  }

  const result = await execRes.json();
  if (result.status === "Failed") {
    throw new Error(`Swap failed on-chain: code=${result.code}`);
  }

  log("swap", `SUCCESS tx: ${result.signature}`);
  return {
    success: true,
    tx: result.signature,
    input_mint,
    output_mint,
    amount_in: result.inputAmountResult,
    amount_out: result.outputAmountResult,
  };
}

/**
 * Retry wrapper: try up to 3 times with increasing slippage.
 */
async function swapWithRetry(wallet, connection, input_mint, output_mint, amountStr, initialSlippageBps = 1000) {
  const slippageSteps = [
    initialSlippageBps,
    Math.round(initialSlippageBps * 1.5),
    initialSlippageBps * 2,
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await _attemptSwap({ wallet, connection, input_mint, output_mint, amountStr, slippageBps: slippageSteps[attempt] });
    } catch (e) {
      if (attempt === 2) throw e;
      log("swap", `Swap attempt ${attempt + 1} failed (${e.message}), retrying with higher slippage...`);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const heliusKey = getHeliusKey();
  if (!heliusKey) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  async function fetchBalances(key) {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${key || getHeliusKey()}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // Fallback: get SOL balance directly from RPC when Helius is unavailable
  async function fetchSolBalanceViaRpc() {
    const lamports = await getConnection().getBalance(new PublicKey(walletAddress));
    const sol = lamports / LAMPORTS_PER_SOL;
    log("wallet", `RPC fallback SOL balance: ${sol.toFixed(4)}`);
    return sol;
  }

  try {
    let data;
    try {
      data = await fetchBalances();
    } catch (e) {
      if (isConnectionError(e.message)) {
        log("wallet", `Connection error fetching balances, checking RPC health...`);
        await _checkRpcHealth();
        data = await fetchBalances();
      } else if (e.message.includes("429")) {
        // Rate limited — rotate key and retry, then fall back to RPC
        const rotated = rotateHeliusKey();
        if (rotated) {
          log("wallet", `Helius rate limited (429) on key ${((_heliusKeyIndex + _heliusKeys.length - 1) % _heliusKeys.length) + 1}, trying key ${_heliusKeyIndex + 1}...`);
          try {
            data = await fetchBalances();
          } catch (e2) {
            log("wallet", `Key ${_heliusKeyIndex + 1} also failed: ${e2.message}`);
            import("../telegram-journal.js").then(m => m.notifyRpcLimit()).catch(() => {});
            const solViaRpc = await fetchSolBalanceViaRpc();
            return {
              wallet: walletAddress,
              sol: Math.round(solViaRpc * 1e6) / 1e6,
              sol_price: 0,
              sol_usd: 0,
              usdc: 0,
              tokens: [],
              total_usd: 0,
              rpc_fallback: true,
            };
          }
        } else {
          // Only one key — retry after 2s
          log("wallet", `Helius rate limited (429), retrying in 2s...`);
          import("../telegram-journal.js").then(m => m.notifyRpcLimit()).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));
          try {
            data = await fetchBalances();
          } catch {
            const solViaRpc = await fetchSolBalanceViaRpc();
            return {
              wallet: walletAddress,
              sol: Math.round(solViaRpc * 1e6) / 1e6,
              sol_price: 0,
              sol_usd: 0,
              usdc: 0,
              tokens: [],
              total_usd: 0,
              rpc_fallback: true,
            };
          }
        }
      } else {
        throw e;
      }
    }
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    // Last resort: get SOL balance from RPC so screening isn't blocked by Helius outages
    try {
      const solViaRpc = await fetchSolBalanceViaRpc();
      return {
        wallet: walletAddress,
        sol: Math.round(solViaRpc * 1e6) / 1e6,
        sol_price: 0,
        sol_usd: 0,
        usdc: 0,
        tokens: [],
        total_usd: 0,
        rpc_fallback: true,
      };
    } catch {
      return {
        wallet: walletAddress,
        sol: 0,
        sol_price: 0,
        sol_usd: 0,
        usdc: 0,
        tokens: [],
        total_usd: 0,
        error: error.message,
      };
    }
  }
}

/**
 * Swap tokens via Jupiter Ultra API (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  // ─── Check if this token has failed too many times recently ──
  const failure = _swapFailures.get(input_mint);
  if (failure && failure.count >= 3) {
    const minutesSinceLastFail = (Date.now() - failure.lastFailedAt) / 60000;
    if (minutesSinceLastFail < 60) {
      log("swap", `Skipping swap for ${input_mint} — failed ${failure.count}x in last hour`);
      return { success: false, error: `Token skipped: ${failure.count} recent swap failures`, skipped: true };
    } else {
      // Reset stale failure record
      _swapFailures.delete(input_mint);
    }
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    let connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      try {
        const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
        decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
      } catch (e) {
        if (isConnectionError(e.message)) {
          log("swap", `RPC error fetching mint info, checking health...`);
          await _checkRpcHealth();
          connection = getConnection();
          const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
          decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
        } else {
          throw e;
        }
      }
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Swap with retry + adaptive slippage ──────────────────
    const result = await swapWithRetry(wallet, connection, input_mint, output_mint, amountStr, 1000);

    // ─── Clear failure count on success ───────────────────────
    _swapFailures.delete(input_mint);

    return result;
  } catch (error) {
    // ─── Track swap failure ───────────────────────────────────
    const prev = _swapFailures.get(input_mint) || { count: 0, lastFailedAt: 0 };
    _swapFailures.set(input_mint, { count: prev.count + 1, lastFailedAt: Date.now() });

    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sweep all dust tokens (USD value > 0 and < $0.10, excluding SOL) back to SOL via swap.
 */
export async function sweepDustTokens() {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const balances = await getWalletBalances({});
  let tokens = (balances.tokens || []).filter(t => t.mint !== SOL_MINT && t.balance > 0);

  // RPC fallback if Helius returned no tokens (rate-limited or unavailable)
  if (tokens.length === 0) {
    tokens = (await getAllTokenBalancesViaRpc()).filter(t => t.mint !== SOL_MINT);
  }

  const results = [];
  for (const token of tokens) {
    try {
      const result = await swapToken({ input_mint: token.mint, output_mint: "SOL", amount: token.balance });
      if (result?.success) {
        results.push({ mint: token.mint, symbol: token.symbol, usd_value: token.usd, success: true });
        log("dust_sweep", `Swapped ${token.symbol || token.mint.slice(0, 8)} ($${token.usd?.toFixed(2) ?? "?"}) → SOL`);
      }
    } catch (e) {
      log("dust_sweep_error", `Failed to sweep ${token.symbol || token.mint.slice(0, 8)}: ${e.message}`);
    }
  }
  return results;
}

/**
 * Sweep ALL non-SOL tokens (any USD value > 0) back to SOL via swap.
 * Used by /withdraw to convert everything to SOL after closing all positions.
 */
export async function sweepAllTokensToSol() {
  const balances = await getWalletBalances({});
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const tokens = (balances.tokens || []).filter(t => t.usd > 0 && t.mint !== SOL_MINT);
  const results = [];
  for (const token of tokens) {
    try {
      const result = await swapToken({ input_mint: token.mint, output_mint: "SOL", amount: token.balance });
      results.push({ mint: token.mint, symbol: token.symbol, usd_value: token.usd, success: result?.success !== false });
      log("sweep_all", `Swapped ${token.symbol || token.mint.slice(0, 8)} ($${token.usd.toFixed(2)}) → SOL`);
    } catch (e) {
      results.push({ mint: token.mint, symbol: token.symbol, usd_value: token.usd, success: false, error: e.message });
      log("sweep_all_error", `Failed to sweep ${token.symbol || token.mint.slice(0, 8)}: ${e.message}`);
    }
  }
  return results;
}

/**
 * Fetch a specific token's balance directly from RPC (bypasses Helius).
 * Returns { mint, symbol, balance, usd: null } or null if no balance.
 */
async function getTokenBalanceViaRpc(mint) {
  try {
    const wallet = getWallet();
    const connection = getConnection();
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
    let totalBalance = 0;
    for (const { account } of accounts.value) {
      const info = account.data?.parsed?.info;
      if (info) totalBalance += parseFloat(info.tokenAmount?.uiAmountString || "0");
    }
    if (totalBalance <= 0) return null;
    log("post_close_swap", `RPC balance for ${mint.slice(0, 8)}: ${totalBalance}`);
    return { mint, symbol: mint.slice(0, 8), balance: totalBalance, usd: null };
  } catch (e) {
    log("post_close_swap", `RPC token balance fetch failed for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch ALL SPL token balances directly from RPC (bypasses Helius).
 * Used as fallback when Helius is rate-limited to ensure no tokens are invisible.
 */
async function getAllTokenBalancesViaRpc() {
  try {
    const wallet = getWallet();
    const connection = getConnection();
    const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM });
    const tokens = [];
    for (const { account } of resp.value) {
      const info = account.data?.parsed?.info;
      if (!info) continue;
      const balance = parseFloat(info.tokenAmount?.uiAmountString || "0");
      if (balance <= 0) continue;
      tokens.push({ mint: info.mint, symbol: info.mint.slice(0, 8), balance, usd: null });
    }
    log("post_close_swap", `RPC fallback: found ${tokens.length} SPL token(s) with balance`);
    return tokens;
  } catch (e) {
    log("post_close_swap", `RPC getAllTokenBalances failed: ${e.message}`);
    return [];
  }
}

/**
 * Swap all non-SOL tokens to SOL after a position close.
 * Attempts to swap all tokens with balance > 0, then re-checks and retries
 * up to maxRounds times until no swappable tokens remain.
 */
export async function swapAllTokensAfterClose({ maxRounds = 3, targetMint = null } = {}) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const allResults = [];

  // Clear failure history for the target token so it gets a fresh chance
  if (targetMint) {
    _swapFailures.delete(targetMint);
  }

  for (let round = 1; round <= maxRounds; round++) {
    // Wait for RPC to reflect balances (first round waits longer)
    await new Promise(r => setTimeout(r, round === 1 ? 3000 : 5000));

    const balances = await getWalletBalances({});
    const allTokens = balances.tokens || [];

    // Swap ALL non-SOL tokens with any balance — dust included
    let tokens = allTokens.filter(t => {
      if (t.mint === SOL_MINT) return false;
      return t.balance > 0;
    });

    // If Helius returned no tokens (rate-limited / RPC fallback),
    // fetch ALL SPL token balances directly from RPC so nothing is invisible
    if (tokens.length === 0) {
      const rpcTokens = await getAllTokenBalancesViaRpc();
      tokens = rpcTokens.filter(t => {
        if (t.mint === SOL_MINT) return false;
        return !allResults.some(r => r.mint === t.mint && r.success);
      });
    }

    if (tokens.length === 0) {
      log("post_close_swap", `Round ${round}: no tokens to swap — all clear`);
      break;
    }

    log("post_close_swap", `Round ${round}: found ${tokens.length} token(s) to swap → SOL`);

    for (const token of tokens) {
      // Skip if already successfully swapped in a previous round
      if (allResults.some(r => r.mint === token.mint && r.success)) continue;

      try {
        const result = await swapToken({ input_mint: token.mint, output_mint: "SOL", amount: token.balance });
        const success = result?.success !== false && !result?.skipped;
        allResults.push({ mint: token.mint, symbol: token.symbol, usd: token.usd, success, round });
        if (success) {
          log("post_close_swap", `Swapped ${token.symbol || token.mint.slice(0, 8)} ($${token.usd?.toFixed(2) ?? "?"}) → SOL`);
        }
      } catch (e) {
        allResults.push({ mint: token.mint, symbol: token.symbol, usd: token.usd, success: false, error: e.message, round });
        log("post_close_swap_error", `Failed to swap ${token.symbol || token.mint.slice(0, 8)}: ${e.message}`);
      }
    }
  }

  return allResults;
}

async function swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, slippageBps = 300 }) {
  // ─── Get quote ─────────────────────────────────────────────
  const quoteRes = await fetch(
    `${JUPITER_QUOTE_API}/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}&slippageBps=${slippageBps}`,
    { headers: { "x-api-key": JUPITER_API_KEY } }
  );
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote error: ${quote.error}`);

  // ─── Get swap tx ───────────────────────────────────────────
  const swapRes = await fetch(`${JUPITER_QUOTE_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": JUPITER_API_KEY },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Swap tx failed: ${swapRes.status} ${await swapRes.text()}`);
  const { swapTransaction } = await swapRes.json();

  // ─── Sign and send ─────────────────────────────────────────
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  let txHash;
  try {
    txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(txHash, "confirmed");
  } catch (e) {
    if (isConnectionError(e.message)) {
      log("swap", `RPC error sending transaction, checking health...`);
      await _checkRpcHealth();
      const freshConn = getConnection();
      txHash = await freshConn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await freshConn.confirmTransaction(txHash, "confirmed");
    } else {
      throw e;
    }
  }

  log("swap", `SUCCESS (fallback) tx: ${txHash}`);
  return { success: true, tx: txHash, input_mint, output_mint };
}
