#!/usr/bin/env node
// Reconstruct intra-position trough PnL from [PNL_API_RAW] log lines,
// join to journal close entries, and quantify how often positions that
// touched ≤ −X% closed fee-inclusive positive.
//
// Usage:  node scripts/analyze-trough-recovery.js [--include-experiments] [--csv]
//
// Notes:
//  - Trough is reconstructed from the PnL checker's polled value: the
//    same price-only pnl_pct the live stop-loss compares against. So
//    "touched ≤ -X%" corresponds to the threshold the agent would have
//    triggered on.
//  - Recovery is fee-inclusive at close: pnl_pct + fees_earned_usd / initial_value_usd * 100.
//  - Cumulative buckets (≤ -X%), not disjoint windows.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");
const JOURNAL = path.join(ROOT, "journal.json");
const EXPERIMENTS = path.join(ROOT, "experiments.json");

const args = new Set(process.argv.slice(2));
const INCLUDE_EXPERIMENTS = args.has("--include-experiments");
const EMIT_CSV = args.has("--csv");

// 1. Load journal closes
const journal = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
const allCloses = (journal.entries || []).filter(e => e.type === "close");

// 2. Identify experiment positions
const experimentPubkeys = new Set();
try {
  const exp = JSON.parse(fs.readFileSync(EXPERIMENTS, "utf8"));
  const map = exp.experiments || {};
  for (const id of Object.keys(map)) {
    const e = map[id];
    if (e.active_position) experimentPubkeys.add(e.active_position);
    for (const it of (e.iterations || [])) {
      if (it.position) experimentPubkeys.add(it.position);
    }
  }
} catch (_) { /* optional */ }

const closes = INCLUDE_EXPERIMENTS
  ? allCloses
  : allCloses.filter(c => !experimentPubkeys.has(c.position));

// 3. Index closes by 8-char pubkey prefix with [openMs, closeMs] window
const prefixIndex = new Map();
let closesWithoutDuration = 0;
for (const c of closes) {
  if (!c.position) continue;
  const closeMs = c.duration?.closed_at
    ? Date.parse(c.duration.closed_at)
    : (c.timestamp ? Date.parse(c.timestamp) : null);
  let openMs = c.duration?.opened_at ? Date.parse(c.duration.opened_at) : null;
  // Fallback: duration field was only added 2026-04-21. For older entries
  // reconstruct openMs from closeMs - minutes_held.
  if ((openMs == null || isNaN(openMs)) && closeMs != null && Number.isFinite(c.minutes_held)) {
    openMs = closeMs - c.minutes_held * 60 * 1000;
  }
  if (openMs == null || isNaN(openMs) || closeMs == null || isNaN(closeMs)) {
    closesWithoutDuration++;
    continue;
  }
  const prefix = c.position.slice(0, 8);
  if (!prefixIndex.has(prefix)) prefixIndex.set(prefix, []);
  prefixIndex.get(prefix).push({ openMs, closeMs, entry: c });
}

// 4. Scan agent logs for [PNL_API_RAW]
const logFiles = fs.readdirSync(LOGS_DIR)
  .filter(f => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(f))
  .map(f => path.join(LOGS_DIR, f))
  .sort();

const lineRe = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[PNL_API_RAW\] (\{.+\})$/;
const troughByEntryId = new Map();
let totalRawLines = 0;
let parsedLines = 0;
let assignedPolls = 0;
let unassignedPolls = 0;
let degeneratePolls = 0;

for (const lf of logFiles) {
  const content = fs.readFileSync(lf, "utf8");
  for (const line of content.split("\n")) {
    if (!line.includes("[PNL_API_RAW]")) continue;
    totalRawLines++;
    const m = line.match(lineRe);
    if (!m) continue;
    let payload;
    try { payload = JSON.parse(m[2]); } catch { continue; }
    parsedLines++;
    const ts = Date.parse(m[1]);
    const pos = payload.pos;
    const pnlUsd = parseFloat(payload.pnlUsd);
    const balances = parseFloat(payload.balances);
    if (!pos || !isFinite(pnlUsd) || !isFinite(balances)) { degeneratePolls++; continue; }
    const initial = balances - pnlUsd;
    if (initial <= 0) { degeneratePolls++; continue; }
    const pnlPct = (pnlUsd / initial) * 100;

    const candidates = prefixIndex.get(pos);
    if (!candidates) { unassignedPolls++; continue; }
    let matched = null;
    for (const c of candidates) {
      // 5-min grace after closeMs to catch late polls before mutex release
      if (ts >= c.openMs && ts <= c.closeMs + 5 * 60 * 1000) { matched = c; break; }
    }
    if (!matched) { unassignedPolls++; continue; }
    assignedPolls++;
    const id = matched.entry.id;
    const cur = troughByEntryId.get(id);
    if (cur === undefined || pnlPct < cur) troughByEntryId.set(id, pnlPct);
  }
}

