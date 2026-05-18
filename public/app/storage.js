// Thin wrappers around localStorage. Every key the dashboard persists on
// the client is named here; nothing else should call localStorage directly
// (so renaming/removing a key is a one-file change).

export const COMPLETED_KEY = "dashboard.completed";
export const REMARKS_KEY_PREFIX = "dashboard.remarks.stack.";
export const JIRA_REMARKS_PREFIX = "dashboard.remarks.jira.";
export const STACK_NAME_OVERRIDE_PREFIX = "dashboard.stack_name_override.";
export const AUTO_REFRESH_INTERVAL_KEY = "dashboard.auto_refresh_ms";
export const SPRINT_FILTER_KEY = "dashboard.sprint_filter";
export const STACK_FILTER_KEY = "dashboard.stack_filter";
export const NOTEPAD_HIDDEN_KEY = "dashboard.notepad_hidden";
export const LAST_INTEL_KEY = "dashboard.lastIntelligentTs";
// Theme override: "light" or "dark" forces, absence means follow OS.
export const THEME_KEY = "dashboard.theme";
// Rolling history of recent refresh durations (ms). Two arrays so the data
// vs recs distributions don't cross-contaminate. Used by progress.js to
// estimate "how long until done" for the fill indicator on the refresh
// buttons.
export const REFRESH_TIMINGS_KEY = "dashboard.refresh_timings_ms";
export const RECS_TIMINGS_KEY = "dashboard.recs_timings_ms";

const TIMINGS_MAX = 50;
const TIMINGS_MIN_SAMPLES = 5;

function readTimings(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(raw) ? raw.filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

export function pushTiming(key, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const arr = readTimings(key);
  arr.push(Math.round(ms));
  while (arr.length > TIMINGS_MAX) arr.shift();
  localStorage.setItem(key, JSON.stringify(arr));
}

// Median over the stored window. Returns null until we have enough samples
// — the progress indicator stays off (just the loading label) until then.
export function medianTiming(key) {
  const arr = readTimings(key);
  if (arr.length < TIMINGS_MIN_SAMPLES) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = sorted.length;
  return m % 2 === 1
    ? sorted[(m - 1) / 2]
    : Math.round((sorted[m / 2 - 1] + sorted[m / 2]) / 2);
}

const DEFAULT_AUTO_REFRESH_MS = 600_000; // 10 minutes

export function getAutoRefreshMs() {
  const stored = parseInt(
    localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY) || "",
    10
  );
  return Number.isFinite(stored) && stored > 0
    ? stored
    : DEFAULT_AUTO_REFRESH_MS;
}

export function getStackNameOverride(stackKey) {
  return localStorage.getItem(STACK_NAME_OVERRIDE_PREFIX + stackKey);
}

export function setStackNameOverride(stackKey, name) {
  if (name && name.trim()) {
    localStorage.setItem(STACK_NAME_OVERRIDE_PREFIX + stackKey, name.trim());
  } else {
    localStorage.removeItem(STACK_NAME_OVERRIDE_PREFIX + stackKey);
  }
}

export function getCompletedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COMPLETED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export function setCompletedSet(set) {
  localStorage.setItem(COMPLETED_KEY, JSON.stringify([...set]));
}

export function toggleCompleted(stackKey) {
  const s = getCompletedSet();
  if (s.has(stackKey)) s.delete(stackKey);
  else s.add(stackKey);
  setCompletedSet(s);
}

export function getSprintFilter() {
  return localStorage.getItem(SPRINT_FILTER_KEY) || "current";
}

export function setSprintFilter(v) {
  localStorage.setItem(SPRINT_FILTER_KEY, v);
}

export function getStackFilter() {
  // Default "without_stack" preserves the original "Untouched Jira" behavior.
  return localStorage.getItem(STACK_FILTER_KEY) || "without_stack";
}

export function setStackFilter(v) {
  localStorage.setItem(STACK_FILTER_KEY, v);
}
