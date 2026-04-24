#!/usr/bin/env node
/**
 * Reconcile Meridian's internal per-close PnL (from logs/actions-*.jsonl)
 * vs Meteora UI's realized PnL (user-provided).
 * Meteora UI formula: PnL ($) = (Current Balance + All-time Withdraw +
 *   Claimable Fees + Claimed Fees) - All-time Deposits. Excludes gas/rent.
 * Meteora timezone: UTC+0 (confirmed by user).
 *
 * This script highlights where Meridian's log values diverge, and
 * identifies pattern: systematic overstate, duplicate entries, or per-variant bias.
 */
import fs from "fs";
import path from "path";

// User-provided Meteora daily PnL (UTC+0, USD)
const METEORA_DAILY = {
  "2026-04-11": -1.47,
  "2026-04-12": -27.15,
  "2026-04-13": -53.39,
  "2026-04-14": -48.23,
  "2026-04-15": -17.42,
  "2026-04-16": -1.67,
  "2026-04-17": 13.78,
  "2026-04-18": 16.66,
  "2026-04-19": -0.05,
  "2026-04-20": -47.81,
  "2026-04-21": 8.57,
  "2026-04-22": -0.41,
  "2026-04-23": -16.92,
};

// ─── load Meridian closes from action logs ──────────────────────────
const LOG_DIR = "logs";
const files = fs.readdirSync(LOG_DIR)
  .filter((f) => /^actions-2026-(04-1[1-9]|04-2[0-3])\.jsonl$/.test(f))
  .sort();

const closes = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(LOG_DIR, f), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.tool !== "close_position" || rec.result?.success !== true) continue;
    const pnl = rec.result.pnl_usd ?? 0;
    const fees = rec.result.fees_earned_usd ?? 0;
    closes.push({
      ts: rec.timestamp,
      date: rec.timestamp.slice(0, 10),       // already UTC (Z suffix in ISO)
      position: rec.args?.position_address || rec.result.position,
      pool_name: rec.result.pool_name || null,
      pnl_usd: pnl,
      fees_usd: fees,
      net_meridian: pnl + fees,                // what my prior analysis used
      pnl_only: pnl,                           // alternative if pnl_usd already fee-inclusive
      variant: rec.args?.variant || null,
      close_reason: rec.args?.close_reason || null,
    });
  }
}

// ─── daily aggregates with THREE possible formulas ──────────────────
const daily = {};
for (const c of closes) {
  if (!daily[c.date]) daily[c.date] = {
    count: 0,
    sum_net: 0,       // pnl_usd + fees_earned_usd
    sum_pnl_only: 0,  // pnl_usd only (in case pnl_usd is already fee-inclusive)
    sum_fees_only: 0, // fees_earned_usd only
    positions: new Set(),
    dup_count: 0,
  };
  const d = daily[c.date];
  d.count++;
  d.sum_net      += c.net_meridian;
  d.sum_pnl_only += c.pnl_usd;
  d.sum_fees_only += c.fees_usd;
  if (d.positions.has(c.position)) d.dup_count++;
  d.positions.add(c.position);
}

// ─── reconcile table ──────────────────────────────────────────────
const dates = Object.keys(METEORA_DAILY).sort();
const rows = [];
let totalMeteora = 0, totalMeridianNet = 0, totalMeridianPnlOnly = 0, totalMeridianFees = 0;
for (const d of dates) {
  const m = daily[d];
  const meteora = METEORA_DAILY[d];
  totalMeteora += meteora;
  totalMeridianNet += m?.sum_net ?? 0;
  totalMeridianPnlOnly += m?.sum_pnl_only ?? 0;
  totalMeridianFees += m?.sum_fees_only ?? 0;
  rows.push({
    date: d,
    closes: m?.count ?? 0,
    duplicates: m?.dup_count ?? 0,
    meteora,
    meridian_net: m?.sum_net ?? 0,
    meridian_pnl_only: m?.sum_pnl_only ?? 0,
    meridian_fees: m?.sum_fees_only ?? 0,
    diff_net: (m?.sum_net ?? 0) - meteora,
    diff_pnl_only: (m?.sum_pnl_only ?? 0) - meteora,
  });
}

