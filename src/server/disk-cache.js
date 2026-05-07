// Tiny TTL-aware JSON-on-disk cache. Used by claude.js (stack names) and
// recs.js (action items). Kept separate from cache.js (the in-memory model
// cache) to avoid an import cycle: cache → model → claude → disk-cache.

const fs = require("fs");

function loadDiskCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw.expiresAt && new Date(raw.expiresAt).getTime() < Date.now())
      return null;
    return raw.data;
  } catch {
    return null;
  }
}

function saveDiskCache(file, data, ttlMs) {
  try {
    const payload = {
      data,
      expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`[disk-cache] save failed for ${file}:`, err.message);
  }
}

module.exports = { loadDiskCache, saveDiskCache };
