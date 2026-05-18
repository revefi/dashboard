// Network calls to the dashboard's own /api/* endpoints. Keeps fetch logic
// in one place so renderers don't talk to the server directly.

import { $, esc } from "./dom.js";
import { store } from "./store.js";
import {
  LAST_INTEL_KEY,
  REFRESH_TIMINGS_KEY,
  RECS_TIMINGS_KEY,
  pushTiming,
} from "./storage.js";
import { render } from "./render.js";
import { updateFreshness } from "./refresh.js";
import { startRefreshProgress, stopRefreshProgress } from "./progress.js";

// Each refresh button has a stable "idle" label set in index.html. We snapshot
// it once on first use so concurrent fetches can't capture a mid-flight
// "↻ Refreshing…" string as the restore value. Without this, two overlapping
// fetches (e.g. manual click + visibilitychange-triggered auto-refresh) raced
// and the second `finally` permanently restored the button to "↻ Refreshing…".
const idleLabels = new Map();
function idleLabelFor(btn) {
  if (!idleLabels.has(btn.id)) idleLabels.set(btn.id, btn.textContent);
  return idleLabels.get(btn.id);
}

// Dedup concurrent fetches per button. A second call returns the in-flight
// promise instead of starting a parallel fetch — the server-side cache means
// they'd produce the same result anyway, and this keeps the button label
// owned by exactly one fetch.
const inFlight = new Map();

const FETCH_TIMEOUT_MS = 60_000;

export function fetchData(force = false, intelligent = false) {
  const btn = intelligent ? $("#refresh-intelligent-btn") : $("#refresh-btn");
  const existing = inFlight.get(btn.id);
  if (existing) return existing;

  const idle = idleLabelFor(btn);
  btn.classList.add("loading");
  btn.textContent = intelligent ? "🧠 Thinking…" : "↻ Refreshing…";
  startRefreshProgress(btn, "data");

  const ctrl = new AbortController();
  const timeoutId = setTimeout(
    () => ctrl.abort(new Error("refresh timed out after 60s")),
    FETCH_TIMEOUT_MS
  );

  const t0 = performance.now();
  const promise = (async () => {
    try {
      const params = new URLSearchParams();
      if (force) params.set("refresh", "1");
      if (intelligent) params.set("intelligent", "1");
      const qs = params.toString();
      const url = qs ? `/api/data?${qs}` : "/api/data";
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const data = await res.json();
      store.currentData = data;
      store.lastFetchTs = Date.now();
      render(data);
      $("#error-banner").style.display = "none";
      updateFreshness();
      // Only successful refreshes contribute to the duration estimate.
      pushTiming(REFRESH_TIMINGS_KEY, performance.now() - t0);
    } catch (err) {
      $("#error-banner").style.display = "";
      $(
        "#error-banner"
      ).textContent = `Error: ${err.message}\n\nTry: refreshing, ensuring \`gh\` and \`gt\` are authenticated, or restarting the server.`;
    } finally {
      clearTimeout(timeoutId);
      stopRefreshProgress(btn);
      btn.classList.remove("loading");
      btn.textContent = idle;
      inFlight.delete(btn.id);
    }
  })();

  inFlight.set(btn.id, promise);
  return promise;
}

export async function fetchRecs(force = false) {
  const btn = $("#recs-refresh-btn");
  const list = $("#recs-list");
  // Dedup like fetchData. The Action items endpoint can take 30s; double-firing
  // costs Claude tokens and confuses the button label.
  const existing = inFlight.get(btn.id);
  if (existing) return existing;
  btn.classList.add("loading");
  btn.disabled = true;
  startRefreshProgress(btn, "recs");
  if (force) {
    list.classList.add("loading");
    list.innerHTML =
      '<li class="empty muted">Generating action items… this can take 10–30s.</li>';
  }
  const t0 = performance.now();
  const promise = (async () => {
    try {
      const url = force
        ? "/api/recommendations?refresh=1"
        : "/api/recommendations";
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const recs = await res.json();
      const { renderRecs } = await import("./render.js");
      renderRecs(recs);
      // Only the force=true path actually hits Claude — measuring the
      // cached read would pull the median to near-zero and make the
      // progress bar fly through. Skip cached reads.
      if (force) pushTiming(RECS_TIMINGS_KEY, performance.now() - t0);
    } catch (err) {
      list.classList.remove("loading");
      list.innerHTML = `<li class="empty" style="color:var(--danger);font-style:normal">Error: ${esc(
        err.message
      )}</li>`;
    } finally {
      stopRefreshProgress(btn);
      btn.classList.remove("loading");
      btn.disabled = false;
      inFlight.delete(btn.id);
    }
  })();
  inFlight.set(btn.id, promise);
  return promise;
}

export async function intelligentRefresh() {
  // Run data refresh (deep — clears Claude-backed disk caches) and recs regen
  // in parallel.
  await Promise.all([fetchData(true, true), fetchRecs(true)]);
  localStorage.setItem(LAST_INTEL_KEY, String(Date.now()));
  updateFreshness();
}
