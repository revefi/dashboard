// All HTML-string rendering. Pure functions of the model (and a bit of
// localStorage-derived state via storage.js). Templates use template
// literals; nothing here touches the network.

import { $, $$, esc, truncate } from "./dom.js";
import { store } from "./store.js";
import {
  REMARKS_KEY_PREFIX,
  JIRA_REMARKS_PREFIX,
  getStackNameOverride,
  getCompletedSet,
  getSprintFilter,
  setSprintFilter,
  getStackFilter,
  setStackFilter,
  getActiveStackSort,
  setActiveStackSort,
} from "./storage.js";
import { SORT_MODES, sortStacks } from "./sort.js";
import { wireDelegates } from "./delegates.js";

export function renderSummary(meta) {
  const t = meta.totals;
  const parts = [
    `<div class="stat" title="Number of distinct PR stacks you have open. Each stack is one connected chain of branches under the same Jira ticket(s)."><div class="v">${t.stacks}</div><div class="l">Active stacks</div></div>`,
    `<div class="stat" title="Total open PRs you authored across all stacks."><div class="v">${t.open_prs}</div><div class="l">Open PRs</div></div>`,
    `<div class="stat ok" title="PRs whose review state is APPROVED."><div class="v">${t.approved}</div><div class="l">Approved</div></div>`,
    `<div class="stat pending" title="PRs that haven't been approved yet and don't have changes requested."><div class="v">${t.pending}</div><div class="l">Pending review</div></div>`,
  ];
  if (t.changes_requested > 0) {
    parts.push(
      `<div class="stat danger" title="PRs where a reviewer requested changes. Address these before re-requesting review."><div class="v">${t.changes_requested}</div><div class="l">Changes requested</div></div>`
    );
  }
  $("#summary").innerHTML = parts.join("");
  $("#meta-date").textContent = meta.date;
}

function renderJiraChips(stack) {
  if (!stack.jira_chips || stack.jira_chips.length === 0) return "";
  return `<div class="chips">${stack.jira_chips
    .map((c) => {
      const label = c.summary ? `${c.key} — ${truncate(c.summary, 60)}` : c.key;
      const title = c.summary ? `${c.key} — ${c.summary}` : c.key;
      return `<a class="chip" href="${esc(
        c.url
      )}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${esc(
        title
      )}">${esc(label)}</a>`;
    })
    .join("")}</div>`;
}

function renderChecksChip(checks) {
  if (!checks || !checks.state) return "";
  const { state, failing, running, total } = checks;
  if (state === "SUCCESS") {
    return `<span class="stack-checks ok" title="${total} check${
      total === 1 ? "" : "s"
    } passed">✓ checks</span>`;
  }
  if (state === "FAILURE" || state === "ERROR") {
    const names = failing.length ? failing : ["(unknown)"];
    const tip = `${failing.length} failing check${
      failing.length === 1 ? "" : "s"
    }:\n  ${names.join("\n  ")}`;
    return `<span class="stack-checks fail" title="${esc(tip)}">✗ ${
      failing.length || "?"
    } failing</span>`;
  }
  if (state === "PENDING" || state === "EXPECTED") {
    return `<span class="stack-checks pending" title="${
      running || total
    } check${
      (running || total) === 1 ? "" : "s"
    } in progress">● running</span>`;
  }
  return "";
}

