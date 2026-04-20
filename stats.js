/**
 * Shared in-memory stats counters — persisted to agent-stats.json.
 * Imported by index.js (display) and tools/executor.js (increment on tool success).
 * Uses a Proxy so every increment auto-saves; no changes needed at call sites.
 */
import fs from "fs";

const STATS_FILE = "./agent-stats.json";

function loadPersisted() {
  try {
    if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch { /* ignore */ }
  return {};
}

function savePersisted(obj) {
  try {
    const { startedAt: _, ...toSave } = obj; // don't persist startedAt — it's per-session
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(toSave));
    fs.renameSync(tmp, STATS_FILE);
  } catch { /* ignore */ }
}

const p = loadPersisted();
const _statsRaw = {
  managementCycles:  p.managementCycles  ?? 0,
  screeningCycles:   p.screeningCycles   ?? 0,
  positionsDeployed: p.positionsDeployed ?? 0,
  positionsClosed:   p.positionsClosed   ?? 0,
  feesClaimed:       p.feesClaimed       ?? 0,
  errors:            p.errors            ?? 0,
  startedAt:         new Date().toISOString(), // always current session
};

export const _stats = new Proxy(_statsRaw, {
  set(target, key, value) {
    target[key] = value;
    if (key !== "startedAt") savePersisted(target);
    return true;
  },
});

// Suppress repeated gas-low notifications until a position closes (which frees SOL)
export const _flags = {
  gasLowNotified: false,
  // Suppress repeated max-positions notifications until a position closes (which frees a slot)
  maxPositionsNotified: false,
};

// Per-position peak PnL tracker — written by the PnL checker on every pass,
// read by lessons.js at close time so the journal can record peak_pnl_pct
// and minutes_to_peak. Cleared on close. In-memory only; resets on restart.
export const _peakTracker = new Map();

export function recordPeak(positionAddress, pct) {
  if (!positionAddress || pct == null || !Number.isFinite(pct)) return;
  const prev = _peakTracker.get(positionAddress);
  if (!prev || pct > prev.peak) {
    _peakTracker.set(positionAddress, { peak: pct, at: Date.now() });
  }
}

export function consumePeak(positionAddress) {
  if (!positionAddress) return null;
  const entry = _peakTracker.get(positionAddress);
  if (!entry) return null;
  _peakTracker.delete(positionAddress);
  return entry;
}
