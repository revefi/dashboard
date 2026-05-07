// Jira state-pill popover: click a pill, fetch valid transitions for the
// ticket, render a small floating menu, transition optimistically with
// revert-on-failure.

import { esc } from "./dom.js";
import { store } from "./store.js";

export async function openStateMenu(pill) {
  closeStateMenu();
  const key = pill.dataset.key;
  const current = pill.dataset.current;
  if (!key) return;

  const origText = pill.textContent;
  pill.disabled = true;
  pill.textContent = "…";

  let transitions = [];
  try {
    const res = await fetch(
      `/api/jira/transitions?key=${encodeURIComponent(key)}`
    );
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "transitions fetch failed");
    transitions = body.transitions || [];
  } catch (err) {
    pill.disabled = false;
    pill.textContent = origText;
    window.alert(`Couldn't fetch transitions: ${err.message}`);
    return;
  }
  pill.disabled = false;
  pill.textContent = origText;

  // Drop transitions that target the current state — Jira sometimes lists a
  // self-loop and clicking it is a no-op confusion.
  const usable = transitions.filter((t) => t.to_status !== current);
  if (usable.length === 0) {
    window.alert(`No transitions available from "${current}".`);
    return;
  }

  const menu = document.createElement("div");
  menu.className = "state-menu";
  menu.innerHTML =
    `<div class="state-menu-head">Move ${esc(key)} from <b>${esc(
      current
    )}</b> to:</div>` +
    usable
      .map(
        (t) =>
          `<button class="state-menu-item cat-${esc(
            t.to_category || "new"
          )}" data-transition-id="${esc(String(t.id))}" data-target="${esc(
            t.to_status
          )}">${esc(t.to_status)}</button>`
      )
      .join("");

  document.body.appendChild(menu);
  positionMenuNear(menu, pill);

  for (const item of menu.querySelectorAll(".state-menu-item")) {
    item.addEventListener("click", async () => {
      const target = item.dataset.target;
      const tid = item.dataset.transitionId;
      closeStateMenu();
      await handleStateTransition(pill, key, tid, target);
    });
  }

  // Click-outside closes.
  setTimeout(() => {
    document.addEventListener("click", _stateMenuOutsideClose, {
      capture: true,
    });
    document.addEventListener("keydown", _stateMenuEscClose);
  }, 0);
}

export function closeStateMenu() {
  const m = document.querySelector(".state-menu");
  if (m) m.remove();
  document.removeEventListener("click", _stateMenuOutsideClose, {
    capture: true,
  });
  document.removeEventListener("keydown", _stateMenuEscClose);
}

function _stateMenuOutsideClose(e) {
  const m = document.querySelector(".state-menu");
  if (m && !m.contains(e.target)) closeStateMenu();
}

function _stateMenuEscClose(e) {
  if (e.key === "Escape") closeStateMenu();
}

function positionMenuNear(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const margin = 6;
  let top = r.bottom + margin + window.scrollY;
  let left = r.left + window.scrollX;
  menu.style.position = "absolute";
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  const mb = menu.getBoundingClientRect();
  if (mb.right > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - mb.width - 8) + window.scrollX;
    menu.style.left = `${left}px`;
  }
  if (r.bottom + margin + mb.height > window.innerHeight) {
    top = r.top - margin - mb.height + window.scrollY;
    menu.style.top = `${top}px`;
  }
}

async function handleStateTransition(pill, key, transitionId, targetStatus) {
  // Optimistic update: flip the pill immediately. Revert on failure.
  const origText = pill.textContent;
  const origCat = [...pill.classList].find((c) => c.startsWith("cat-"));
  pill.textContent = targetStatus;
  pill.dataset.current = targetStatus;
  // Best-effort coloring: indeterminate for In Progress/In Review, done for
  // Done/Closed, else "new".
  const newCat = /done|closed/i.test(targetStatus)
    ? "cat-done"
    : /progress|review/i.test(targetStatus)
    ? "cat-indeterminate"
    : "cat-new";
  if (origCat) pill.classList.remove(origCat);
  pill.classList.add(newCat);

  // Update cached list so re-renders keep the new state.
  const cached = store.cachedUntouchedList.find((t) => t.key === key);
  let cachedOrig;
  if (cached) {
    cachedOrig = { status: cached.status, status_category: cached.status_category };
    cached.status = targetStatus;
    cached.status_category = newCat.replace("cat-", "");
  }

  try {
    const res = await fetch("/api/jira/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, transition_id: transitionId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(body.error || res.statusText || "transition failed");
    }
  } catch (err) {
    // Revert.
    pill.textContent = origText;
    pill.dataset.current = origText;
    pill.classList.remove(newCat);
    if (origCat) pill.classList.add(origCat);
    if (cached && cachedOrig) {
      cached.status = cachedOrig.status;
      cached.status_category = cachedOrig.status_category;
    }
    window.alert(`Transition failed:\n\n${err.message}`);
  }
}
