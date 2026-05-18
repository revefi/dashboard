// Per-stage refresh timing. Each /api/data refresh creates a Timer, wraps
// its slow steps with `t.time(name, () => promise)`, then appends one
// JSON-line summary to cache/refresh-timings.jsonl for later inspection
// (e.g. `tail -n 20 cache/refresh-timings.jsonl | jq`).

const fs = require("fs");
const path = require("path");
const { CACHE_DIR } = require("./config");

const LOG_FILE = path.join(CACHE_DIR, "refresh-timings.jsonl");
const MAX_LINES = 1000;       // rotate point
const ROTATE_BYTES = 1 << 20; // 1 MiB — only rescan when the file grows beyond this

class Timer {
  constructor() {
    this.t0 = performance.now();
    this.stages = {};
  }

  // Run `fn()` and record how long it took under `name`. Multiple calls
  // with the same name accumulate, which is useful if you wrap several
  // parallel chunks of the same logical phase.
  async time(name, fn) {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const elapsed = performance.now() - start;
      this.stages[name] = Math.round((this.stages[name] || 0) + elapsed);
    }
  }

  // Snapshot the timer state. Total is wall-clock from construction to
  // now, so it includes any unwrapped work between stages.
  summary(extra = {}) {
    return {
      ts: new Date().toISOString(),
      total_ms: Math.round(performance.now() - this.t0),
      stages: { ...this.stages },
      ...extra,
    };
  }
}

function appendTimingRecord(record) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
    // Only rotate when the file actually gets large — we'd rather skip
    // the read+rewrite cost on the hot path most of the time.
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > ROTATE_BYTES) {
      const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(LOG_FILE, lines.slice(-MAX_LINES).join("\n") + "\n");
      }
    }
  } catch (err) {
    console.warn("[timing] log write failed:", err.message);
  }
}

module.exports = { Timer, appendTimingRecord };
