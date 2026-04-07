/**
 * Dashboard API endpoint handlers.
 * All handlers receive (req, res, url) and must write the full response.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getJournalEntries, removeJournalEntry, updateJournalEntry } from "../journal.js";
import { getMyPositions } from "../tools/dlmm.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTrackedPositions, getStateSummary } from "../state.js";
import { getPerformanceSummary, listLessons, removeLesson, updateLessonFields, getLessonRuleType, addLesson } from "../lessons.js";
import { extractRules } from "../lesson-rules.js";
import { _stats } from "../stats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_PATH = path.join(__dirname, "../lessons.json");
const EXP_LESSONS_PATH = path.join(__dirname, "../experiment-lessons.json");
const LOGS_DIR = path.join(__dirname, "../logs");

// ─── Simple TTL cache ──────────────────────────────────────────────────────
function makeCache(ttlMs) {
  let value = null;
  let expiresAt = 0;
  return {
    async get(fn) {
      if (Date.now() < expiresAt) return value;
      value = await fn();
      expiresAt = Date.now() + ttlMs;
      return value;
    },
    invalidate() { expiresAt = 0; },
  };
}

const walletCache    = makeCache(60_000);
const positionsCache = makeCache(60_000);
const portfolioCache = makeCache(60_000);

// ─── JSON response helper ──────────────────────────────────────────────────
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function err(res, message, status = 500) {
  json(res, { error: message }, status);
}

// ─── Portfolio metrics computation ────────────────────────────────────────
function computePortfolio(closes) {
  if (!closes.length) {
    return {
      net_pnl_usd: 0, net_pnl_sol: 0, net_pnl_pct: 0,
      win_rate_pct: 0, day_win_rate_pct: 0, profit_factor: null,
      calendar: {}, cumulative: [], total_closes: 0,
    };
  }

  let totalPnlUsd = 0, totalPnlSol = 0, totalInitUsd = 0;
  let posGross = 0, negGross = 0, wins = 0;
  const byDay = {}, byDaySol = {}, byDayInitUsd = {};
  const sorted = [...closes].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (const c of sorted) {
    const feesUsd = c.fees_earned_usd ?? 0;
    const pnlUsd = (c.pnl_usd ?? 0) + feesUsd;
    const pnlSol = (c.pnl_sol ?? 0) + (c.sol_price > 0 ? feesUsd / c.sol_price : 0);
    totalPnlUsd += pnlUsd;
    totalPnlSol += pnlSol;
    totalInitUsd += c.initial_value_usd ?? 0;
    if (pnlUsd > 0) { posGross += pnlUsd; wins++; }
    else negGross += Math.abs(pnlUsd);

    const day = (c.timestamp || "").slice(0, 10);
    if (day) {
      byDay[day] = (byDay[day] ?? 0) + pnlUsd;
      byDaySol[day] = +(((byDaySol[day] ?? 0) + pnlSol).toFixed(6));
      byDayInitUsd[day] = (byDayInitUsd[day] ?? 0) + (c.initial_value_usd ?? 0);
    }
  }

  // Per-day PnL% for calendar cells
  const calendarPct = {};
  for (const [day, pnl] of Object.entries(byDay)) {
    const init = byDayInitUsd[day];
    calendarPct[day] = init > 0 ? +((pnl / init) * 100).toFixed(2) : 0;
  }

  // Day win rate
  const days = Object.values(byDay);
  const dayWins = days.filter(v => v > 0).length;
  const dayWinRate = days.length ? (dayWins / days.length) * 100 : 0;

  // Profit factor
  const profitFactor = negGross > 0 ? posGross / negGross : null;

  // Cumulative series
  let cumUsd = 0, cumSol = 0;
  const cumulative = sorted.map(c => {
    const cFees = c.fees_earned_usd ?? 0;
    cumUsd += (c.pnl_usd ?? 0) + cFees;
    cumSol += (c.pnl_sol ?? 0) + (c.sol_price > 0 ? cFees / c.sol_price : 0);
    return { date: c.timestamp, cum_usd: +cumUsd.toFixed(4), cum_sol: +cumSol.toFixed(6) };
  });

  return {
    net_pnl_usd:       +totalPnlUsd.toFixed(2),
    net_pnl_sol:       +totalPnlSol.toFixed(6),
    net_pnl_pct:       totalInitUsd > 0 ? +((totalPnlUsd / totalInitUsd) * 100).toFixed(2) : 0,
    win_rate_pct:      +((wins / closes.length) * 100).toFixed(1),
    day_win_rate_pct:  +dayWinRate.toFixed(1),
    profit_factor:     profitFactor !== null ? +profitFactor.toFixed(2) : null,
    calendar:          byDay,
    calendar_sol:      byDaySol,
    calendar_pct:      calendarPct,
    cumulative,
    total_closes:      closes.length,
  };
}

// ─── Endpoint handlers ────────────────────────────────────────────────────

export async function handleStats(req, res) {
  try {
    const summary = getStateSummary();
    const perf    = getPerformanceSummary();
    const uptimeMs = Date.now() - new Date(_stats.startedAt).getTime();

    json(res, {
      uptime_min:        Math.floor(uptimeMs / 60_000),
      started_at:        _stats.startedAt,
      management_cycles: _stats.managementCycles,
      screening_cycles:  _stats.screeningCycles,
      positions_deployed:_stats.positionsDeployed,
      positions_closed:  _stats.positionsClosed,
      fees_claimed:      _stats.feesClaimed,
      errors:            _stats.errors,
      open_positions:    summary.open_positions,
      closed_positions:  summary.closed_positions,
      total_fees_usd:    summary.total_fees_claimed_usd,
      win_rate_pct:      perf?.win_rate_pct ?? null,
      total_pnl_usd:     perf?.total_pnl_usd ?? null,
      profit_factor:     perf ? null : null, // computed in portfolio
    });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleWallet(req, res) {
  try {
    const data = await walletCache.get(() => getWalletBalances());
    json(res, data);
  } catch (e) {
    err(res, e.message);
  }
}

export async function handlePositions(req, res) {
  try {
    const [live, tracked] = await Promise.all([
      positionsCache.get(() => getMyPositions()),
      Promise.resolve(getTrackedPositions(true)),
    ]);

    const trackedMap = Object.fromEntries(tracked.map(t => [t.position, t]));
    const positions  = (live?.positions || []).map(p => ({
      ...p,
      ...(trackedMap[p.position] || {}),
    }));

    json(res, { total: positions.length, positions });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handlePortfolio(req, res) {
  try {
    const data = await portfolioCache.get(async () => {
      const closes = getJournalEntries({ type: "close" });
      return computePortfolio(closes);
    });
    json(res, data);
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleHistory(req, res) {
  try {
    const closes = getJournalEntries({ type: "close" });
    closes.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    json(res, { total: closes.length, entries: closes });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleJournal(req, res, url) {
  try {
    const params = url.searchParams;
    const filter = {};
    if (params.get("type")) filter.type = params.get("type");
    if (params.get("from")) filter.from = params.get("from");
    if (params.get("to"))   filter.to   = params.get("to");
    const entries = getJournalEntries(filter);
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    json(res, { total: entries.length, entries });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleLessons(req, res, url) {
  try {
    const source = url?.searchParams?.get("source"); // "regular", "experiment", or null (all)
    let lessons = [];
    if (source !== "experiment" && fs.existsSync(LESSONS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
      lessons.push(...(raw.lessons || []));
    }
    if (source !== "regular" && fs.existsSync(EXP_LESSONS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(EXP_LESSONS_PATH, "utf8"));
      lessons.push(...(raw.lessons || []));
    }
    lessons.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")); // newest first
    // Attach extracted rule enforcement info per lesson
    let enforcedMap = {};
    try {
      const { screening, management } = extractRules("MANAGER");
      for (const r of [...screening, ...management]) {
        if (r.lesson_id) enforcedMap[r.lesson_id] = { type: r.type, ...(r.threshold_pct != null ? { threshold_pct: r.threshold_pct } : {}), ...(r.strategy ? { strategy: r.strategy } : {}) };
      }
    } catch {}
    const enriched = lessons.map(l => ({ ...l, rule_type: getLessonRuleType(l.rule), enforced: enforcedMap[l.id] || null }));
    json(res, { total: enriched.length, lessons: enriched });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleUpdateLesson(req, res, pathname) {
  try {
    const id = parseInt(pathname.split("/").pop(), 10);
    if (!id || isNaN(id)) { err(res, "Invalid lesson ID", 400); return; }
    const body = await readBody(req);
    const fields = JSON.parse(body);
    const updated = updateLessonFields(id, fields);
    if (!updated) { err(res, "Lesson not found", 404); return; }
    json(res, { ok: true, lesson: { ...updated, rule_type: getLessonRuleType(updated.rule) } });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleDeleteLesson(req, res, pathname) {
  try {
    const id = parseInt(pathname.split("/").pop(), 10);
    if (!id || isNaN(id)) { err(res, "Invalid lesson ID", 400); return; }
    const removed = removeLesson(id);
    if (!removed) { err(res, "Lesson not found", 404); return; }
    json(res, { ok: true, removed });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleCreateLesson(req, res) {
  try {
    const body = await readBody(req);
    const { rule, tags, pinned, role, category } = JSON.parse(body);
    if (!rule?.trim()) { err(res, "Rule text is required", 400); return; }
    addLesson(rule.trim(), tags || [], { pinned: !!pinned, role: role || null, category: category || null });
    json(res, { ok: true });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleBulkDeleteLessons(req, res) {
  try {
    const body = await readBody(req);
    const { ids } = JSON.parse(body);
    if (!Array.isArray(ids) || !ids.length) { err(res, "ids array is required", 400); return; }
    const results = ids.map(id => ({ id, removed: !!removeLesson(id) }));
    json(res, { ok: true, results });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleDeleteJournal(req, res, pathname) {
  try {
    const id = parseInt(pathname.split("/").pop(), 10);
    if (!id || isNaN(id)) { err(res, "Invalid journal entry ID", 400); return; }
    const removed = removeJournalEntry(id);
    if (!removed) { err(res, "Journal entry not found", 404); return; }
    portfolioCache.invalidate();
    json(res, { ok: true, removed });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleUpdateJournal(req, res, pathname) {
  try {
    const id = parseInt(pathname.split("/").pop(), 10);
    if (!id || isNaN(id)) { err(res, "Invalid journal entry ID", 400); return; }
    const body = await readBody(req);
    const fields = JSON.parse(body);
    const updated = updateJournalEntry(id, fields);
    if (!updated) { err(res, "Journal entry not found", 404); return; }
    portfolioCache.invalidate();
    json(res, { ok: true, entry: updated });
  } catch (e) {
    err(res, e.message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export async function handleLogs(req, res, url) {
  try {
    const params = url.searchParams;
    const date   = params.get("date") || new Date().toISOString().slice(0, 10);
    const lines  = Math.min(parseInt(params.get("lines") || "200"), 1000);
    const file   = path.join(LOGS_DIR, `agent-${date}.log`);

    if (!fs.existsSync(file)) {
      json(res, { date, lines: [] });
      return;
    }

    const content = fs.readFileSync(file, "utf8");
    const all     = content.split("\n").filter(Boolean);
    const tail    = all.slice(-lines);
    json(res, { date, total: all.length, lines: tail });
  } catch (e) {
    err(res, e.message);
  }
}

export async function handleActions(req, res, url) {
  try {
    const params = url.searchParams;
    const date   = params.get("date") || new Date().toISOString().slice(0, 10);
    const limit  = Math.min(parseInt(params.get("limit") || "100"), 500);
    const tool   = params.get("tool") || null; // optional filter by tool name
    const file   = path.join(LOGS_DIR, `actions-${date}.jsonl`);

    if (!fs.existsSync(file)) {
      json(res, { date, total: 0, actions: [] });
      return;
    }

    const content = fs.readFileSync(file, "utf8");
    let actions = content.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (tool) actions = actions.filter(a => a.tool === tool);

    const total = actions.length;
    const tail = actions.slice(-limit).reverse(); // newest first
    json(res, { date, total, actions: tail });
  } catch (e) {
    err(res, e.message);
  }
}
