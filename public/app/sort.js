// Sort comparators for the Active stacks list. All client-side — the
// server's natural order is preserved, but render.js re-sorts before
// emitting cards based on the user's localStorage pick.
//
// Every `cmp` is written desc-style (largest value at top). Direction is
// a single global toggle stored separately ("asc" or "desc", default
// "desc"). Switching modes never auto-flips the arrow — the arrow only
// changes when the user clicks the toggle button.

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

export const SORT_MODES = {
  updated: {
    label: "Updated",
    cmp: (a, b) => maxUpdated(b) - maxUpdated(a),
  },
  behind: {
    label: "Behind",
    cmp: (a, b) => (b.behind_origin || 0) - (a.behind_origin || 0),
  },
  comments: {
    label: "Comments",
    cmp: (a, b) => totalHumanComments(b) - totalHumanComments(a),
  },
  prs: {
    label: "PRs",
    cmp: (a, b) => (b.counts?.created || 0) - (a.counts?.created || 0),
  },
  created: {
    label: "Created",
    cmp: (a, b) => minCreated(b) - minCreated(a),
  },
  name: {
    label: "Name",
    cmp: (a, b) => (b.name || "").localeCompare(a.name || ""),
  },
};

export function sortStacks(stacks, mode, dir) {
  const entry = SORT_MODES[mode] || SORT_MODES.updated;
  // Stable: spread first so we don't mutate the caller's array; Array.sort
  // is stable on V8 ≥7 so equal-key stacks keep their server-natural order.
  const sorted = [...stacks].sort(entry.cmp);
  return dir === "asc" ? sorted.reverse() : sorted;
}

// "↓" for desc (largest at top), "↑" for asc. Mode-independent so the
// arrow stays stable as the user flips between sort modes.
export function arrowFor(dir) {
  return dir === "asc" ? "↑" : "↓";
}
