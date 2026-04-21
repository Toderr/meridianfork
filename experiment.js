/**
 * Experiment Tier — Strategy Optimization Loop
 *
 * A self-contained system that iterates on a single pool: deploy → wait for
 * close → analyze → redeploy with optimized params → repeat until convergence.
 *
 * Experiment positions participate in the regular management cycle normally.
 * Only the PnL checker uses experiment-specific TP/SL/time-limit thresholds.
 *
 * State persisted to experiments.json (gitignored runtime file).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS_FILE = path.join(__dirname, "experiments.json");

// ─── Default parameter space to search ───────────────────────────
const DEFAULT_PARAMETER_SPACE = {
  strategy:   ["bid_ask", "spot"],
  bins_below: [30, 50, 69, 100],
  bins_above: [0], // HARDCODED single-sided SOL — upside bins always 0
};

// ─── Default experiment-specific rules ──────────────────────────
const DEFAULT_RULES = {
  takeProfitFeePct:      3,    // lower TP to close faster and iterate
  fastTpPct:             8,
  emergencyPriceDropPct: -30,
  maxMinutesHeld:        120,  // force-close after 2h to keep loop moving
  trailingActivate:      4,
  trailingFloor:         3,
};

// ─── State helpers ────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(EXPERIMENTS_FILE)) return { experiments: {} };
  try {
    return JSON.parse(fs.readFileSync(EXPERIMENTS_FILE, "utf8"));
  } catch {
    return { experiments: {} };
  }
}

function save(data) {
  const tmp = EXPERIMENTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, EXPERIMENTS_FILE);
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Start a new experiment on a pool.
 * Deploys iteration 1 immediately with initial parameters.
 */
export async function startExperiment({
  pool_address,
  pool_name,
  base_mint,
  bin_step,
  deploy_amount_sol,
  max_iterations,
  convergence_window,
  rules,
  parameter_space,
}) {
  if (!pool_address) return { error: "pool_address is required" };

  const data = load();
  // Check if a running experiment already exists for this pool
  const existing = Object.values(data.experiments).find(
    e => e.pool === pool_address && e.status === "running"
  );
  if (existing) {
    return { error: `Experiment ${existing.id} is already running on this pool. Cancel it first.` };
  }

  const id = `exp_${Date.now()}`;
  const now = new Date().toISOString();

  const exp = {
    id,
    pool: pool_address,
    pool_name: pool_name || pool_address.slice(0, 8),
    base_mint: base_mint || null,
    bin_step: bin_step || null,
    status: "running",
    created_at: now,
    updated_at: now,
    deploy_amount_sol: deploy_amount_sol ?? 0.3,
    max_iterations: max_iterations ?? 20,
    convergence_window: convergence_window ?? 3,
    best_pnl_pct: null,
    best_score: null,
    best_iteration: null,
    iterations_without_improvement: 0,
    active_position: null,
    rules: { ...DEFAULT_RULES, ...(rules || {}) },
    parameter_space: { ...DEFAULT_PARAMETER_SPACE, ...(parameter_space || {}) },
    iterations: [],
  };

  data.experiments[id] = exp;
  save(data);
  log("experiment", `Started experiment ${id} on ${exp.pool_name}`);

  // Deploy iteration 1 with initial params
  const initParams = getInitialParams(exp.parameter_space);
  const deployResult = await deployIteration(exp, initParams, 1);

  if (deployResult.error) {
    // Mark failed if first deploy failed
    const d2 = load();
    d2.experiments[id].status = "failed";
    d2.experiments[id].updated_at = new Date().toISOString();
    save(d2);
    return { error: `Failed to deploy iteration 1: ${deployResult.error}`, experiment_id: id };
  }

  return {
    experiment_id: id,
    pool_name: exp.pool_name,
    deploy_amount_sol: exp.deploy_amount_sol,
    max_iterations: exp.max_iterations,
    initial_params: initParams,
    position: deployResult.position,
    message: `Experiment started. Iteration 1 deployed with ${initParams.strategy}, bins_below=${initParams.bins_below}, bins_above=${initParams.bins_above}. Will auto-iterate on close.`,
  };
}

