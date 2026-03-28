/**
 * Claude Ask — general-purpose Q&A agent for Telegram /claude command.
 *
 * Loads context from runtime JSON files, injects into prompt, spawns
 * `claude --print`, and returns plain-text response.
 *
 * Usage (standalone test):
 *   node scripts/claude-ask.js "take lesson from position <addr>"
 */

import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CLAUDE_BIN = "/home/ubuntu/.local/bin/claude";

const STATE_FILE       = path.join(ROOT, "state.json");
const JOURNAL_FILE     = path.join(ROOT, "journal.json");
const LESSONS_FILE     = path.join(ROOT, "lessons.json");
const EXP_LESSONS_FILE = path.join(ROOT, "experiment-lessons.json");
const USER_CONFIG_FILE = path.join(ROOT, "user-config.json");

const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function buildContext() {
  const state   = loadJson(STATE_FILE)   || {};
  const journal = loadJson(JOURNAL_FILE) || {};
  const regLessons = loadJson(LESSONS_FILE) || {};
  const expLessons = loadJson(EXP_LESSONS_FILE) || {};
  const lessons = { lessons: [...(regLessons.lessons || []), ...(expLessons.lessons || [])] };
  const config  = loadJson(USER_CONFIG_FILE) || {};

  // Open positions
  const openPositions = Object.values(state.positions || {});

  // Last 15 journal entries
  const recentJournal = (journal.entries || []).slice(-15);

  // Last 20 lessons
  const lessonList = (lessons.lessons || []).slice(-20).map(l =>
    `[${l.type || "?"}] ${l.rule}`
  );

  // Recent performance
  const recentPerf = (lessons.performance || []).slice(-10).map(p => {
    const sign = (p.pnl_pct ?? 0) >= 0 ? "+" : "";
    return `${p.pool_name || "?"} | ${p.strategy || "?"} | ${sign}${(p.pnl_pct ?? 0).toFixed(2)}% | held=${p.minutes_held || 0}m | reason=${p.close_reason || "?"}`;
  });

  // Config snapshot (relevant subset)
  const cfgSubset = {
    strategy:              config.strategy,
    binsBelow:             config.binsBelow,
    strategyRules:         config.strategyRules,
    deployAmountSol:       config.deployAmountSol,
    maxDeployAmount:       config.maxDeployAmount,
    positionSizePct:       config.positionSizePct,
    maxPositions:          config.risk?.maxPositions,
    takeProfitFeePct:      config.management?.takeProfitFeePct,
    fastTpPct:             config.management?.fastTpPct,
    trailingActivate:      config.management?.trailingActivate,
    trailingFloor:         config.management?.trailingFloor,
    emergencyPriceDropPct: config.management?.emergencyPriceDropPct,
    minFeeTvl24h:          config.minFeeTvl24h,
    minAgeForYieldExit:    config.minAgeForYieldExit,
    outOfRangeBinsToClose: config.outOfRangeBinsToClose,
  };

  const parts = [];

  parts.push(`=== OPEN POSITIONS (${openPositions.length}) ===`);
  if (openPositions.length === 0) {
    parts.push("No open positions.");
  } else {
    for (const p of openPositions) {
      parts.push(JSON.stringify(p, null, 2));
    }
  }

  parts.push(`\n=== RECENT JOURNAL (last ${recentJournal.length} entries) ===`);
  if (recentJournal.length === 0) {
    parts.push("No journal entries.");
  } else {
    for (const e of recentJournal) {
      parts.push(JSON.stringify(e));
    }
  }

  parts.push(`\n=== RECENT PERFORMANCE (last ${recentPerf.length}) ===`);
  parts.push(recentPerf.length ? recentPerf.join("\n") : "No performance data.");

  parts.push(`\n=== CURRENT LESSONS (${lessonList.length}) ===`);
  parts.push(lessonList.length ? lessonList.join("\n") : "No lessons yet.");

  parts.push(`\n=== STRATEGY CONFIG ===`);
  parts.push(JSON.stringify(cfgSubset, null, 2));

  return parts.join("\n");
}

function buildPrompt(query, context) {
  return `You are an assistant for an autonomous Solana DLMM LP agent (Meridian/Meteora).
You have access to the current agent state below. Answer the user's question clearly and concisely.
If the user asks you to "take lesson" or "add lesson", output the lesson rule as a plain string starting with "LESSON:".
If the user asks you to update a config value, output it as "CONFIG: key=value".
Otherwise, just answer naturally — no markdown, no bullet lists unless needed.

--- AGENT STATE ---
${context}
--- END STATE ---

User question: ${query}`;
}

export async function claudeAsk(query) {
  const context = buildContext();
  const prompt  = buildPrompt(query, context);

  const args = [
    "--print",
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { env: { ...process.env } });
    let out = "";
    let err = "";

    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });

    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
        return;
      }
      try {
        const envelope = JSON.parse(out.trim());
        if (envelope.is_error) {
          reject(new Error(`Claude error: ${envelope.result}`));
          return;
        }
        resolve((envelope.result || "").trim());
      } catch {
        // Fallback: return raw stdout if not JSON envelope
        resolve(out.trim() || "(no response)");
      }
    });

    child.on("error", reject);

    child.stdin.write(prompt);
    child.stdin.end();

    setTimeout(() => {
      child.kill();
      reject(new Error("claude-ask timed out after 3 minutes"));
    }, TIMEOUT_MS);
  });
}

// ─── Standalone run ───────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const query = process.argv.slice(2).join(" ") || "Summarize my current positions and recent performance.";
  console.log(`Query: ${query}\n`);
  claudeAsk(query)
    .then(r => { console.log("Response:\n" + r); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
