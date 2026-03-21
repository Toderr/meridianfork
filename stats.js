/**
 * Shared in-memory stats counters.
 * Imported by index.js (display) and tools/executor.js (increment on tool success).
 */
export const _stats = {
  managementCycles: 0,
  screeningCycles: 0,
  positionsDeployed: 0,
  positionsClosed: 0,
  feesClaimed: 0,
  errors: 0,
  startedAt: new Date().toISOString(),
};
