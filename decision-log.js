/**
 * Decision Log — structured record of every deploy/close/skip/no-deploy outcome.
 *
 * Lets the agent (and the user) answer "why did you...?" without re-deriving from logs.
 * Bounded ring buffer (200 entries) with atomic writes.
 *
 * appendDecision() is fire-and-forget safe: never throws, returns null on failure.
 */
import fs from "fs";
import { log } from "./logger.js";

const FILE = "./decision-log.json";
const MAX_ENTRIES = 200;
const MAX_SUMMARY = 280;
const MAX_REASON  = 500;
const MAX_RISK    = 140;

const VALID_TYPES  = new Set(["deploy", "close", "claim", "skip", "no_deploy", "note"]);
const VALID_ACTORS = new Set(["SCREENER", "MANAGER", "RULE_ENGINE", "PNL_CHECKER", "AGENT", "USER", "GENERAL"]);

function load() {
  if (!fs.existsSync(FILE)) return { decisions: [] };
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!data || !Array.isArray(data.decisions)) return { decisions: [] };
    return data;
  } catch (e) {
    log("decision_log_warn", `Invalid ${FILE}: ${e.message} — starting fresh`);
    return { decisions: [] };
  }
}

function save(data) {
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    log("decision_log_error", `save failed: ${e.message}`);
  }
}

function sanitize(value, maxLen = MAX_SUMMARY) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim().slice(0, maxLen);
  return s || null;
}

function sanitizeMetrics(m) {
  if (!m || typeof m !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (v == null) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 120);
  }
  return out;
}

/**
 * Append a decision. Always safe — wraps every failure.
 *
 * @param {Object}   entry
 * @param {string}   entry.type     - "deploy" | "close" | "claim" | "skip" | "no_deploy" | "note"
 * @param {string}   entry.actor    - "SCREENER" | "MANAGER" | "RULE_ENGINE" | "PNL_CHECKER" | "AGENT" | "USER" | "GENERAL"
 * @param {string}  [entry.pool]
 * @param {string}  [entry.pool_name]
 * @param {string}  [entry.position]
 * @param {string}  [entry.summary]
 * @param {string}  [entry.reason]
 * @param {string[]}[entry.risks]
 * @param {Object}  [entry.metrics]
 * @returns {Object|null}
 */
export function appendDecision(entry) {
  try {
    if (!entry || typeof entry !== "object") return null;
    const type  = VALID_TYPES.has(entry.type)   ? entry.type  : "note";
    const actor = VALID_ACTORS.has(entry.actor) ? entry.actor : "AGENT";
    const decision = {
      id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      type,
      actor,
      pool: entry.pool || null,
      pool_name: sanitize(entry.pool_name || entry.pool, 120),
      position: entry.position || null,
      summary: sanitize(entry.summary, MAX_SUMMARY),
      reason: sanitize(entry.reason, MAX_REASON),
      risks: Array.isArray(entry.risks)
        ? entry.risks.map(r => sanitize(r, MAX_RISK)).filter(Boolean).slice(0, 6)
        : [],
      metrics: sanitizeMetrics(entry.metrics),
    };
    const data = load();
    data.decisions.unshift(decision);
    if (data.decisions.length > MAX_ENTRIES) data.decisions = data.decisions.slice(0, MAX_ENTRIES);
    save(data);
    return decision;
  } catch (e) {
    log("decision_log_error", `appendDecision failed: ${e.message}`);
    return null;
  }
}

/**
 * Get recent decisions, optionally filtered.
 * @param {Object} opts
 * @param {number} [opts.limit=10]   - Clamped to [1, 50]
 * @param {string} [opts.type]
 * @param {string} [opts.actor]
 * @param {string} [opts.position]
 */
export function getRecentDecisions({ limit = 10, type = null, actor = null, position = null } = {}) {
  try {
    const n = Math.max(1, Math.min(50, parseInt(limit) || 10));
    const data = load();
    let out = data.decisions || [];
    if (type)     out = out.filter(d => d.type === type);
    if (actor)    out = out.filter(d => d.actor === actor);
    if (position) out = out.filter(d => d.position === position);
    return out.slice(0, n);
  } catch (e) {
    log("decision_log_error", `getRecentDecisions failed: ${e.message}`);
    return [];
  }
}

/**
 * Compact one-line-per-decision summary for prompt injection / Telegram.
 * Returns null when the log is empty (so caller can omit the section).
 */
export function getDecisionSummary(limit = 6) {
  const decisions = getRecentDecisions({ limit });
  if (!decisions.length) return null;
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || (d.pool ? d.pool.slice(0, 8) : "—")}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason  ? `reason: ${d.reason}`   : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
