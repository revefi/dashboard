// In-memory cache for /api/data, plus the cache-aware getData() wrapper.
// Other modules (routes.js, restack.js) reset the cache by mutating
// `cache.ts = 0` — works because they share the same object reference.

const fs = require("fs");
const { CACHE_TTL_MS, STACK_NAMES_CACHE_FILE } = require("./config");
const { buildModel } = require("./model");

const cache = { ts: 0, data: null, building: null };

function clearClaudeBackedCaches() {
  // Stack names are the only Claude-backed disk cache now (Jira goes through
  // direct REST).
  try {
    fs.unlinkSync(STACK_NAMES_CACHE_FILE);
  } catch {
    /* file may not exist */
  }
}

async function getData(forceRefresh = false, opts = {}) {
  if (opts.intelligent) clearClaudeBackedCaches();

  const now = Date.now();
  if (
    !forceRefresh &&
    !opts.intelligent &&
    cache.data &&
    now - cache.ts < CACHE_TTL_MS
  ) {
    return cache.data;
  }
  if (cache.building) return cache.building;
  cache.building = (async () => {
    try {
      const data = await buildModel();
      cache.ts = Date.now();
      cache.data = data;
      cache.building = null;
      return data;
    } catch (err) {
      cache.building = null;
      throw err;
    }
  })();
  return cache.building;
}

module.exports = { cache, getData, clearClaudeBackedCaches };
