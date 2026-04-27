// Live dashboard — vanilla JS SPA. Polls /api/data + manages /api/recommendations.

const COMPLETED_KEY = "dashboard.completed";
const REMARKS_KEY_PREFIX = "dashboard.remarks.stack.";
const JIRA_REMARKS_PREFIX = "dashboard.remarks.jira.";
const WORKING_KEY_PREFIX = "dashboard.working.";
const STACK_NAME_OVERRIDE_PREFIX = "dashboard.stack_name_override.";
const AUTO_REFRESH_MS = 600_000; // 10 minutes

function getStackNameOverride(stackKey) {
  return localStorage.getItem(STACK_NAME_OVERRIDE_PREFIX + stackKey);
}
function setStackNameOverride(stackKey, name) {
  if (name && name.trim()) {
    localStorage.setItem(STACK_NAME_OVERRIDE_PREFIX + stackKey, name.trim());
  } else {
    localStorage.removeItem(STACK_NAME_OVERRIDE_PREFIX + stackKey);
  }
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getCompletedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COMPLETED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function setCompletedSet(set) {
  localStorage.setItem(COMPLETED_KEY, JSON.stringify([...set]));
}
function toggleCompleted(stackKey) {
  const s = getCompletedSet();
  if (s.has(stackKey)) s.delete(stackKey);
  else s.add(stackKey);
  setCompletedSet(s);
}

// ---------- rendering ----------
function renderSummary(meta) {
  const t = meta.totals;
  const parts = [
    `<div class="stat"><div class="v">${t.stacks}</div><div class="l">Active stacks</div></div>`,
    `<div class="stat"><div class="v">${t.open_prs}</div><div class="l">Open PRs</div></div>`,
    `<div class="stat ok"><div class="v">${t.approved}</div><div class="l">Approved</div></div>`,
    `<div class="stat pending"><div class="v">${t.pending}</div><div class="l">Pending review</div></div>`,
  ];
  if (t.changes_requested > 0) {
    parts.push(
      `<div class="stat danger"><div class="v">${t.changes_requested}</div><div class="l">Changes requested</div></div>`
    );
  }
  $("#summary").innerHTML = parts.join("");
  $("#meta-date").textContent = meta.date;
}

function truncate(s, n) {
  if (!s || s.length <= n) return s || "";
  return s.slice(0, n - 1) + "…";
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
  const draft = pr.is_draft ? " 📝" : "";
  return `
    <div class="stack-row ${cls}">
      <a class="stack-link" href="${esc(
        pr.url
      )}" target="_blank" rel="noopener">
        <span class="stack-num">#${pr.num}</span>
        ${jira}
        <span class="stack-pr-title">${esc(pr.title)}${draft}</span>
        ${author}
      </a>
      ${comments}
      <span class="stack-status ${cls}">${esc(pr.status_label)}</span>
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
    ? `(cd .claude/worktrees/${resume.worktree_name} && cldr ${resume.sid})`
    : `cldr ${resume.sid}`;
  return `<span class="copy-cmd" data-cmd="${esc(cmd)}" data-copy>💻 ${esc(
    cmd
  )} <span class="cp">copy</span></span>`;
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

  const pillCategory = completed
    ? '<span class="pill merged">Merged</span>'
    : `<span class="pill ${stack.category}">${esc(
        stack.category_label
      )}</span>`;
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
      )}">↩ Restore to active</button>`
    : `<button class="btn complete" data-action="complete" data-key="${esc(
        stack.stack_key
      )}">✓ Mark complete</button>`;

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
                stack.top_pr
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
          <div class="stack-row trunk"><span class="stack-link" style="cursor:default">main (trunk)</span></div>
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

const SPRINT_FILTER_KEY = "dashboard.sprint_filter";
let cachedUntouchedList = [];

function getSprintFilter() {
  return localStorage.getItem(SPRINT_FILTER_KEY) || "current";
}
function setSprintFilter(v) {
  localStorage.setItem(SPRINT_FILTER_KEY, v);
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

function renderSprintFilter(sprints) {
  const wrap = $("#sprint-filter-wrap");
  if (!wrap) return;
  if (!sprints || sprints.length === 0) {
    wrap.innerHTML = "";
    return;
  }
  const current = getSprintFilter();
  const primaryId = pickPrimarySprintId(cachedUntouchedList);
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
    rebuildSidebar(currentData);
  });
}

function pickPrimarySprintId(list) {
  // "Current sprint" definition: prefer the sprint with the most tickets in 'active' state;
  // if no active tickets, fall back to the most-tickets 'future' sprint (planning the next one);
  // else the most recent 'closed' sprint.
  const counts = new Map(); // id → { state, name, count }
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

function renderUntouchedRows() {
  const filtered = applySprintFilter(cachedUntouchedList);
  const tbody = $("#untouched-rows");
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:18px;color:var(--muted);font-style:italic;text-align:center">
      No tickets in this sprint. Switch the dropdown to <strong>All sprints</strong>.
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
      ${renderSprintCell(t.sprint)}
      <td>${esc(t.updated_label || "")}</td>
      <td><label class="toggle"><input type="checkbox" class="working-cb"><span class="slider"></span></label></td>
      <td><div class="remarks" data-md-key="${esc(
        JIRA_REMARKS_PREFIX + t.key
      )}"></div></td>
    </tr>`
    )
    .join("");
  wireDelegates();
}

function renderUntouchedJira(list, jiraConfigured) {
  const sec = $("#untouched-section");
  cachedUntouchedList = list || [];
  if (!list || list.length === 0) {
    if (jiraConfigured === false) {
      sec.style.display = "";
      $("#sprint-filter-wrap").innerHTML = "";
      $(
        "#untouched-rows"
      ).innerHTML = `<tr><td colspan="8" style="padding:24px;color:var(--muted);font-style:italic;text-align:center">
        Jira not configured. Add <code>ATLASSIAN_EMAIL</code> and <code>ATLASSIAN_API_TOKEN</code> to <code>.claude/dashboard/.env</code> and restart the server.
      </td></tr>`;
      return;
    }
    sec.style.display = "none";
    return;
  }
  sec.style.display = "";
  renderSprintFilter(uniqueSprintsFromTickets(list));
  renderUntouchedRows();
}

function render(data) {
  if (!data) return;
  renderSummary(data.meta);
  const completed = getCompletedSet();

  const active = data.stacks.filter((s) => !completed.has(s.stack_key));
  const merged = data.stacks.filter((s) => completed.has(s.stack_key));

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

// ---------- sidebar jump nav ----------
function rebuildSidebar(data) {
  if (!data) return;
  const completed = getCompletedSet();
  const active = data.stacks.filter((s) => !completed.has(s.stack_key));
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
      label: "Untouched Jira",
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
  sections.push({ id: "recs-section", label: "Recommendations", children: [] });

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

function wireDelegates() {
  // Stack-card toggle: click the .stack-summary to flip the `expanded` class on
  // the parent .stack-card. We use a custom toggle (not <details>/<summary>)
  // because contenteditable inside <summary> has too many focus / Space-key
  // edge cases to fight with.
  $$("[data-toggle-card]").forEach((el) => {
    if (el._toggleWired) return;
    el._toggleWired = true;
    el.addEventListener("click", (e) => {
      // Defensive: if the click came from a child that wasn't supposed to
      // bubble (e.g. an interactive element inside the summary), bail. Buttons
      // and copy chips already call stopPropagation, but if we ever miss one,
      // this skips the toggle for any element that has its own onclick.
      if (e.target.closest("[data-stop-toggle]")) return;
      const card = el.closest(".stack-card");
      if (!card) return;
      card.classList.toggle("expanded");
      updateCollapseAllLabel();
    });
  });

  // Stack remarks (markdown persisted to localStorage). On first sight of
  // a stack, we migrate any Untouched-Jira remarks for this stack's Jira keys
  // into the stack remarks so notes you wrote before the PR existed don't get
  // stranded. Migration is one-time per Jira key — the source entry is removed
  // after merging, so subsequent renders don't double-migrate.
  $$(".stack-remarks").forEach((el) => {
    const storeKey = el.dataset.mdKey;
    const stackKey = el.dataset.stackKey;
    let stored = localStorage.getItem(storeKey) || "";

    const card = el.closest(".stack-card");
    const stack = card
      ? currentData?.stacks?.find((s) => s.stack_key === card.dataset.stackKey)
      : null;
    if (stack && Array.isArray(stack.jira_keys)) {
      const migrated = [];
      for (const jk of stack.jira_keys) {
        const jiraStored = localStorage.getItem(JIRA_REMARKS_PREFIX + jk);
        if (jiraStored && jiraStored.trim()) {
          migrated.push(`*↳ from ${jk}*\n\n${jiraStored}`);
          localStorage.removeItem(JIRA_REMARKS_PREFIX + jk);
        }
      }
      if (migrated.length > 0) {
        const merged = migrated.join("\n\n---\n\n");
        stored = stored ? `${stored}\n\n---\n\n${merged}` : merged;
        localStorage.setItem(storeKey, stored);
      }
    }

    wireMarkdownRemarks(el, storeKey, {
      placeholder: "Add a note for this stack…",
    });
  });

  // Jira row remarks + working checkbox.
  const today = new Date().toISOString().slice(0, 10);
  $$("tr.jira-row").forEach((row) => {
    const k = row.dataset.key;
    const cb = row.querySelector(".working-cb");
    const wkKey = WORKING_KEY_PREFIX + today + "." + k;
    cb.checked = localStorage.getItem(wkKey) === "1";
    if (cb.checked) row.classList.add("working");
    cb.addEventListener("change", () => {
      localStorage.setItem(wkKey, cb.checked ? "1" : "0");
      row.classList.toggle("working", cb.checked);
    });
    const rem = row.querySelector(".remarks");
    if (rem) {
      wireMarkdownRemarks(rem, rem.dataset.mdKey, { placeholder: "Add note…" });
    }
  });

  // Copy buttons. Stop propagation so clicks don't toggle the parent <details>
  // when this button lives inside a <summary>.
  $$("[data-copy]").forEach((el) => {
    if (el._copyWired) return;
    el._copyWired = true;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cmd = el.dataset.cmd;
      navigator.clipboard.writeText(cmd).then(() => {
        const cp = el.querySelector(".cp");
        if (!cp) return;
        const orig = cp.textContent;
        cp.textContent = "copied!";
        cp.style.color = "var(--success)";
        setTimeout(() => {
          cp.textContent = orig;
          cp.style.color = "";
        }, 1200);
      });
    });
  });

  // Mark-complete / Restore buttons.
  $$('[data-action="complete"], [data-action="restore"]').forEach((el) => {
    if (el._actionWired) return;
    el._actionWired = true;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCompleted(el.dataset.key);
      render(currentData);
    });
  });

  // Anything tagged data-stop-toggle: swallow pointer + key events so interacting
  // with content inside <summary> (e.g. typing Space in the remarks editable)
  // doesn't bubble up and toggle the <details> open/closed.
  $$("[data-stop-toggle]").forEach((el) => {
    if (el._stopToggleWired) return;
    el._stopToggleWired = true;
    const stop = (e) => e.stopPropagation();
    for (const evt of ["click", "mousedown", "keydown", "keypress", "keyup"]) {
      el.addEventListener(evt, stop);
    }
  });

  // Pencil icon next to stack name: click to inline-edit the stack name. The
  // override is keyed by stack_key in localStorage and takes priority over the
  // model's `stack.name` (which is Claude-generated).
  $$("[data-edit-name]").forEach((btn) => {
    if (btn._editNameWired) return;
    btn._editNameWired = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".stack-card");
      if (!card) return;
      const stackKey = card.dataset.stackKey;
      const nameDiv = btn.parentElement;
      const textSpan = nameDiv.querySelector(".stack-name-text");
      if (!textSpan) return;
      const original = textSpan.textContent;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "stack-name-input";
      input.value = original;
      input.setAttribute("data-stop-toggle", "");
      // Stop propagation directly on the input too (data-stop-toggle handlers
      // are attached on render; this freshly-created node hasn't been wired yet).
      const stop = (ev) => ev.stopPropagation();
      for (const evt of ["click", "mousedown", "keydown", "keypress", "keyup"]) {
        input.addEventListener(evt, stop);
      }

      let finalized = false;
      const finish = (save) => {
        if (finalized) return;
        finalized = true;
        const next = input.value.trim();
        const changed = save && next && next !== original;
        if (changed) {
          setStackNameOverride(stackKey, next);
          textSpan.textContent = next;
        }
        input.replaceWith(textSpan);
        btn.style.display = "";
        // Sidebar nav reads names lazily — rebuild it so the renamed stack
        // shows up there immediately too.
        if (changed) rebuildSidebar(currentData);
      };

      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          finish(false);
        }
      });

      textSpan.replaceWith(input);
      btn.style.display = "none";
      input.focus();
      input.select();
    });
  });

  // Cards default to collapsed; sync the header button's label to match.
  updateCollapseAllLabel();
}

// Markdown helpers. We store raw markdown in localStorage and render via the
// `marked` library on view. Editing swaps the rendered <div> for a <textarea>
// holding the raw text. Re-renders on blur. Detects existing legacy HTML and
// passes it through (marked allows inline HTML by default).
function renderMarkdown(text) {
  if (!text) return "";
  if (typeof window.marked === "undefined") {
    // marked.min.js may still be loading on first paint — fall back to plain text.
    return esc(text).replace(/\n/g, "<br>");
  }
  // marked.parse handles GitHub-flavored markdown by default in v15.
  return window.marked.parse(text, { breaks: true, gfm: true });
}

function wireMarkdownRemarks(wrap, persistKey, opts = {}) {
  // Idempotent per element instance — call after every render.
  if (wrap._mdWired) return;
  wrap._mdWired = true;

  const placeholder = opts.placeholder || "Add a note…";
  // Build two children: a rendered view, and a textarea (hidden until focused).
  // We use the wrap element directly as the container so caller styles still apply.
  const stored = localStorage.getItem(persistKey) || "";

  const view = document.createElement("div");
  view.className = "md-view";
  if (stored) view.innerHTML = renderMarkdown(stored);
  else view.innerHTML = `<span class="md-placeholder">${esc(placeholder)}</span>`;

  const editor = document.createElement("textarea");
  editor.className = "md-editor";
  editor.spellcheck = false;
  editor.hidden = true;
  editor.value = stored;
  editor.placeholder = placeholder;
  editor.rows = Math.max(1, stored.split("\n").length);

  // Edit-mode entry: clicking the rendered view swaps to textarea, focused.
  view.addEventListener("click", (e) => {
    // Let actual link clicks work normally — don't grab them as edit triggers.
    if (e.target.closest("a")) return;
    e.stopPropagation();
    enterEdit();
  });

  function autoSize() {
    editor.style.height = "auto";
    editor.style.height = editor.scrollHeight + "px";
  }
  function enterEdit() {
    editor.value = localStorage.getItem(persistKey) || "";
    view.hidden = true;
    editor.hidden = false;
    autoSize();
    editor.focus();
    // Place caret at end.
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
  function exitEdit() {
    const next = editor.value;
    if (next === "") localStorage.removeItem(persistKey);
    else localStorage.setItem(persistKey, next);
    view.innerHTML = next
      ? renderMarkdown(next)
      : `<span class="md-placeholder">${esc(placeholder)}</span>`;
    editor.hidden = true;
    view.hidden = false;
  }

  editor.addEventListener("blur", exitEdit);
  editor.addEventListener("input", autoSize);
  editor.addEventListener("keydown", (e) => {
    // Esc commits and exits (same as blur). Cmd/Ctrl+Enter also exits.
    if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
      e.preventDefault();
      editor.blur();
      return;
    }
    // Markdown shortcuts: Cmd+B / Cmd+I / Cmd+K wrap the selection.
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      wrapSelection(editor, "**", "**");
    } else if (k === "i") {
      e.preventDefault();
      wrapSelection(editor, "*", "*");
    } else if (k === "k") {
      e.preventDefault();
      const url = prompt("Link URL:", "https://");
      if (url) {
        const { selectionStart: s, selectionEnd: e2, value } = editor;
        const text = value.slice(s, e2) || "link";
        editor.setRangeText(`[${text}](${url})`, s, e2, "end");
        autoSize();
      }
    }
  });

  // Replace wrap's previous contents with our two children (preserves classes).
  wrap.innerHTML = "";
  wrap.appendChild(view);
  wrap.appendChild(editor);
}

function wrapSelection(textarea, before, after) {
  const { selectionStart: s, selectionEnd: e, value } = textarea;
  const text = value.slice(s, e);
  textarea.setRangeText(`${before}${text}${after}`, s, e, "end");
  // Fire input so autoSize runs.
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------- recommendations ----------
function renderRecs(recs) {
  const list = $("#recs-list");
  const meta = $("#recs-meta");
  list.classList.remove("loading");
  if (!recs || !recs.html) {
    list.innerHTML =
      '<li class="empty muted">No recommendations yet — click <strong>⟳ Generate</strong> to ask Claude.</li>';
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

async function fetchRecs(force = false) {
  const btn = $("#recs-refresh-btn");
  const list = $("#recs-list");
  btn.classList.add("loading");
  btn.disabled = true;
  if (force) {
    list.classList.add("loading");
    list.innerHTML =
      '<li class="empty muted">Generating recommendations… this can take 10–30s.</li>';
  }
  try {
    const url = force
      ? "/api/recommendations?refresh=1"
      : "/api/recommendations";
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const recs = await res.json();
    renderRecs(recs);
  } catch (err) {
    list.classList.remove("loading");
    list.innerHTML = `<li class="empty" style="color:var(--danger);font-style:normal">Error: ${esc(
      err.message
    )}</li>`;
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

// ---------- data fetching ----------
let currentData = null;
let lastFetchTs = 0;
let autoRefreshTimer = null;

async function fetchData(force = false, intelligent = false) {
  const btn = intelligent ? $("#refresh-intelligent-btn") : $("#refresh-btn");
  const origLabel = btn.textContent;
  btn.classList.add("loading");
  btn.textContent = intelligent ? "🧠 Thinking…" : "↻ Refreshing…";
  try {
    const params = new URLSearchParams();
    if (force) params.set("refresh", "1");
    if (intelligent) params.set("intelligent", "1");
    const qs = params.toString();
    const url = qs ? `/api/data?${qs}` : "/api/data";
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const data = await res.json();
    currentData = data;
    lastFetchTs = Date.now();
    render(data);
    $("#error-banner").style.display = "none";
    updateFreshness();
  } catch (err) {
    $("#error-banner").style.display = "";
    $(
      "#error-banner"
    ).textContent = `Error: ${err.message}\n\nTry: refreshing, ensuring \`gh\` and \`gt\` are authenticated, or restarting the server.`;
  } finally {
    btn.classList.remove("loading");
    btn.textContent = origLabel;
  }
}

