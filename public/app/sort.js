// Sort comparators for the Active stacks list. All client-side — the
// server's natural order is preserved, but render.js re-sorts before
// emitting cards based on the user's localStorage pick.
//
// Each entry has a `label` for the dropdown and a `cmp` that's a regular
// Array.sort comparator over two stack objects. Comparators always pull
// "more interesting first" so the layout is consistent regardless of the
// underlying metric direction (newest, biggest, most behind — all desc).

function maxUpdated(s) {
  let m = 0;
  for (const p of s.prs || []) {
    const t = p.updated_at ? new Date(p.updated_at).getTime() : 0;
    if (t > m) m = t;
  }
  return m;
}

function minCreated(s) {
  let m = Infinity;
  for (const p of s.prs || []) {
    const t = p.created_at ? new Date(p.created_at).getTime() : Infinity;
    if (t < m) m = t;
  }
  return Number.isFinite(m) ? m : 0;
}

function totalHumanComments(s) {
  let n = 0;
  for (const p of s.prs || []) n += p.human_comments || 0;
  return n;
}

// Each mode's `cmp` is written for its natural direction ("most
// interesting first"). `naturalDir` records whether that natural order
// puts the largest value at the top (desc, ↓) or the smallest (asc, ↑).
// The direction toggle reverses the sorted result; the arrow shown in the
// UI is derived from naturalDir XOR (dir === "reversed").
// Labels are neutral dimensions ("Updated", not "Recently updated") so
// the dropdown reads cleanly with the arrow toggle — "Updated ↓" is
// newest first, "Updated ↑" is oldest first, etc. Each `naturalDir` is
// what most users expect as the *default* direction for that dimension:
// Updated → newest first (desc); Created → oldest first (asc, the
// "stalled work" use case); Name → A-Z (asc).
export const SORT_MODES = {
  updated: {
    label: "Updated",
    naturalDir: "desc",
    cmp: (a, b) => maxUpdated(b) - maxUpdated(a),
  },
  behind: {
    label: "Behind",
    naturalDir: "desc",
    cmp: (a, b) => (b.behind_origin || 0) - (a.behind_origin || 0),
  },
  comments: {
    label: "Comments",
    naturalDir: "desc",
    cmp: (a, b) => totalHumanComments(b) - totalHumanComments(a),
  },
  prs: {
    label: "PRs",
    naturalDir: "desc",
    cmp: (a, b) => (b.counts?.created || 0) - (a.counts?.created || 0),
  },
  // Kept the `oldest` storage key so any localStorage value from before
  // the rename keeps working — only the displayed label changed.
  oldest: {
    label: "Created",
    naturalDir: "asc",
    cmp: (a, b) => minCreated(a) - minCreated(b),
  },
  name: {
    label: "Name",
    naturalDir: "asc",
    cmp: (a, b) => (a.name || "").localeCompare(b.name || ""),
  },
};

export function sortStacks(stacks, mode, dir) {
  const entry = SORT_MODES[mode] || SORT_MODES.updated;
  // Stable: spread first so we don't mutate the caller's array; Array.sort
  // is stable on V8 ≥7 so equal-key stacks keep their server-natural order.
  const sorted = [...stacks].sort(entry.cmp);
  return dir === "reversed" ? sorted.reverse() : sorted;
}

// Returns "↓" if the current effective order puts larger values at the
// top, "↑" if smaller. Used by the direction toggle button so the arrow
// matches what the user actually sees.
export function arrowFor(mode, dir) {
  const entry = SORT_MODES[mode] || SORT_MODES.updated;
  const naturalDesc = entry.naturalDir === "desc";
  const isReversed = dir === "reversed";
  const effectiveDesc = naturalDesc !== isReversed; // XOR
  return effectiveDesc ? "↓" : "↑";
}
