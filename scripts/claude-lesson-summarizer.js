/**
 * Claude Lesson Summarizer
 *
 * Runs daily at 23:59 UTC+7. Uses `claude --print` to consolidate
 * accumulated lessons: deletes superseded/contradicted ones and merges
 * groups of similar lessons into a single concise rule.
 *
 * Safety guarantees:
 *   - Never deletes pinned lessons
 *   - Never touches experiment lessons
 *   - Max 70% reduction per run
 *   - Skips silently on malformed Claude response
 *
 * Fire-and-forget from index.js — never throws past its own error boundary.
 *
 * Usage (standalone test):
 *   node scripts/claude-lesson-summarizer.js
 */

import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CLAUDE_BIN = "/home/ubuntu/.local/bin/claude";
const LESSONS_FILE = path.join(ROOT, "lessons.json");

// ─── File helpers ─────────────────────────────────────────��───────

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ─── Build prompt ────────────────────────────────────────────────��

function buildPrompt(lessons) {
  const lessonLines = lessons.map(l =>
    `ID:${l.id} [${l.category||"general"}/${l.outcome||"manual"}${l.pinned?" PINNED":""}] ${l.rule}`
  ).join("\n");

  const maxDelete = Math.floor(lessons.length * 0.7);

  return `You are aggressively cleaning the lesson library of an autonomous Solana DLMM LP trading agent.
The goal is MAXIMUM CONCISENESS — every lesson must be a short, actionable rule. No stories, no examples, no verbose explanations.

CURRENT LESSONS (${lessons.length} total):
${lessonLines}

TASK — Be aggressive:
1. DELETE duplicates: Multiple "CAUTION: Quick loss on X-SOL" with same template → keep ZERO, merge into one short rule.
2. DELETE noise: AUTO-EVOLVED, SELF-TUNED, FORMAT lessons that don't affect trading decisions.
3. DELETE superseded: Old rule replaced by newer/better one.
4. MERGE similar lessons into ONE short rule. Examples of good merged rules:
   - "CAUTION: 15 quick losses (<20m) — check momentum/volume before deploy" (replaces 15 individual CAUTION lessons)
   - "PREFER bid_ask over spot — avg PnL +4.5% vs -24% over 1000 trades"
   - "AVOID volatility=null + spot strategy — goes OOR 100%"
   - "PREFER single_sided_reseed on med-vol — avg PnL +2.55% vs bid_ask -0.13%"

CONCISENESS RULES (CRITICAL):
- Each new_rule MUST be under 120 characters. No exceptions.
- No raw JSON, no bin_range objects, no long token lists in rules.
- No "Pool conditions deteriorated fast — check momentum and volume before similar deploys" boilerplate.
- Strip specific token names from merged rules — generalize the pattern.
- One fact per rule. If a lesson has 5 bullet points, split into 5 short rules or pick the most important one.

STRUCTURED FORMATS (prefer these — they get auto-enforced by the rule parser):
  "AVOID strategy=X"
  "AVOID strategy=X when volatility > Y"
  "SKIP: global_fees_sol < X"
  "NEVER deploy more than X SOL"
  "AVOID holding > Xm when pnl < Y%"
  "DO NOT close OOR < Xm"
  "NEVER hold position below -X%"
  "TAKE PROFIT at X%"
  "PREFER strategy=X when volatility < Y"

HARD CONSTRAINTS:
- NEVER delete or merge lessons marked PINNED
- Max ${maxDelete} deletions (40% cap)
- Do NOT merge lessons from different categories

Respond ONLY with valid JSON:
{
  "delete": [id1, id2, ...],
  "merge": [
    { "ids": [id1, id2, id3], "new_rule": "SHORT RULE <120 chars", "reason": "why" }
  ],
  "rationale": "summary"
}

If nothing needs cleanup: { "delete": [], "merge": [], "rationale": "Clean" }`;
}

// ─── Notify journal bot ───────────────────────────────────────────

const CAT_EMOJI = {
  strategy:   "📐",
  "stop loss": "🛑",
  "take profit": "🎯",
  sizing:     "💰",
  general:    "📝",
};

function catEmoji(cat) {
  return CAT_EMOJI[(cat || "general").toLowerCase()] ?? "📝";
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : "General"; }