const LAST_INTEL_KEY = "dashboard.lastIntelligentTs";

async function intelligentRefresh() {
  // Run data refresh (deep — clears Claude-backed disk caches) and recs regen in parallel.
  const ok = await Promise.all([fetchData(true, true), fetchRecs(true)]);
  // Mark only if at least the data fetch succeeded (intel-fresh shows worst-case staleness).
  localStorage.setItem(LAST_INTEL_KEY, String(Date.now()));
  updateFreshness();
}

function relAge(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function updateFreshness() {
  if (lastFetchTs) $("#freshness").textContent = `· ${relAge(lastFetchTs)}`;
  const lastIntel = parseInt(localStorage.getItem(LAST_INTEL_KEY) || "0", 10);
  if (lastIntel) {
    $("#intel-freshness").textContent = `· intel ${relAge(lastIntel)}`;
  } else {
    $("#intel-freshness").textContent = "· not yet run";
  }
}

function setupAutoRefresh() {
  const cb = $("#auto-refresh-cb");
  function tick() {
    if (cb.checked && document.visibilityState === "visible") {
      // Auto-refresh ONLY pulls /api/data — never regenerates Claude recommendations.
      fetchData(false);
    }
  }
  cb.addEventListener("change", () => {
    clearInterval(autoRefreshTimer);
    if (cb.checked) autoRefreshTimer = setInterval(tick, AUTO_REFRESH_MS);
  });
  if (cb.checked) autoRefreshTimer = setInterval(tick, AUTO_REFRESH_MS);
  setInterval(updateFreshness, 5000);
}

// ---------- init ----------
function toggleAllStacks() {
  const cards = $$(".stack-card");
  if (cards.length === 0) return;
  // If any are expanded, collapse all. Otherwise, expand all.
  const anyExpanded = [...cards].some((c) => c.classList.contains("expanded"));
  for (const c of cards) c.classList.toggle("expanded", !anyExpanded);
  updateCollapseAllLabel();
}

function updateCollapseAllLabel() {
  const btn = $("#collapse-all-btn");
  if (!btn) return;
  const cards = $$(".stack-card");
  const anyExpanded = [...cards].some((c) => c.classList.contains("expanded"));
  btn.textContent = anyExpanded ? "⊟ Collapse all" : "⊞ Expand all";
}

// Keep `--sticky-top` in sync with the actual header height so the sidebar /
// notepad always sit just below the sticky header, even when buttons wrap to a
// second line on narrower windows.
function syncStickyTop() {
  const header = document.querySelector("header.top");
  if (!header) return;
  const h = Math.ceil(header.getBoundingClientRect().height) + 16; // 16px gap
  document.documentElement.style.setProperty("--sticky-top", h + "px");
}

function initNotepad() {
  const el = $("#notepad-content");
  if (!el) return;
  wireMarkdownRemarks(el, el.dataset.mdKey, {
    placeholder: "Scratch space — markdown is welcome.",
  });
  // Saved-indicator hint: when the editor's blur fires (which is when
  // wireMarkdownRemarks persists), flash a brief "saved" label.
  const saved = $("#notepad-saved");
  let savedTimer = null;
  el.addEventListener(
    "blur",
    () => {
      if (!saved) return;
      saved.classList.add("show");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => saved.classList.remove("show"), 1200);
    },
    true /* capture so we catch the textarea's blur from inside the wrap */
  );
}

document.addEventListener("DOMContentLoaded", () => {
  $("#refresh-btn").addEventListener("click", () => fetchData(true));
  $("#refresh-intelligent-btn").addEventListener("click", intelligentRefresh);
  $("#recs-refresh-btn").addEventListener("click", () => fetchRecs(true));
  $("#collapse-all-btn").addEventListener("click", toggleAllStacks);
  // Per-card toggle listeners are wired in wireDelegates() (toggle doesn't bubble).
  setupAutoRefresh();
  updateFreshness(); // seed intel-freshness label from localStorage
  initNotepad();
  syncStickyTop();
  window.addEventListener("resize", syncStickyTop);
  fetchData(false);
  fetchRecs(false); // load cached recs from server (does NOT regenerate)
});