function renderPrRow(pr, opts = {}) {
  const cls = pr.status_class || "primary";
  const jira = pr.jira_tag
    ? `<span class="stack-jira">[${esc(pr.jira_tag)}]${
        pr.part_tag ? esc(pr.part_tag) : ""
      }</span>`
    : "";
  const author = opts.is_upstream
    ? `<span class="stack-author">· @${esc(pr.author)}</span>`
    : "";
  const comments =
    pr.human_comments || pr.bot_comments
      ? `<span class="stack-comments" title="${pr.human_comments || 0} human, ${
          pr.bot_comments || 0
        } bot (open)">💬 <span class="h">${
          pr.human_comments || 0
        }h</span>/<span class="b">${pr.bot_comments || 0}b</span></span>`
      : "";
  const checksChip = renderChecksChip(pr.checks);
  // Drafts replace the review-status pill with a single Draft chip — review
  // states like "Needs review" are misleading on drafts that aren't ready.
  // Local-only branches (no GitHub PR yet) get their own pill.
  const statusPill = pr.is_local
    ? `<span class="stack-status local" title="No GitHub PR yet — branch exists locally only. Run gt submit from the worktree to push.">📦 Local only</span>`
    : pr.is_draft
    ? `<span class="stack-status draft" title="PR is in draft — open it to mark ready for review.">📝 Draft</span>`
    : `<span class="stack-status ${cls}">${esc(pr.status_label)}</span>`;
  const numLabel = pr.num ? `#${pr.num}` : "—";
  const titleSpan = `<span class="stack-pr-title" title="${esc(pr.title)}">${esc(pr.title)}</span>`;
  const linkOpen = pr.url
    ? `<a class="stack-link" href="${esc(pr.url)}" target="_blank" rel="noopener">`
    : `<span class="stack-link no-pr">`;
  const linkClose = pr.url ? `</a>` : `</span>`;
  return `
    <div class="stack-row ${cls}">
      ${linkOpen}
        <span class="stack-num">${numLabel}</span>
        ${jira}
        ${titleSpan}
        ${author}
      ${linkClose}
      ${
        pr.branch
          ? `<button class="pr-copy-branch" data-copy data-cmd="${esc(
              pr.branch
            )}" title="Copy branch name: ${esc(pr.branch)}" aria-label="Copy branch name">⎘</button>`
          : ""
      }
      ${comments}
      ${checksChip}
      ${statusPill}
      <span class="stack-time">${esc(pr.updated_label || "")}</span>
    </div>`;
}

function renderUpstreamBanner(stack) {
  if (!stack.upstream) return "";
  const u = stack.upstream;
  const blocking = u.changes_requested + u.review_required;
  if (blocking > 0) {
    return `<div class="upstream-banner">🚧 Blocked by <b>${blocking}</b> upstream PR(s) by @${esc(
      u.author
    )} not yet approved.</div>`;
  }
  return `<div class="upstream-banner ok">✅ All ${u.n} upstream PRs by @${esc(
    u.author
  )} are approved — awaiting their merge before yours can land.</div>`;
}

function renderUpstreamPRs(stack) {
  if (!stack.upstream_prs || stack.upstream_prs.length === 0) return "";
  const u = stack.upstream;
  const summary =
    `Show ${stack.upstream_prs.length} dependent PR${
      stack.upstream_prs.length === 1 ? "" : "s"
    } by @${esc(u.author)} ` +
    `(${u.approved} approved${
      u.changes_requested > 0
        ? ` · ${u.changes_requested} changes-requested`
        : ""
    }${u.review_required > 0 ? ` · ${u.review_required} pending` : ""})`;
  return `
    <details class="upstream-pr-list">
      <summary>${summary}</summary>
      ${stack.upstream_prs
        .map((p) => renderPrRow(p, { is_upstream: true }))
        .join("")}
    </details>`;
}

function renderResumeBtn(resume) {
  if (!resume) return "";
  const cmd = resume.in_worktree
    ? `(cd .claude/worktrees/${resume.worktree_name} && claude --resume ${resume.sid})`
    : `claude --resume ${resume.sid}`;
  const tip =
    "Resumes the most relevant Claude session for this stack. Picked by scoring all your session logs on mentions of this stack's PR numbers, branch names, Jira keys, and worktree name.";
  return `<span class="copy-cmd" data-cmd="${esc(cmd)}" data-copy title="${esc(
    tip
  )}">💻 ${esc(cmd)} <span class="cp">copy</span></span>`;
}