// Build paginated lesson list messages grouped by category
// idToIndex: Map<id, displayIndex> from listAllLessons() for consistent numbering
function buildLessonPages(lessons, idToIndex, maxChars = 3800) {
  const CAT_ORDER = ["strategy", "stop loss", "take profit", "sizing", "general"];
  const grouped = {};
  for (const l of lessons) {
    const cat = (l.category || "general").toLowerCase();
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(l);
  }

  // Sort categories: known order first, then alphabetical for unknowns
  const cats = Object.keys(grouped).sort((a, b) => {
    const ai = CAT_ORDER.indexOf(a), bi = CAT_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  const pages = [];
  let current = [`📚 Active Lessons: ${lessons.length}\n/update_lesson <N> <new rule>  |  /del_lesson <N>`];
  let currentLen = current[0].length + 1;

  for (const cat of cats) {
    const items = grouped[cat];
    const header = `\n${catEmoji(cat)} ${cap(cat)} (${items.length})`;
    const lines = items.map(l => {
      const idx = idToIndex?.get(l.id);
      const prefix = idx != null ? `#${idx} ` : "";
      return `• ${prefix}${l.rule}`;
    });

    // Try to fit header + lines into current page, else start new page
    const block = [header, ...lines].join("\n");
    if (currentLen + block.length + 1 > maxChars && current.length > 1) {
      pages.push(current.join("\n"));
      current = [`📚 Active Lessons (cont.)`];
      currentLen = current[0].length + 1;
    }

    // Add header
    current.push(header);
    currentLen += header.length + 1;

    // Add lines, paginating mid-category if needed
    for (const line of lines) {
      if (currentLen + line.length + 1 > maxChars) {
        pages.push(current.join("\n"));
        current = [`📚 Active Lessons (cont.)`];
        currentLen = current[0].length + 1;
      }
      current.push(line);
      currentLen += line.length + 1;
    }
  }

  if (current.length > 1) pages.push(current.join("\n"));
  return pages;
}

// ─── Policy digest consolidation via Claude ─────────────────────

const AVOID_RE = /\b(AVOID|NEVER|SKIP|FAILED|DO NOT|BLOCK)\b/i;
const PREFER_RE = /\b(PREFER|WORKED|CONSIDER|GOOD|USE|TAKE PROFIT)\b/i;

async function consolidatePolicyLessons(lessons, { removeLesson, addLesson, log }) {
  const avoidLessons  = lessons.filter(l => !l.pinned && AVOID_RE.test(l.rule));
  const preferLessons = lessons.filter(l => !l.pinned && PREFER_RE.test(l.rule));
  const policyLessons = [...avoidLessons, ...preferLessons];

  // Need at least 3 policy lessons to consolidate
  if (policyLessons.length < 3) return null;

  // Deduplicate (a lesson can match both AVOID and PREFER)
  const uniqueIds = new Set();
  const unique = policyLessons.filter(l => {
    if (uniqueIds.has(l.id)) return false;
    uniqueIds.add(l.id);
    return true;
  });

  const lessonLines = unique.map(l =>
    `ID:${l.id} [${l.category||"general"}] ${l.rule}`
  ).join("\n");

  const prompt = `You are consolidating AVOID/PREFER trading rules of an autonomous Solana DLMM LP agent into a CONCISE policy digest.
Goal: Replace verbose/duplicate lessons with SHORT actionable rules (<120 chars each).

CURRENT POLICY LESSONS (${unique.length}):
${lessonLines}

TASK:
Group by topic → consolidate each group into ONE short rule. Be aggressive — the fewer lessons, the better.

Categories to consolidate into:
- TAKE PROFIT: what % to close at
- STOP LOSS: what % to cut losses
- STRATEGY SELECTION: when to use bid_ask vs spot vs single_sided_reseed
- SIZING: max deploy amount
- ENTRY FILTERS: what pools to skip
- MANAGEMENT: OOR grace, hold time limits

FORMATS (rule parser uses regex — MUST match one):
  "TAKE PROFIT at X%"
  "NEVER hold position below -X%"
  "PREFER strategy=X when volatility < Y"
  "AVOID strategy=X when volatility > Y"
  "AVOID strategy=X"
  "SKIP: global_fees_sol < X"
  "NEVER deploy more than X SOL"
  "AVOID holding > Xm when pnl < Y%"
  "DO NOT close OOR < Xm"

RULES:
- Each new_rule: SINGLE rule, ONE format, under 120 characters
- Keep most conservative threshold from originals
- 3+ lessons minimum per consolidation
- NEVER touch PINNED lessons
- Strip token-specific names — generalize patterns

Respond ONLY with valid JSON:
{
  "consolidations": [
    { "delete_ids": [id1, id2, ...], "new_rule": "SHORT RULE", "category": "strategy|general|stop loss|take profit|sizing" }
  ],
  "rationale": "summary"
}`;

  const args = ["--print", "--output-format", "json", "--no-session-persistence", "--tools", ""];

  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { env: { ...process.env } });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => {
      if (code !== 0) reject(new Error(`claude digest exited ${code}: ${err.slice(0, 300)}`));
      else resolve(out);
    });
    child.on("error", reject);
    child.stdin.write(prompt);
    child.stdin.end();
    setTimeout(() => { child.kill(); reject(new Error("claude digest timed out")); }, 3 * 60 * 1000);
  });

  let envelope;
  try { envelope = JSON.parse(stdout.trim()); } catch { return null; }
  if (envelope.is_error) return null;

  const raw = (envelope.result || "").trim();
  const jsonStart = raw.indexOf("{");
  const jsonEnd   = raw.lastIndexOf("}");
  const cleaned = jsonStart !== -1 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }

  const consolidations = Array.isArray(parsed.consolidations)
    ? parsed.consolidations.filter(c => Array.isArray(c.delete_ids) && c.delete_ids.length >= 2 && typeof c.new_rule === "string" && c.new_rule.trim())
    : [];

  if (consolidations.length === 0) return null;

  const pinnedIds = new Set(lessons.filter(l => l.pinned).map(l => l.id));
  const validIds = new Set(unique.map(l => l.id));
  const idToLesson = Object.fromEntries(unique.map(l => [l.id, l]));

  let totalDeleted = 0;
  const digestParts = ["📋 POLICY DIGEST"];
  const deletedByCategory = {};

  for (const { delete_ids, new_rule, category } of consolidations) {
    const safeIds = delete_ids.filter(id => validIds.has(id) && !pinnedIds.has(id));
    if (safeIds.length < 2) continue;

    // Add consolidated lesson
    const cat = category || "general";
    addLesson(new_rule.trim(), ["consolidated"], { category: cat });
    log("lesson_summarizer", `Policy consolidation: ${safeIds.length} lessons → "${new_rule.slice(0, 80)}"`);

    // Delete originals
    for (const id of safeIds) {
      const removed = removeLesson(id);
      if (removed) {
        totalDeleted++;
        const origCat = (idToLesson[id]?.category || "general").toLowerCase();
        deletedByCategory[origCat] = (deletedByCategory[origCat] || 0) + 1;
      }
    }

    digestParts.push(`\n${catEmoji(cat)} ${cap(cat)} (${safeIds.length} → 1):`);
    digestParts.push(new_rule);
  }

  if (totalDeleted === 0) return null;

  return {
    deletedCount: totalDeleted,
    digestMsg: digestParts.join("\n"),
    deletedByCategory,
    consolidationCount: consolidations.length,
  };
}

