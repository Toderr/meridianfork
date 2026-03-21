/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 */

import fs from "fs";
import { log } from "./logger.js";

const BLACKLIST_FILE = "./token-blacklist.json";

function load() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
    // Filter out expired entries on load
    const now = Date.now();
    const filtered = {};
    for (const [mint, entry] of Object.entries(raw)) {
      if (entry.expires_at != null && entry.expires_at < now) continue;
      filtered[mint] = entry;
    }
    return filtered;
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist and not expired.
 * Used in screening.js before returning pools to the LLM.
 */
export function isBlacklisted(mint) {
  if (!mint) return false;
  const db = load();
  const entry = db[mint];
  if (!entry) return false;
  if (entry.expires_at != null && entry.expires_at < Date.now()) return false;
  return true;
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 * @param {string} mint - Token mint address
 * @param {string} [symbol] - Token symbol for readability
 * @param {string} [reason] - Why this token is being blacklisted
 * @param {number|null} [days] - Auto-expire after N days; null/0 = permanent
 */
export function addToBlacklist({ mint, symbol, reason = "", days = null }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (db[mint]) {
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
      added_at: db[mint].added_at,
      expires_at: db[mint].expires_at,
    };
  }

  const added_at = Date.now();
  const expires_at = (days && days > 0) ? added_at + days * 86400000 : null;

  db[mint] = {
    mint,
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at,
    expires_at,
    added_by: "agent",
  };

  save(db);
  const expiry = expires_at ? ` (expires ${new Date(expires_at).toISOString()})` : " (permanent)";
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}${expiry}`);
  return { blacklisted: true, mint, symbol, reason, added_at, expires_at };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 * Returns active (non-expired) entries only.
 */
export function listBlacklist() {
  const db = load(); // already filters expired on load
  const entries = Object.values(db).map(({ mint, symbol, reason, added_at, expires_at }) => ({
    mint,
    symbol,
    reason,
    added_at,
    expires_at,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}