function renderTrunkRow(stack) {
  const behind = stack.behind_origin || 0;
  // If the stack sits on someone else's PRs, the "behind origin/main" count is
  // misleading (it spans past the upstream fork). Hide it entirely.
  if (stack.upstream || behind === 0) {
    return `<div class="stack-row trunk"><span class="stack-link" style="cursor:default">main (trunk)</span></div>`;
  }
  const label = `${behind} commit${behind === 1 ? "" : "s"} behind`;
  const canRestack = !!stack.worktree?.path;
  const check = stack.restack_check; // {ok, conflicts} | null
  const hasConflicts = check && check.ok === false;
  const isClean = check && check.ok === true;

  // Mergeability badge — sits between the "behind" pill and the action button.
  let mergeBadge = "";
  if (hasConflicts) {
    const files = check.conflicts;
    const preview = files.slice(0, 3).join(", ") + (files.length > 3 ? `, +${files.length - 3} more` : "");
    const tip = `Predicted merge conflicts. gt restack will fail.\n\nConflicting files:\n  ${files.join(
      "\n  "
    )}\n\nResolve manually: cd into the worktree and run \`gt restack\`.`;
    mergeBadge = `<span class="trunk-conflicts" title="${esc(
      tip
    )}">✗ conflicts: ${esc(preview)}</span>`;
  } else if (isClean) {
    mergeBadge = `<span class="trunk-mergeable" title="In-memory 3-way merge against origin/main produced no conflicts.">✓ mergeable</span>`;
  }

  // Action button — disabled when conflicts predicted, hidden when no worktree.
  let action = "";
  if (canRestack) {
    const btnTip = hasConflicts
      ? "Restack disabled — merge conflicts predicted. Resolve manually first."
      : `Click to restack onto origin/main (runs gt restack + gt submit --stack -u in ${stack.worktree.path}).`;
    const disabledAttr = hasConflicts ? "disabled" : "";
    action = `<button class="trunk-restack-btn" data-restack-stack="${esc(
      stack.stack_key
    )}" ${disabledAttr} title="${esc(btnTip)}">↻ Restack</button>`;
  }

  return `<div class="stack-row trunk">
    <span class="stack-link" style="cursor:default">
      main (trunk)
      <span class="trunk-behind">⚠ ${esc(label)}</span>
      ${mergeBadge}
      ${action}
    </span>
  </div>`;
}

