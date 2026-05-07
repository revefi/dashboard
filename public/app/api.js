// Network calls to the dashboard's own /api/* endpoints. Keeps fetch logic
// in one place so renderers don't talk to the server directly.

import { $, esc } from "./dom.js";
import { store } from "./store.js";
import { LAST_INTEL_KEY } from "./storage.js";
import { render } from "./render.js";
import { updateFreshness } from "./refresh.js";

export async function fetchData(force = false, intelligent = false) {
  const btn = intelligent ? $("#refresh-intelligent-btn") : $("#refresh-btn");
  const origLabel = btn.textContent;
  btn.classList.add("loading");
  btn.textContent = intelligent ? "🧠 Thinking…" : "↻ Refreshing…";
  try {
    const params = new URLSearchParams();
    if (force) params.set("refresh", "1");
    if (intelligent) params.set("intelligent", "1");
    const qs = params.toString();
    const url = qs ? `/api/data?${qs}` : "/api/data";
    const res = await fetch(url);
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
  } catch (err) {
    $("#error-banner").style.display = "";
    $(
      "#error-banner"
    ).textContent = `Error: ${err.message}\n\nTry: refreshing, ensuring \`gh\` and \`gt\` are authenticated, or restarting the server.`;
  } finally {
    btn.classList.remove("loading");
    btn.textContent = origLabel;
  }
}

export async function fetchRecs(force = false) {
  const btn = $("#recs-refresh-btn");
  const list = $("#recs-list");
  btn.classList.add("loading");
  btn.disabled = true;
  if (force) {
    list.classList.add("loading");
    list.innerHTML =
      '<li class="empty muted">Generating action items… this can take 10–30s.</li>';
  }
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
  } catch (err) {
    list.classList.remove("loading");
    list.innerHTML = `<li class="empty" style="color:var(--danger);font-style:normal">Error: ${esc(
      err.message
    )}</li>`;
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

export async function intelligentRefresh() {
  // Run data refresh (deep — clears Claude-backed disk caches) and recs regen
  // in parallel.
  await Promise.all([fetchData(true, true), fetchRecs(true)]);
  localStorage.setItem(LAST_INTEL_KEY, String(Date.now()));
  updateFreshness();
}
