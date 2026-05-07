// Git + Graphite operations. All read-only except the optional `git fetch
// origin main` in fetchOriginMain (which doesn't touch local branches).

const path = require("path");
const fs = require("fs");
const { sh, execP } = require("./shell");
const { REPO } = require("./config");

// ---------- gt log parsing ----------
function parseGtLog(text) {
  const lines = text.split("\n");
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // Match: leading whitespace, glyph (↱◯◉), optional `─┴┘├` connectors, optional `$`, branch, rest.
    const m = line.match(/^(\s*)[↱◯◉][─┴┘├│\s]*\$?\s*(\S+)\s*(.*)$/);
    if (!m) continue;
    const depth = m[1].length;
    const branch = m[2];
    const rest = (m[3] || "").trim();
    const flags = (rest.match(/\(([^)]+)\)/g) || []).map((s) =>
      s.slice(1, -1).trim()
    );
    parsed.push({ depth, branch, flags });
  }
  return parsed;
}

function buildStacksFromGtLog(parsedLines) {
  // Leaves are lines whose previous line has equal-or-less depth (top-of-stack).
  const stacks = [];
  for (let i = 0; i < parsedLines.length; i++) {
    const cur = parsedLines[i];
    if (cur.branch === "main") continue;
    const prev = parsedLines[i - 1];
    const isLeaf = !prev || prev.depth <= cur.depth;
    if (!isLeaf) continue;

    // Walk down: ancestors are subsequent lines with strictly smaller depth than current min.
    const chain = [cur];
    let minDepth = cur.depth;
    for (let j = i + 1; j < parsedLines.length; j++) {
      const nxt = parsedLines[j];
      if (nxt.depth < minDepth) {
        chain.push(nxt);
        minDepth = nxt.depth;
        if (nxt.branch === "main") break;
      }
    }
    // Drop trunk from chain (we render it separately).
    const trimmed = chain.filter((b) => b.branch !== "main");
    if (trimmed.length === 0) continue;
    stacks.push(trimmed);
  }
  return stacks;
}

// ---------- worktrees ----------
async function fetchWorktrees() {
  const stdout = await sh("git worktree list --porcelain");
  const out = [];
  let cur = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9) };
    else if (line.startsWith("branch "))
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "") {
      if (cur.path) out.push(cur);
      cur = {};
    }
  }
  if (cur.path) out.push(cur);
  return out
    .filter((w) => w.path.includes("/.claude/worktrees/"))
    .map((w) => ({
      ...w,
      name: path.basename(w.path),
    }));
}

// Update remote-tracking ref so per-stack behind counts are fresh. Read-only
// w.r.t. local branches and worktrees.
async function fetchOriginMain() {
  try {
    await sh("git fetch origin main --quiet");
  } catch {
    // ignore — offline or transient; per-stack counts will use whatever
    // origin/main we have locally.
  }
}

// How many commits `origin/main` has that this stack's fork-point on main
// doesn't. Per-stack because different stacks can branch off different
// commits of main (e.g. created at different times, or partially restacked).
async function fetchStackBehind(branch) {
  try {
    const base = (
      await sh(`git merge-base ${branch} origin/main`)
    ).trim();
    if (!base) return 0;
    const out = await sh(`git rev-list --count ${base}..origin/main`);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// Predict whether `gt restack` will hit conflicts by performing an in-memory
// 3-way merge between origin/main and the stack's leaf branch. Read-only —
// `git merge-tree --write-tree` writes objects to the loose-object store but
// never modifies refs or working trees. Exit 0 = clean, 1 = conflicts (with
// conflicting paths listed after the tree OID).
async function checkRestackConflicts(branch) {
  try {
    await execP(
      `git merge-tree --write-tree --name-only --no-messages origin/main ${branch}`,
      { cwd: REPO, maxBuffer: 5 * 1024 * 1024 }
    );
    return { ok: true, conflicts: [] };
  } catch (e) {
    if (e.code === 1 && e.stdout) {
      const lines = e.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      // First line is the (incomplete) tree OID; the rest are conflicting paths.
      const conflicts = [...new Set(lines.slice(1))];
      return { ok: false, conflicts };
    }
    // Other errors (missing branch, missing origin/main, etc.) — return null
    // so the UI can fall back to "unknown" rather than claiming success.
    return null;
  }
}

// For local-only branches (worktree exists, no PR yet), synthesize a PR-like
// object from the latest commit so downstream rendering keeps working.
async function fetchLocalBranchMeta(branch) {
  try {
    const stdout = await sh(
      `git log ${branch} --format='%s%n%cI' -n1 --no-color`
    );
    const lines = stdout.split("\n");
    const title = (lines[0] || "").trim();
    const updatedAt = (lines[1] || "").trim();
    return {
      number: null,
      title: title || branch,
      isDraft: false,
      reviewDecision: null,
      updatedAt,
      headRefName: branch,
      isLocal: true,
    };
  } catch {
    return null;
  }
}

async function isRebaseInProgress(wt) {
  try {
    const gitDir = (
      await execP(`git -C '${wt}' rev-parse --git-dir`)
    ).stdout.trim();
    const abs = gitDir.startsWith("/") ? gitDir : path.join(wt, gitDir);
    return (
      fs.existsSync(path.join(abs, "rebase-merge")) ||
      fs.existsSync(path.join(abs, "rebase-apply"))
    );
  } catch {
    return false;
  }
}

module.exports = {
  parseGtLog,
  buildStacksFromGtLog,
  fetchWorktrees,
  fetchOriginMain,
  fetchStackBehind,
  checkRestackConflicts,
  fetchLocalBranchMeta,
  isRebaseInProgress,
};