function renderStackCard(stack, isMerged, idx) {
  const completed = isMerged;
  const counts = stack.counts;
  const totalHuman = stack.prs.reduce((n, p) => n + (p.human_comments || 0), 0);
  const totalBot = stack.prs.reduce((n, p) => n + (p.bot_comments || 0), 0);
  const totalComments = totalHuman + totalBot;
  const commentChip = totalComments > 0
    ? `<span class="count-chip ${totalHuman > 0 ? "danger" : ""}" title="${totalHuman} human, ${totalBot} bot — open review threads across all PRs">💬 ${totalComments} ${totalComments === 1 ? "comment" : "comments"}${totalHuman > 0 ? ` (${totalHuman}h/${totalBot}b)` : ""}</span>`
    : "";
  const countChips = [
    `<span class="count-chip">${counts.created} created</span>`,
    counts.merged > 0
      ? `<span class="count-chip ok">${counts.merged} merged</span>`
      : "",
    counts.approved > 0
      ? `<span class="count-chip ok">${counts.approved} approved</span>`
      : "",
    counts.pending > 0
      ? `<span class="count-chip warn">${counts.pending} pending</span>`
      : "",
    counts.changes_requested > 0
      ? `<span class="count-chip danger">${counts.changes_requested} changes-requested</span>`
      : "",
    commentChip,
  ]
    .filter(Boolean)
    .join("");

  const categoryTooltips = {
    human_review:
      "At least one open human review comment to address. Top priority — usually means a reviewer left feedback you haven't replied to yet.",
    ready:
      "All your PRs are approved and there are no upstream blockers. Safe to merge.",
    blocked_upstream:
      "Your PRs are approved, but the stack sits on top of upstream PRs (by other authors) that aren't merged yet. Wait for those to land first.",
    awaiting_review:
      "At least one PR in the stack hasn't been reviewed/approved yet. Nothing actionable on your side — just waiting.",
  };
  const pillCategory = completed
    ? '<span class="pill merged" title="You marked this stack complete. Use the ↩ Restore button to move it back to the active list.">Merged</span>'
    : `<span class="pill ${stack.category}" title="${esc(
        categoryTooltips[stack.category] || ""
      )}">${esc(stack.category_label)}</span>`;
  const pillRestack = stack.needs_restack
    ? '<span class="pill warn">⚠ Needs restack</span>'
    : "";

  const wtCmd = stack.worktree
    ? `<span class="copy-cmd" data-cmd="git worktree remove ${esc(
        stack.worktree.path
      )}" data-copy>🗑 git worktree remove ${esc(
        stack.worktree.path
      )} <span class="cp">copy</span></span>`
    : "";

  const completeBtn = completed
    ? `<button class="btn restore" data-action="restore" data-key="${esc(
        stack.stack_key
      )}" title="Move this stack back to the Active list.">↩ Restore to active</button>`
    : `<button class="btn complete" data-action="complete" data-key="${esc(
        stack.stack_key
      )}" title="Move this stack to the Merged section. Useful once everything is deployed or you want it out of your daily view. Restorable later.">✓ Mark complete</button>`;

  const anchorId = `stack-${completed ? "merged" : "active"}-${esc(
    stack.stack_key
  )}`;
  return `
    <div id="${anchorId}" class="card stack-card ${
    completed ? "merged-card" : ""
  }" data-stack-key="${esc(stack.stack_key)}">
      <div class="stack-summary" data-toggle-card>
        <div class="stack-head">
          <div>
            <div class="stack-name">
              <span class="stack-num-h">#${idx}</span><span class="stack-name-text">${esc(
    getStackNameOverride(stack.stack_key) || stack.name
  )}</span><button class="stack-name-edit" data-edit-name data-stop-toggle title="Edit name (click to rename)" type="button">✎</button>
            </div>
            <div class="meta-row" style="margin-top:0">
              ${
                stack.top_pr && stack.top_pr.num
                  ? `<span><b>Top:</b> <a href="${esc(
                      stack.top_pr.url
                    )}" target="_blank" rel="noopener" onclick="event.stopPropagation()">#${
                      stack.top_pr.num
                    }</a></span>`
                  : ""
              }
              ${
                stack.worktree
                  ? `<span><b>Worktree:</b> <code>${esc(
                      stack.worktree.name
                    )}</code></span>`
                  : ""
              }
            </div>
            ${renderJiraChips(stack)}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
            ${pillCategory}
            ${pillRestack}
          </div>
        </div>
        <div class="counts" style="margin-top:8px">${countChips}</div>
        <div class="actions">
          ${completeBtn}
          ${stack.resume && !completed ? renderResumeBtn(stack.resume) : ""}
          ${completed && stack.worktree ? wtCmd : ""}
        </div>
        ${
          !completed
            ? `
        <div class="stack-remarks-wrap" data-stop-toggle>
          <div class="label">📝 Remarks</div>
          <div class="stack-remarks" data-md-key="${esc(
            REMARKS_KEY_PREFIX + stack.stack_key
          )}" data-stack-key="${esc(stack.stack_key)}"></div>
        </div>`
            : ""
        }
      </div>
      <div class="stack-body">
        ${completed ? "" : renderUpstreamBanner(stack)}
        ${
          stack.needs_restack && !completed
            ? '<div class="restack-warn">⚠️ Run <code>gt restack</code> before merging.</div>'
            : ""
        }
        <div class="stack-list">
          ${stack.prs
            .map((p, i) =>
              renderPrRow(p, { is_bottom: i === stack.prs.length - 1 })
            )
            .join("")}
          ${!completed ? renderUpstreamPRs(stack) : ""}
          ${renderTrunkRow(stack)}
        </div>
      </div>
    </div>`;
}

function renderStaleWorktrees(list) {
  const sec = $("#stale-section");
  if (!list || list.length === 0) {
    sec.style.display = "none";
    return;
  }
  sec.style.display = "";
  $("#stale-list").innerHTML = list
    .map(
      (wt) => `
    <div class="stale-worktree-row">
      <span class="stale-worktree-name">${esc(wt.name)}</span>
      <span class="stale-worktree-reason">
        ${esc(wt.reason)}${
        wt.pr_url
          ? ` (<a href="${esc(wt.pr_url)}" target="_blank" rel="noopener">PR #${
              wt.pr_num
            }</a>)`
          : ""
      }
      </span>
      <span class="copy-cmd" data-cmd="git worktree remove ${esc(
        wt.path
      )}" data-copy>git worktree remove ${esc(
        wt.path
      )} <span class="cp">copy</span></span>
    </div>
  `
    )
    .join("");
}

// Sort tickets by actionability: actively-in-flight states first, then
// To Do/Backlog. Within a tier, newer-updated wins.
const STATE_ORDER = {
  "In Review": 0,
  "In Progress": 1,
  Blocked: 2,
  "To Do": 3,
  Backlog: 4,
};

