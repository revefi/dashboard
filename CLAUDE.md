# CLAUDE.md — Dashboard codebase guide

Personal PR/stack dashboard for Revefi work. Replaces running `/daily-start`
repeatedly throughout the day. A small Node server polls `gh`, `gt`, Jira REST,
and Claude session files; a vanilla-JS SPA renders the result. Lives at
`~/dashboard/`, gitignored, not tied to any single project except via configured
absolute paths.

## Files

```
~/dashboard/
├── server.js               main HTTP server (zero deps, single file)
├── start.sh                launchd wrapper (sets PATH, sources zshrc creds)
├── public/
│   ├── index.html          SPA shell (~140 lines)
│   ├── app.js              all client logic (~880 lines)
│   ├── styles.css          all styling (~1090 lines)
│   └── favicon.ico
├── cache/
│   ├── recommendations.json   Claude-generated recs (manual refresh only)
│   └── stack-names.json       Claude-named stacks, keyed by PR-set hash
├── README.md               user-facing docs
└── CLAUDE.md               (this file — codebase guide for future edits)
```

There are no `node_modules` and no build step — Node 22's built-in `http`
module + `fetch` are sufficient. The `claude` CLI is shelled out for AI work.

## Runtime architecture

```
                ┌─────────────────────┐
   Browser ──── │ http://localhost:7787│
                └──────────┬──────────┘
                           │
                           ▼
   ┌────────────────────────────────────────────────────┐
   │ server.js                                          │
   │   /api/data            ← model JSON                │
   │   /api/recommendations ← Claude-generated <li>s    │
   │   /api/health          ← lightweight status        │
   │   /  /styles.css /app.js  /favicon.ico (static)    │
   └─────────┬────────────────────────────────────────┬─┘
             │ shells out to                          │ writes to
             ▼                                        ▼
   ┌─────────────────────┐                  ┌──────────────┐
   │  gh, gt, git, claude│                  │ ./cache/*    │
   │  Jira REST (fetch)  │                  │ (disk caches)│
   │  ~/.claude/projects/│                  └──────────────┘
   │     *.jsonl (grep)  │
   └─────────────────────┘
```

## server.js anatomy

Sections, in order, separated by `// ----------` banner comments:

| Section | What it does |
| --- | --- |
| **constants** | `REPO`, `SESSIONS_ROOT`, `PORT`, `CACHE_DIR`, file paths |
| **shell helpers** | `sh()`, `shRetry()` — promisified `exec` with retry |
| **gt log parsing** | `parseGtLog()`, `buildStacksFromGtLog()` — text → tree |
| **worktrees** | `fetchWorktrees()` from `git worktree list --porcelain` |
| **PRs** | `fetchOpenPRs`, `fetchRecentMergedPRs`, `fetchAnyPR`, `fetchPRMeta`, `fetchReviewThreadsBulk` (one aliased GraphQL query for all PRs) |
| **Claude CLI** | `callClaude()`, `parseJsonLoose()`, disk-cache helpers |
| **Jira** | `jiraGet/jiraPost`, `fetchJiraTickets`, `fetchOpenJiraTickets` (direct REST only) |
| **session scoring** | `scoreSessionsForStack()` greps Claude session JSONLs |
| **title parsing** | `parseTitle()` strips `[REV-XXXX][Part N]` prefix |
| **model assembly** | `buildModel()` — the main pipeline |
| **stack-name generation** | `enhanceStackNamesWithClaude()` (Claude bulk call, cached) |
| **caching** | `getData()`, `clearClaudeBackedCaches()` |
| **recommendations** | `getRecommendations()`, prompt construction, disk cache |
| **HTTP** | `serveStatic()`, `MIME` table, route dispatch |

### `buildModel()` pipeline (the hot path)

```
1. parallel fetch:  gt log + open PRs + recent merged PRs + worktrees
2. parse gt log → list of leaf-to-trunk chains
3. for each chain:
     partition into user_segment (your PRs)
                  + upstream_segment (parent PRs by others)
4. fetch upstream PR metadata (gh pr view per branch, parallel)
5. fetch review-thread counts (one bulk GraphQL query, aliased fields per PR)
6. score Claude sessions per stack (grep PR#s + branch names)
7. enhanceStackNamesWithClaude() — bulk Claude call for any stack
                                    whose PR-set hash isn't cached
8. fetch Jira tickets bulk (chip summaries) via direct REST
9. fetch open Jira list (untouched section)
10. detect stale worktrees (any worktree whose branch isn't in open PRs)
11. assemble final model object
```

A "stack" object on the wire looks like:

