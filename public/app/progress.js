// Rough progress indicator for the refresh buttons. Reads the median of
// recent refresh durations from localStorage and animates a CSS variable
// `--refresh-progress` (0..1) on the button while a refresh is in flight.
// topbar.css turns that variable into a left-to-right background fill.
//
// Once elapsed exceeds the median, the fill is held at 1 and the button
// gets `.progress-pulse`, which animates opacity (indeterminate "still
// working") so the user knows we're past the estimate but not stuck.
//
// requestAnimationFrame is preferable to setInterval here: smoother
// updates, and the browser naturally pauses it when the tab is hidden so
// we don't burn battery on offscreen tabs.

import {
  REFRESH_TIMINGS_KEY,
  RECS_TIMINGS_KEY,
  medianTiming,
} from "./storage.js";

const MODE_KEYS = {
  data: REFRESH_TIMINGS_KEY,
  recs: RECS_TIMINGS_KEY,
};

// rafId keyed by button.id so two simultaneous tickers (refresh-btn +
// recs-refresh-btn during 🧠 Intelligent) don't trample each other.
const active = new Map();

export function startRefreshProgress(btn, mode) {
  stopRefreshProgress(btn); // belt-and-braces: cancel any prior ticker
  const key = MODE_KEYS[mode];
  if (!key) return;
  const median = medianTiming(key);
  if (median == null || median <= 0) return; // <5 samples: no estimate yet
  const t0 = performance.now();

  function tick() {
    const elapsed = performance.now() - t0;
    const ratio = Math.min(1, elapsed / median);
    btn.style.setProperty("--refresh-progress", String(ratio));
    if (ratio >= 0.95) btn.classList.add("progress-pulse");
    const rafId = requestAnimationFrame(tick);
    active.set(btn.id, rafId);
  }
  tick();
}

export function stopRefreshProgress(btn) {
  const rafId = active.get(btn.id);
  if (rafId != null) cancelAnimationFrame(rafId);
  active.delete(btn.id);
  btn.classList.remove("progress-pulse");
  btn.style.removeProperty("--refresh-progress");
}
