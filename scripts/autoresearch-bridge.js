/**
 * Autoresearch Bridge
 *
 * Connects Meridian's review cycle to autoresearch-dlmm.
 * Runs prepare.py + backtest.py for a target pool and returns structured results.
 *
 * Used by claude-lesson-updater.js to enrich the review prompt with backtest data.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const AUTORESEARCH_DIR = "/home/ubuntu/autoresearch-dlmm";
const UV_BIN = "/home/ubuntu/.local/bin/uv";
const LEARNING_REPORT = path.join(AUTORESEARCH_DIR, "experiments", "learning_report.md");

// ─── Pool selection ──────────────────────────────────────────────

/**
 * Pick the most-closed pool from recent performance records.
 * Tiebreaker: worst avg PnL (most to learn from).
 */
export function pickTargetPool(perfRecords) {
  if (!perfRecords || perfRecords.length === 0) return null;

  const poolMap = new Map();
  for (const r of perfRecords) {
    if (!r.pool) continue;
    if (!poolMap.has(r.pool)) {
      poolMap.set(r.pool, { poolAddress: r.pool, poolName: r.pool_name || r.pool, count: 0, totalPnl: 0, totalMinutes: 0 });
    }
    const entry = poolMap.get(r.pool);
    entry.count++;
    entry.totalPnl += r.pnl_pct ?? 0;
    entry.totalMinutes += r.minutes_held ?? 0;
  }

  if (poolMap.size === 0) return null;

  const sorted = [...poolMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (a.totalPnl / a.count) - (b.totalPnl / b.count); // worse PnL first
  });

  const best = sorted[0];
  return {
    poolAddress: best.poolAddress,
    poolName: best.poolName,
    avgMinutesHeld: best.count > 0 ? Math.round(best.totalMinutes / best.count) : 60,
  };
}

// ─── Horizon mapping ─────────────────────────────────────────────

export function mapHorizon(avgMinutesHeld) {
  if (avgMinutesHeld < 360) return "scalp";
  if (avgMinutesHeld < 2160) return "intraday";
  if (avgMinutesHeld < 10080) return "swing";
  return "7d_profile";
}

// ─── Subprocess runner ───────────────────────────────────────────

function runCommand(bin, args, opts = {}) {
  const { cwd = AUTORESEARCH_DIR, timeoutMs = 180_000, env } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Exit ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
    child.on("error", e => { clearTimeout(timer); reject(e); });
  });
}

// ─── Backtest output parser ──────────────────────────────────────

function parseBacktestOutput(stdout) {
  const lines = stdout.split("\n");
  const metrics = {};
  const benchmarkLines = [];
  let inBenchmark = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Parse key metrics from backtest output
    if (trimmed.includes("Primary Score") || trimmed.includes("primary_score")) {
      const m = trimmed.match(/([-\d.]+)/);
      if (m) metrics.primary_score = parseFloat(m[1]);
    }
    if (trimmed.includes("Net P&L") || trimmed.includes("net_pnl")) {
      const m = trimmed.match(/([-\d.]+)%/);
      if (m) metrics.net_pnl_pct = parseFloat(m[1]);
    }
    if (trimmed.includes("Win Rate") || trimmed.includes("win_rate")) {
      const m = trimmed.match(/([-\d.]+)%/);
      if (m) metrics.win_rate_pct = parseFloat(m[1]);
    }
    if (trimmed.includes("Time in Range") || trimmed.includes("time_in_range")) {
      const m = trimmed.match(/([-\d.]+)%/);
      if (m) metrics.time_in_range_pct = parseFloat(m[1]);
    }
    if (trimmed.includes("APR") || trimmed.includes("apr")) {
      const m = trimmed.match(/([-\d.]+)%/);
      if (m && !metrics.net_apr) metrics.net_apr = parseFloat(m[1]);
    }
    if (trimmed.includes("Rebalance") || trimmed.includes("rebalance")) {
      const m = trimmed.match(/(\d+)/);
      if (m && !metrics.rebalances) metrics.rebalances = parseInt(m[1]);
    }

    // Capture benchmark comparison section
    if (/benchmark|top lp/i.test(trimmed)) inBenchmark = true;
    if (inBenchmark) {
      benchmarkLines.push(trimmed);
      if (benchmarkLines.length > 15) inBenchmark = false;
    }
  }

  return {
    metrics,
    benchmarkComparison: benchmarkLines.join("\n") || null,
    rawOutput: stdout.slice(-2000), // last 2000 chars as fallback
  };
}

// ─── Main export ─────────────────────────────────────────────────

/**
 * Run prepare.py + backtest.py for a pool and return structured results.
 * Returns null on any failure (never throws).
 */
export async function runBacktestForPool(poolAddress, horizon) {
  try {
    // Check autoresearch dir exists
    if (!fs.existsSync(AUTORESEARCH_DIR)) return null;

    const env = { ...process.env, LPAGENT_API_KEYS: process.env.LPAGENT_API_KEY || "" };
    const hasLpKey = !!process.env.LPAGENT_API_KEY;

    // 1. Run prepare.py
    const prepareArgs = ["run", "prepare.py", "--pool", poolAddress, "--horizon", horizon];
    if (!hasLpKey) prepareArgs.push("--skip-lp");
    await runCommand(UV_BIN, prepareArgs, { env, timeoutMs: 120_000 });

    // 2. Run backtest.py (scalp uses shorter windows for short-lived meme pools)
    const backtestArgs = ["run", "backtest.py", "--pool", poolAddress, "--horizon", horizon, "--eval-mode", "rolling", "--split", "both"];
    if (horizon === "scalp") {
      backtestArgs.push("--window-hours", "1", "--start-every-hours", "0.5");
    }
    const backtestStdout = await runCommand(UV_BIN, backtestArgs, { env, timeoutMs: 120_000 });

    // 3. Parse results
    const parsed = parseBacktestOutput(backtestStdout);

    // 4. Read learning report if exists
    let learningReport = null;
    if (fs.existsSync(LEARNING_REPORT)) {
      try {
        const raw = fs.readFileSync(LEARNING_REPORT, "utf8");
        learningReport = raw.slice(0, 1500);
      } catch { /* ignore */ }
    }

    return {
      pool: poolAddress,
      poolName: null, // caller sets this
      horizon,
      metrics: parsed.metrics,
      benchmarkComparison: parsed.benchmarkComparison,
      rawOutput: parsed.rawOutput,
      learningReport,
    };
  } catch {
    return null;
  }
}
