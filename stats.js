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
    fs.writeFileSync(STATS_FILE, JSON.stringify(toSave));
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