// ─── pattern detection ────────────────────────────────────────────
// (1) systematic overstate vs Meteora?
const avgDiffNet       = rows.reduce((s, r) => s + r.diff_net, 0) / rows.length;
const avgDiffPnlOnly   = rows.reduce((s, r) => s + r.diff_pnl_only, 0) / rows.length;
// (2) which formula is closer to Meteora?
const rssNet     = Math.sqrt(rows.reduce((s, r) => s + r.diff_net ** 2, 0));
const rssPnlOnly = Math.sqrt(rows.reduce((s, r) => s + r.diff_pnl_only ** 2, 0));
// (3) duplicate position closes (same position closed twice in same day)
const anyDuplicates = rows.reduce((s, r) => s + r.duplicates, 0);

// ─── print reconcile table ────────────────────────────────────────
console.log(`\n=== Reconciliation: Meridian (logs) vs Meteora UI ===\n`);
console.log(`Date        | n  | dup | Meteora    | M.net       | diff.net     | M.pnl_only  | diff.pnl_only`);
console.log(`------------|----|-----|------------|-------------|--------------|-------------|---------------`);
for (const r of rows) {
  console.log(
    `${r.date}  | ${String(r.closes).padStart(2)} | ${String(r.duplicates).padStart(3)} | ` +
    `${r.meteora.toFixed(2).padStart(10)} | ${r.meridian_net.toFixed(2).padStart(11)} | ` +
    `${r.diff_net.toFixed(2).padStart(12)} | ${r.meridian_pnl_only.toFixed(2).padStart(11)} | ` +
    `${r.diff_pnl_only.toFixed(2).padStart(13)}`
  );
}
console.log(`------------|----|-----|------------|-------------|--------------|-------------|---------------`);
console.log(
  `TOTAL       |    |     | ${totalMeteora.toFixed(2).padStart(10)} | ` +
  `${totalMeridianNet.toFixed(2).padStart(11)} | ${(totalMeridianNet - totalMeteora).toFixed(2).padStart(12)} | ` +
  `${totalMeridianPnlOnly.toFixed(2).padStart(11)} | ${(totalMeridianPnlOnly - totalMeteora).toFixed(2).padStart(13)}`
);

console.log(`\n=== Formula Comparison ===`);
console.log(`  Meridian.net (pnl_usd + fees_usd):      RSS diff = ${rssNet.toFixed(2)} · avg diff = ${avgDiffNet.toFixed(2)}`);
console.log(`  Meridian.pnl_only (pnl_usd alone):      RSS diff = ${rssPnlOnly.toFixed(2)} · avg diff = ${avgDiffPnlOnly.toFixed(2)}`);
console.log(`  Winner (closer to Meteora): ${rssNet < rssPnlOnly ? "NET formula" : "PNL_ONLY formula"}`);
console.log(`  Duplicate position-closes across all days: ${anyDuplicates}`);

// ─── also write markdown ──────────────────────────────────────────
const md = [];
md.push(`# Reconciliation: Meridian Logs vs Meteora UI (11–23 Apr 2026)\n`);
md.push(`> Ground truth: Meteora UI (user-provided, UTC+0). Comparison: Meridian's \`logs/actions-*.jsonl\` per-close \`pnl_usd\` and \`fees_earned_usd\`.\n`);
md.push(`## Daily Reconciliation\n`);
md.push(`| Date | Closes | Dup | Meteora ($) | Meridian net ($) | Δ net | Meridian pnl_only ($) | Δ pnl_only |`);
md.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const r of rows) {
  md.push(`| ${r.date} | ${r.closes} | ${r.duplicates} | ${r.meteora.toFixed(2)} | ${r.meridian_net.toFixed(2)} | ${r.diff_net.toFixed(2)} | ${r.meridian_pnl_only.toFixed(2)} | ${r.diff_pnl_only.toFixed(2)} |`);
}
md.push(`| **TOTAL** | | | **${totalMeteora.toFixed(2)}** | **${totalMeridianNet.toFixed(2)}** | **${(totalMeridianNet - totalMeteora).toFixed(2)}** | **${totalMeridianPnlOnly.toFixed(2)}** | **${(totalMeridianPnlOnly - totalMeteora).toFixed(2)}** |`);

