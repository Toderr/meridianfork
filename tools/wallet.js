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
import { notifyHeliusAllFailed, notifyHeliusRotated, notifyRpcLimit } from "../telegram.js";

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
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

// ─── Helius API Key Rotation ───────────────────────────────────
// Supports HELIUS_API_KEY, HELIUS_API_KEY_2, HELIUS_API_KEY_3 — switches on 429.
const _heliusKeys = [process.env.HELIUS_API_KEY, process.env.HELIUS_API_KEY_2, process.env.HELIUS_API_KEY_3].filter(Boolean);
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

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
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

  // Fallback: get SOL balance directly from RPC when Helius is unavailable.
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
      if (!e.message.includes("429")) throw e;
      // Rate limited — try all remaining keys before falling back to RPC.
      let recovered = false;
      const keysToTry = _heliusKeys.length > 1 ? _heliusKeys.length - 1 : 1;
      for (let attempt = 0; attempt < keysToTry; attempt++) {
        const prevIdx = _heliusKeyIndex;
        const rotated = rotateHeliusKey();
        const prevKey = prevIdx + 1;
        if (rotated) {
          log("wallet", `Helius rate limited (429) on key ${prevKey}, trying key ${_heliusKeyIndex + 1}...`);
        } else {
          log("wallet", `Helius rate limited (429), retrying in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
        }
        try {
          data = await fetchBalances();
          recovered = true;
          // Notify rotation success only when we had multiple keys to try.
          if (rotated) {
            notifyHeliusRotated({
              fromKey: prevKey,
              toKey: _heliusKeyIndex + 1,
              totalKeys: _heliusKeys.length,
            }).catch(() => {});
          }
          break;
        } catch (e2) {
          if (!e2.message.includes("429")) throw e2;
          log("wallet", `Key ${_heliusKeyIndex + 1} also rate limited: ${e2.message}`);
          if (attempt < keysToTry - 1) await new Promise(r => setTimeout(r, 500));
        }
      }
      if (!recovered) {
        notifyHeliusAllFailed({ totalKeys: _heliusKeys.length, fallback: "rpc" }).catch(() => {});
        notifyRpcLimit().catch(() => {});
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
    // Last resort: get SOL balance from RPC so screening isn't blocked by Helius outages.
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
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
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

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