function sortJiraList(list) {
  return [...list].sort((a, b) => {
    const oa = STATE_ORDER[a.status] ?? 50;
    const ob = STATE_ORDER[b.status] ?? 50;
    if (oa !== ob) return oa - ob;
    return (b.updated || "").localeCompare(a.updated || "");
  });
}

function uniqueSprintsFromTickets(list) {
  const map = new Map();
  for (const t of list) {
    if (!t.sprint) continue;
    if (!map.has(t.sprint.id)) map.set(t.sprint.id, t.sprint);
  }
  // Sort: active first, then by start date desc.
  return [...map.values()].sort((a, b) => {
    if (a.state === "active" && b.state !== "active") return -1;
    if (a.state !== "active" && b.state === "active") return 1;
    return (b.start_date || "").localeCompare(a.start_date || "");
  });
}

function pickPrimarySprintId(list) {
  // "Current sprint" definition: prefer the sprint with the most tickets in
  // 'active' state; if no active tickets, fall back to the most-tickets
  // 'future' sprint (planning the next one); else the most recent 'closed'
  // sprint.
  const counts = new Map();
  for (const t of list) {
    if (!t.sprint) continue;
    const key = t.sprint.id;
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { id: key, state: t.sprint.state, count: 1 });
  }
  const ranked = [...counts.values()].sort((a, b) => {
    const order = { active: 0, future: 1, closed: 2 };
    const sa = order[a.state] ?? 3;
    const sb = order[b.state] ?? 3;
    if (sa !== sb) return sa - sb;
    return b.count - a.count;
  });
  return ranked[0]?.id || null;
}

function applyStackFilter(list) {
  const f = getStackFilter();
  if (f === "all") return list;
  if (f === "with_stack") return list.filter((t) => !!t.stack);
  return list.filter((t) => !t.stack);
}

function applySprintFilter(list) {
  const filter = getSprintFilter();
  if (filter === "all") return list;
  if (filter === "none") return list.filter((t) => !t.sprint);
  if (filter === "current") {
    const primaryId = pickPrimarySprintId(list);
    if (primaryId == null) return list;
    return list.filter((t) => t.sprint && t.sprint.id === primaryId);
  }
  return list.filter((t) => t.sprint && String(t.sprint.id) === filter);
}

function renderStackFilter() {
  const wrap = $("#stack-filter-wrap");
  if (!wrap) return;
  const cur = getStackFilter();
  wrap.innerHTML = `<select class="sprint-select" id="stack-select" title="Whether to show tickets that already have an active PR stack."><option value="without_stack">Without stack</option><option value="with_stack">With stack</option><option value="all">All</option></select>`;
  const sel = $("#stack-select");
  sel.value = cur;
  sel.addEventListener("change", () => {
    setStackFilter(sel.value);
    renderUntouchedRows();
    rebuildSidebar(store.currentData);
  });
}

function renderSprintFilter(sprints) {
  const wrap = $("#sprint-filter-wrap");
  if (!wrap) return;
  if (!sprints || sprints.length === 0) {
    wrap.innerHTML = "";
    return;
  }
  const current = getSprintFilter();
  const primaryId = pickPrimarySprintId(store.cachedUntouchedList);
  const primary = sprints.find((s) => s.id === primaryId);
  const currentLabel = primary
    ? `Current sprint (${primary.name})`
    : "Current sprint";
  const opts = [
    `<option value="current">${esc(currentLabel)}</option>`,
    `<option value="all">All sprints</option>`,
    `<option value="none">No sprint</option>`,
    ...sprints.map(
      (s) =>
        `<option value="${esc(String(s.id))}">${esc(s.name)} (${esc(
          s.state || ""
        )})</option>`
    ),
  ].join("");
  wrap.innerHTML = `<select class="sprint-select" id="sprint-select">${opts}</select>`;
  const sel = $("#sprint-select");
  sel.value = current;
  sel.addEventListener("change", () => {
    setSprintFilter(sel.value);
    renderUntouchedRows();
    rebuildSidebar(store.currentData);
  });
}

