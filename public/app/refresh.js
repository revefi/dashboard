// Auto-refresh + freshness label + collapse-all + sticky-header sizing.
// Everything that runs on a timer or window event.

import { $, $$, relAge } from "./dom.js";
import { store } from "./store.js";
import {
  AUTO_REFRESH_INTERVAL_KEY,
  LAST_INTEL_KEY,
  getAutoRefreshMs,
} from "./storage.js";

let autoRefreshTimer = null;

export function updateFreshness() {
  if (store.lastFetchTs)
    $("#freshness").textContent = `· ${relAge(store.lastFetchTs)}`;
  const lastIntel = parseInt(localStorage.getItem(LAST_INTEL_KEY) || "0", 10);
  if (lastIntel) {
    $("#intel-freshness").textContent = `· ${relAge(lastIntel)}`;
  } else {
    $("#intel-freshness").textContent = "· not yet run";
  }
}

export async function setupAutoRefresh() {
  // Lazy-import fetchData to break the api.js → refresh.js cycle (api.js
  // imports updateFreshness from us).
  const { fetchData } = await import("./api.js");

  const cb = $("#auto-refresh-cb");
  const sel = $("#auto-refresh-interval");

  sel.value = String(getAutoRefreshMs());
  sel.addEventListener("change", () => {
    localStorage.setItem(AUTO_REFRESH_INTERVAL_KEY, sel.value);
    schedule();
  });
  cb.addEventListener("change", schedule);

  // Self-rescheduling tick. setInterval is unreliable in background tabs
  // (browsers throttle to >=1m), so each tick re-arms a setTimeout. The
  // visibilitychange listener below covers the throttled case by firing
  // immediately when the tab regains focus.
  function tick() {
    if (cb.checked && document.visibilityState === "visible") {
      // Auto-refresh ONLY pulls /api/data — never regenerates Claude recs.
      fetchData(false).finally(schedule);
    } else {
      schedule();
    }
  }
  function schedule() {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
    if (!cb.checked) return;
    autoRefreshTimer = setTimeout(tick, getAutoRefreshMs());
  }

  // When the tab becomes visible again, fire immediately if the configured
  // interval has elapsed since the last successful refresh.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !cb.checked) return;
    const since = Date.now() - (store.lastFetchTs || 0);
    if (since >= getAutoRefreshMs()) fetchData(false).finally(schedule);
  });

  schedule();
  setInterval(updateFreshness, 5000);
}

export function toggleAllStacks() {
  const cards = $$(".stack-card");
  if (cards.length === 0) return;
  const anyExpanded = [...cards].some((c) => c.classList.contains("expanded"));
  for (const c of cards) c.classList.toggle("expanded", !anyExpanded);
  updateCollapseAllLabel();
}

export function updateCollapseAllLabel() {
  const btn = $("#collapse-all-btn");
  if (!btn) return;
  const cards = $$(".stack-card");
  const anyExpanded = [...cards].some((c) => c.classList.contains("expanded"));
  btn.textContent = anyExpanded ? "⊟ Collapse all" : "⊞ Expand all";
}

// Keep `--sticky-top` in sync with the actual header height so the sidebar /
// notepad always sit just below the sticky header, even when buttons wrap to a
// second line on narrower windows.
export function syncStickyTop() {
  const header = document.querySelector("header.top");
  if (!header) return;
  const h = Math.ceil(header.getBoundingClientRect().height) + 16; // 16px gap
  document.documentElement.style.setProperty("--sticky-top", h + "px");
}