/**
 * Get a single experiment by ID.
 */
export function getExperiment(id) {
  const data = load();
  const exp = data.experiments[id];
  if (!exp) return { error: `Experiment ${id} not found` };
  return { ...exp, total_iterations: exp.iterations.length };
}

/**
 * List all experiments, optionally filtered by status.
 */
export function listExperiments({ status } = {}) {
  const data = load();
  const all = Object.values(data.experiments);
  const filtered = status ? all.filter(e => e.status === status) : all;
  return filtered.map(e => ({
    id: e.id,
    pool_name: e.pool_name,
    pool: e.pool,
    status: e.status,
    current_iteration: e.iterations.length,
    max_iterations: e.max_iterations,
    best_pnl_pct: e.best_pnl_pct,
    best_iteration: e.best_iteration,
    active_position: e.active_position,
    created_at: e.created_at,
  }));
}

/**
 * Pause an experiment (stops auto-redeploy after next close).
 */
export function pauseExperiment(id) {
  const data = load();
  if (!data.experiments[id]) return { error: `Experiment ${id} not found` };
  if (data.experiments[id].status !== "running") return { error: `Experiment is not running (status: ${data.experiments[id].status})` };
  data.experiments[id].status = "paused";
  data.experiments[id].updated_at = new Date().toISOString();
  save(data);
  return { paused: true, id };
}

/**
 * Resume a paused experiment — redeploys next iteration immediately.
 */
export async function resumeExperiment(id) {
  const data = load();
  const exp = data.experiments[id];
  if (!exp) return { error: `Experiment ${id} not found` };
  if (exp.status !== "paused") return { error: `Experiment is not paused (status: ${exp.status})` };

  data.experiments[id].status = "running";
  data.experiments[id].updated_at = new Date().toISOString();
  save(data);

  // Re-analyze and deploy next iteration
  const fresh = load().experiments[id];
  const { next_params, analysis } = analyzeAndOptimize(fresh);
  const nextN = fresh.iterations.length + 1;
  const deployResult = await deployIteration(fresh, next_params, nextN);
  if (deployResult.error) return { error: deployResult.error };

  return { resumed: true, id, iteration: nextN, params: next_params, analysis };
}

/**
 * Cancel an experiment. Does NOT close the active position automatically
 * (let the agent handle that via normal management).
 */
export function cancelExperiment(id) {
  const data = load();
  if (!data.experiments[id]) return { error: `Experiment ${id} not found` };
  data.experiments[id].status = "cancelled";
  data.experiments[id].updated_at = new Date().toISOString();
  save(data);
  log("experiment", `Experiment ${id} cancelled`);
  return { cancelled: true, id, note: "Active position (if any) remains open — manage it normally." };
}

/**
 * Look up an experiment by the position address currently deployed in it.
 * Used by the PnL checker to apply experiment-specific thresholds.
 */
export function getExperimentByPosition(position_address) {
  const data = load();
  return Object.values(data.experiments).find(
    e => e.active_position === position_address && e.status === "running"
  ) || null;
}

// ─── Iteration Engine ─────────────────────────────────────────────

/**
 * Called from the close pipeline (executor.js) when a position whose variant
 * starts with "exp_" is closed. Records the result, decides the next iteration
 * or marks convergence.
 *
 * Fire-and-forget — never throws.
 */
