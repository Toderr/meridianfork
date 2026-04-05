/**
 * Knowledge Wiki — auto-compiled markdown knowledge base.
 *
 * Inspired by Karpathy's "raw data → LLM-compiled wiki" concept,
 * but deterministic (no LLM needed per update). Compiles trading
 * journal + lessons + snapshots into structured markdown pages:
 *
 *   wiki/tokens/    — per-token trade history & insights
 *   wiki/strategies/ — strategy playbook with performance data
 *   wiki/market/    — market regime detection & condition log
 *   wiki/index.md   — master index
 *
 * Pages auto-update after every close and every snapshot cycle.
 * Agent can query pages via the query_wiki tool.
 */

import fs from "fs";
import path from "path";
import { log } from "./logger.js";

const WIKI_DIR = "./wiki";
const TOKENS_DIR = path.join(WIKI_DIR, "tokens");
const STRATEGIES_DIR = path.join(WIKI_DIR, "strategies");
const MARKET_DIR = path.join(WIKI_DIR, "market");

const JOURNAL_FILE = "./journal.json";
const LESSONS_FILE = "./lessons.json";
const STRATEGY_FILE = "./strategy-library.json";

// ─── Helpers ────────────────────────────────────────────────────

function ensureDirs() {
  for (const dir of [WIKI_DIR, TOKENS_DIR, STRATEGIES_DIR, MARKET_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

function formatPct(v) {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function formatUsd(v) {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
}

function formatMins(m) {
  if (m == null) return "N/A";
  if (m < 60) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function extractTokenName(poolName) {
  // "Downald-SOL" → "Downald", "BURNIE-SOL" → "BURNIE"
  if (!poolName) return "unknown";
  const parts = poolName.split("-");
  if (parts.length >= 2 && parts[parts.length - 1] === "SOL") {
    return parts.slice(0, -1).join("-");
  }
  return parts[0];
}

// ─── Token Pages ────────────────────────────────────────────────

/**
 * Compile a markdown page for a specific token from all journal closes.
 */
function compileTokenPage(tokenName, closes, lessons) {
  const trades = closes.length;
  const wins = closes.filter(c => c.pnl_pct > 0).length;
  const losses = closes.filter(c => c.pnl_pct <= 0).length;
  const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : "0";
  const totalPnlUsd = closes.reduce((s, c) => s + (c.pnl_usd || 0), 0);
  const totalFees = closes.reduce((s, c) => s + (c.fees_earned_usd || 0), 0);
  const avgPnlPct = trades > 0 ? closes.reduce((s, c) => s + (c.pnl_pct || 0), 0) / trades : 0;
  const avgHoldMin = trades > 0 ? closes.reduce((s, c) => s + (c.minutes_held || 0), 0) / trades : 0;
  const avgRangeEff = trades > 0 ? closes.reduce((s, c) => s + (c.range_efficiency || 0), 0) / trades : 0;

  // Best and worst trades
  const sorted = [...closes].sort((a, b) => (b.pnl_pct || 0) - (a.pnl_pct || 0));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Strategy breakdown
  const byStrategy = {};
  for (const c of closes) {
    const s = c.strategy || "unknown";
    if (!byStrategy[s]) byStrategy[s] = { trades: 0, wins: 0, totalPnl: 0 };
    byStrategy[s].trades++;
    if (c.pnl_pct > 0) byStrategy[s].wins++;
    byStrategy[s].totalPnl += c.pnl_pct || 0;
  }

  // Close reasons breakdown
  const byReason = {};
  for (const c of closes) {
    const reason = (c.close_reason || "unknown").split(":")[0].trim();
    byReason[reason] = (byReason[reason] || 0) + 1;
  }

  // Relevant lessons
  const tokenLessons = lessons.filter(l =>
    l.rule && l.rule.toLowerCase().includes(tokenName.toLowerCase())
  );

  // Trend: last 5 trades
  const recent = closes.slice(-5);
  const recentAvgPnl = recent.length > 0
    ? recent.reduce((s, c) => s + (c.pnl_pct || 0), 0) / recent.length
    : 0;

  let md = `# ${tokenName}\n\n`;
  md += `> Auto-compiled from ${trades} trade(s). Last updated: ${new Date().toISOString().split("T")[0]}\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Trades | ${trades} (${wins}W / ${losses}L) |\n`;
  md += `| Win Rate | ${winRate}% |\n`;
  md += `| Total PnL | ${formatUsd(totalPnlUsd)} |\n`;
  md += `| Total Fees | $${totalFees.toFixed(2)} |\n`;
  md += `| Avg PnL | ${formatPct(avgPnlPct)} |\n`;
  md += `| Avg Hold Time | ${formatMins(avgHoldMin)} |\n`;
  md += `| Avg Range Efficiency | ${avgRangeEff.toFixed(1)}% |\n`;
  md += `| Recent Trend (last 5) | ${formatPct(recentAvgPnl)} avg |\n`;

  md += `\n## Strategy Performance\n\n`;
  md += `| Strategy | Trades | Win Rate | Avg PnL |\n|----------|--------|----------|---------|\n`;
  for (const [strat, data] of Object.entries(byStrategy)) {
    const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(0) : "0";
    const ap = data.trades > 0 ? (data.totalPnl / data.trades).toFixed(2) : "0";
    md += `| ${strat} | ${data.trades} | ${wr}% | ${formatPct(parseFloat(ap))} |\n`;
  }

  md += `\n## Close Reasons\n\n`;
  for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    md += `- **${reason}**: ${count}x\n`;
  }

  if (best) {
    md += `\n## Notable Trades\n\n`;
    md += `- **Best**: ${formatPct(best.pnl_pct)} (${formatUsd(best.pnl_usd)}) — ${best.strategy}, held ${formatMins(best.minutes_held)}, ${best.close_reason || ""}\n`;
    if (worst && worst !== best) {
      md += `- **Worst**: ${formatPct(worst.pnl_pct)} (${formatUsd(worst.pnl_usd)}) — ${worst.strategy}, held ${formatMins(worst.minutes_held)}, ${worst.close_reason || ""}\n`;
    }
  }

  if (tokenLessons.length > 0) {
    md += `\n## Lessons Learned\n\n`;
    for (const l of tokenLessons.slice(0, 5)) {
      md += `- ${l.rule}\n`;
    }
  }

  // Recent trade log (last 10)
  const recentTrades = closes.slice(-10);
  if (recentTrades.length > 0) {
    md += `\n## Recent Trades\n\n`;
    md += `| Date | Strategy | PnL | Fees | Hold | Reason |\n|------|----------|-----|------|------|--------|\n`;
    for (const t of recentTrades.reverse()) {
      const date = t.timestamp?.split("T")[0] || "?";
      md += `| ${date} | ${t.strategy || "?"} | ${formatPct(t.pnl_pct)} | $${(t.fees_earned_usd || 0).toFixed(2)} | ${formatMins(t.minutes_held)} | ${(t.close_reason || "").slice(0, 40)} |\n`;
    }
  }

  return md;
}

// ─── Strategy Playbook ──────────────────────────────────────────

/**
 * Compile a strategy playbook page from performance data + strategy library.
 */
function compileStrategyPage(strategyId, strategyDef, perfRecords, lessons) {
  const trades = perfRecords.length;
  if (trades === 0 && !strategyDef) return null;

  const wins = perfRecords.filter(p => p.pnl_pct > 0).length;
  const losses = perfRecords.filter(p => p.pnl_pct <= 0).length;
  const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : "0";
  const avgPnlPct = trades > 0 ? perfRecords.reduce((s, p) => s + (p.pnl_pct || 0), 0) / trades : 0;
  const totalPnlUsd = perfRecords.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  const totalFees = perfRecords.reduce((s, p) => s + (p.fees_earned_usd || 0), 0);
  const avgHoldMin = trades > 0 ? perfRecords.reduce((s, p) => s + (p.minutes_held || 0), 0) / trades : 0;
  const avgRangeEff = trades > 0 ? perfRecords.reduce((s, p) => s + (p.range_efficiency || 0), 0) / trades : 0;

  // By volatility bucket
  const volBuckets = { low: [], med: [], high: [], extreme: [], unknown: [] };
  for (const p of perfRecords) {
    const v = p.volatility;
    if (v == null) volBuckets.unknown.push(p);
    else if (v < 2) volBuckets.low.push(p);
    else if (v < 5) volBuckets.med.push(p);
    else if (v < 10) volBuckets.high.push(p);
    else volBuckets.extreme.push(p);
  }

  // By bin_step
  const byBinStep = {};
  for (const p of perfRecords) {
    const bs = p.bin_step || "?";
    if (!byBinStep[bs]) byBinStep[bs] = { trades: 0, wins: 0, totalPnl: 0 };
    byBinStep[bs].trades++;
    if (p.pnl_pct > 0) byBinStep[bs].wins++;
    byBinStep[bs].totalPnl += p.pnl_pct || 0;
  }

  // Strategy-relevant lessons
  const stratLessons = lessons.filter(l =>
    l.rule && (
      l.rule.toLowerCase().includes(strategyId.toLowerCase()) ||
      (strategyDef?.name && l.rule.toLowerCase().includes(strategyDef.name.toLowerCase()))
    )
  );

  // Comparative lessons
  const compLessons = lessons.filter(l =>
    l.outcome === "comparative" && l.rule && l.rule.toLowerCase().includes(strategyId.toLowerCase())
  );

  let md = `# Strategy: ${strategyDef?.name || strategyId}\n\n`;
  md += `> Auto-compiled from ${trades} trade(s). Last updated: ${new Date().toISOString().split("T")[0]}\n\n`;

  // Strategy definition
  if (strategyDef) {
    md += `## Definition\n\n`;
    md += `- **Type**: ${strategyDef.lp_strategy || "any"}\n`;
    md += `- **Best For**: ${strategyDef.best_for || "N/A"}\n`;
    if (strategyDef.token_criteria?.notes) md += `- **Token Criteria**: ${strategyDef.token_criteria.notes}\n`;
    if (strategyDef.entry?.condition) md += `- **Entry**: ${strategyDef.entry.condition}\n`;
    if (strategyDef.entry?.notes) md += `- **Entry Notes**: ${strategyDef.entry.notes}\n`;
    if (strategyDef.range?.notes) md += `- **Range**: ${strategyDef.range.notes}\n`;
    if (strategyDef.exit?.take_profit_pct) md += `- **TP**: ${strategyDef.exit.take_profit_pct}%\n`;
    if (strategyDef.exit?.notes) md += `- **Exit Notes**: ${strategyDef.exit.notes}\n`;
  }

  if (trades > 0) {
    md += `\n## Performance Summary\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Trades | ${trades} (${wins}W / ${losses}L) |\n`;
    md += `| Win Rate | ${winRate}% |\n`;
    md += `| Avg PnL | ${formatPct(avgPnlPct)} |\n`;
    md += `| Total PnL | ${formatUsd(totalPnlUsd)} |\n`;
    md += `| Total Fees | $${totalFees.toFixed(2)} |\n`;
    md += `| Avg Hold | ${formatMins(avgHoldMin)} |\n`;
    md += `| Avg Range Efficiency | ${avgRangeEff.toFixed(1)}% |\n`;

    // Volatility breakdown
    md += `\n## Performance by Volatility\n\n`;
    md += `| Volatility | Trades | Win Rate | Avg PnL |\n|------------|--------|----------|---------|\n`;
    for (const [bucket, records] of Object.entries(volBuckets)) {
      if (records.length === 0) continue;
      const bw = records.filter(r => r.pnl_pct > 0).length;
      const bwr = ((bw / records.length) * 100).toFixed(0);
      const bap = (records.reduce((s, r) => s + (r.pnl_pct || 0), 0) / records.length).toFixed(2);
      md += `| ${bucket} | ${records.length} | ${bwr}% | ${formatPct(parseFloat(bap))} |\n`;
    }

    // Bin step breakdown
    if (Object.keys(byBinStep).length > 1) {
      md += `\n## Performance by Bin Step\n\n`;
      md += `| Bin Step | Trades | Win Rate | Avg PnL |\n|----------|--------|----------|---------|\n`;
      for (const [bs, data] of Object.entries(byBinStep).sort((a, b) => b[1].trades - a[1].trades)) {
        const wr = ((data.wins / data.trades) * 100).toFixed(0);
        const ap = (data.totalPnl / data.trades).toFixed(2);
        md += `| ${bs} | ${data.trades} | ${wr}% | ${formatPct(parseFloat(ap))} |\n`;
      }
    }
  }

  // When to use / when to avoid
  if (trades >= 5) {
    md += `\n## Insights\n\n`;
    // Best volatility bucket
    let bestBucket = null, bestAvg = -Infinity;
    for (const [bucket, records] of Object.entries(volBuckets)) {
      if (records.length < 3) continue;
      const avg = records.reduce((s, r) => s + (r.pnl_pct || 0), 0) / records.length;
      if (avg > bestAvg) { bestAvg = avg; bestBucket = bucket; }
    }
    if (bestBucket) {
      md += `- **Best in**: ${bestBucket} volatility (${formatPct(bestAvg)} avg PnL, ${volBuckets[bestBucket].length} trades)\n`;
    }
    // Worst bucket
    let worstBucket = null, worstAvg = Infinity;
    for (const [bucket, records] of Object.entries(volBuckets)) {
      if (records.length < 3) continue;
      const avg = records.reduce((s, r) => s + (r.pnl_pct || 0), 0) / records.length;
      if (avg < worstAvg) { worstAvg = avg; worstBucket = bucket; }
    }
    if (worstBucket && worstBucket !== bestBucket) {
      md += `- **Worst in**: ${worstBucket} volatility (${formatPct(worstAvg)} avg PnL, ${volBuckets[worstBucket].length} trades)\n`;
    }
  }

  if (compLessons.length > 0) {
    md += `\n## Comparative Lessons\n\n`;
    for (const l of compLessons.slice(0, 5)) {
      md += `- ${l.rule}\n`;
    }
  }

  if (stratLessons.length > 0) {
    md += `\n## Related Lessons\n\n`;
    for (const l of stratLessons.slice(0, 5)) {
      md += `- [${l.outcome || "info"}] ${l.rule}\n`;
    }
  }

  return md;
}

// ─── Market Condition Log ───────────────────────────────────────

/**
 * Compile market condition page from recent snapshots + journal data.
 * Detects regimes: trending up, trending down, ranging, volatile.
 */
function compileMarketPage(snapshots, recentCloses) {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  let md = `# Market Conditions\n\n`;
  md += `> Auto-compiled. Last updated: ${now.toISOString()}\n\n`;

  // Current regime from snapshots
  if (snapshots.length >= 2) {
    const latest = snapshots[snapshots.length - 1];
    const earliest = snapshots[0];

    md += `## Current Snapshot\n\n`;
    md += `- **Positions**: ${latest.positions || 0}\n`;
    md += `- **Portfolio Value**: $${(latest.total_value_usd || 0).toFixed(2)}\n`;
    md += `- **Total PnL**: ${formatUsd(latest.total_pnl_usd)}\n`;
    md += `- **Unclaimed Fees**: $${(latest.total_unclaimed_fees_usd || 0).toFixed(2)}\n`;

    // Trend detection from snapshots
    const pnlValues = snapshots.map(s => s.total_pnl_usd || 0);
    const firstHalf = pnlValues.slice(0, Math.floor(pnlValues.length / 2));
    const secondHalf = pnlValues.slice(Math.floor(pnlValues.length / 2));
    const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
    const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;
    const pnlDrift = secondAvg - firstAvg;

    // Volatility of PnL swings
    const pnlStdDev = pnlValues.length > 1 ? Math.sqrt(
      pnlValues.reduce((s, v) => s + Math.pow(v - (pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length), 2), 0) / pnlValues.length
    ) : 0;

    let regime = "unknown";
    if (pnlDrift > 2 && pnlStdDev < 5) regime = "trending_up";
    else if (pnlDrift < -2 && pnlStdDev < 5) regime = "trending_down";
    else if (pnlStdDev > 5) regime = "volatile";
    else regime = "ranging";

    const regimeLabel = {
      trending_up: "Trending Up — portfolio PnL improving",
      trending_down: "Trending Down — portfolio PnL declining",
      volatile: "Volatile — large PnL swings",
      ranging: "Ranging — stable PnL, sideways market",
    };

    md += `\n## Detected Regime\n\n`;
    md += `**${regimeLabel[regime] || regime}**\n\n`;
    md += `- PnL Drift: ${formatUsd(pnlDrift)} (2nd half avg vs 1st half)\n`;
    md += `- PnL StdDev: $${pnlStdDev.toFixed(2)}\n`;
    md += `- Snapshots analyzed: ${snapshots.length}\n`;
    md += `- Window: ${earliest.timestamp} → ${latest.timestamp}\n`;
  }

  // Recent trade performance as market signal
  if (recentCloses.length > 0) {
    const last24h = recentCloses.filter(c => {
      const ts = new Date(c.timestamp || c.recorded_at);
      return (now - ts) < 24 * 60 * 60 * 1000;
    });
    const last6h = recentCloses.filter(c => {
      const ts = new Date(c.timestamp || c.recorded_at);
      return (now - ts) < 6 * 60 * 60 * 1000;
    });

    md += `\n## Trade Performance Signals\n\n`;

    if (last6h.length > 0) {
      const wr6 = last6h.filter(c => c.pnl_pct > 0).length;
      const avg6 = last6h.reduce((s, c) => s + (c.pnl_pct || 0), 0) / last6h.length;
      md += `### Last 6 Hours\n`;
      md += `- Trades: ${last6h.length} (${wr6} wins)\n`;
      md += `- Avg PnL: ${formatPct(avg6)}\n`;

      // Dominant close reasons
      const reasons6 = {};
      for (const c of last6h) {
        const r = (c.close_reason || "unknown").split(":")[0].trim();
        reasons6[r] = (reasons6[r] || 0) + 1;
      }
      const topReason = Object.entries(reasons6).sort((a, b) => b[1] - a[1])[0];
      if (topReason) md += `- Top close reason: ${topReason[0]} (${topReason[1]}x)\n`;
    }

    if (last24h.length > 0) {
      const wr24 = last24h.filter(c => c.pnl_pct > 0).length;
      const avg24 = last24h.reduce((s, c) => s + (c.pnl_pct || 0), 0) / last24h.length;
      md += `\n### Last 24 Hours\n`;
      md += `- Trades: ${last24h.length} (${wr24} wins)\n`;
      md += `- Avg PnL: ${formatPct(avg24)}\n`;

      // Strategy performance in last 24h
      const byStrat24 = {};
      for (const c of last24h) {
        const s = c.strategy || "unknown";
        if (!byStrat24[s]) byStrat24[s] = { trades: 0, wins: 0, totalPnl: 0 };
        byStrat24[s].trades++;
        if (c.pnl_pct > 0) byStrat24[s].wins++;
        byStrat24[s].totalPnl += c.pnl_pct || 0;
      }
      md += `\n| Strategy | Trades | Win Rate | Avg PnL |\n|----------|--------|----------|---------|\n`;
      for (const [s, d] of Object.entries(byStrat24).sort((a, b) => b[1].trades - a[1].trades)) {
        md += `| ${s} | ${d.trades} | ${((d.wins / d.trades) * 100).toFixed(0)}% | ${formatPct(d.totalPnl / d.trades)} |\n`;
      }
    }

    // Win rate trend: compare last 20 vs previous 20
    if (recentCloses.length >= 20) {
      const last20 = recentCloses.slice(-20);
      const prev20 = recentCloses.slice(-40, -20);
      if (prev20.length >= 10) {
        const wr_last = (last20.filter(c => c.pnl_pct > 0).length / last20.length * 100).toFixed(0);
        const wr_prev = (prev20.filter(c => c.pnl_pct > 0).length / prev20.length * 100).toFixed(0);
        const avgPnl_last = last20.reduce((s, c) => s + (c.pnl_pct || 0), 0) / last20.length;
        const avgPnl_prev = prev20.reduce((s, c) => s + (c.pnl_pct || 0), 0) / prev20.length;

        md += `\n### Trend Comparison\n\n`;
        md += `| Period | Win Rate | Avg PnL |\n|--------|----------|---------|\n`;
        md += `| Last 20 trades | ${wr_last}% | ${formatPct(avgPnl_last)} |\n`;
        md += `| Previous 20 | ${wr_prev}% | ${formatPct(avgPnl_prev)} |\n`;

        const improving = avgPnl_last > avgPnl_prev;
        md += `\n**Trend**: ${improving ? "Improving" : "Declining"} (${formatPct(avgPnl_last - avgPnl_prev)} shift)\n`;
      }
    }
  }

  // Regime history log — append-only
  const historyFile = path.join(MARKET_DIR, "regime-history.jsonl");
  if (snapshots.length >= 2) {
    const latest = snapshots[snapshots.length - 1];
    const pnlValues = snapshots.map(s => s.total_pnl_usd || 0);
    const firstHalf = pnlValues.slice(0, Math.floor(pnlValues.length / 2));
    const secondHalf = pnlValues.slice(Math.floor(pnlValues.length / 2));
    const pnlDrift = (secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length) -
                     (firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length);
    const pnlStdDev = Math.sqrt(
      pnlValues.reduce((s, v) => s + Math.pow(v - pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length, 2), 0) / pnlValues.length
    );
    let regime = "ranging";
    if (pnlDrift > 2 && pnlStdDev < 5) regime = "trending_up";
    else if (pnlDrift < -2 && pnlStdDev < 5) regime = "trending_down";
    else if (pnlStdDev > 5) regime = "volatile";

    const entry = {
      timestamp: new Date().toISOString(),
      regime,
      pnl_drift: Math.round(pnlDrift * 100) / 100,
      pnl_stddev: Math.round(pnlStdDev * 100) / 100,
      positions: latest.positions || 0,
      portfolio_usd: latest.total_value_usd || 0,
    };
    try { fs.appendFileSync(historyFile, JSON.stringify(entry) + "\n"); } catch {}
  }

  // Show recent regime history
  if (fs.existsSync(historyFile)) {
    try {
      const lines = fs.readFileSync(historyFile, "utf8").trim().split("\n").slice(-20);
      const history = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (history.length > 0) {
        md += `\n## Regime History (last ${history.length} entries)\n\n`;
        md += `| Time | Regime | PnL Drift | StdDev | Positions |\n|------|--------|-----------|--------|-----------|\n`;
        for (const h of history.slice(-10)) {
          const t = h.timestamp?.split("T")[1]?.slice(0, 5) || "?";
          md += `| ${t} | ${h.regime} | ${formatUsd(h.pnl_drift)} | $${h.pnl_stddev?.toFixed(2) || "?"} | ${h.positions} |\n`;
        }
      }
    } catch {}
  }

  return md;
}

// ─── Strategy Comparison (master playbook index) ────────────────

function compileStrategyIndex(allStrategyPages) {
  let md = `# Strategy Playbook\n\n`;
  md += `> Compiled from all trading history. Last updated: ${new Date().toISOString().split("T")[0]}\n\n`;
  md += `| Strategy | Trades | Win Rate | Avg PnL | Total PnL | Best Condition |\n`;
  md += `|----------|--------|----------|---------|-----------|----------------|\n`;

  for (const { id, trades, winRate, avgPnl, totalPnl, bestCondition } of allStrategyPages) {
    md += `| [${id}](${sanitizeFilename(id)}.md) | ${trades} | ${winRate}% | ${formatPct(avgPnl)} | ${formatUsd(totalPnl)} | ${bestCondition} |\n`;
  }

  md += `\nSee individual strategy pages for detailed breakdown by volatility, bin step, and related lessons.\n`;
  return md;
}

// ─── Wiki Index ─────────────────────────────────────────────────

function compileIndex(tokenSummaries, strategySummaries, regime) {
  let md = `# Trading Knowledge Wiki\n\n`;
  md += `> Auto-compiled from trading data. Last updated: ${new Date().toISOString()}\n\n`;

  if (regime) {
    md += `## Current Market: ${regime}\n\n`;
  }

  md += `## Strategies (${strategySummaries.length})\n\n`;
  for (const s of strategySummaries.sort((a, b) => b.trades - a.trades)) {
    md += `- [${s.id}](strategies/${sanitizeFilename(s.id)}.md) — ${s.trades} trades, ${s.winRate}% WR, ${formatPct(s.avgPnl)} avg\n`;
  }

  md += `\n## Tokens (${tokenSummaries.length} traded)\n\n`;
  // Top 20 by trade count
  const topTokens = tokenSummaries.sort((a, b) => b.trades - a.trades).slice(0, 30);
  for (const t of topTokens) {
    md += `- [${t.name}](tokens/${sanitizeFilename(t.name)}.md) — ${t.trades} trades, ${t.winRate}% WR, ${formatPct(t.avgPnl)}\n`;
  }
  if (tokenSummaries.length > 30) {
    md += `- ... and ${tokenSummaries.length - 30} more tokens\n`;
  }

  md += `\n## Market Conditions\n\n`;
  md += `- [Current Conditions](market/conditions.md)\n`;

  return md;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Full wiki rebuild from all data sources.
 * Called on startup or manually via tool.
 */
export function compileFullWiki() {
  try {
    ensureDirs();
    const journal = loadJson(JOURNAL_FILE) || { entries: [] };
    const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
    const stratLib = loadJson(STRATEGY_FILE) || { active: null, strategies: {} };

    const closes = journal.entries.filter(e => e.type === "close");
    const perfRecords = lessonsData.performance || [];
    const lessons = lessonsData.lessons || [];

    // ─── Token pages ────
    const tokenGroups = {};
    for (const c of closes) {
      const token = extractTokenName(c.pool_name);
      if (!tokenGroups[token]) tokenGroups[token] = [];
      tokenGroups[token].push(c);
    }

    const tokenSummaries = [];
    for (const [token, tokenCloses] of Object.entries(tokenGroups)) {
      const md = compileTokenPage(token, tokenCloses, lessons);
      atomicWrite(path.join(TOKENS_DIR, `${sanitizeFilename(token)}.md`), md);
      const wins = tokenCloses.filter(c => c.pnl_pct > 0).length;
      tokenSummaries.push({
        name: token,
        trades: tokenCloses.length,
        winRate: tokenCloses.length > 0 ? ((wins / tokenCloses.length) * 100).toFixed(0) : "0",
        avgPnl: tokenCloses.length > 0 ? tokenCloses.reduce((s, c) => s + (c.pnl_pct || 0), 0) / tokenCloses.length : 0,
      });
    }

    // ─── Strategy pages ────
    const stratGroups = {};
    for (const p of perfRecords) {
      const s = p.strategy || "unknown";
      if (!stratGroups[s]) stratGroups[s] = [];
      stratGroups[s].push(p);
    }
    // Include strategies from library even if no trades
    for (const id of Object.keys(stratLib.strategies || {})) {
      if (!stratGroups[id]) stratGroups[id] = [];
    }

    const strategySummaries = [];
    for (const [stratId, records] of Object.entries(stratGroups)) {
      const stratDef = stratLib.strategies?.[stratId] || null;
      const md = compileStrategyPage(stratId, stratDef, records, lessons);
      if (md) {
        atomicWrite(path.join(STRATEGIES_DIR, `${sanitizeFilename(stratId)}.md`), md);
      }
      const wins = records.filter(r => r.pnl_pct > 0).length;
      const avgPnl = records.length > 0 ? records.reduce((s, r) => s + (r.pnl_pct || 0), 0) / records.length : 0;

      // Best condition
      let bestCondition = "N/A";
      if (records.length >= 5) {
        const volBuckets = { low: [], med: [], high: [], unknown: [] };
        for (const r of records) {
          const v = r.volatility;
          if (v == null) volBuckets.unknown.push(r);
          else if (v < 2) volBuckets.low.push(r);
          else if (v < 5) volBuckets.med.push(r);
          else volBuckets.high.push(r);
        }
        let bestAvg = -Infinity;
        for (const [b, recs] of Object.entries(volBuckets)) {
          if (recs.length < 2) continue;
          const a = recs.reduce((s, r) => s + (r.pnl_pct || 0), 0) / recs.length;
          if (a > bestAvg) { bestAvg = a; bestCondition = `${b} vol`; }
        }
      }

      strategySummaries.push({
        id: stratId,
        trades: records.length,
        winRate: records.length > 0 ? ((wins / records.length) * 100).toFixed(0) : "0",
        avgPnl,
        totalPnl: records.reduce((s, r) => s + (r.pnl_usd || 0), 0),
        bestCondition,
      });
    }

    // Strategy index
    const stratIndex = compileStrategyIndex(strategySummaries);
    atomicWrite(path.join(STRATEGIES_DIR, "index.md"), stratIndex);

    // ─── Market page ────
    const snapshots = loadTodaySnapshots();
    const recentCloses = closes.slice(-50);
    const marketMd = compileMarketPage(snapshots, recentCloses);
    atomicWrite(path.join(MARKET_DIR, "conditions.md"), marketMd);

    // Detect current regime for index
    let regime = "unknown";
    if (snapshots.length >= 2) {
      const pnlValues = snapshots.map(s => s.total_pnl_usd || 0);
      const half = Math.floor(pnlValues.length / 2);
      const drift = (pnlValues.slice(half).reduce((a, b) => a + b, 0) / (pnlValues.length - half)) -
                    (pnlValues.slice(0, half).reduce((a, b) => a + b, 0) / half);
      const stddev = Math.sqrt(pnlValues.reduce((s, v) => s + Math.pow(v - pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length, 2), 0) / pnlValues.length);
      if (drift > 2 && stddev < 5) regime = "Trending Up";
      else if (drift < -2 && stddev < 5) regime = "Trending Down";
      else if (stddev > 5) regime = "Volatile";
      else regime = "Ranging";
    }

    // ─── Master index ────
    const indexMd = compileIndex(tokenSummaries, strategySummaries, regime);
    atomicWrite(path.join(WIKI_DIR, "index.md"), indexMd);

    log("wiki", `Full wiki compiled: ${tokenSummaries.length} tokens, ${strategySummaries.length} strategies`);
    return { tokens: tokenSummaries.length, strategies: strategySummaries.length, regime };
  } catch (err) {
    log("wiki_error", `Wiki compilation failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Incremental update after a position close.
 * Only recompiles the affected token page, strategy page, and market page.
 */
export function updateAfterClose(closeData) {
  try {
    ensureDirs();
    const journal = loadJson(JOURNAL_FILE) || { entries: [] };
    const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
    const stratLib = loadJson(STRATEGY_FILE) || { active: null, strategies: {} };

    const closes = journal.entries.filter(e => e.type === "close");
    const lessons = lessonsData.lessons || [];
    const perfRecords = lessonsData.performance || [];

    // Update token page
    const tokenName = extractTokenName(closeData.pool_name);
    const tokenCloses = closes.filter(c => extractTokenName(c.pool_name) === tokenName);
    const tokenMd = compileTokenPage(tokenName, tokenCloses, lessons);
    atomicWrite(path.join(TOKENS_DIR, `${sanitizeFilename(tokenName)}.md`), tokenMd);

    // Update strategy page
    const stratId = closeData.strategy || "unknown";
    const stratPerf = perfRecords.filter(p => p.strategy === stratId);
    const stratDef = stratLib.strategies?.[stratId] || null;
    const stratMd = compileStrategyPage(stratId, stratDef, stratPerf, lessons);
    if (stratMd) {
      atomicWrite(path.join(STRATEGIES_DIR, `${sanitizeFilename(stratId)}.md`), stratMd);
    }

    // Update market page
    const snapshots = loadTodaySnapshots();
    const recentCloses = closes.slice(-50);
    const marketMd = compileMarketPage(snapshots, recentCloses);
    atomicWrite(path.join(MARKET_DIR, "conditions.md"), marketMd);

    log("wiki", `Updated wiki: token=${tokenName}, strategy=${stratId}`);
  } catch (err) {
    log("wiki_error", `Wiki incremental update failed: ${err.message}`);
  }
}

/**
 * Update market condition page from snapshot data.
 * Called from logSnapshot() — lightweight, only touches market page.
 */
export function updateMarketFromSnapshot() {
  try {
    ensureDirs();
    const journal = loadJson(JOURNAL_FILE) || { entries: [] };
    const closes = journal.entries.filter(e => e.type === "close");
    const snapshots = loadTodaySnapshots();
    if (snapshots.length < 2) return; // need at least 2 snapshots for trend

    const recentCloses = closes.slice(-50);
    const marketMd = compileMarketPage(snapshots, recentCloses);
    atomicWrite(path.join(MARKET_DIR, "conditions.md"), marketMd);
  } catch (err) {
    log("wiki_error", `Market page update failed: ${err.message}`);
  }
}

/**
 * Query a wiki page by type and name.
 * Used by the query_wiki tool.
 */
export function queryWiki({ type, name, query }) {
  ensureDirs();

  // List available pages
  if (type === "list" || (!type && !name && !query)) {
    const result = { tokens: [], strategies: [], market: [] };
    try { result.tokens = fs.readdirSync(TOKENS_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", "")); } catch {}
    try { result.strategies = fs.readdirSync(STRATEGIES_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", "")); } catch {}
    try { result.market = fs.readdirSync(MARKET_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", "")); } catch {}
    return result;
  }

  // Read specific page
  if (type && name) {
    const dirs = { token: TOKENS_DIR, tokens: TOKENS_DIR, strategy: STRATEGIES_DIR, strategies: STRATEGIES_DIR, market: MARKET_DIR };
    const dir = dirs[type] || TOKENS_DIR;
    const filename = sanitizeFilename(name) + ".md";
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      return { page: fs.readFileSync(filePath, "utf8") };
    }
    return { error: `Page not found: ${type}/${filename}` };
  }

  // Search across all pages
  if (query) {
    const q = query.toLowerCase();
    const results = [];
    for (const dir of [TOKENS_DIR, STRATEGIES_DIR, MARKET_DIR]) {
      try {
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".md"))) {
          const content = fs.readFileSync(path.join(dir, file), "utf8");
          if (content.toLowerCase().includes(q)) {
            // Extract matching section
            const lines = content.split("\n");
            const matchLines = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(q)) {
                matchLines.push(lines[i].trim());
                if (matchLines.length >= 3) break;
              }
            }
            results.push({ file: path.relative(WIKI_DIR, path.join(dir, file)), matches: matchLines });
          }
        }
      } catch {}
    }
    return { results };
  }

  return { error: "Specify type+name, query, or type=list" };
}

/**
 * Get a compact wiki summary for prompt injection.
 * Returns strategy playbook + market regime in minimal form.
 */
export function getWikiSummary() {
  try {
    // Strategy index
    const stratIndexPath = path.join(STRATEGIES_DIR, "index.md");
    let stratSummary = "";
    if (fs.existsSync(stratIndexPath)) {
      stratSummary = fs.readFileSync(stratIndexPath, "utf8");
    }

    // Market conditions — compact version
    const marketPath = path.join(MARKET_DIR, "conditions.md");
    let marketSummary = "";
    if (fs.existsSync(marketPath)) {
      const full = fs.readFileSync(marketPath, "utf8");
      // Extract just Summary, Detected Regime, and Trade Performance Signals sections
      const lines = full.split("\n");
      const keep = [];
      let capturing = false;
      for (const line of lines) {
        if (line.startsWith("## Current Snapshot") || line.startsWith("## Detected Regime") || line.startsWith("## Trade Performance Signals")) {
          capturing = true;
        } else if (line.startsWith("## Regime History")) {
          capturing = false; // skip history table to save tokens
        }
        if (capturing) keep.push(line);
      }
      marketSummary = keep.join("\n");
    }

    if (!stratSummary && !marketSummary) return null;

    let summary = "";
    if (stratSummary) {
      summary += `── STRATEGY PLAYBOOK (from wiki) ──\n${stratSummary}\n`;
    }
    if (marketSummary) {
      summary += `── MARKET CONDITIONS (from wiki) ──\n${marketSummary}\n`;
    }
    return summary;
  } catch {
    return null;
  }
}

// ─── Internal helpers ───────────────────────────────────────────

function loadTodaySnapshots() {
  const dateStr = new Date().toISOString().split("T")[0];
  const file = path.join("logs", `snapshots-${dateStr}.jsonl`);
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n")
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