function renderSprintCell(sprint) {
  if (!sprint) return `<td class="sprint-cell">—</td>`;
  const cls =
    sprint.state === "active"
      ? "sprint-active"
      : sprint.state === "closed"
      ? "sprint-closed"
      : "";
  return `<td class="sprint-cell"><span class="${cls}" title="${esc(
    sprint.state || ""
  )}">${esc(sprint.name)}</span></td>`;
}

function renderStateCell(t) {
  const status = t.status || "—";
  const cat = t.status_category || "new";
  return `<td class="state-cell"><button class="state-pill cat-${esc(
    cat
  )}" data-state-pill data-key="${esc(t.key)}" data-current="${esc(
    status
  )}" title="Click to change state">${esc(status)}</button></td>`;
}

function renderStackCell(t) {
  if (!t.stack) return `<td class="stack-cell muted">—</td>`;
  const anchor = `stack-active-${t.stack.stack_key}`;
  const label = truncate(t.stack.name || t.stack.stack_key, 32);
  return `<td class="stack-cell"><a href="#${esc(
    anchor
  )}" data-jump="${esc(anchor)}" title="${esc(
    t.stack.name || t.stack.stack_key
  )}">${esc(label)}</a></td>`;
}

function renderUntouchedRows() {
  const filtered = sortJiraList(
    applyStackFilter(applySprintFilter(store.cachedUntouchedList))
  );
  const tbody = $("#untouched-rows");
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:18px;color:var(--muted);font-style:italic;text-align:center">
      No tickets match the current filters.
    </td></tr>`;
    return;
  }
  tbody.innerHTML = filtered
    .map(
      (t, idx) => `
    <tr class="jira-row" data-key="${esc(t.key)}">
      <td style="color:var(--muted);font-weight:600">${idx + 1}</td>
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(
        t.key
      )}</a></td>
      <td><span class="type-badge ${esc((t.type || "task").toLowerCase())}">${
        t.type === "Bug" ? "🐛 Bug" : "📋 Task"
      }</span></td>
      <td><a class="jira-title" href="${esc(
        t.url
      )}" target="_blank" rel="noopener">${esc(t.summary)}</a></td>
      ${renderStateCell(t)}
      ${renderSprintCell(t.sprint)}
      ${renderStackCell(t)}
      <td>${esc(t.updated_label || "")}</td>
      <td><div class="remarks" data-md-key="${esc(
        JIRA_REMARKS_PREFIX + t.key
      )}"></div></td>
    </tr>`
    )
    .join("");
  wireDelegates();
}

// Exposed so stack-filter / sprint-filter onChange handlers can re-render.
export { renderUntouchedRows };

function renderUntouchedJira(list, jiraConfigured) {
  const sec = $("#untouched-section");
  store.cachedUntouchedList = list || [];
  if (!list || list.length === 0) {
    if (jiraConfigured === false) {
      sec.style.display = "";
      $("#sprint-filter-wrap").innerHTML = "";
      $("#stack-filter-wrap").innerHTML = "";
      $(
        "#untouched-rows"
      ).innerHTML = `<tr><td colspan="9" style="padding:24px;color:var(--muted);font-style:italic;text-align:center">
        Jira not configured. Add <code>ATLASSIAN_EMAIL</code> and <code>ATLASSIAN_API_TOKEN</code> to <code>~/.zshrc</code> and restart the server.
      </td></tr>`;
      return;
    }
    sec.style.display = "none";
    return;
  }
  sec.style.display = "";
  renderStackFilter();
  renderSprintFilter(uniqueSprintsFromTickets(list));
  renderUntouchedRows();
}

export function renderRecs(recs) {
  const list = $("#recs-list");
  const meta = $("#recs-meta");
  list.classList.remove("loading");
  if (!recs || !recs.html) {
    list.innerHTML =
      '<li class="empty muted">No action items yet — click <strong>⟳ Generate</strong> to ask Claude.</li>';
    meta.textContent = "";
    return;
  }
  list.innerHTML = recs.html;
  if (recs.ts) {
    const d = new Date(recs.ts);
    meta.textContent = `· generated ${d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })} ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  }
}

