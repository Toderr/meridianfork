#!/usr/bin/env node
/**
 * One-off: reconcile lessons.json with current hardcoded rules & prune pinned set.
 * Safe to re-run — idempotent on edits (matches by id).
 * Run: node scripts/apply-lesson-audit.js
 */
import fs from "fs";
import path from "path";

const LESSONS_FILE = path.resolve("lessons.json");

const now = new Date().toISOString();

// ── 1. Lessons to DELETE (conflict with current hardcoded rules) ──────────────
const DELETE_IDS = new Set([
  "1774264789365", // 23-pos TP analysis: default 5%/scalper 3-5%/holder 8-12%/fee>$2 hold.
                   // Conflicts with current takeProfitFeePct=3 / fastTpPct=8 / hard-hold-cap $4/hr.
  "1774634751822", // GTCHI-SOL: volatility>=8, bins_above>=30.
                   // Conflicts with MAX_VOLATILITY_HARDCODED=5 and hardcoded bins_above=0.
]);

// ── 2. Lessons to UPDATE (rewrite rule text to match current config) ─────────
// Current runtime: maxPositions=5, emergencyPriceDropPct=-4, postLossCooldownPct=-3,
// postLossCooldownMin=240, takeProfitFeePct=3, fastTpPct=8.
const UPDATES = {
  // maxPositions=5: deploy gate
  "1774524475865":
    "[DEPLOY GATE] maxPositions=5. After close_position, DO NOT deploy again until open_positions <= 4. Maintain 1 position buffer — screening/deploy only when at 4 remaining slots.",

  // slot enforcement — mirror of above, keep forceful wording
  "1774540892218":
    "[ENFORCEMENT] Setelah close_position → STOP screening/deploy. TUNGGU sampai open_positions <= 4. Slot ke-5 tetap KOSONG. Baru boleh screening lagi setelah turun ke 4 positions. BERLAKU untuk SEMUA close — tidak ada pengecualian.",

  // stop loss — match emergencyPriceDropPct=-4 (rule engine parses "below -4%" + NEVER)
  "1774659647458":
    "NEVER hold position below -4% — PnL checker enforces stop loss at emergencyPriceDropPct=-4%. Meme DLMM pools gap through, so cut early and do not average down.",

  // post-loss cooldown — match postLossCooldownPct=-3, postLossCooldownMin=240
  "1776751821770":
    "AVOID redeploying on any pool or base_mint that closed <= -3% within the last 240 minutes. Post-loss cooldown enforces this automatically in screening — repeat-loss tokens keep dumping.",

  // TP config-driven — already accurate, just trim + add explicit parseable numbers
  "1774687041120":
    "TAKE PROFIT is config-driven: close at takeProfitFeePct=3% via PnL checker or fastTpPct=8% hard ceiling. Do not override with hard-coded thresholds in prompts.",
};

// ── 3. Final pinned set (10 max). Everything else gets unpinned. ─────────────
const KEEP_PINNED = new Set([
  "1774659647458", // stop loss -4%
  "1774687041120", // TP config-driven (3%/8%)
  "1776751821770", // post-loss cooldown -3%/240m
  "1776943911325", // AVOID bin_step <= 25 (2026-04-23 audit)
  "1776943911327", // PREFER single_sided_reseed (2026-04-23 audit)
  "1777700000000", // variant diversification (2026-04-24)
  "1774540892218", // deploy gate enforcement
  "1774768042558", // one position per token pair
  "1774659745107", // ALWAYS use pnl_checker data
  "1774659718131", // NEVER use trailing stop
]);

// ── apply ────────────────────────────────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf-8"));
const before = raw.lessons.length;
const beforePinned = raw.lessons.filter((x) => x.pinned).length;

const kept = [];
const changes = { deleted: [], updated: [], unpinned: [], stillPinned: [] };

for (const lesson of raw.lessons) {
  const id = String(lesson.id);

  if (DELETE_IDS.has(id)) {
    changes.deleted.push({ id, rule: lesson.rule.slice(0, 80) });
    continue;
  }

  let next = { ...lesson };

  if (UPDATES[id]) {
    changes.updated.push({ id, oldRule: lesson.rule.slice(0, 80), newRule: UPDATES[id].slice(0, 80) });
    next.rule = UPDATES[id];
    next.updated_at = now;
    next.audit_note = "2026-04-24 hardcoded-rule reconciliation";
  }

  const shouldPin = KEEP_PINNED.has(id);
  if (next.pinned && !shouldPin) {
    changes.unpinned.push({ id, rule: (next.rule || "").slice(0, 80) });
    next.pinned = false;
  } else if (shouldPin && !next.pinned) {
    next.pinned = true; // safety — ensure KEEP_PINNED are pinned
  }
  if (next.pinned) changes.stillPinned.push({ id, rule: (next.rule || "").slice(0, 80) });

  kept.push(next);
}

raw.lessons = kept;

// atomic write
const tmp = LESSONS_FILE + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
fs.renameSync(tmp, LESSONS_FILE);

// report
console.log("=== LESSON AUDIT APPLIED ===");
console.log(`Before: ${before} lessons (${beforePinned} pinned)`);
console.log(`After:  ${kept.length} lessons (${changes.stillPinned.length} pinned)`);
console.log(`\nDELETED (${changes.deleted.length}):`);
changes.deleted.forEach((x) => console.log(`  [${x.id}] ${x.rule}`));
console.log(`\nUPDATED (${changes.updated.length}):`);
changes.updated.forEach((x) => {
  console.log(`  [${x.id}]`);
  console.log(`    old: ${x.oldRule}`);
  console.log(`    new: ${x.newRule}`);
});
console.log(`\nUNPINNED (${changes.unpinned.length}):`);
changes.unpinned.forEach((x) => console.log(`  [${x.id}] ${x.rule}`));
console.log(`\nSTILL PINNED (${changes.stillPinned.length}):`);
changes.stillPinned.forEach((x) => console.log(`  [${x.id}] ${x.rule}`));
