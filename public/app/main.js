// Entry point. Wires DOMContentLoaded handlers and kicks off the first
// data + recs fetch. Everything else lives in its own module.

import { $ } from "./dom.js";
import { fetchData, fetchRecs, intelligentRefresh } from "./api.js";
import {
  setupAutoRefresh,
  updateFreshness,
  toggleAllStacks,
  syncStickyTop,
} from "./refresh.js";
import {
  initNotepad,
  applyNotepadVisibility,
  toggleNotepad,
} from "./notepad.js";

document.addEventListener("DOMContentLoaded", () => {
  $("#refresh-btn").addEventListener("click", () => fetchData(true));
  $("#refresh-intelligent-btn").addEventListener("click", intelligentRefresh);
  $("#recs-refresh-btn").addEventListener("click", () => fetchRecs(true));
  $("#collapse-all-btn").addEventListener("click", toggleAllStacks);
  $("#toggle-notepad-btn").addEventListener("click", toggleNotepad);
  applyNotepadVisibility();
  // Per-card toggle listeners are wired in wireDelegates() (toggle doesn't bubble).
  setupAutoRefresh();
  updateFreshness(); // seed intel-freshness label from localStorage
  initNotepad();
  syncStickyTop();
  window.addEventListener("resize", syncStickyTop);
  fetchData(false);
  fetchRecs(false); // load cached recs from server (does NOT regenerate)
});
