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

export const SORT_MODES = {
  updated: {
    label: "Recently updated",
    cmp: (a, b) => maxUpdated(b) - maxUpdated(a),
  },
  behind: {
    label: "Most behind origin",
    cmp: (a, b) => (b.behind_origin || 0) - (a.behind_origin || 0),
  },
  comments: {
    label: "Most review comments",
    cmp: (a, b) => totalHumanComments(b) - totalHumanComments(a),
  },
  prs: {
    label: "Most PRs",
    cmp: (a, b) => (b.counts?.created || 0) - (a.counts?.created || 0),
  },
  oldest: {
    label: "Oldest first",
    cmp: (a, b) => minCreated(a) - minCreated(b),
  },
  name: {
    label: "Alphabetical",
    cmp: (a, b) => (a.name || "").localeCompare(b.name || ""),
  },
};

export function sortStacks(stacks, mode) {
  const entry = SORT_MODES[mode] || SORT_MODES.updated;
  // Stable: spread first so we don't mutate the caller's array; Array.sort
  // is stable on V8 ≥7 so equal-key stacks keep their server-natural order.
  return [...stacks].sort(entry.cmp);
}
