/**
 * Screening Cache — in-memory store for token characteristics captured during screening.
 *
 * When the screener enriches candidates (holders, OKX, smart wallets, momentum, etc.),
 * we cache those characteristics by pool address. When deploy_position is called,
 * the executor looks up the cache and attaches the data to the tracked position.
 *
 * This allows lessons to analyze performance by token characteristics
 * (e.g., "tokens with mcap < $50k work best with bid_ask").
 *
 * Cache is in-memory only — survives the screening→deploy window (seconds),
 * evicts entries older than 30 minutes to prevent stale data.
 */

const _cache = new Map();
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Store enrichment data for a pool.
 * @param {string} poolAddress
 * @param {Object} data — token characteristics from screening enrichment
 */
export function cacheTokenProfile(poolAddress, data) {
  if (!poolAddress || !data) return;
  _cache.set(poolAddress, { ...data, _cached_at: Date.now() });
  // Evict stale entries
  for (const [key, val] of _cache) {
    if (Date.now() - val._cached_at > MAX_AGE_MS) _cache.delete(key);
  }
}

/**
 * Retrieve and consume cached enrichment data for a pool.
 * Returns null if not found or stale.
 * @param {string} poolAddress
 * @returns {Object|null}
 */
export function getTokenProfile(poolAddress) {
  if (!poolAddress) return null;
  const entry = _cache.get(poolAddress);
  if (!entry) return null;
  if (Date.now() - entry._cached_at > MAX_AGE_MS) {
    _cache.delete(poolAddress);
    return null;
  }
  const { _cached_at, ...data } = entry;
  return data;
}
