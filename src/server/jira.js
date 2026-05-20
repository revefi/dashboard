// Jira REST client. Fast (~50ms/ticket), so we fetch fresh on every
// buildModel — no disk cache. Without ATLASSIAN_* in the env, all calls
// return empty and the UI shows a "Jira not configured" hint.

const { JIRA_BASE } = require("./config");

function jiraConfigured() {
  return !!(process.env.ATLASSIAN_EMAIL && process.env.ATLASSIAN_API_TOKEN);
}

async function jiraGet(pathStr) {
  if (!jiraConfigured()) return null;
  const auth = Buffer.from(
    `${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`
  ).toString("base64");
  const res = await fetch(`${JIRA_BASE}${pathStr}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira ${pathStr}: ${res.status}`);
  return res.json();
}

async function jiraPost(pathStr, body, opts = {}) {
  if (!jiraConfigured()) return null;
  const auth = Buffer.from(
    `${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`
  ).toString("base64");
  const res = await fetch(`${JIRA_BASE}${pathStr}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${pathStr}: ${res.status} ${text.slice(0, 200)}`);
  }
  // Some Jira POSTs (transitions) return 204 No Content; opts.expectEmpty
  // skips the JSON parse for those.
  if (opts.expectEmpty || res.status === 204) return null;
  return res.json();
}

function parseActiveSprint(field) {
  // Sprint custom field: array of sprint objects with id/name/state/startDate/endDate.
  if (!Array.isArray(field)) return null;
  const chosen =
    field.find((s) => s && s.state === "active") ||
    field[field.length - 1] ||
    null;
  if (!chosen) return null;
  return {
    id: chosen.id,
    name: chosen.name,
    state: chosen.state,
    start_date: chosen.startDate || null,
    end_date: chosen.endDate || null,
  };
}

async function fetchJiraTickets(keys) {
  if (keys.length === 0 || !jiraConfigured()) return {};
  const fields = "summary,issuetype,status,priority,updated";
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        const data = await jiraGet(
          `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`
        );
        if (!data) return null;
        return [
          key,
          {
            key: data.key,
            summary: data.fields.summary,
            type: data.fields.issuetype?.name || "Task",
            status: data.fields.status?.name || "",
            priority: data.fields.priority?.name || "Medium",
            updated: data.fields.updated,
          },
        ];
      } catch {
        return null;
      }
    })
  );
  return Object.fromEntries(entries.filter(Boolean));
}

async function fetchJiraTicket(key) {
  const map = await fetchJiraTickets([key]);
  return map[key] || null;
}

async function fetchOpenJiraTickets() {
  if (!jiraConfigured()) return [];
  try {
    const data = await jiraPost(`/rest/api/3/search/jql`, {
      jql: "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC",
      // customfield_10020 = "Sprint" on revefi.atlassian.net.
      fields: [
        "summary",
        "issuetype",
        "status",
        "priority",
        "updated",
        "created",
        "customfield_10020",
      ],
      maxResults: 50,
    });
    if (!data || !data.issues) return [];
    return data.issues.map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      type: i.fields.issuetype?.name || "Task",
      status: i.fields.status?.name || "",
      // Jira's three top-level status buckets — used for sort + pill colour:
      //   "new" (To Do/Backlog), "indeterminate" (In Progress/In Review),
      //   "done" (Done/Closed). Tickets in `done` shouldn't be in this list
      //   anyway because of the `statusCategory != Done` JQL filter.
      status_category: i.fields.status?.statusCategory?.key || "new",
      priority: i.fields.priority?.name || "Medium",
      updated: i.fields.updated,
      created: i.fields.created,
      sprint: parseActiveSprint(i.fields.customfield_10020),
    }));
  } catch (err) {
    console.warn("[jira] fetchOpenJiraTickets failed:", err.message);
    return [];
  }
}

// Fetch the valid transitions for a ticket (e.g. "Start Progress",
// "In Review", "Done"). Each entry has `{ id, name, to_status }`. The frontend
// uses `id` when posting back.
async function fetchJiraTransitions(key) {
  if (!jiraConfigured()) return [];
  if (!/^[A-Z]+-\d+$/.test(key)) throw new Error("invalid jira key");
  const data = await jiraGet(
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`
  );
  if (!data || !Array.isArray(data.transitions)) return [];
  return data.transitions.map((t) => ({
    id: t.id,
    name: t.name,
    to_status: t.to?.name || t.name,
    to_category: t.to?.statusCategory?.key || null,
  }));
}

// Perform a transition. POST returns 204 No Content on success.
async function performJiraTransition(key, transitionId) {
  if (!jiraConfigured()) throw new Error("jira not configured");
  if (!/^[A-Z]+-\d+$/.test(key)) throw new Error("invalid jira key");
  if (!/^\d+$/.test(String(transitionId))) {
    throw new Error("invalid transition id");
  }
  await jiraPost(
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    { transition: { id: String(transitionId) } },
    { expectEmpty: true }
  );
}

function deriveJiraNote(t) {
  if (t.type === "Bug") return "Customer-visible";
  return "—";
}

// Pick the most "Done-like" transition available for a ticket and fire
// it. We match on the `to.statusCategory.key === "done"` field (Jira's
// canonical signal) and fall back to a name regex if that isn't set.
// Throws when no such transition is reachable from the ticket's current
// state — caller surfaces the error.
async function closeJiraTicket(key) {
  if (!jiraConfigured()) throw new Error("jira not configured");
  const transitions = await fetchJiraTransitions(key);
  if (transitions.length === 0) {
    throw new Error(`no transitions available for ${key}`);
  }
  const done =
    transitions.find((t) => t.to_category === "done") ||
    transitions.find((t) => /^(done|closed|resolved)$/i.test(t.to_status));
  if (!done) {
    const available = transitions.map((t) => t.to_status).join(", ");
    throw new Error(
      `no "Done" transition reachable from current state; available: ${available}`
    );
  }
  await performJiraTransition(key, done.id);
  return done.to_status;
}

module.exports = {
  jiraConfigured,
  jiraGet,
  jiraPost,
  parseActiveSprint,
  fetchJiraTickets,
  fetchJiraTicket,
  fetchOpenJiraTickets,
  fetchJiraTransitions,
  performJiraTransition,
  closeJiraTicket,
  deriveJiraNote,
};
