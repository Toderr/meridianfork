#!/usr/bin/env node
/**
 * Rebuild journal.json from logs/actions-*.jsonl using the CANONICAL
 * Meteora formula (fee-inclusive). Uses the hybrid approach:
 *   - Pre 2026-04-15: pnl_usd in logs is already fee-inclusive (datapi raw)
 *   - From 2026-04-15: pnl_usd is price-only, must add fees_earned_usd
 * This matches commit 247666b ("eliminate PnL double-counting").
 *
 * Safety: backs up existing journal.json first. Filters out "Empty position"
 * closes (they are no-op PnL-checker cleanups, not real trades).
 */
import fs from "fs";
import path from "path";

const LOG_DIR = "logs";
const OUT = "journal.json";
const BACKUP = `${OUT}.pre-rebuild-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;

// Cutoff timestamp when `pnl_usd` accounting semantics changed.
// Commit 247666b on 2026-04-15T09:01Z (=17:01 +0800).
const FORMULA_CUTOFF = "2026-04-15T09:01:00Z";

// ─── load all action logs ────────────────────────────────────────────
const files = fs.readdirSync(LOG_DIR)
  .filter((f) => /^actions-2026-\d{2}-\d{2}\.jsonl$/.test(f))
  .sort();

const entries = [];
let nextId = 1_000_000_000_000;
const stats = { opens: 0, closes: 0, emptySkipped: 0, preCutoff: 0, postCutoff: 0 };

for (const f of files) {
  const raw = fs.readFileSync(path.join(LOG_DIR, f), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.tool === "deploy_position" && rec.result?.success !== false && rec.result?.position) {
      entries.push({
        id: nextId++,
        type: "open",
        timestamp: rec.timestamp,
        position: rec.result.position,
        pool: rec.args?.pool_address || rec.result?.pool || null,
        pool_name: rec.args?.pool_name || rec.result?.pool_name || null,
        strategy: rec.args?.strategy || null,
        amount_sol: rec.args?.amount_y ?? rec.args?.amount_sol ?? 0,
        initial_value_usd: rec.args?.initial_value_usd ?? null,
        sol_price: rec.args?.sol_price ?? rec.result?.sol_price ?? null,
        bin_step: rec.args?.bin_step ?? null,
        volatility: rec.args?.volatility ?? null,
        fee_tvl_ratio: rec.args?.fee_tvl_ratio ?? null,
        organic_score: rec.args?.organic_score ?? null,
        bin_range: rec.result?.bin_range || rec.args?.bin_range || null,
        variant: rec.args?.variant || null,
        _rebuilt: true,
      });
      stats.opens++;
    }

    if (rec.tool === "close_position" && rec.result?.success === true) {
      const reason = rec.args?.close_reason || "agent decision";
      // Filter out empty-position cleanups (PnL checker no-ops, value=0 fees=0)
      if (/^Empty position/i.test(reason)) {
        stats.emptySkipped++;
        continue;
      }

      const pre = rec.timestamp < FORMULA_CUTOFF;
      const pnlRaw = rec.result.pnl_usd ?? 0;
      const feesRaw = rec.result.fees_earned_usd ?? 0;

      // Hybrid formula: match Meteora UI semantics
      const canonicalPnl = pre ? pnlRaw : (pnlRaw + feesRaw);
      const priceOnly    = pre ? (pnlRaw - feesRaw) : pnlRaw;

      if (pre) stats.preCutoff++; else stats.postCutoff++;

      entries.push({
        id: nextId++,
        type: "close",
        timestamp: rec.timestamp,
        position: rec.args?.position_address || rec.result?.position,
        pool: rec.result?.pool || null,
        pool_name: rec.result?.pool_name || null,
        strategy: null,                  // not in close result — populated from open if needed
        pnl_usd: canonicalPnl,          // Meteora-equivalent, fee-inclusive
        pnl_usd_price_only: priceOnly,
        pnl_sol: rec.result?.pnl_sol ?? null,
        pnl_pct: rec.result?.pnl_pct ?? null,
        fees_earned_usd: feesRaw,
        sol_price: rec.result?.sol_price ?? null,
        minutes_held: rec.result?.minutes_held ?? null,
        range_efficiency: rec.result?.range_efficiency ?? null,
        close_reason: reason,
        base_mint: rec.result?.base_mint ?? null,
        _rebuilt: true,
        _formula: pre ? "pre-247666b (pnl_usd=fee-inclusive)" : "post-247666b (pnl_usd=price-only, +fees)",
      });
      stats.closes++;
    }
  }
}

entries.sort((a, b) => (a.timestamp || "") < (b.timestamp || "") ? -1 : 1);

// ─── backup + write ──────────────────────────────────────────────────
if (fs.existsSync(OUT)) {
  fs.copyFileSync(OUT, BACKUP);
  console.log(`Backed up existing journal → ${BACKUP}`);
}

const payload = { entries };
fs.writeFileSync(OUT + ".tmp", JSON.stringify(payload, null, 2));
fs.renameSync(OUT + ".tmp", OUT);

// ─── report ──────────────────────────────────────────────────────────
console.log(`\n=== Journal Rebuild Complete ===`);
console.log(`Input:       ${files.length} action log files`);
console.log(`Output:      ${OUT} (${entries.length} entries)`);
console.log(`  opens:           ${stats.opens}`);
console.log(`  closes:          ${stats.closes}`);
console.log(`  empty skipped:   ${stats.emptySkipped}  (PnL-checker no-ops)`);
console.log(`  pre-cutoff:      ${stats.preCutoff}   (pnl_usd kept as-is, fee-inclusive)`);
console.log(`  post-cutoff:     ${stats.postCutoff}  (pnl_usd + fees_earned_usd)`);

// Sanity sum
let totalNet = 0;
for (const e of entries) if (e.type === "close") totalNet += (e.pnl_usd ?? 0);
console.log(`\nTotal cumulative pnl_usd (Meteora-equivalent): $${totalNet.toFixed(2)}`);
console.log(`Date range: ${entries[0]?.timestamp?.slice(0, 10)} → ${entries[entries.length - 1]?.timestamp?.slice(0, 10)}`);