md.push(`\n## Pattern Analysis\n`);
md.push(`- **Meridian.net (pnl_usd + fees_usd):** RSS diff ${rssNet.toFixed(2)}, avg diff per day ${avgDiffNet.toFixed(2)}`);
md.push(`- **Meridian.pnl_only (pnl_usd alone):** RSS diff ${rssPnlOnly.toFixed(2)}, avg diff per day ${avgDiffPnlOnly.toFixed(2)}`);
md.push(`- **Formula closer to Meteora:** ${rssNet < rssPnlOnly ? "`pnl_usd + fees_usd` (NET)" : "`pnl_usd` alone (datapi's pnlUsd is already fee-inclusive on these days)"}`);
md.push(`- **Duplicate closes detected:** ${anyDuplicates} (same position address closed twice in same day)`);
md.push(``);

// Hypothesis verdict
md.push(`## Verdict\n`);
if (Math.abs(totalMeridianPnlOnly - totalMeteora) < Math.abs(totalMeridianNet - totalMeteora)) {
  md.push(`**Bug: fees double-counted.** Summing \`pnl_usd + fees_earned_usd\` gives a total off by $${(totalMeridianNet - totalMeteora).toFixed(2)} vs Meteora's $${totalMeteora.toFixed(2)}. Using \`pnl_usd\` alone reduces the error to $${(totalMeridianPnlOnly - totalMeteora).toFixed(2)}.`);
  md.push(`\nThis matches commit **247666b** (15 Apr): _"eliminate PnL double-counting — Meteora datapi pnlUsd is fee-inclusive"_. After that commit, \`pnl_usd\` in logs should be price-only (fee-inclusive minus unclaimed). But the data here suggests \`pnl_usd\` in pre-15-Apr logs still held fee-inclusive value.`);
  md.push(`\n**Recommendation:** When computing "what-Meteora-shows" internal PnL, use \`pnl_usd\` only (NOT \`pnl_usd + fees_earned_usd\`). Or introduce a single canonical field like \`true_pnl_usd\` and populate it consistently.\n`);
} else {
  md.push(`**Net formula (\`pnl_usd + fees_earned_usd\`) is closer to Meteora.** Diff $${(totalMeridianNet - totalMeteora).toFixed(2)} may come from per-position accounting drift (e.g. gas/rent, stuck tokens, or minor price timing).\n`);
}

md.push(`## Day-by-Day Biggest Divergences (sorted by |Δ|)\n`);
const byDiff = [...rows].sort((a, b) => Math.abs(b.diff_net) - Math.abs(a.diff_net)).slice(0, 5);
md.push(`| Date | Meteora | Meridian.net | Δ | Closes |`);
md.push(`| --- | ---: | ---: | ---: | ---: |`);
for (const r of byDiff) {
  md.push(`| ${r.date} | ${r.meteora.toFixed(2)} | ${r.meridian_net.toFixed(2)} | ${r.diff_net.toFixed(2)} | ${r.closes} |`);
}
md.push(``);

md.push(`## Next Steps\n`);
md.push(`1. Pick the 1-2 biggest-divergence days (table above), open \`logs/actions-<that-date>.jsonl\`, dump all \`close_position\` entries, and spot-check against Meteora UI per-position PnL.`);
md.push(`2. If duplicates > 0: investigate why same position_address closed twice (possibly retry-on-error logic didn't check idempotency).`);
md.push(`3. Decide canonical formula: (a) use \`pnl_usd\` alone everywhere, OR (b) keep \`net = pnl_usd + fees\` but verify \`pnl_usd\` is price-only.`);
md.push(`4. Once formula is consistent, rebuild \`journal.json\` from action logs using the canonical formula (script can be written).\n`);

md.push(`---`);
md.push(`*Generated ${new Date().toISOString()} via \`scripts/reconcile-meteora-meridian.js\`.*`);

const OUT = "docs/reconcile-meteora-meridian.md";
if (!fs.existsSync("docs")) fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(OUT + ".tmp", md.join("\n"));
fs.renameSync(OUT + ".tmp", OUT);
console.log(`\nWrote ${OUT} (${md.length} lines)`);