```js
{
  stack_key: "REV-12412+REV-12893",     // sorted Jira keys joined with "+"
  jira_keys: ["REV-12412", "REV-12893"],
  jira_chips: [{key, summary, url}],
  name: "Created By column + Author filter",  // Claude-generated
  category: "awaiting_review" | "ready" | "blocked_upstream" | "human_review",
  category_label: "Awaiting review",
  needs_restack: true,
  top_pr: {num, url},
  counts: {created, merged, approved, pending, changes_requested},
  upstream: null | {n, author, approved, changes_requested, review_required},
  worktree: null | {name, path, branch},
  resume: null | {sid, in_worktree, worktree_name},
  prs: [Pr],            // user's PRs, top-of-stack first
  upstream_prs: [Pr],   // other authors' PRs lower in chain (collapsed in UI)
}

Pr = {
  num, url, title, jira_tag, part_tag,
  is_draft, decision, status_label, status_class,
  human_comments, bot_comments, updated_label, needs_restack,
}
```

## Caching model

Three layers, intentionally:

| Cache | Where | TTL | Invalidation |
| --- | --- | --- | --- |
| `cache.data` | in-memory | 30s | `?refresh=1` query param |
| `cache/stack-names.json` | disk | 30 days, but key includes sorted PR-set hash so it auto-busts when a stack's PRs change | 🧠 Intelligent click clears the file |
| `cache/recommendations.json` | disk | forever | ⟳ Generate or 🧠 Intelligent click |

Jira tickets and the Untouched Jira list are NOT cached on disk — direct REST
is fast enough (~50ms per ticket, <200ms for the bulk search) that every plain
↻ Refresh fetches them fresh. There's a `jiraTicketMem` Map in
`fetchJiraTickets`, but it's only re-populated within a single `buildModel()`
call to avoid duplicate REST calls when multiple stacks reference the same key.

### Refresh modes

| User action | What gets refetched | Claude calls? |
| --- | --- | --- |
| ↻ Refresh / Auto (10m) | gh, gt, git, Jira REST | none (uses cached stack-names + recs) |
| 🧠 Intelligent | All of the above + wipes stack-names cache + regenerates recommendations | yes (stack names + recs) |
| ⟳ Generate (in Recs section) | Just recommendations | yes (recs only) |

## Frontend (`public/`)

`index.html` is a static SPA shell with named placeholder elements
(`#summary`, `#active-stacks`, `#untouched-rows`, `#recs-list`, etc.).
`app.js` populates them by `innerHTML = ...` after fetching `/api/data`.

### Render pipeline

```
fetchData() ──→ render(data) ──┬──→ renderSummary()
                                ├──→ renderStackCard() × N (active)
                                ├──→ renderStackCard() × N (merged)
                                ├──→ renderUntouchedJira()  → renderUntouchedRows()
                                ├──→ renderStaleWorktrees()
                                ├──→ rebuildSidebar()
                                └──→ wireDelegates()  ← attach event listeners
```

`wireDelegates()` is called after every render and is idempotent (uses
`el._wired = true` flags). It attaches:

- `toggle` listeners on `details.stack-card` (for the "Collapse all" label)
- `paste` / `blur` / `keydown` on `.stack-remarks` and `.remarks` for rich-text
- `click` on `[data-copy]` (copy commands), `[data-action="complete"]`,
  `[data-action="restore"]`, `[data-jump]` (sidebar nav)
- Per-row jira working-today checkbox + remarks

### localStorage keys

All under the `dashboard.*` namespace:

| Key | Purpose |
| --- | --- |
| `dashboard.completed` | JSON array of stack_keys marked complete |
| `dashboard.remarks.stack.<stack_key>` | Per-stack rich-text remarks |
| `dashboard.remarks.jira.<key>` | Per-Jira-ticket rich-text remarks |
| `dashboard.working.YYYY-MM-DD.<key>` | Per-day "working today" toggle |
| `dashboard.lastIntelligentTs` | ms-since-epoch of last 🧠 click |
| `dashboard.sprint_filter` | "current" / "all" / "none" / `<sprintId>` |

## Adding features

### To add a new server endpoint

1. In `server.js`, add a route inside the `http.createServer` handler block.
   Look for where `/api/health` is wired up — same pattern.
2. If it needs slow data, route it through a cache layer like
   `getRecommendations` does (in-flight dedup + disk persist).

### To add a new section to the UI

1. Add a `<section id="...">` placeholder to `index.html`.
2. Add a render function in `app.js` (e.g., `renderXyz(data)`) and call it
   from `render(data)`.
3. Update `rebuildSidebar(data)` so the section shows up in the jump nav.
4. Style it in `styles.css` — variables already cover light + dark mode.

### To add a new field to stack cards

1. Server-side: enrich the stack model in `buildModel()` (or in
   `enhanceStackNamesWithClaude`-style post-processing).