// 5. Build joined dataset with fee-inclusive close pct
const joined = [];
for (const c of closes) {
  const trough = troughByEntryId.get(c.id);
  if (trough === undefined) continue;
  const initial = c.initial_value_usd;
  const fees = c.fees_earned_usd || 0;
  const pricePct = c.pnl_pct;
  const feeInclPct = initial > 0 ? pricePct + (fees / initial) * 100 : pricePct;
  joined.push({
    id: c.id,
    pos: c.position,
    pool: c.pool_name,
    closed_at: c.duration?.closed_at || c.timestamp,
    trough,
    pricePct,
    feeInclPct,
    fees,
    initial,
  });
}

// 6. Cumulative bucket analysis (-1% .. -15%)
const buckets = [];
for (let x = -1; x >= -15; x--) buckets.push(x);

const out = [];
const log = (s = "") => out.push(s);

log("# Trough Recovery Analysis");
log("");
log("## Coverage");
log(`- Agent log files scanned: ${logFiles.length}`);
log(`- \`[PNL_API_RAW]\` lines parsed: ${parsedLines.toLocaleString()} / ${totalRawLines.toLocaleString()}`);
log(`- Polls assigned to a journal entry: ${assignedPolls.toLocaleString()}`);
log(`- Polls dropped (no journal match in window): ${unassignedPolls.toLocaleString()}`);
log(`- Polls dropped (degenerate values): ${degeneratePolls.toLocaleString()}`);
log(`- Journal closes total: ${allCloses.length}`);
log(`- Experiment closes excluded: ${INCLUDE_EXPERIMENTS ? 0 : (allCloses.length - closes.length)} (\`--include-experiments\` to include)`);
log(`- Eligible closes (with duration): ${closes.length - closesWithoutDuration}`);
log(`- **Closes with reconstructed trough: ${joined.length} / ${closes.length}**`);
log(`- Closes without trough (older than retained logs): ${closes.length - joined.length}`);
log("");

log("## Cumulative recovery rate by trough threshold");
log("Recovery = closed at fee-inclusive `pnl_pct + fees/initial > 0`. Buckets are cumulative (≤ −X%).");
log("");
log("| Trough ≤ | n | Rec (fee-incl) | Rec % (fee-incl) | Rec (price-only) | Rec % (price-only) | Avg final fee-incl % | Median final fee-incl % |");
log("|---|---|---|---|---|---|---|---|");

const median = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

for (const x of buckets) {
  const touched = joined.filter(c => c.trough <= x);
  const n = touched.length;
  const recFee = touched.filter(c => c.feeInclPct > 0).length;
  const recPrice = touched.filter(c => c.pricePct > 0).length;
  const avg = n ? touched.reduce((a, b) => a + b.feeInclPct, 0) / n : null;
  const med = n ? median(touched.map(c => c.feeInclPct)) : null;
  const rateFee = n ? (recFee / n * 100).toFixed(1) + "%" : "–";
  const ratePrice = n ? (recPrice / n * 100).toFixed(1) + "%" : "–";
  log(`| ≤ ${String(x).padStart(3)}% | ${n} | ${recFee} | ${rateFee} | ${recPrice} | ${ratePrice} | ${avg !== null ? avg.toFixed(2) + "%" : "–"} | ${med !== null ? med.toFixed(2) + "%" : "–"} |`);
}

log("");
log("## Stop-loss policy interpretation");
const at10 = joined.filter(c => c.trough <= -10);
const at10rec = at10.filter(c => c.feeInclPct > 0);
const at5 = joined.filter(c => c.trough <= -5);
const at5rec = at5.filter(c => c.feeInclPct > 0);
const at3 = joined.filter(c => c.trough <= -3);
const at3rec = at3.filter(c => c.feeInclPct > 0);
log(`- Current \`emergencyPriceDropPct = -10%\`: ${at10.length} touched ≤ −10%; ${at10rec.length} (${at10.length ? (at10rec.length/at10.length*100).toFixed(1) : "–"}%) closed fee-inclusive positive.`);
log(`- At ≤ −5%: ${at5.length} touched; ${at5rec.length} (${at5.length ? (at5rec.length/at5.length*100).toFixed(1) : "–"}%) recovered.`);
log(`- At ≤ −3%: ${at3.length} touched; ${at3rec.length} (${at3.length ? (at3rec.length/at3.length*100).toFixed(1) : "–"}%) recovered.`);

console.log(out.join("\n"));

if (EMIT_CSV) {
  const csvPath = path.join(ROOT, "logs", "trough-recovery.csv");
  const rows = ["id,pool,closed_at,trough_pct,price_only_pct,fee_incl_pct,initial_usd,fees_usd"];
  for (const r of joined) {
    rows.push([r.id, r.pool, r.closed_at, r.trough.toFixed(3), r.pricePct.toFixed(3), r.feeInclPct.toFixed(3), r.initial, r.fees].join(","));
  }
  fs.writeFileSync(csvPath, rows.join("\n"));
  console.error(`\nCSV written: ${csvPath}`);
}
