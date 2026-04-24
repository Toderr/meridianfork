#!/usr/bin/env node
/**
 * Build a structured changelog for commits between 28 Mar – 23 Apr 2026 (+0800).
 * Source branch: main. Groups by week + subsystem.
 * Run: node scripts/build-changelog.js
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const SINCE = "2026-03-28 00:00 +0800";
const UNTIL = "2026-04-23 23:59 +0800";
const BRANCH = "main";
const OUT = "docs/changelog-mar28-apr23.md";

// ─── fetch commits ───────────────────────────────────────────────
const raw = execSync(
  `git log --no-merges --since="${SINCE}" --until="${UNTIL}" --format="%h|%ci|%s" ${BRANCH}`,
  { encoding: "utf8" }
).trim();

const commits = raw.split("\n").map((line) => {
  const [hash, iso, ...rest] = line.split("|");
  const msg = rest.join("|");
  const date = iso.slice(0, 10); // YYYY-MM-DD
  return { hash, iso, date, msg };
});

console.error(`Fetched ${commits.length} commits`);

// ─── categorize ──────────────────────────────────────────────────
const CATEGORIES = [
  { name: "Lessons & Learning",      match: /\b(lesson|learn|evolution|summariz|autoresearch|goals?)\b/i },
  { name: "Screening & Candidates",  match: /\b(screen|candidate|discover|okx|smart[- ]?wallet|narrative|clusters|volatility|cooldown|unique[- ]?token)\b/i },
  { name: "Management & Rules",      match: /\b(management[- ]?rule|rule[- ]?engine|pnl[- ]?checker|stop[- ]?loss|take[- ]?profit|trailing|hold[- ]?time|oor|yield[- ]?exit|hard[- ]?hold|variant|big[- ]?loss|mitigation)\b/i },
  { name: "PnL & Reporting",         match: /\b(pnl|report|briefing|true_pnl|fee[- ]?inclusive|journal)\b/i },
  { name: "Observability & Logs",    match: /\b(decision[- ]?log|snapshot|observabil|logging|error[- ]?notif|dust[- ]?sweep)\b/i },
  { name: "Telegram & CLI",          match: /\b(telegram|command|cli|harness|claude-ask|repl|withdraw)\b/i },
  { name: "Dashboard & UI",          match: /\b(dashboard|ui|frontend|card|mobile[- ]?ux)\b/i },
  { name: "Wiki & Strategy Library", match: /\b(wiki|strategy[- ]?library|strategy[- ]?template|knowledge)\b/i },
  { name: "Audit & Compare",         match: /\b(audit|compare[- ]?period|analyzer|backtest)\b/i },
  { name: "Infra, Dev & Build",      match: /\b(patch|install|npm|postinstall|ignore|pm2|restart|multi[- ]?provider|llm|minimax)\b/i },
  { name: "Docs",                    match: /^docs[:(]/i },
  { name: "Reverts",                 match: /^revert[:(]/i },
];

function categorize(msg) {
  for (const c of CATEGORIES) {
    if (c.match.test(msg)) return c.name;
  }
  return "Other";
}

// ─── group by week ───────────────────────────────────────────────
const WEEKS = [
  { label: "Week 1 (28 Mar – 3 Apr)",  start: "2026-03-28", end: "2026-04-03" },
  { label: "Week 2 (4 Apr – 10 Apr)",  start: "2026-04-04", end: "2026-04-10" },
  { label: "Week 3 (11 Apr – 17 Apr)", start: "2026-04-11", end: "2026-04-17" },
  { label: "Week 4 (18 Apr – 23 Apr)", start: "2026-04-18", end: "2026-04-23" },
];

function weekOf(dateStr) {
  for (const w of WEEKS) if (dateStr >= w.start && dateStr <= w.end) return w.label;
  return "Unknown";
}

for (const c of commits) {
  c.category = categorize(c.msg);
  c.week = weekOf(c.date);
  c.isRevert = /^revert[:(]/i.test(c.msg);
}

// ─── identify revert pairs ────────────────────────────────────────
const reverts = commits.filter((c) => c.isRevert);

// ─── most-touched files ──────────────────────────────────────────
const filesRaw = execSync(
  `git log --no-merges --since="${SINCE}" --until="${UNTIL}" --name-only --format= ${BRANCH}`,
  { encoding: "utf8" }
).trim();

const fileCount = {};
for (const line of filesRaw.split("\n")) {
  if (!line) continue;
  fileCount[line] = (fileCount[line] || 0) + 1;
}
const topFiles = Object.entries(fileCount)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);

// ─── themes per week (one-liner) ─────────────────────────────────
const WEEK_THEMES = {
  "Week 1 (28 Mar – 3 Apr)":  "Experiment tier ships, hive-mind opens, multi-provider LLM routing, goals system & token-characteristic lessons land.",
  "Week 2 (4 Apr – 10 Apr)":  "Learning-system hardening — manual management mode, volatility guardrails, deploy floor, removing hardcoded screening, goals integration.",
  "Week 3 (11 Apr – 17 Apr)": "PnL rewrite (fee-inclusive `true_pnl`), decision log landed, hold-time cuts disabled (30-Mar baseline restore), Telegram command matching hardened.",
  "Week 4 (18 Apr – 23 Apr)": "Big-loss mitigation bundle, hardcoded guardrails (vol cap 5, variant casing, $4/hr escape), audit tooling — compare-periods, /audit slash command.",
};

// ─── render markdown ─────────────────────────────────────────────
const lines = [];
lines.push(`# Meridian Changelog — 28 Mar s/d 23 Apr 2026\n`);
lines.push(`> Auto-generated from \`git log\` on branch \`${BRANCH}\`. Range: \`${SINCE}\` → \`${UNTIL}\`.\n`);

// Overview
lines.push(`## Overview\n`);
lines.push(`- **Total commits (non-merge):** ${commits.length}`);
lines.push(`- **Actual date range:** ${commits[commits.length - 1].date} → ${commits[0].date}`);
lines.push(`- **Reverts:** ${reverts.length}`);
lines.push(`- **Distinct categories touched:** ${new Set(commits.map((c) => c.category)).size}\n`);

// Major themes
lines.push(`### Major themes (4 weeks)\n`);
lines.push(`1. **Learning system maturity** — moved from freeform LLM-driven derivation to a 3-layer enforced system (prompt / pre-agent / executor) with goal-aligned lessons, threshold evolution guardrails, token-characteristic analysis, and daily Claude summarizer + autoresearch loops.`);
lines.push(`2. **PnL correctness** — eliminated USD↔SOL conversion drift and double-counting; adopted Meteora datapi's canonical fee-inclusive \`pnlUsd\` as the single source of truth, journaled with fee-inclusive totals.`);
lines.push(`3. **Deterministic rule engine** — replaced LLM management decisions with \`management-rules.js\` (yield-exit, OOR, hard-hold cap, claim fees) backed by audit-derived constants. LLM fallback only for unparseable instructions.`);
lines.push(`4. **Big-loss mitigation** — hardcoded volatility cap (≤5), unique-token-across-pools guard, post-loss cooldown, forced single-sided SOL, variant null-guard + proven-variant bonus, confidence cap at 8.`);
lines.push(`5. **Observability** — structured decision log, error notifications, per-source throttling, portfolio snapshots, compare-periods A/B audit, /audit slash command, daily autoresearch biggest-win-vs-loss.\n`);

// Top-touched files
lines.push(`### Most-touched files (top 10)\n`);
lines.push(`| File | Commits |`);
lines.push(`| --- | ---: |`);
for (const [f, n] of topFiles) lines.push(`| \`${f}\` | ${n} |`);
lines.push(``);

// Per-week sections
lines.push(`## Per-Week Changelog\n`);
for (const w of WEEKS) {
  const weekCommits = commits.filter((c) => c.week === w.label);
  if (!weekCommits.length) {
    lines.push(`### ${w.label} — 0 commits\n_(no commits in this window)_\n`);
    continue;
  }
  lines.push(`### ${w.label} — ${weekCommits.length} commits\n`);
  lines.push(`**Theme:** ${WEEK_THEMES[w.label] || "—"}\n`);

  // Group by category, preserve category ordering
  const byCat = new Map();
  for (const c of weekCommits) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  // Use defined order, then spill
  const order = [...CATEGORIES.map((x) => x.name), "Other"];
  for (const cat of order) {
    if (!byCat.has(cat)) continue;
    lines.push(`#### ${cat}`);
    for (const c of byCat.get(cat)) {
      lines.push(`- \`${c.hash}\` ${c.date} — ${c.msg}`);
    }
    lines.push(``);
  }
}

// Reverts
if (reverts.length) {
  lines.push(`## Reverts & Walk-backs\n`);
  for (const r of reverts) {
    lines.push(`- \`${r.hash}\` ${r.date} — ${r.msg}`);
  }
  lines.push(``);
}

// Appendix
lines.push(`## Appendix: Full Commit List (oldest → newest)\n`);
const chronological = [...commits].reverse();
for (const c of chronological) {
  lines.push(`- \`${c.hash}\` ${c.date} ${c.iso.slice(11, 16)} — ${c.msg}`);
}
lines.push(``);

lines.push(`---\n*Generated ${new Date().toISOString()} via \`scripts/build-changelog.js\`.*\n`);

// ─── write atomic ─────────────────────────────────────────────────
const dir = path.dirname(OUT);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const tmp = OUT + ".tmp";
fs.writeFileSync(tmp, lines.join("\n"));
fs.renameSync(tmp, OUT);

console.error(`Wrote ${OUT} (${lines.length} lines, ${commits.length} commits)`);
