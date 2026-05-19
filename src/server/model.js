// Build the dashboard model — the JSON payload returned by /api/data.
// Everything else in src/server/ is data plumbing; this file is the
// orchestration that turns raw `gt log`, `gh pr list`, Jira REST, and
// session-grep results into the shape the frontend renders.

const { sh, execP } = require("./shell");
const { REPO } = require("./config");
const {
  parseGtLog,
  buildStacksFromGtLog,
  fetchWorktrees,
  fetchStackBehind,
  checkRestackConflicts,
  fetchLocalBranchMeta,
} = require("./git");
const { Timer, appendTimingRecord } = require("./timing");
const {
  fetchOpenPRs,
  fetchRecentMergedPRs,
  fetchAnyPR,
  fetchPRMeta,
  fetchPrSignalsBulk,
} = require("./gh");
const {
  jiraConfigured,
  fetchJiraTickets,
  fetchOpenJiraTickets,
  deriveJiraNote,
} = require("./jira");
const {
  scoreSessionsForStack,
  enhanceStackNamesWithClaude,
} = require("./claude");

// All PR links in the dashboard go to Graphite, not GitHub — CLAUDE.md
// convention. gh CLI / GraphQL responses give us the GitHub URL by default,
// so we always derive ours from the PR number instead of using `.url`.
function graphiteUrl(prNumber) {
  return prNumber != null
    ? `https://app.graphite.com/github/pr/revefi/rcode/${prNumber}`
    : null;
}

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