export async function onExperimentPositionClosed(position_address, closeResult) {
  try {
    const data = load();
    const exp = Object.values(data.experiments).find(
      e => e.active_position === position_address
    );
    if (!exp) return; // not an active experiment position

    const id = exp.id;
    log("experiment", `Experiment ${id}: position ${position_address.slice(0, 8)} closed`);

    // Find the active iteration entry and fill in result
    const iterEntry = exp.iterations.find(
      it => it.position === position_address && it.status === "active"
    );
    if (iterEntry) {
      iterEntry.status = "closed";
      iterEntry.closed_at = new Date().toISOString();
      iterEntry.result = {
        pnl_pct:          closeResult.pnl_pct          ?? 0,
        pnl_usd:          closeResult.pnl_usd          ?? 0,
        fees_earned_usd:  closeResult.fees_earned_usd  ?? 0,
        range_efficiency: closeResult.range_efficiency ?? 0,
        minutes_held:     closeResult.minutes_held     ?? 0,
        close_reason:     closeResult.close_reason     || "unknown",
      };
    }

    // Clear active position
    exp.active_position = null;
    exp.updated_at = new Date().toISOString();

    // If paused or cancelled, stop here
    if (exp.status !== "running") {
      save(data);
      return;
    }

    // Analyze & decide next action
    const { next_params, analysis, should_stop } = analyzeAndOptimize(exp);
    if (iterEntry) iterEntry.analysis = analysis;

    // Update best result tracking
    const score = computeScore(iterEntry?.result);
    if (exp.best_score === null || score > exp.best_score) {
      exp.best_score = score;
      exp.best_pnl_pct = iterEntry?.result?.pnl_pct ?? null;
      exp.best_iteration = iterEntry?.iteration ?? null;
      exp.iterations_without_improvement = 0;
    } else {
      exp.iterations_without_improvement = (exp.iterations_without_improvement || 0) + 1;
    }

    save(data);

    if (should_stop || checkConvergence(exp)) {
      await finalizeExperiment(id);
      return;
    }

    // Deploy next iteration
    const nextN = exp.iterations.length + 1;
    const freshExp = load().experiments[id];
    const deployResult = await deployIteration(freshExp, next_params, nextN);

    // Notify main bot + journal bot
    const iterPayload = {
      experimentId: id,
      poolName: exp.pool_name,
      iteration: nextN,
      prevResult: iterEntry?.result,
      params: next_params,
      analysis,
      deploySuccess: !deployResult.error,
    };
    try {
      const { notifyExperimentIteration } = await import("./telegram.js");
      await notifyExperimentIteration(iterPayload).catch(() => {});
    } catch {}
    try {
      const { notifyJournalExperimentIteration } = await import("./telegram-journal.js");
      await notifyJournalExperimentIteration(iterPayload).catch(() => {});
    } catch {}

  } catch (err) {
    log("experiment_error", `onExperimentPositionClosed failed: ${err.message}`);
  }
}

// ─── Optimizer ────────────────────────────────────────────────────

/**
 * Deterministic hill-climbing optimizer.
 * Returns { next_params, analysis, should_stop }.
 */
