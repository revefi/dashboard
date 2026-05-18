// Rough progress indicator for the refresh buttons. Reads the median of
// recent refresh durations from localStorage and animates a CSS variable
// `--refresh-progress` (0..1) on the button while a refresh is in flight.
// topbar.css turns that variable into a left-to-right background fill.
//
// Once elapsed exceeds the median, the fill is held at 1 and the button
// gets `.progress-pulse`, which animates opacity (indeterminate "still
// working") so the user knows we're past the estimate but not stuck.
//
// On completion, the fill snaps to 100%, flashes the success tint, and
// fades out over ~600ms (the `.progress-complete` class + keyframes in
// topbar.css). This replaces the old "snap straight back to 0" behavior
// which felt abrupt.
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
// recs-refresh-btn during ✨ Intelligent) don't trample each other.
const active = new Map();
// Pending completion-animation teardown timers, keyed by button.id. Lets
// a fresh startRefreshProgress() cancel a still-fading completion from
// the previous refresh before it clobbers the new progress var.
const completionTimers = new Map();
const COMPLETE_ANIMATION_MS = 600;

export function startRefreshProgress(btn, mode) {
  // Hard reset before starting so we don't carry over a fading completion
  // bar or a stale rAF from the previous refresh.
  resetRefreshProgress(btn);
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

// Called at the end of a refresh. Plays the completion animation if we
// were actively rendering progress; otherwise just no-ops (no flash for
// users with <5 samples, since they never saw a progress bar to begin
// with).
export function stopRefreshProgress(btn) {
  const wasTracking = active.has(btn.id);
  const rafId = active.get(btn.id);
  if (rafId != null) cancelAnimationFrame(rafId);
  active.delete(btn.id);
  btn.classList.remove("progress-pulse");

  if (!wasTracking) {
    btn.style.removeProperty("--refresh-progress");
    return;
  }

  // Pin to 100% (the existing CSS transition handles the brief widen if
  // we were under the median when the refresh finished), add the
  // .progress-complete class to drive the success-tint + fade-out keyframes,
  // then tear down the var/class after the animation finishes.
  btn.style.setProperty("--refresh-progress", "1");
  btn.classList.add("progress-complete");
  const prev = completionTimers.get(btn.id);
  if (prev != null) clearTimeout(prev);
  const timer = setTimeout(() => {
    btn.classList.remove("progress-complete");
    btn.style.removeProperty("--refresh-progress");
    completionTimers.delete(btn.id);
  }, COMPLETE_ANIMATION_MS + 50); // small buffer so the animation visibly settles
  completionTimers.set(btn.id, timer);
}

// Used by startRefreshProgress to instantly tear down whatever state the
// button might be in (including a mid-fade completion). Not exported —
// callers that want a "soft" finish use stopRefreshProgress.
function resetRefreshProgress(btn) {
  const rafId = active.get(btn.id);
  if (rafId != null) cancelAnimationFrame(rafId);
  active.delete(btn.id);
  const timer = completionTimers.get(btn.id);
  if (timer != null) clearTimeout(timer);
  completionTimers.delete(btn.id);
  btn.classList.remove("progress-pulse");
  btn.classList.remove("progress-complete");
  btn.style.removeProperty("--refresh-progress");
}