// Compact single-unit relative time: "12s ago", "5m ago", "4h ago", "3d ago".
// "today" / "yesterday" used to obscure whether a PR was touched 20 minutes
// or 23 hours ago — the granular version surfaces that at a glance.
function relTime(iso) {
  if (!iso) return "";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
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

async function buildModel() {
  const t = new Timer();

  // Stage 1: cheap parallel fetches. `git fetch origin main` used to live
  // here too — it now runs as a 5-min background tick from index.js so
  // the manual-refresh path doesn't pay for it. behind-counts read
  // whatever origin/main ref the background tick most recently pulled.
  const [gtLogText, openPRs, mergedPRs, worktrees] = await t.time(
    "initial_fetch",
    () =>
      Promise.all([
        sh("gt log short --no-interactive --classic"),
        fetchOpenPRs(),
        fetchRecentMergedPRs(),
        fetchWorktrees(),
      ])
  );

  // Stage 2: kick off everything we *can* start with just openPRs +
  // worktrees in hand. These all run in parallel with the rest of
  // buildModel — we only await them at the very end before assembling
  // the return value.
  const prSignalsPromise = t.time("pr_signals", () =>
    fetchPrSignalsBulk(openPRs.map((p) => p.number))
  );

  // Stale worktrees + open Jira are independent of anything stack-shaped.
  // Pulling them out of the post-render block lets them overlap with the
  // expensive `resumes` work below.
  const activeBranchesEarly = new Set(openPRs.map((p) => p.headRefName));
  const stalePromise = t.time("stale_worktrees", () =>
    Promise.all(
      worktrees.map(async (w) => {
        if (activeBranchesEarly.has(w.branch)) return null;
        const anyPR = await fetchAnyPR(w.branch);
        if (anyPR) {
          if (anyPR.state === "MERGED") {
            return { ...w, reason: `PR #${anyPR.number} merged`, pr_num: anyPR.number, pr_url: graphiteUrl(anyPR.number) };
          }
          if (anyPR.state === "CLOSED") {
            return { ...w, reason: `PR #${anyPR.number} closed without merge`, pr_num: anyPR.number, pr_url: graphiteUrl(anyPR.number) };
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
    )
  );
  const openJiraPromise = t.time("open_jira", () => fetchOpenJiraTickets());

  const parsedLines = parseGtLog(gtLogText);
  const rawStacks = buildStacksFromGtLog(parsedLines);

  const branchToOpenPR = new Map(openPRs.map((p) => [p.headRefName, p]));
  const branchToMergedPR = new Map(mergedPRs.map((p) => [p.h, p]));
  const worktreeBranchToWT = new Map(worktrees.map((w) => [w.branch, w]));

  // Pre-detect branches that are FULLY merged into origin/main even though
  // they don't show up in fetchRecentMergedPRs. Graphite squashes leave the
  // GitHub PR CLOSED with mergedAt=null, so our recent-merged scan misses
  // them. Without this check, a freshly-merged branch whose worktree still
  // exists would be classified as "local only" and shown as an active stack.
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
  await t.time("fully_merged_detect", () =>
    Promise.all(
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
    )
  );

  // Partition each stack into user_segment (top, has user PRs) vs upstream_segment (below).
  const enrichedStacks = [];
  for (const chain of rawStacks) {
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
    if (
      !userBranches.some(
        (u) => (u.pr && !u.isMerged) || u.isLocal
      )
    )
      continue;

    enrichedStacks.push({ userBranches, upstreamBranches, allBranches: chain });
  }

  // Fire-and-await: local-branch synthetic PR meta and upstream PR meta
  // both kick off here. local_branch_meta MUST complete before we build
  // enrichedMeta (which reads u.pr.title for jira-tag parsing). upstream
  // meta only feeds the render loop, so it can stay in flight until then.
  const localBranches = enrichedStacks.flatMap((s) =>
    s.userBranches.filter((u) => u.isLocal)
  );
  const localMetaPromise = t.time("local_branch_meta", () =>
    Promise.all(
      localBranches.map(async (u) => {
        const meta = await fetchLocalBranchMeta(u.branch);
        if (meta) u.pr = meta;
        else u.pr = { number: null, title: u.branch, isLocal: true, isDraft: false };
      })
    )
  );
  const upstreamMetaPromise = t.time("upstream_meta", async () => {
    const upstreamLookups = new Map();
    for (const s of enrichedStacks) {
      for (const ub of s.upstreamBranches) {
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
    const metaMap = new Map();
    await Promise.all(
      [...upstreamPRMap.values()].map(async (pr) => {
        const meta = await fetchPRMeta(pr.number);
        if (meta) metaMap.set(pr.headRefName, meta);
      })
    );
    return metaMap;
  });

  // Need u.pr.title for jira-tag parsing in enrichedMeta — wait only for
  // local_branch_meta (typically 20ms). upstream/pr_signals stay running.
  await localMetaPromise;

  // Pre-compute jiraKeys + worktree per stack — synchronous derivation.
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
  // (E) Kick off all three parallel arrays and await them in ONE shot up
  // front instead of `await`ing per-stack inside the loop. Each subarray
  // gets its own timer so we can spot which of the three is the slow leg.
  const resumesPromise = t.time("resumes", () =>
    Promise.all(
      enrichedMeta.map((m) =>
        scoreSessionsForStack(m.keywords, m.worktree?.name)
      )
    )
  );
  const behindsPromise = t.time("behinds", () =>
    Promise.all(
      enrichedMeta.map((m) => fetchStackBehind(m.es.userBranches[0].branch))
    )
  );
  const conflictsPromise = t.time("conflicts", () =>
    Promise.all(
      enrichedMeta.map((m) =>
        checkRestackConflicts(m.es.userBranches[0].branch)
      )
    )
  );
  // We can start jira_chips now: it only needs the union of jira keys
  // across all stacks, which is derivable from enrichedMeta. Letting it
  // run in parallel with the slow `resumes` work means jira_chips's
  // ~1.2s falls inside the resumes window instead of after it.
  const allJiraKeys = [
    ...new Set(enrichedMeta.flatMap((m) => m.jiraKeys)),
  ];
  const jiraChipsPromise = allJiraKeys.length
    ? t.time("jira_chips", () => fetchJiraTickets(allJiraKeys))
    : Promise.resolve({});

  // Single barrier before the render loop: wait for everything still in
  // flight. resumes (~5s) is the long tail; everything else is shorter
  // and overlapping with it.
  const [resumes, behinds, conflicts, prSignals, upstreamMetaMap] =
    await Promise.all([
      resumesPromise,
      behindsPromise,
      conflictsPromise,
      prSignalsPromise,
      upstreamMetaPromise,
    ]);

  const stacks = [];
  for (let stackIdx = 0; stackIdx < enrichedMeta.length; stackIdx++) {
    const { es, userOpenPRs, userMergedPRs, jiraKeys, worktree } = enrichedMeta[stackIdx];

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
        num: u.pr.number,
        url: graphiteUrl(u.pr.number),
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
        // Raw ISO timestamps so the frontend can sort stacks by recency
        // and age. updated_label is pre-formatted for the row UI; these
        // are the sortable counterparts.
        updated_at: u.pr.updatedAt || null,
        created_at: u.pr.createdAt || null,
        needs_restack: u.flags && u.flags.includes("needs restack"),
      };
    });

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
          url: graphiteUrl(meta.number),
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

    const resume = resumes[stackIdx];
    const behindOrigin = behinds[stackIdx];
    const restackCheck = conflicts[stackIdx];

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

  await t.time("enhance_names", () => enhanceStackNamesWithClaude(stacks));

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

  // All three of these promises were kicked off earlier and have been
  // running while resumes was the long tail. Awaiting them here is
  // essentially free — they're almost always already resolved.
  const [staleResults, jiraChipsMap, openJiraTickets] = await Promise.all([
    stalePromise,
    jiraChipsPromise,
    openJiraPromise,
  ]);
  const staleWorktrees = staleResults.filter(Boolean);

  // Enrich stacks with Jira chip data (key + summary).
  const ticketsByKey = new Map();
  for (const [k, v] of Object.entries(jiraChipsMap || {})) {
    if (v) ticketsByKey.set(k, v);
  }
  for (const s of stacks) {
    s.jira_chips = s.jira_keys.map((k) => {
      const ticket = ticketsByKey.get(k);
      return {
        key: k,
        summary: ticket?.summary || null,
        url: `https://revefi.atlassian.net/browse/${k}`,
      };
    });
  }
  const jiraKeyToStack = new Map();
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

  appendTimingRecord(
    t.summary({
      stack_count: stacks.length,
      open_pr_count: totals.open_prs,
    })
  );

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

module.exports = { buildModel, parseTitle, relTime, deriveStatus };
