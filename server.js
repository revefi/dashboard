#!/usr/bin/env node
// Personal live dashboard server. Zero deps. Run: `node server.js`
// Listens on http://localhost:7787 — gitignored, never committed.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  encodeProjectDir,
  REPO,
  HOME,
  SESSIONS_ROOT,
  MAIN_SESSIONS_DIR,
  PORT,
  CACHE_TTL_MS,
  STATIC_DIR,
  CACHE_DIR,
  RECS_CACHE_FILE,
  STACK_NAMES_CACHE_FILE,
  STACK_NAMES_TTL_MS,
} = require("./src/server/config");
const { sh, shRetry, shWithInput, execP, execFileP } = require("./src/server/shell");
const { loadDiskCache, saveDiskCache } = require("./src/server/disk-cache");
const {
  parseGtLog,
  buildStacksFromGtLog,
  fetchWorktrees,
  fetchOriginMain,
  fetchStackBehind,
  checkRestackConflicts,
  fetchLocalBranchMeta,
  isRebaseInProgress,
} = require("./src/server/git");
const {
  getLogin,
  fetchOpenPRs,
  fetchRecentMergedPRs,
  fetchAnyPR,
  fetchPRMeta,
  fetchPrSignalsBulk,
  summarizeChecks,
} = require("./src/server/gh");
const {
  jiraConfigured,
  fetchJiraTickets,
  fetchOpenJiraTickets,
  fetchJiraTransitions,
  performJiraTransition,
  deriveJiraNote,
} = require("./src/server/jira");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let cache = { ts: 0, data: null, building: null };

// ---------- Claude CLI helper ----------
function callClaude(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];
    if (opts.model !== false)
      args.push("--model", opts.model || "claude-haiku-4-5");
    if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("claude timed out after 90s"));
    }, opts.timeoutMs || 90_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Try to extract a JSON object/array from Claude's text response (it may wrap with prose or fences).
function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  const firstBrace = Math.min(
    ...["{", "["].map((c) => {
      const i = text.indexOf(c);
      return i === -1 ? Infinity : i;
    })
  );
  if (!isFinite(firstBrace)) return null;
  // Find matching close — naive but works since Claude output is usually clean.
  const candidate = text.slice(firstBrace);
  // Try progressively shorter slices until JSON parses.
  for (let end = candidate.length; end > 0; end--) {
    try {
      return JSON.parse(candidate.slice(0, end));
    } catch {}
  }
  return null;
}

// ---------- session scoring ----------
function listSessions(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      sid: f.slice(0, -".jsonl".length),
      file: path.join(dir, f),
    }));
}

async function scoreSessionsForStack(keywords, worktreeName) {
  const dirs = [MAIN_SESSIONS_DIR];
  if (worktreeName) {
    dirs.push(
      path.join(
        SESSIONS_ROOT,
        encodeProjectDir(`${REPO}/.claude/worktrees/${worktreeName}`)
      )
    );
  }
  const pat = keywords
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pat) return null;

  const escPat = pat.replace(/'/g, `'\\''`);
  const targets = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of listSessions(dir)) targets.push({ ...f, dir });
  }

  // Parallel grep across all session files. ~60 files in parallel run in well
  // under a second on macOS; sequential awaits used to take seconds per stack.
  const results = (
    await Promise.all(
      targets.map(async ({ sid, file, dir }) => {
        try {
          const { stdout } = await execP(
            `grep -cE '${escPat}' '${file.replace(/'/g, `'\\''`)}'`
          );
          const count = parseInt(stdout.trim(), 10) || 0;
          if (count <= 0) return null;
          const stat = fs.statSync(file);
          return { sid, count, mtime: stat.mtimeMs, dir };
        } catch {
          // grep exit 1 = no matches.
          return null;
        }
      })
    )
  ).filter(Boolean);
  if (results.length === 0) return null;
  results.sort((a, b) => b.count - a.count || b.mtime - a.mtime);
  const top = results[0];
  const isWorktreeDir = top.dir !== MAIN_SESSIONS_DIR;
  return {
    sid: top.sid,
    in_worktree: isWorktreeDir,
    worktree_name: isWorktreeDir ? worktreeName : null,
  };
}

