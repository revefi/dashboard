// "↻ Restack" button click handler. Confirms with the user, POSTs to
// /api/restack, and pulls fresh data on success.

import { store } from "./store.js";
import { fetchData } from "./api.js";

export async function handleRestackClick(btn) {
  const stackKey = btn.dataset.restackStack;
  const stack = store.currentData?.stacks?.find((s) => s.stack_key === stackKey);
  if (!stack) return;
  const wt = stack.worktree?.path || "(unknown)";
  const behind = stack.behind_origin || 0;
  const ok = window.confirm(
    `Restack "${stack.name}" onto origin/main and push?\n\n` +
      `Runs in: ${wt}\n` +
      `  1) gt restack — rebase ${behind} commit${
        behind === 1 ? "" : "s"
      } of upstream changes under your stack\n` +
      `  2) gt submit --stack -u --no-edit --no-interactive — force-with-lease push every branch in the stack to update the PRs\n\n` +
      `On merge conflict: rebase aborts, branches unchanged, nothing pushed.\n` +
      `On push conflict (someone else pushed): force-with-lease refuses, local restack stays, branches not pushed.`
  );
  if (!ok) return;

  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Restacking + pushing…`;
  try {
    const res = await fetch("/api/restack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack_key: stackKey }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const msg = body.error || res.statusText || "Restack failed";
      window.alert(`Restack failed:\n\n${msg}`);
      btn.disabled = false;
      btn.innerHTML = origHTML;
      return;
    }
    // Success — pull fresh data so the badge clears (or shows the new count).
    await fetchData(true, false);
  } catch (err) {
    window.alert(`Restack failed:\n\n${err.message}`);
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}