export function rebuildSidebar(data) {
  if (!data) return;
  const completed = getCompletedSet();
  // Sort active stacks the same way the main view does so the sidebar
  // numbering matches what the user sees on the right.
  const active = sortStacks(
    data.stacks.filter((s) => !completed.has(s.stack_key)),
    getActiveStackSort()
  );
  const merged = data.stacks.filter((s) => completed.has(s.stack_key));

  const sections = [];
  sections.push({
    id: "active-section",
    label: "Active stacks",
    children: active.map((s, i) => ({
      id: `stack-active-${s.stack_key}`,
      num: i + 1,
      label: getStackNameOverride(s.stack_key) || s.name,
      cls: "",
    })),
  });
  if (merged.length > 0) {
    sections.push({
      id: "merged-section",
      label: "Merged stacks",
      children: merged.map((s, i) => ({
        id: `stack-merged-${s.stack_key}`,
        num: i + 1,
        label: getStackNameOverride(s.stack_key) || s.name,
        cls: "merged",
      })),
    });
  }
  if (data.untouched_jira && data.untouched_jira.length > 0) {
    sections.push({
      id: "untouched-section",
      label: "Jira",
      children: [],
    });
  }
  if (data.stale_worktrees && data.stale_worktrees.length > 0) {
    sections.push({
      id: "stale-section",
      label: "Stale worktrees",
      children: [],
    });
  }
  sections.push({ id: "recs-section", label: "Action items", children: [] });

  const html = sections
    .map((sec) => {
      const childHtml =
        sec.children.length > 0
          ? `<div class="nav-stack-list">${sec.children
              .map(
                (c) =>
                  `<button class="nav-stack-item ${c.cls}" data-jump="${esc(
                    c.id
                  )}" title="${esc(c.label)}">
                    <span class="nav-stack-num">#${c.num}</span><span>${esc(
                    c.label
                  )}</span>
                  </button>`
              )
              .join("")}</div>`
          : "";
      return `<button class="nav-section" data-jump="${esc(sec.id)}">${esc(
        sec.label
      )}</button>${childHtml}`;
    })
    .join("");
  $("#jump-nav").innerHTML = html;

  // Wire jump-to behavior.
  $$("[data-jump]").forEach((el) => {
    if (el._jumpWired) return;
    el._jumpWired = true;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(el.dataset.jump);
      if (!target) return;
      // If targeting a collapsed stack-card, expand it before scrolling.
      if (target.classList.contains("stack-card")) {
        target.classList.add("expanded");
      }
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderActiveSortDropdown() {
  const wrap = $("#active-sort-wrap");
  if (!wrap) return;
  const cur = getActiveStackSort();
  const opts = Object.entries(SORT_MODES)
    .map(
      ([key, mode]) =>
        `<option value="${esc(key)}">${esc(mode.label)}</option>`
    )
    .join("");
  wrap.innerHTML = `<select class="sprint-select" id="active-sort-select" title="Sort active stacks">${opts}</select>`;
  const sel = $("#active-sort-select");
  sel.value = cur;
  sel.addEventListener("change", () => {
    setActiveStackSort(sel.value);
    // Re-render with the new sort. Cheap: same data, just resorted.
    render(store.currentData);
  });
}

export function render(data) {
  if (!data) return;
  renderSummary(data.meta);
  const completed = getCompletedSet();

  const activeUnsorted = data.stacks.filter((s) => !completed.has(s.stack_key));
  const active = sortStacks(activeUnsorted, getActiveStackSort());
  const merged = data.stacks.filter((s) => completed.has(s.stack_key));

  renderActiveSortDropdown();

  $("#active-stacks").innerHTML =
    active.length === 0
      ? '<div class="card" style="text-align:center;color:var(--muted)">No active stacks.</div>'
      : active.map((s, i) => renderStackCard(s, false, i + 1)).join("");

  if (merged.length > 0) {
    $("#merged-section").style.display = "";
    $("#merged-stacks").innerHTML = merged
      .map((s, i) => renderStackCard(s, true, i + 1))
      .join("");
  } else {
    $("#merged-section").style.display = "none";
  }

  renderUntouchedJira(data.untouched_jira, data.meta.jira_configured);
  renderStaleWorktrees(data.stale_worktrees);
  rebuildSidebar(data);
  wireDelegates();

  $("#footer-text").textContent = `Last updated ${new Date(
    data.meta.generated_at
  ).toLocaleTimeString()}`;
}