// ---------- title parsing ----------
function parseTitle(title) {
  // Extract [REV-XXXX] or [NO-JIRA] and [Part N] prefixes, return remainder.
  let body = title;
  let jiraTag = null,
    partTag = null;
  const jm = body.match(/^\[(REV-\d+|NO-JIRA)\]\s*/);
  if (jm) {
    jiraTag = jm[1];
    body = body.slice(jm[0].length);
  }
  const pm = body.match(/^\[(Part [^\]]+)\]\s*/);
  if (pm) {
    partTag = `[${pm[1]}]`;
    body = body.slice(pm[0].length);
  }
  return { jira_tag: jiraTag, part_tag: partTag, title: body.trim() };
}

function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const ageDays = (Date.now() - then) / 86_400_000;
  if (ageDays < 1) return "today";
  return `${Math.floor(ageDays)}d ago`;
}

function deriveStatus(decision, isBottom, isUserPR) {
  if (!isUserPR) {
    if (decision === "APPROVED") return { label: "Approved", cls: "ok" };
    if (decision === "CHANGES_REQUESTED")
      return { label: "Changes requested", cls: "warn" };
    return { label: "Needs review", cls: "primary" };
  }
  if (decision === "APPROVED")
    return isBottom
      ? { label: "Approved", cls: "ok" }
      : { label: "Waiting on downstream", cls: "ok" };
  if (decision === "CHANGES_REQUESTED")
    return { label: "Changes requested", cls: "warn" };
  return { label: "Needs review", cls: "primary" };
}

