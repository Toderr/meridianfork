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
 *   - Max 40% reduction per run
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

  const maxDelete = Math.floor(lessons.length * 0.4);

  return `You are cleaning up the lesson library of an autonomous Solana DLMM LP trading agent.

CURRENT LESSONS (${lessons.length} total):
${lessonLines}

TASK:
Reduce lesson bloat by identifying:
1. SUPERSEDED: A lesson that is strictly replaced by a newer, more specific lesson covering the same rule. Delete the older/vaguer one.
2. CONTRADICTED: Two lessons that directly conflict (e.g., one says AVOID bid_ask, another says PREFER bid_ask). Delete the weaker/older one.
3. MERGEABLE: 3+ lessons that are all variations of the same underlying rule. Replace them with one concise merged rule.

HARD CONSTRAINTS (you MUST follow these):
- NEVER delete or merge lessons marked PINNED
- NEVER suggest deleting more than ${maxDelete} lessons total (max 40% reduction)
- Do NOT merge lessons from different categories
- Only merge if the lessons are truly redundant — when in doubt, leave them
- The merged rule must follow the LESSON FORMAT below so it gets auto-enforced

LESSON FORMAT (merged rules must match one of these patterns):
  "AVOID strategy=X"
  "AVOID strategy=X when volatility > Y"
  "AVOID volatility > X"
  "SKIP: global_fees_sol < X"
  "AVOID top_10_pct > X"
  "NEVER deploy more than X SOL"
  "AVOID holding > Xm when pnl < Y%"
  "DO NOT close OOR < Xm"
  "NEVER hold position below -X%"
  "TAKE PROFIT at X%"
  (or freeform AVOID/NEVER/SKIP/PREFER/WORKED/FAILED rules if no pattern fits)

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "delete": [id1, id2, ...],
  "merge": [
    { "ids": [id1, id2, id3], "new_rule": "MERGED RULE TEXT", "reason": "one sentence why" }
  ],
  "rationale": "1-2 sentence summary of what was cleaned up"
}

If nothing needs cleanup, respond with: { "delete": [], "merge": [], "rationale": "No redundant lessons found" }`;
}

// ─── Notify journal bot ───────────────────────────────────────────

async function notifyCleanup({ deleted, merged, rationale }) {
  const parts = ["🧹 LESSON CLEANUP"];
  if (deleted > 0) parts.push(`🗑️ Deleted: ${deleted} superseded/contradicted`);
  if (merged > 0)  parts.push(`🔀 Merged: ${merged} group(s)`);
  if (rationale)   parts.push(`💡 ${rationale}`);
  const msg = parts.join("\n");

  try {
    const { isEnabled, sendMessage } = await import("../telegram.js");
    if (isEnabled()) await sendMessage(msg);
  } catch { /* main bot not available */ }

  try {
    const { isEnabled: journalEnabled, notifyClaudeReview } = await import("../telegram-journal.js");
    if (journalEnabled()) await notifyClaudeReview({ newLessons: [], appliedConfig: {}, rationale: msg });
  } catch { /* journal bot not available */ }
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

    const prompt = buildPrompt(regularLessons);
    const args = ["--print", "--output-format", "json", "--no-session-persistence", "--tools", ""];

    log("lesson_summarizer", `Spawning claude CLI (${regularLessons.length} regular lessons)`);

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

    // Parse outer claude JSON envelope
    let envelope;
    try { envelope = JSON.parse(stdout.trim()); } catch {
      throw new Error(`Non-JSON output from claude: ${stdout.slice(0, 200)}`);
    }
    if (envelope.is_error) throw new Error(`Claude error: ${envelope.result}`);

    // Parse inner response JSON
    let parsed;
    const raw = (envelope.result || "").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try { parsed = JSON.parse(cleaned); } catch {
      throw new Error(`Claude returned non-JSON content: ${raw.slice(0, 200)}`);
    }

    const toDelete = Array.isArray(parsed.delete) ? parsed.delete.filter(id => typeof id === "number") : [];
    const toMerge  = Array.isArray(parsed.merge)  ? parsed.merge.filter(m => Array.isArray(m.ids) && typeof m.new_rule === "string") : [];
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";

    if (toDelete.length === 0 && toMerge.length === 0) {
      log("lesson_summarizer", `Done — no cleanup needed. ${rationale}`);
      return;
    }

    const { removeLesson, addLesson } = await import("../lessons.js");

    // Safety: never delete pinned lessons
    const pinnedIds = new Set(regularLessons.filter(l => l.pinned).map(l => l.id));
    const safeDelete = toDelete.filter(id => !pinnedIds.has(id));

    // Safety: max 40% reduction
    const maxDelete = Math.floor(regularLessons.length * 0.4);
    const mergeDeleteCount = toMerge.reduce((n, m) => n + m.ids.filter(id => !pinnedIds.has(id)).length, 0);
    const totalDeletes = safeDelete.length + mergeDeleteCount;
    if (totalDeletes > maxDelete) {
      log("lesson_summarizer", `Safety cap: would delete ${totalDeletes} but max is ${maxDelete}. Skipping run.`);
      return;
    }

    // Apply deletions
    let deletedCount = 0;
    for (const id of safeDelete) {
      const removed = removeLesson(id);
      if (removed) deletedCount++;
    }

    // Apply merges: add consolidated rule, then delete originals
    let mergedGroups = 0;
    for (const { ids, new_rule, reason } of toMerge) {
      if (!new_rule.trim()) continue;
      const safeIds = ids.filter(id => !pinnedIds.has(id));
      if (safeIds.length < 2) continue; // need at least 2 to merge
      addLesson(new_rule.trim(), ["merged"], { category: "general" });
      for (const id of safeIds) removeLesson(id);
      mergedGroups++;
      log("lesson_summarizer", `Merged ${safeIds.length} lessons → "${new_rule.slice(0, 80)}": ${reason||""}`);
    }

    if (deletedCount > 0 || mergedGroups > 0) {
      await notifyCleanup({ deleted: deletedCount, merged: mergedGroups, rationale });
      log("lesson_summarizer", `Done — deleted ${deletedCount}, merged ${mergedGroups} group(s). ${rationale}`);
    } else {
      log("lesson_summarizer", `Done — no changes applied after safety checks.`);
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