2. Frontend: add the rendering inside `renderStackCard()` in `app.js`. Stack
   card structure: `summary` (visible when collapsed) → `stack-body`
   (revealed on expand). Header info goes in `summary`, detail in `stack-body`.

### To add a new persisted user-setting

Use `localStorage` with a `dashboard.*` key. Read/write helper pattern:

```js
const FOO_KEY = "dashboard.foo";
function getFoo() { return localStorage.getItem(FOO_KEY) || "default"; }
function setFoo(v) { localStorage.setItem(FOO_KEY, v); }
```

### To call Claude for a new feature

Use `callClaude(prompt, opts)` — it spawns the `claude` CLI, pipes the prompt
via stdin, returns stdout. `opts.allowedTools` accepts a comma-separated MCP
tool name list. `opts.model` defaults to `claude-haiku-4-5`. Always cache
the result on disk via `loadDiskCache` / `saveDiskCache` if the answer is
expensive — Claude calls are 5–60s each.

If Claude needs to return structured data, ask for JSON only and use
`parseJsonLoose()` to be tolerant of fences/preamble.

## Gotchas (things that bit us)

1. **gh's `--author "@me"` returns `[]` under Node child_process.** No clue
   why — works fine from interactive shell. Workaround in `fetchOpenPRs`:
   fetch all open PRs and filter by `author.login` in JS. Always pass
   `--repo revefi/rcode` explicitly because gh's auto-detect from cwd is
   also flaky in the same context.

2. **Atlassian deprecated `/rest/api/3/search`** mid-2024. Must use POST
   `/rest/api/3/search/jql` — see `jiraPost()` and `fetchOpenJiraTickets()`.
   Sprint custom field is `customfield_10020` on revefi.atlassian.net.

3. **`gt log short --no-interactive --classic`** uses Unicode box-drawing
   chars (`↱`, `│`, `─`, `┴`, `┘`, `├`). The regex in `parseGtLog()` accounts
   for these. Indent depth = column count of leading whitespace.

4. **Stack partitioning rule**: leaves are lines whose previous line has
   equal-or-less indent. For each leaf, walk DOWN looking for strictly
   smaller-indent ancestors. Trunk is `main`. A "user segment" stops at the
   first branch that doesn't match an open user PR or recent-merged user PR.

5. **macOS TCC blocks launchd from Desktop / Documents / Downloads.**
   That's why this project lives at `~/dashboard/`, not `~/Desktop/...`. TCC
   also blocks reads of `~/.tool-versions` and `~/.asdfrc`, so launchd can't
   use asdf shims. `start.sh` works around this by hardcoding the concrete
   `node` and `gh` binary paths, and setting an explicit PATH for child
   processes.

6. **The `toggle` DOM event does NOT bubble.** When wiring "Collapse all"
   label updates, attach a listener to each `<details>` individually inside
   `wireDelegates()`, not a delegated listener on `document`.

7. **Recommendations cache file shape ≠ TTL'd disk-cache shape.** Recs are
   stored as `{ts, html}` directly (saved by `saveRecsToDisk`), not the
   `{data, expiresAt}` envelope used by `loadDiskCache/saveDiskCache`. If
   you need to read it programmatically, special-case it.

8. **GitHub TLS handshakes are flaky from CLI.** `shRetry` exists exactly
   for this; wrap any new `gh ...` calls in it.

## Operations

- Server runs under launchd. Start: `launchctl load ~/Library/LaunchAgents/com.varun.dashboard.plist`. Stop: `launchctl unload ...`. Status: `launchctl list | grep dashboard`.
- Logs: `/tmp/dashboard.log`, `/tmp/dashboard.err`.
- Manual restart after a code change: `launchctl kickstart -k gui/$(id -u)/com.varun.dashboard`.
- For server.js or start.sh changes you need a restart. For `public/*.js`,
  `public/*.css`, `public/*.html` — just hard-refresh the browser
  (Cmd+Shift+R).

## Configuration

Two env vars must be in the launchd job's environment for full functionality:

- `ATLASSIAN_EMAIL` — for Jira REST auth
- `ATLASSIAN_API_TOKEN` — get one at https://id.atlassian.com/manage-profile/security/api-tokens

Both are sourced from `~/.zshrc` by `start.sh` (via grep + eval) so they don't
need to live in the launchd plist itself. Without them the dashboard still
works — the Untouched Jira section and stack-card chip summaries just don't
populate (the UI shows a "Jira not configured" hint).

The `REPO` and `SESSIONS_ROOT` constants at the top of `server.js` point at
the rcode repo and your Claude project sessions dir. Change these if you ever
repurpose the dashboard for a different project.