// ---------- model assembly ----------
async function buildModel() {
  const [gtLogText, openPRs, mergedPRs, worktrees] = await Promise.all([
    sh("gt log short --no-interactive --classic"),
    fetchOpenPRs(),
    fetchRecentMergedPRs(),
    fetchWorktrees(),
    fetchOriginMain(),
  ]);

  const parsedLines = parseGtLog(gtLogText);
  const rawStacks = buildStacksFromGtLog(parsedLines);

  const branchToOpenPR = new Map(openPRs.map((p) => [p.headRefName, p]));
  const branchToMergedPR = new Map(mergedPRs.map((p) => [p.h, p]));
  const worktreeNameSet = new Set(worktrees.map((w) => w.name));
  const worktreeBranchToWT = new Map(worktrees.map((w) => [w.branch, w]));

  // Pre-detect branches that are FULLY merged into origin/main even though
  // they don't show up in fetchRecentMergedPRs. Graphite squashes leave the
  // GitHub PR CLOSED with mergedAt=null, so our recent-merged scan misses
  // them. Without this check, a freshly-merged branch whose worktree still
  // exists would be classified as "local only" and shown as an active stack.
  // We only need to check branches that are local-only candidates: have a
  // worktree, no open PR, and no recently-merged-PR record.
  const localCandidateBranches = [
    ...new Set(
      rawStacks.flatMap((c) =>
        c
          .filter(
            (b) =>
              worktreeBranchToWT.has(b.branch) &&
              !branchToOpenPR.has(b.branch) &&
              !branchToMergedPR.has(b.branch)
          )
          .map((b) => b.branch)
      )
    ),
  ];
  const fullyMergedBranches = new Set();
  await Promise.all(
    localCandidateBranches.map(async (branch) => {
      try {
        const { stdout } = await execP(
          `git rev-list --count ${branch} ^origin/main`,
          { cwd: REPO, maxBuffer: 1e6 }
        );
        const ahead = parseInt(stdout.trim(), 10) || 0;
        if (ahead === 0) fullyMergedBranches.add(branch);
      } catch {
        // git error → leave it as a candidate; partitioning will treat it
        // as local-only and the user can still see it.
      }
    })
  );

  // Partition each stack into user_segment (top, has user PRs) vs upstream_segment (below).
  const enrichedStacks = [];
  for (const chain of rawStacks) {
    // chain is leaf-first.
    const userBranches = [];
    const upstreamBranches = [];
    let inUserSegment = true;
    for (const b of chain) {
      const openPR = branchToOpenPR.get(b.branch);
      const merged = branchToMergedPR.get(b.branch);
      const wt = worktreeBranchToWT.get(b.branch);
      const isFullyMerged = fullyMergedBranches.has(b.branch);
      if (inUserSegment && openPR) {
        userBranches.push({ ...b, pr: openPR, isUser: true });
      } else if (inUserSegment && merged) {
        // Recently merged user PR — still user segment.
        userBranches.push({ ...b, pr: merged, isUser: true, isMerged: true });
      } else if (inUserSegment && wt && !isFullyMerged) {
        // Local-only branch: user has a worktree but hasn't submitted a PR
        // yet. Synthetic `pr` is filled in below from git log. Branches that
        // are fully merged into origin/main are excluded — the stale-worktree
        // section catches them for cleanup instead.
        userBranches.push({ ...b, pr: null, isUser: true, isLocal: true });
      } else if (inUserSegment) {
        inUserSegment = false;
        upstreamBranches.push(b);
      } else {
        upstreamBranches.push(b);
      }
    }
    if (userBranches.length === 0) continue;
    // Keep stacks with at least one open PR OR at least one local-only branch
    // (so unsubmitted in-progress stacks still appear).
    if (
      !userBranches.some(
        (u) => (u.pr && !u.isMerged) || u.isLocal
      )
    )
      continue;

    enrichedStacks.push({ userBranches, upstreamBranches, allBranches: chain });
  }

  // Fill in synthetic `pr` for local-only branches (worktree exists, no GitHub
  // PR yet). Run all in parallel — each is one quick `git log -n1`.
  const localBranches = enrichedStacks.flatMap((s) =>
    s.userBranches.filter((u) => u.isLocal)
  );
  await Promise.all(
    localBranches.map(async (u) => {
      const meta = await fetchLocalBranchMeta(u.branch);
      if (meta) u.pr = meta;
      else u.pr = { number: null, title: u.branch, isLocal: true, isDraft: false };
    })
  );

  // Look up review decisions for upstream branches that have open PRs.
  const upstreamLookups = new Map();
  for (const s of enrichedStacks) {
    for (const ub of s.upstreamBranches) {
      // Find any open PR for this branch (could be by another author).
      // Cheap lookup via gh pr list --search head:<branch>.
      if (!upstreamLookups.has(ub.branch)) {
        upstreamLookups.set(ub.branch, fetchAnyPR(ub.branch));
      }
    }
  }
  const upstreamPRMap = new Map();
  for (const [branch, p] of upstreamLookups) {
    const result = await p;
    if (result && result.state === "OPEN") upstreamPRMap.set(branch, result);
  }
  // Fetch full meta (review decisions) for each upstream PR.
  const upstreamMetaMap = new Map();
  await Promise.all(
    [...upstreamPRMap.values()].map(async (pr) => {
      const meta = await fetchPRMeta(pr.number);
      if (meta) upstreamMetaMap.set(pr.headRefName, meta);
    })
  );

  // Fetch review threads for all user PRs in ONE bulk GraphQL query (aliased
  // fields). Local-only branches have `pr.number === null` and are skipped.
  const allUserPRNums = enrichedStacks.flatMap((s) =>
    s.userBranches
      .filter((u) => u.pr && !u.isMerged && u.pr.number != null)
      .map((u) => u.pr.number)
  );
  const prSignals = await fetchPrSignalsBulk(allUserPRNums);

  // Pre-compute jiraKeys + worktree per stack so we can kick off all session-scoring
  // calls in parallel up front (each scoring call grep's ~60 JSONL files; serializing
  // them across stacks turned a few-hundred-ms job into seconds).
  const enrichedMeta = enrichedStacks.map((es) => {
    const userOpenPRs = es.userBranches.filter((u) => u.pr && !u.isMerged);
    const userMergedPRs = es.userBranches.filter((u) => u.isMerged);
    const jiraKeysSet = new Set();
    for (const u of userOpenPRs) {
      const t = parseTitle(u.pr.title);
      if (t.jira_tag && t.jira_tag !== "NO-JIRA") jiraKeysSet.add(t.jira_tag);
    }
    const jiraKeys = [...jiraKeysSet].sort();
    let worktree = null;
    for (const u of es.userBranches) {
      if (worktreeBranchToWT.has(u.branch)) {
        worktree = worktreeBranchToWT.get(u.branch);
        break;
      }
    }
    const keywords = [
      ...userOpenPRs
        .filter((u) => u.pr.number != null)
        .map((u) => String(u.pr.number)),
      ...userMergedPRs.map((u) => String(u.pr.n || u.pr.number)),
      ...es.userBranches.map((u) => u.branch),
      ...jiraKeys,
      worktree?.name,
    ];
    return { es, userOpenPRs, userMergedPRs, jiraKeys, worktree, keywords };
  });
  const resumePromises = enrichedMeta.map((m) =>
    scoreSessionsForStack(m.keywords, m.worktree?.name)
  );

  // Per-stack "commits behind origin/main" — uses the leaf branch's merge-base
  // with origin/main. Stacks created/restacked at different times can have
  // different bases, so we don't share a single number.
  const behindPromises = enrichedMeta.map((m) =>
    fetchStackBehind(m.es.userBranches[0].branch)
  );
  // Per-stack restack-conflict prediction (in-memory 3-way merge against
  // origin/main). Lets the UI disable the Restack button when conflicts
  // are guaranteed.
  const conflictPromises = enrichedMeta.map((m) =>
    checkRestackConflicts(m.es.userBranches[0].branch)
  );

  // Build final model.
  const stacks = [];
  for (let stackIdx = 0; stackIdx < enrichedMeta.length; stackIdx++) {
    const { es, userOpenPRs, userMergedPRs, jiraKeys, worktree } = enrichedMeta[stackIdx];

    // Build PRs (top → bottom).
    const userPRsRender = userOpenPRs.map((u, i) => {
      const t = parseTitle(u.pr.title);
      const isBottom = i === userOpenPRs.length - 1;
      const status = deriveStatus(
        u.pr.reviewDecision || "REVIEW_REQUIRED",
        isBottom,
        true
      );
      const sig =
        u.pr.number != null
          ? prSignals.get(u.pr.number) || { human: 0, bot: 0, checks: null }
          : { human: 0, bot: 0, checks: null };
      const isLocal = !!u.pr.isLocal;
      return {
        num: u.pr.number, // null for local-only branches
        url: u.pr.number
          ? `https://app.graphite.com/github/pr/revefi/rcode/${u.pr.number}`
          : null,
        branch: u.branch,
        title: t.title,
        jira_tag: t.jira_tag,
        part_tag: t.part_tag,
        is_draft: !!u.pr.isDraft,
        is_local: isLocal,
        decision: u.pr.reviewDecision || "REVIEW_REQUIRED",
        status_label: isLocal ? "Local only" : status.label,
        status_class: isLocal ? "local" : status.cls,
        human_comments: sig.human,
        bot_comments: sig.bot,
        // Suppress check chip on drafts and local-only branches.
        checks: u.pr.isDraft || isLocal ? null : sig.checks,
        updated_label: relTime(u.pr.updatedAt),
        needs_restack: u.flags && u.flags.includes("needs restack"),
      };
    });

    // Counts.
    const counts = {
      created: userOpenPRs.length,
      merged: userMergedPRs.length,
      approved: userPRsRender.filter((p) => p.decision === "APPROVED").length,
      pending: userPRsRender.filter(
        (p) => p.decision !== "APPROVED" && p.decision !== "CHANGES_REQUESTED"
      ).length,
      changes_requested: userPRsRender.filter(
        (p) => p.decision === "CHANGES_REQUESTED"
      ).length,
    };

    // Upstream PRs render.
    const upstreamPRsRender = es.upstreamBranches
      .map((ub) => upstreamMetaMap.get(ub.branch))
      .filter(Boolean)
      .map((meta) => {
        const t = parseTitle(meta.title);
        const status = deriveStatus(
          meta.reviewDecision || "REVIEW_REQUIRED",
          false,
          false
        );
        return {
          num: meta.number,
          url: meta.url,
          title: t.title,
          jira_tag: t.jira_tag,
          part_tag: t.part_tag,
          author: meta.author?.login || "unknown",
          decision: meta.reviewDecision || "REVIEW_REQUIRED",
          status_label: status.label,
          status_class: status.cls,
          updated_label: relTime(meta.updatedAt),
        };
      });

    // Upstream summary stats.
    let upstream = null;
    if (upstreamPRsRender.length > 0) {
      const approved = upstreamPRsRender.filter(
        (p) => p.decision === "APPROVED"
      ).length;
      const cr = upstreamPRsRender.filter(
        (p) => p.decision === "CHANGES_REQUESTED"
      ).length;
      const rr = upstreamPRsRender.length - approved - cr;
      upstream = {
        n: upstreamPRsRender.length,
        author: upstreamPRsRender[0]?.author || "unknown",
        approved,
        changes_requested: cr,
        review_required: rr,
      };
    }

    // Stack category.
    const anyHumanComments = userPRsRender.some((p) => p.human_comments > 0);
    const allApproved = userPRsRender.every((p) => p.decision === "APPROVED");
    let category, categoryLabel;
    if (anyHumanComments) {
      category = "human_review";
      categoryLabel = "Address review comments";
    } else if (
      allApproved &&
      (!upstream ||
        upstream.changes_requested + upstream.review_required === 0) &&
      !upstream
    ) {
      category = "ready";
      categoryLabel = "Ready to merge";
    } else if (
      allApproved &&
      upstream &&
      upstream.changes_requested + upstream.review_required === 0
    ) {
      category = "blocked_upstream";
      categoryLabel = "Blocked upstream";
    } else if (allApproved && upstream) {
      category = "blocked_upstream";
      categoryLabel = "Blocked upstream";
    } else {
      category = "awaiting_review";
      categoryLabel = "Awaiting review";
    }

    const needsRestack = userPRsRender.some((p) => p.needs_restack);

    // Stack name: bottom PR title (closest-to-trunk usually has the most descriptive name).
    const bottomPR = userOpenPRs[userOpenPRs.length - 1];
    const baseTitle = bottomPR
      ? parseTitle(bottomPR.pr.title).title
      : es.userBranches[0].branch;
    const stackName =
      baseTitle.replace(/\s*\|\s*/g, " — ").slice(0, 100) ||
      es.userBranches[0].branch;

    const stackKey =
      jiraKeys.length > 0
        ? jiraKeys.join("+")
        : `NO-JIRA-${es.userBranches[es.userBranches.length - 1].branch}`;

    // Resume session + behind + conflict promises were kicked off up front.
    const resume = await resumePromises[stackIdx];
    const behindOrigin = await behindPromises[stackIdx];
    const restackCheck = await conflictPromises[stackIdx];

    stacks.push({
      stack_key: stackKey,
      jira_keys: jiraKeys,
      name: stackName,
      category,
      category_label: categoryLabel,
      needs_restack: needsRestack,
      behind_origin: behindOrigin,
      restack_check: restackCheck,
      top_pr: userPRsRender[0]
        ? { num: userPRsRender[0].num, url: userPRsRender[0].url }
        : null,
      counts,
      upstream,
      worktree: worktree
        ? { name: worktree.name, path: worktree.path, branch: worktree.branch }
        : null,
      resume,
      prs: userPRsRender,
      upstream_prs: upstreamPRsRender,
    });
  }

  // Improve stack names via Claude (cached on disk by PR-set hash so it only regens
  // when a stack's PRs actually change). On any failure we keep the fallback name.
  await enhanceStackNamesWithClaude(stacks);

  // Order stacks by category priority.
  const categoryOrder = {
    human_review: 0,
    ready: 1,
    blocked_upstream: 2,
    awaiting_review: 3,
    other: 4,
  };
  stacks.sort(
    (a, b) =>
      (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9)
  );

  // Stale worktrees.
  const activeBranches = new Set(openPRs.map((p) => p.headRefName));
  const staleResults = await Promise.all(
    worktrees.map(async (w) => {
      if (activeBranches.has(w.branch)) return null;
      const anyPR = await fetchAnyPR(w.branch);
      if (anyPR) {
        if (anyPR.state === "MERGED") {
          return { ...w, reason: `PR #${anyPR.number} merged`, pr_num: anyPR.number, pr_url: anyPR.url };
        }
        if (anyPR.state === "CLOSED") {
          return { ...w, reason: `PR #${anyPR.number} closed without merge`, pr_num: anyPR.number, pr_url: anyPR.url };
        }
        return null;
      }
      try {
        const { stdout } = await execP(
          `git -C '${w.path}' log main..HEAD --oneline | head -1`
        );
        if (!stdout.trim()) {
          return { ...w, reason: "Branch fully merged into main (no unique commits)", pr_num: null, pr_url: null };
        }
      } catch {
        // ignore — git error means we just don't classify this worktree as stale
      }
      return null;
    })
  );
  const staleWorktrees = staleResults.filter(Boolean);

  // Enrich stacks with Jira chip data (key + summary).
  const allJiraKeys = [...new Set(stacks.flatMap((s) => s.jira_keys))];
  const ticketsByKey = new Map();
  if (allJiraKeys.length > 0) {
    const map = await fetchJiraTickets(allJiraKeys);
    for (const [k, v] of Object.entries(map)) if (v) ticketsByKey.set(k, v);
  }
  for (const s of stacks) {
    s.jira_chips = s.jira_keys.map((k) => {
      const t = ticketsByKey.get(k);
      return {
        key: k,
        summary: t?.summary || null,
        url: `https://revefi.atlassian.net/browse/${k}`,
      };
    });
  }

  // Jira tickets assigned to me — all of them, with a `stack` reference for any
  // ticket that's already attached to an open stack. The frontend filters this
  // (default: "without stack"). Wire field name kept as `untouched_jira` to
  // avoid churn — it's a misnomer now, the section title in the UI is just
  // "Jira".
  const openJiraTickets = await fetchOpenJiraTickets();
  const jiraKeyToStack = new Map(); // key → { stack_key, name }
  for (const s of stacks) {
    for (const k of s.jira_keys) {
      if (!jiraKeyToStack.has(k)) {
        jiraKeyToStack.set(k, { stack_key: s.stack_key, name: s.name });
      }
    }
  }
  const untouchedJira = openJiraTickets.map((t, idx) => ({
    rank: idx + 1,
    key: t.key,
    url: `https://revefi.atlassian.net/browse/${t.key}`,
    type: t.type,
    summary: t.summary,
    priority: t.priority,
    updated: t.updated,
    updated_label: relTime(t.updated),
    note: deriveJiraNote(t),
    sprint: t.sprint || null,
    status: t.status,
    status_category: t.status_category,
    stack: jiraKeyToStack.get(t.key) || null,
  }));

  // Totals.
  const allUserPRs = stacks.flatMap((s) => s.prs);
  const totals = {
    stacks: stacks.length,
    open_prs: allUserPRs.length,
    approved: allUserPRs.filter((p) => p.decision === "APPROVED").length,
    pending: allUserPRs.filter(
      (p) => p.decision !== "APPROVED" && p.decision !== "CHANGES_REQUESTED"
    ).length,
    changes_requested: allUserPRs.filter(
      (p) => p.decision === "CHANGES_REQUESTED"
    ).length,
  };

  return {
    meta: {
      generated_at: new Date().toISOString(),
      date: new Date().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      totals,
      jira_configured: jiraConfigured(),
    },
    stacks,
    untouched_jira: untouchedJira,
    stale_worktrees: staleWorktrees,
  };
}