async function notifyCleanup({ deleted, merged, deletedByCategory, mergeDetails, remainingLessons, idToIndex, digestMsg }) {
  const parts = ["🧹 LESSON CLEANUP"];

  if (deleted > 0) {
    parts.push(`🗑️ Deleted: ${deleted}`);
    const cats = Object.entries(deletedByCategory).sort((a, b) => b[1] - a[1]);
    for (const [cat, n] of cats) {
      parts.push(`  ${catEmoji(cat)} ${cap(cat)}: ${n}`);
    }
  }

  if (merged > 0) {
    parts.push(`🔀 Merged: ${merged} group(s)`);
    for (const { category, new_rule, count } of mergeDetails) {
      parts.push(`  ${catEmoji(category)} ${cap(category)}: "${new_rule.slice(0, 60)}${new_rule.length > 60 ? "…" : ""}" (${count} → 1)`);
    }
  }

  const summaryMsg = parts.join("\n");
  const lessonPages = remainingLessons?.length > 0 ? buildLessonPages(remainingLessons, idToIndex) : [];

  // Send to main bot
  try {
    const { isEnabled, sendMessage } = await import("../telegram.js");
    if (isEnabled()) {
      await sendMessage(summaryMsg);
      if (digestMsg) await sendMessage(digestMsg);
      for (const page of lessonPages) await sendMessage(page);
    }
  } catch { /* main bot not available */ }

  // Send to journal bot
  try {
    const { isEnabled: journalEnabled, notifyClaudeReview } = await import("../telegram-journal.js");
    if (journalEnabled()) {
      await notifyClaudeReview({ newLessons: [], appliedConfig: {}, rationale: summaryMsg });
      if (digestMsg) await notifyClaudeReview({ newLessons: [], appliedConfig: {}, rationale: digestMsg });
      for (const page of lessonPages) await notifyClaudeReview({ newLessons: [], appliedConfig: {}, rationale: page });
    }
  } catch { /* journal bot not available */ }
}

