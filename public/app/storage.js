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