// ---------- stack-name generation (Claude, cached by PR-set hash) ----------
function stackPrHash(stack) {
  return [...stack.prs.map((p) => p.num)].sort((a, b) => a - b).join(",");
}
function stackNameCacheKey(stack) {
  return `${stack.stack_key}:${stackPrHash(stack)}`;
}

async function enhanceStackNamesWithClaude(stacks) {
  // Load disk cache once (already TTL-checked by loadDiskCache).
  const cached = loadDiskCache(STACK_NAMES_CACHE_FILE) || {};

  // Apply cached names + collect stacks needing fresh names.
  const needs = [];
  for (const s of stacks) {
    const ck = stackNameCacheKey(s);
    if (cached[ck]) {
      s.name = cached[ck];
    } else {
      needs.push({ ck, stack: s });
    }
  }
  if (needs.length === 0) return;

  // Build a single Claude prompt for all stacks at once.
  const payload = needs.reduce((acc, { ck, stack }) => {
    acc[ck] = stack.prs.map((p) => {
      const tag = p.jira_tag ? `[${p.jira_tag}]` : "";
      const part = p.part_tag || "";
      return `${tag}${part} ${p.title}`.trim();
    });
    return acc;
  }, {});

  const prompt =
    `Generate a short, descriptive stack name (4-7 words, Title Case, no quotes, no trailing punctuation) ` +
    `for each PR stack below. The name should capture the WHAT of the stack, not the individual parts. ` +
    `Avoid generic words like "stack" or "PRs". Use "&" or "+" to combine when a stack covers multiple themes.\n\n` +
    `Output ONLY a JSON object mapping the original key to the generated name. No preamble, no fences.\n\n` +
    `Stacks (key → list of PR titles, top to bottom):\n${JSON.stringify(
      payload,
      null,
      2
    )}`;

  let parsed;
  try {
    const out = await callClaude(prompt, { timeoutMs: 60_000 });
    parsed = parseJsonLoose(out);
  } catch (err) {
    console.warn("[stack-names] callClaude failed:", err.message);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  for (const { ck, stack } of needs) {
    const name = parsed[ck];
    if (typeof name === "string" && name.trim()) {
      stack.name = name.trim();
      cached[ck] = stack.name;
    }
  }
  saveDiskCache(STACK_NAMES_CACHE_FILE, cached, STACK_NAMES_TTL_MS);
}

// ---------- caching ----------
function clearClaudeBackedCaches() {
  // Stack names are the only Claude-backed disk cache now (Jira goes through direct REST).
  try {
    fs.unlinkSync(STACK_NAMES_CACHE_FILE);
  } catch {
    /* file may not exist */
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// Restack a stack onto origin/main by running `gt restack` inside its worktree.
// Heavily guarded:
//   - looks up the stack by key from current model (no client-supplied paths)
//   - refuses if the stack has upstream PRs (would skip over someone else's work)
//   - refuses if the stack has no worktree (gt sync from main handles those)
//   - refuses if the worktree has uncommitted changes (would clobber WIP)
//   - on any failure runs `git rebase --abort` to leave the branch state clean
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
    // Restack already happened; don't undo it. Surface a partial-success error
    // so the user knows the push needs a manual retry.
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

async function getData(forceRefresh = false, opts = {}) {
  if (opts.intelligent) clearClaudeBackedCaches();

  const now = Date.now();
  if (
    !forceRefresh &&
    !opts.intelligent &&
    cache.data &&
    now - cache.ts < CACHE_TTL_MS
  ) {
    return cache.data;
  }
  if (cache.building) return cache.building;
  cache.building = (async () => {
    try {
      const data = await buildModel();
      cache = { ts: Date.now(), data, building: null };
      return data;
    } catch (err) {
      cache.building = null;
      throw err;
    }
  })();
  return cache.building;
}

// ---------- recommendations (Claude-backed) ----------
let recsCache = loadRecsFromDisk();
let recsBuilding = null;

function loadRecsFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(RECS_CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveRecsToDisk(recs) {
  try {
    fs.writeFileSync(RECS_CACHE_FILE, JSON.stringify(recs, null, 2));
  } catch (err) {
    console.warn("[recs] save failed:", err.message);
  }
}

function buildRecsPayload(model) {
  // Trim to the smallest payload that still gives Claude enough to make sharp recommendations.
  return {
    stacks: model.stacks.map((s) => ({
      name: s.name,
      category: s.category,
      jira: s.jira_keys,
      counts: s.counts,
      needs_restack: s.needs_restack,
      top_pr: s.top_pr?.num || null,
      bottom_pr: s.prs[s.prs.length - 1]?.num || null,
      worktree: s.worktree?.name || null,
      upstream: s.upstream
        ? {
            n: s.upstream.n,
            author: s.upstream.author,
            approved: s.upstream.approved,
            changes_requested: s.upstream.changes_requested,
            review_required: s.upstream.review_required,
          }
        : null,
      prs: s.prs.map((p) => ({
        n: p.num,
        d: p.decision,
        h: p.human_comments,
        b: p.bot_comments,
      })),
    })),
    untouched_jira: (model.untouched_jira || []).slice(0, 8).map((j) => ({
      key: j.key,
      type: j.type,
      summary: j.summary,
      days_old: Math.floor(
        (Date.now() - new Date(j.updated).getTime()) / 86400000
      ),
    })),
    stale_worktrees: model.stale_worktrees.map((w) => ({
      name: w.name,
      reason: w.reason,
    })),
  };
}

async function generateRecommendations(model) {
  const payload = buildRecsPayload(model);
  const prompt =
    `You are reviewing my live PR/stack dashboard and producing actionable recommendations.\n\n` +
    `Output 3-6 single-sentence recommendations as raw HTML <li> elements (no <ol> wrapper, no markdown, no preamble — just <li>...</li> joined by newlines). Rules:\n` +
    `- Start with <strong>action phrase</strong>.\n` +
    `- Reference PR numbers as <a href="https://app.graphite.com/github/pr/revefi/rcode/NUM" target="_blank" rel="noopener">#NUM</a>.\n` +
    `- Reference Jira tickets as <a href="https://revefi.atlassian.net/browse/KEY" target="_blank" rel="noopener">KEY</a>.\n` +
    `- Wrap commands like \`gt restack\` in <code>...</code>.\n` +
    `- Order most actionable first: human review comments, ready-to-merge, blocked upstream, restacks needed, fresh review requests, stale worktrees, new work pick.\n` +
    `- Skip categories that don't apply.\n\n` +
    `Field key: counts.{created,merged,approved,pending,changes_requested}; per-PR d=reviewDecision (APPROVED|REVIEW_REQUIRED|CHANGES_REQUESTED|empty), h=human review comments (open), b=bot review comments (open).\n\n` +
    `Data: ${JSON.stringify(payload)}`;

  return callClaude(prompt, { timeoutMs: 90_000 });
}

async function getRecommendations(forceRefresh = false) {
  if (!forceRefresh && recsCache) return recsCache;
  if (recsBuilding) return recsBuilding;
  recsBuilding = (async () => {
    try {
      const model = await getData(false);
      const html = await generateRecommendations(model);
      const recs = {
        ts: new Date().toISOString(),
        html,
      };
      recsCache = recs;
      saveRecsToDisk(recs);
      return recs;
    } finally {
      recsBuilding = null;
    }
  })();
  return recsBuilding;
}

// ---------- HTTP server ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(STATIC_DIR, urlPath);
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/api/data") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      const intelligent = url.searchParams.get("intelligent") === "1";
      const data = await getData(force, { intelligent });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message, stack: err.stack }));
    }
    return;
  }
  if (url.pathname === "/api/recommendations") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      const recs = await getRecommendations(force);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(recs || { ts: null, html: "" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (url.pathname === "/api/restack" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await restackStack(body?.stack_key);
      res.writeHead(result.ok ? 200 : 400, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Jira transitions: list valid next-states for a ticket.
  if (url.pathname === "/api/jira/transitions" && req.method === "GET") {
    try {
      const key = url.searchParams.get("key") || "";
      const transitions = await fetchJiraTransitions(key);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, transitions }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Jira transitions: perform one. Body: { key, transition_id }.
  if (url.pathname === "/api/jira/transition" && req.method === "POST") {
    try {
      const body = await readJson(req);
      await performJiraTransition(body?.key, body?.transition_id);
      // Bust the dashboard cache so the next /api/data picks up the new
      // status from Jira instead of the 30s-stale snapshot.
      cache.ts = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        cached: !!cache.data,
        age_ms: Date.now() - cache.ts,
        recs_cached: !!recsCache,
        recs_ts: recsCache?.ts || null,
        jira_configured: jiraConfigured(),
      })
    );
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Live dashboard listening on http://localhost:${PORT}`);
  console.log(`Open in browser, or run:  open http://localhost:${PORT}`);
  console.log(
    `Jira: ${
      jiraConfigured()
        ? "configured"
        : "NOT configured (set ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN in .env)"
    }`
  );
});