// ─── Batch size ───────────────────────────────────────────────────
const BATCH_SIZE = 50;

// ─── Process one batch via claude CLI ────────────────────────────

async function processBatch(batch, { removeLesson, addLesson, log }) {
  const prompt = buildPrompt(batch);
  const args = ["--print", "--output-format", "json", "--no-session-persistence", "--tools", ""];

  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { env: { ...process.env } });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      else resolve(out);
    });
    child.on("error", reject);
    child.stdin.write(prompt);
    child.stdin.end();
    setTimeout(() => { child.kill(); reject(new Error("claude subprocess timed out")); }, 5 * 60 * 1000);
  });

  let envelope;
  try { envelope = JSON.parse(stdout.trim()); } catch {
    throw new Error(`Non-JSON output from claude: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error) throw new Error(`Claude error: ${envelope.result}`);

  let parsed;
  const raw = (envelope.result || "").trim();
  // Extract JSON object robustly: find first { and last }
  const jsonStart = raw.indexOf("{");
  const jsonEnd   = raw.lastIndexOf("}");
  const cleaned = jsonStart !== -1 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
  try { parsed = JSON.parse(cleaned); } catch {
    throw new Error(`Claude returned non-JSON content: ${raw.slice(0, 200)}`);
  }

  const toDelete = Array.isArray(parsed.delete) ? parsed.delete.filter(id => typeof id === "number") : [];
  const toMerge  = Array.isArray(parsed.merge)  ? parsed.merge.filter(m => Array.isArray(m.ids) && typeof m.new_rule === "string") : [];
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";

  const empty = { deletedCount: 0, mergedGroups: 0, deletedByCategory: {}, mergeDetails: [] };
  if (toDelete.length === 0 && toMerge.length === 0) return empty;

  const idToLesson = Object.fromEntries(batch.map(l => [l.id, l]));
  const pinnedIds = new Set(batch.filter(l => l.pinned).map(l => l.id));
  const safeDelete = toDelete.filter(id => !pinnedIds.has(id));

  // Safety: max 70% reduction per batch (aggressive cleanup)
  const maxDelete = Math.floor(batch.length * 0.7);
  const mergeDeleteCount = toMerge.reduce((n, m) => n + m.ids.filter(id => !pinnedIds.has(id)).length, 0);
  const totalDeletes = safeDelete.length + mergeDeleteCount;
  if (totalDeletes > maxDelete) {
    log("lesson_summarizer", `Batch safety cap: would delete ${totalDeletes} but max is ${maxDelete}. Skipping batch.`);
    return empty;
  }

  const deletedByCategory = {};
  let deletedCount = 0;
  for (const id of safeDelete) {
    const removed = removeLesson(id);
    if (removed) {
      deletedCount++;
      const cat = (idToLesson[id]?.category || "general").toLowerCase();
      deletedByCategory[cat] = (deletedByCategory[cat] || 0) + 1;
    }
  }

  let mergedGroups = 0;
  const mergeDetails = [];
  for (const { ids, new_rule, reason } of toMerge) {
    if (!new_rule.trim()) continue;
    const safeIds = ids.filter(id => !pinnedIds.has(id));
    if (safeIds.length < 2) continue;
    // Infer category from the most common category among merged lessons
    const cats = safeIds.map(id => (idToLesson[id]?.category || "general").toLowerCase());
    const catFreq = {};
    for (const c of cats) catFreq[c] = (catFreq[c] || 0) + 1;
    const category = Object.entries(catFreq).sort((a, b) => b[1] - a[1])[0][0];
    addLesson(new_rule.trim(), ["merged"], { category });
    for (const id of safeIds) {
      removeLesson(id);
      const cat = (idToLesson[id]?.category || "general").toLowerCase();
      deletedByCategory[cat] = (deletedByCategory[cat] || 0) + 1;
      deletedCount++;
    }
    mergedGroups++;
    mergeDetails.push({ category, new_rule, count: safeIds.length });
    log("lesson_summarizer", `Merged ${safeIds.length} lessons → "${new_rule.slice(0, 80)}": ${reason||""}`);
  }

  return { deletedCount, mergedGroups, deletedByCategory, mergeDetails };
}

// ─── Main ─────────────────────────────────────────────────────────

export async function claudeSummarizeLessons() {
  const { log } = await import("../logger.js");

  try {
    const data = loadJson(LESSONS_FILE) || { lessons: [] };
    // Only process regular lessons — experiment lessons are isolated
    const regularLessons = (data.lessons || []).filter(l => l.source !== "experiment");

    if (regularLessons.length < 10) {
      log("lesson_summarizer", `Skipping — only ${regularLessons.length} regular lessons (min 10)`);
      return;
    }

    const { removeLesson, addLesson } = await import("../lessons.js");

    // Split into batches
    const batches = [];
    for (let i = 0; i < regularLessons.length; i += BATCH_SIZE) {
      batches.push(regularLessons.slice(i, i + BATCH_SIZE));
    }

    log("lesson_summarizer", `Processing ${regularLessons.length} lessons in ${batches.length} batch(es) of ~${BATCH_SIZE}`);

    let totalDeleted = 0;
    let totalMerged = 0;
    const totalDeletedByCategory = {};
    const allMergeDetails = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      log("lesson_summarizer", `Batch ${i + 1}/${batches.length}: ${batch.length} lessons`);
      try {
        const { deletedCount, mergedGroups, deletedByCategory, mergeDetails } = await processBatch(batch, { removeLesson, addLesson, log });
        totalDeleted += deletedCount;
        totalMerged  += mergedGroups;
        for (const [cat, n] of Object.entries(deletedByCategory || {})) {
          totalDeletedByCategory[cat] = (totalDeletedByCategory[cat] || 0) + n;
        }
        allMergeDetails.push(...(mergeDetails || []));
        log("lesson_summarizer", `Batch ${i + 1} done — deleted ${deletedCount}, merged ${mergedGroups}`);
      } catch (e) {
        log("lesson_summarizer_error", `Batch ${i + 1} failed: ${e.message}`);
      }
    }

    // ── Policy digest consolidation (runs after batch cleanup) ──
    let digestMsg = null;
    try {
      const postCleanupData = loadJson(LESSONS_FILE) || { lessons: [] };
      const postCleanupLessons = (postCleanupData.lessons || []).filter(l => l.source !== "experiment");
      const digestResult = await consolidatePolicyLessons(postCleanupLessons, { removeLesson, addLesson, log });
      if (digestResult) {
        totalDeleted += digestResult.deletedCount;
        for (const [cat, n] of Object.entries(digestResult.deletedByCategory || {})) {
          totalDeletedByCategory[cat] = (totalDeletedByCategory[cat] || 0) + n;
        }
        digestMsg = digestResult.digestMsg;
        log("lesson_summarizer", `Policy consolidation: deleted ${digestResult.deletedCount}, created ${digestResult.consolidationCount} summary lesson(s)`);
      }
    } catch (e) {
      log("lesson_summarizer_error", `Policy consolidation failed: ${e.message}`);
    }

    if (totalDeleted > 0 || totalMerged > 0) {
      // Reload lessons after all mutations to get final state
      const finalData = loadJson(LESSONS_FILE) || { lessons: [] };
      const remainingLessons = (finalData.lessons || []).filter(l => l.source !== "experiment");
      // Build index map consistent with listAllLessons() for /update_lesson and /del_lesson
      const { listAllLessons: listAll } = await import("../lessons.js");
      const allLessons = listAll();
      const idToIndex = new Map(allLessons.map(l => [l.id, l.index]));
      await notifyCleanup({ deleted: totalDeleted, merged: totalMerged, deletedByCategory: totalDeletedByCategory, mergeDetails: allMergeDetails, remainingLessons, idToIndex, digestMsg });
      log("lesson_summarizer", `Done — deleted ${totalDeleted}, merged ${totalMerged} group(s). ${remainingLessons.length} lessons remain.`);
    } else {
      log("lesson_summarizer", `Done — no cleanup needed across all batches.`);
    }

  } catch (e) {
    const { log } = await import("../logger.js");
    log("lesson_summarizer_error", `claudeSummarizeLessons failed: ${e.message}`);
  }
}

// ─── Standalone run ───────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  claudeSummarizeLessons().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