export function analyzeAndOptimize(exp) {
  const closedIters = exp.iterations.filter(it => it.status === "closed" && it.result);
  const space = exp.parameter_space;

  if (closedIters.length === 0) {
    return {
      next_params: getInitialParams(space),
      analysis: "First iteration — starting with default parameters.",
      should_stop: false,
    };
  }

  // Score all iterations
  const scored = closedIters.map(it => ({
    ...it,
    score: computeScore(it.result),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const tried = new Set(exp.iterations.map(it => paramKey(it.params)));

  // Round-robin parameter mutation: strategy → bins_below → bins_above
  const mutationOrder = ["strategy", "bins_below", "bins_above"];
  const totalMutations = closedIters.length - 1; // 0-indexed
  const mutationIdx = totalMutations % mutationOrder.length;
  const paramToMutate = mutationOrder[mutationIdx];

  // Try all values for the chosen param, keeping others from best
  const candidates = (space[paramToMutate] || []).map(val => ({
    strategy:   paramToMutate === "strategy"   ? val : best.params.strategy,
    bins_below: paramToMutate === "bins_below" ? val : best.params.bins_below,
    bins_above: paramToMutate === "bins_above" ? val : best.params.bins_above,
    amount_sol: exp.deploy_amount_sol,
  })).filter(c => !tried.has(paramKey(c)));

  if (candidates.length > 0) {
    // Pick the first untried candidate (closest to best)
    const next_params = candidates[0];
    const analysis = buildAnalysis(best, scored, paramToMutate, next_params);
    return { next_params, analysis, should_stop: false };
  }

  // All single-param neighbors tried — try cross of top-2 if available
  if (scored.length >= 2) {
    const second = scored[1];
    const cross = {
      strategy:   best.params.strategy,
      bins_below: second.params.bins_below,
      bins_above: second.params.bins_above,
      amount_sol: exp.deploy_amount_sol,
    };
    if (!tried.has(paramKey(cross))) {
      const analysis = `All single-param variants tried. Combining best strategy (${cross.strategy}) with top-2 range (bins_below=${cross.bins_below}, bins_above=${cross.bins_above}).`;
      return { next_params: cross, analysis, should_stop: false };
    }
  }

  // All combinations exhausted — converged
  return {
    next_params: best.params,
    analysis: `All parameter combinations in the search space have been explored. Best: iteration ${best.iteration} with score ${best.score.toFixed(2)} (pnl=${best.result.pnl_pct?.toFixed(1)}%, range_eff=${best.result.range_efficiency?.toFixed(0)}%).`,
    should_stop: true,
  };
}

/**
 * Returns true if the experiment has converged and should stop.
 */
export function checkConvergence(exp) {
  if (exp.iterations.length >= exp.max_iterations) return true;
  if (exp.iterations_without_improvement >= exp.convergence_window) return true;
  return false;
}

// ─── Internals ────────────────────────────────────────────────────

function getInitialParams(space) {
  return {
    strategy:   space.strategy?.[0]   ?? "bid_ask",
    bins_below: space.bins_below?.[0] ?? 69,
    bins_above: space.bins_above?.[0] ?? 0,
    amount_sol: null, // filled by deployIteration
  };
}

function paramKey(params) {
  return `${params.strategy}|${params.bins_below}|${params.bins_above}`;
}

/** Composite score: 60% pnl, 40% range efficiency (both normalized to [0,1]).
 *  Losses are penalized asymmetrically — a -10% loss scores much worse than a +10% gain. */
function computeScore(result) {
  if (!result) return 0;
  const pnl = result.pnl_pct ?? 0;
  // Asymmetric normalization: gains map linearly 0.5→1.0, losses are penalized 2x harder (0.5→0.0 faster)
  let pnlNorm;
  if (pnl >= 0) {
    pnlNorm = 0.5 + Math.min(pnl, 100) / 200; // +100% → 1.0
  } else {
    pnlNorm = Math.max(0, 0.5 + pnl / 100);    // -50% → 0.0 (2x penalty vs gains)
  }
  // range_efficiency: 0-100% → 0-1
  const effNorm = Math.max(0, Math.min(1, (result.range_efficiency || 0) / 100));
  return 0.6 * pnlNorm + 0.4 * effNorm;
}

function buildAnalysis(best, scored, paramMutated, next_params) {
  const worst = scored[scored.length - 1];
  return (
    `Best so far: iteration ${best.iteration} (${best.params.strategy}, bins_below=${best.params.bins_below}, bins_above=${best.params.bins_above}) ` +
    `— pnl=${best.result.pnl_pct?.toFixed(1)}%, range_eff=${best.result.range_efficiency?.toFixed(0)}%. ` +
    `Worst: iteration ${worst.iteration} (pnl=${worst.result.pnl_pct?.toFixed(1)}%). ` +
    `Mutating ${paramMutated} → ${next_params[paramMutated]}.`
  );
}

async function deployIteration(exp, params, iterationN) {
  try {
    const { executeTool } = await import("./tools/executor.js");

    const deployArgs = {
      pool_address:   exp.pool,
      pool_name:      exp.pool_name,
      base_mint:      exp.base_mint || undefined,
      bin_step:       exp.bin_step  || undefined,
      amount_y:       exp.deploy_amount_sol,
      strategy:       params.strategy,
      bins_below:     params.bins_below,
      bins_above:     params.bins_above,
      variant:        exp.id,
      confidence_level: 10, // bypass confidence gate for experiments
    };

    const result = await executeTool("deploy_position", deployArgs);

    if (result?.error) {
      log("experiment", `Experiment ${exp.id} iteration ${iterationN} deploy failed: ${result.error}`);
      return { error: result.error };
    }

    if (!result?.position) {
      return { error: "deploy_position returned no position address" };
    }

    // Record the iteration entry
    const data = load();
    const e = data.experiments[exp.id];
    if (e) {
      e.iterations.push({
        iteration:   iterationN,
        position:    result.position,
        params:      { ...params, amount_sol: exp.deploy_amount_sol },
        deployed_at: new Date().toISOString(),
        closed_at:   null,
        result:      null,
        analysis:    null,
        status:      "active",
      });
      e.active_position = result.position;
      e.updated_at = new Date().toISOString();
      save(data);
    }

    log("experiment", `Experiment ${exp.id} iteration ${iterationN} deployed: ${result.position?.slice(0, 8)}`);
    return { position: result.position };
  } catch (err) {
    log("experiment_error", `deployIteration failed: ${err.message}`);
    return { error: err.message };
  }
}

async function finalizeExperiment(id) {
  const data = load();
  const exp = data.experiments[id];
  if (!exp) return;

  const closedIters = exp.iterations.filter(it => it.status === "closed" && it.result);
  let convergenceReason = "unknown";
  if (exp.iterations.length >= exp.max_iterations) convergenceReason = `max iterations (${exp.max_iterations}) reached`;
  else if (exp.iterations_without_improvement >= exp.convergence_window) convergenceReason = `${exp.iterations_without_improvement} iterations without improvement`;
  else convergenceReason = "all parameter combinations exhausted";

  exp.status = "converged";
  exp.updated_at = new Date().toISOString();
  save(data);

  log("experiment", `Experiment ${id} converged: ${convergenceReason}`);

  // Find best iteration
  const scored = closedIters
    .map(it => ({ ...it, score: computeScore(it.result) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];

  // Send Telegram convergence report (main bot + journal bot)
  const report = generateExperimentReport(exp);
  let experimentLessons = [];
  try {
    const { getExperimentLessons } = await import("./lessons.js");
    experimentLessons = getExperimentLessons(id);
  } catch {}

  const convPayload = {
    experimentId: id,
    poolName: exp.pool_name,
    bestParams: best?.params,
    bestPnlPct: best?.result?.pnl_pct,
    bestRangeEff: best?.result?.range_efficiency,
    totalIterations: exp.iterations.length,
    convergenceReason,
    report,
    experimentLessons,
  };
  try {
    const { notifyExperimentConverged } = await import("./telegram.js");
    await notifyExperimentConverged(convPayload).catch(() => {});
  } catch {}
  try {
    const { notifyJournalExperimentConverged } = await import("./telegram-journal.js");
    await notifyJournalExperimentConverged(convPayload).catch(() => {});
  } catch {}
}

/**
 * Generate a human-readable iteration progression report.
 */
export function generateExperimentReport(exp) {
  const lines = [`Experiment: ${exp.pool_name} (${exp.id})`];
  lines.push(`Status: ${exp.status} | Iterations: ${exp.iterations.length}/${exp.max_iterations}`);
  lines.push("");

  const closed = exp.iterations.filter(it => it.result);
  if (closed.length === 0) {
    lines.push("No completed iterations yet.");
    return lines.join("\n");
  }

  const scored = closed.map(it => ({ ...it, score: computeScore(it.result) })).sort((a, b) => b.score - a.score);

  lines.push("Iterations (best first):");
  for (const it of scored) {
    const r = it.result;
    lines.push(
      `  #${it.iteration}: ${it.params.strategy} bins=${it.params.bins_below}↓/${it.params.bins_above}↑ ` +
      `pnl=${(r.pnl_pct >= 0 ? "+" : "")}${r.pnl_pct?.toFixed(1)}% ` +
      `range_eff=${r.range_efficiency?.toFixed(0)}% ` +
      `held=${r.minutes_held}m`
    );
  }

  const best = scored[0];
  if (best) {
    lines.push("");
    lines.push(`Best: #${best.iteration} — ${best.params.strategy}, bins_below=${best.params.bins_below}, bins_above=${best.params.bins_above}`);
    lines.push(`  pnl=${(best.result.pnl_pct >= 0 ? "+" : "")}${best.result.pnl_pct?.toFixed(1)}%, range_eff=${best.result.range_efficiency?.toFixed(0)}%`);
  }

  return lines.join("\n");
}
