// `gt restack` driver behind POST /api/restack.
//
// Heavily guarded:
//   - looks up the stack by key from current model (no client-supplied paths)
//   - refuses if the stack has upstream PRs (would skip over someone else's work)
//   - refuses if the stack has no worktree (gt sync from main handles those)
//   - refuses if the worktree has uncommitted changes (would clobber WIP)
//   - on any failure runs `git rebase --abort` to leave the branch state clean

const { execP } = require("./shell");
const { isRebaseInProgress } = require("./git");
const { cache, getData } = require("./cache");

async function restackStack(stackKey) {
  if (!stackKey || typeof stackKey !== "string") {
    return { ok: false, error: "stack_key required" };
  }
  // Always read fresh — we want the up-to-date worktree path and behind count.
  const model = await getData(true);
  const stack = model.stacks.find((s) => s.stack_key === stackKey);
  if (!stack) return { ok: false, error: `unknown stack ${stackKey}` };
  if (stack.upstream) {
    return {
      ok: false,
      error:
        "Stack sits on top of upstream PRs from another author — restacking onto origin/main would skip past them. Restack manually.",
    };
  }
  if (!stack.worktree?.path) {
    return {
      ok: false,
      error:
        "Stack has no worktree. Run `gt sync` from the main checkout instead.",
    };
  }
  if ((stack.behind_origin || 0) === 0) {
    return { ok: false, error: "Already up to date with origin/main." };
  }
  if (stack.restack_check && stack.restack_check.ok === false) {
    return {
      ok: false,
      error:
        `Predicted merge conflicts in:\n  ${stack.restack_check.conflicts.join(
          "\n  "
        )}\n\nResolve manually with \`gt restack\` in the worktree, then retry.`,
    };
  }

  const wt = stack.worktree.path;
  // Reject if anything is uncommitted in the worktree — gt restack would refuse
  // anyway, and we don't want to touch a dirty tree.
  try {
    const dirty = (
      await execP(`git -C '${wt}' status --porcelain`, { maxBuffer: 1e6 })
    ).stdout.trim();
    if (dirty) {
      return {
        ok: false,
        error: `Worktree has uncommitted changes. Commit or stash before restacking.\n\n${dirty
          .split("\n")
          .slice(0, 10)
          .join("\n")}`,
      };
    }
  } catch (e) {
    return { ok: false, error: `git status failed: ${e.message}` };
  }

  // Run `gt restack`. On conflict gt leaves a half-finished rebase in place; we
  // detect that via the rebase-state files and abort to restore the branch.
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const r = await execP(`gt restack`, {
      cwd: wt,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    exitCode = e.code || 1;
    stdout = e.stdout || "";
    stderr = e.stderr || e.message || "";
  }

  // Check for an in-progress rebase regardless of exit code — belt-and-braces.
  const inRebase = await isRebaseInProgress(wt);
  if (inRebase || exitCode !== 0) {
    let abortMsg = "";
    if (inRebase) {
      try {
        await execP(`git -C '${wt}' rebase --abort`);
        abortMsg = "Aborted in-progress rebase; branch state restored.";
      } catch (e) {
        abortMsg = `WARNING: failed to abort rebase: ${e.message}. Investigate worktree manually.`;
      }
    }
    // Invalidate cache so next /api/data refetches even though nothing changed
    // — keeps the UI consistent if the user hits ↻ Refresh.
    cache.ts = 0;
    return {
      ok: false,
      error: [
        "gt restack failed.",
        abortMsg,
        "--- stdout ---",
        stdout.slice(-2000),
        "--- stderr ---",
        stderr.slice(-2000),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  // Restack succeeded locally. Now push the rewritten branches so the GitHub
  // PRs reflect the new commits. `-u` (update-only) prevents creating new PRs;
  // `--no-edit --no-interactive` skips all prompts; the default push mode is
  // --force-with-lease, which refuses if anyone else pushed in the meantime.
  let pushOut = "";
  let pushErr = "";
  let pushExit = 0;
  try {
    const r = await execP(`gt submit --stack -u --no-edit --no-interactive`, {
      cwd: wt,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 180_000,
    });
    pushOut = r.stdout;
    pushErr = r.stderr;
  } catch (e) {
    pushExit = e.code || 1;
    pushOut = e.stdout || "";
    pushErr = e.stderr || e.message || "";
  }

  // Invalidate cache regardless — local branch SHAs changed even if the push failed.
  cache.ts = 0;

  if (pushExit !== 0) {
    return {
      ok: false,
      error: [
        "Restacked locally, but `gt submit` failed to push.",
        "Local branches are correctly rebased; retry the push manually with `gt submit -u` from the worktree.",
        "--- restack stdout ---",
        stdout.slice(-1500),
        "--- submit stdout ---",
        pushOut.slice(-1500),
        "--- submit stderr ---",
        pushErr.slice(-1500),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    ok: true,
    message: [
      "Restacked and pushed successfully.",
      "--- restack ---",
      stdout.trim(),
      "--- submit ---",
      pushOut.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

module.exports = { restackStack };
