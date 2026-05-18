# CLAUDE.md — Dashboard codebase guide

Personal PR/stack dashboard for Revefi work. Replaces running `/daily-start`
repeatedly throughout the day. A small Node server polls `gh`, `gt`, Jira REST,
and Claude session files; a vanilla-JS SPA renders the result. Lives at
`~/dashboard/`, its own private GitHub repo, not tied to any single project
except via configured absolute paths in `src/server/config.js` (`REPO`,
`SESSIONS_ROOT`).

## Files

```
~/dashboard/
├── server.js                4-line shim: `require("./src/server")`
├── src/server/              backend, split by concern (CommonJS, no deps)
│   ├── index.js             boots http.createServer + listens on PORT
│   ├── config.js            env vars, paths, constants
│   ├── shell.js             sh / shRetry / shWithInput
│   ├── disk-cache.js        loadDiskCache / saveDiskCache (TTL-aware)
│   ├── git.js               worktrees, behind, conflicts, gt-log parsing
│   ├── gh.js                PRs + bulk GraphQL signals (review threads + CI)
│   ├── jira.js              REST client + transitions
│   ├── claude.js            callClaude, session scoring, stack-name gen
│   ├── model.js             buildModel — the /api/data hot path
│   ├── cache.js             in-memory cache + getData wrapper
│   ├── recs.js              "Action items" Claude-backed recommendations
│   ├── restack.js           POST /api/restack handler
│   └── routes.js            HTTP request dispatch + serveStatic + MIME
├── start.sh                 launchd wrapper (sets PATH, sources zshrc creds)
├── public/
│   ├── index.html           SPA shell — three-column layout
│   ├── app/                 frontend, split by concern (native ES modules)
│   │   ├── main.js          DOMContentLoaded wiring (entry)
│   │   ├── store.js         shared mutable state (currentData, etc.)
│   │   ├── storage.js       localStorage keys + getters/setters
│   │   ├── dom.js           $, $$, esc, truncate, relAge
│   │   ├── api.js           fetchData, fetchRecs, intelligentRefresh
│   │   ├── render.js        all render*() + render(data) + rebuildSidebar
│   │   ├── notepad.js       markdown editor + notepad init
│   │   ├── theme.js         Auto/Light/Dark cycle button
│   │   ├── progress.js      median-driven progress fill on refresh buttons
│   │   ├── jira-state.js    state-pill popover + transitions
│   │   ├── restack-action.js  restack click handler
│   │   ├── refresh.js       auto-refresh, freshness, collapse-all
│   │   └── delegates.js     wireDelegates event delegation
│   ├── styles.css           14-line @import aggregator
│   ├── styles/              styling, split by topic
│   │   ├── base.css         :root vars, reset, layout shell
│   │   ├── topbar.css       header.top, refresh buttons, auto-toggle
│   │   ├── summary.css      summary stats, h2, .muted, .error-banner
│   │   ├── stacks.css       cards, PR rows, trunk, upstream, remarks
│   │   ├── jira-table.css   .chips, table.jira, type-badge, remarks
│   │   ├── recs.css         Action items panel
│   │   ├── sidebar.css      jump-nav + scroll-margin offsets
│   │   ├── jira-state.css   sprint filter, state pills, state menu
│   │   └── markdown.css     .md-view + .md-editor
│   ├── marked.min.js        markdown parser (GFM), ~40KB, served as static
│   └── favicon.ico
├── tools/
│   ├── snapshot.sh          backward-compat snapshot harness for refactors
│   └── snapshot-filter.jq   jq filter that zeroes volatile fields
├── cache/                   gitignored
│   ├── recommendations.json    Claude-generated recs (manual refresh only)
│   └── stack-names.json        Claude-named stacks, keyed by PR-set hash
├── README.md                user-facing docs
└── CLAUDE.md                (this file — codebase guide for future edits)

~/Library/LaunchAgents/
└── com.<you>.dashboard.plist  launchd job; runs ~/dashboard/start.sh on login
```

There are no `node_modules` and no build step on either side — Node 22's built-in
`http` module + `fetch` are sufficient on the server, the frontend is plain
HTML/CSS/JS + native ES modules, plus the dropped-in `marked.min.js`. The
`claude` CLI is shelled out for AI-shaped work (recommendations, stack name
generation).

## Runtime architecture

```
                ┌─────────────────────┐
   Browser ──── │ http://localhost:7787│
                └──────────┬──────────┘
                           │
                           ▼
   ┌────────────────────────────────────────────────────┐
   │ src/server/ (CommonJS modules)                     │
   │   /api/data                ← model JSON            │
   │   /api/recommendations     ← Claude-generated <li>s│
   │   /api/restack (POST)      ← gt restack + gt submit│
   │   /api/jira/transitions    ← list valid transitions│
   │   /api/jira/transition POST ← perform a transition │
   │   /api/health              ← lightweight status    │
   │   /  /styles.css /app/*.js /styles/*.css /marked   │
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

Plain refresh end-to-end takes ~8 seconds, dominated by GitHub's GraphQL
response time and a few `gh` subprocess spawns. See "Performance notes" below.

## `src/server/` anatomy

One module per concern. `index.js` boots the HTTP server; everything else
exports a small surface that other modules import. `server.js` at the repo
root is a 4-line shim that just `require("./src/server")` so launchd configs
keep working without a path change.

| Module | What it owns |
| --- | --- |
| `config.js` | `REPO` (from `process.env.WORKSPACE_PATH` — required), `SESSIONS_ROOT` (`$HOME/.claude/projects`), `MAIN_SESSIONS_DIR` (derived via `encodeProjectDir(REPO)`), `PORT`, `CACHE_DIR`, `STATIC_DIR`, all file paths and constants |
| `shell.js` | `sh()`, `shRetry()`, `shWithInput()` — promisified `exec` / `spawn` with retry / stdin pipe |
| `disk-cache.js` | `loadDiskCache(file)` / `saveDiskCache(file, data, ttlMs)` — TTL-aware JSON-on-disk helpers |
| `git.js` | `parseGtLog`, `buildStacksFromGtLog`, `fetchWorktrees`, `fetchOriginMain`, `fetchStackBehind` (per-stack `behind origin/main`), `checkRestackConflicts` (in-memory 3-way merge via `git merge-tree --write-tree`), `fetchLocalBranchMeta` (synthesizes a PR-shaped object from `git log -1` for branches without a PR), `isRebaseInProgress` |
| `gh.js` | `getLogin`, `fetchOpenPRs`, `fetchRecentMergedPRs`, `fetchAnyPR`, `fetchPRMeta`, `fetchPrSignalsBulk` (one aliased GraphQL query returning review-thread counts AND CI `statusCheckRollup` for every user PR), `summarizeChecks` (rollup → `{state, failing[], running, total}`) |
| `jira.js` | `jiraGet/jiraPost` (POST supports `expectEmpty: true` for 204 no-body endpoints), `fetchJiraTickets`, `fetchOpenJiraTickets`, `fetchJiraTransitions(key)`, `performJiraTransition(key, transitionId)`, `parseActiveSprint`, `deriveJiraNote`, `jiraConfigured` |
| `claude.js` | `callClaude()`, `parseJsonLoose()`, `scoreSessionsForStack()` (greps Claude session JSONLs in parallel), `enhanceStackNamesWithClaude()` (bulk Claude call, disk-cached by PR-set hash) |
| `model.js` | `buildModel()` — the `/api/data` hot path, plus the small `parseTitle/relTime/deriveStatus` helpers it uses |
| `cache.js` | in-memory `cache = {ts, data, building}` + `getData(forceRefresh, opts)` wrapper + `clearClaudeBackedCaches()`. Other modules mutate `cache.ts = 0` to invalidate (works because they share the object reference) |
| `recs.js` | `getRecommendations()`, prompt construction, disk cache, `getRecsCacheState()` |
| `restack.js` | `restackStack(stackKey)` — guarded `gt restack` + `gt submit --stack -u` in the stack's worktree (POST `/api/restack` body) |
| `routes.js` | `handle(req, res)` request dispatcher + `serveStatic` + `MIME` + `readJson(req)` |
| `index.js` | `http.createServer(handle)` + `listen(PORT)` + boot logs |

### `buildModel()` pipeline (the hot path)

```
1. parallel fetch:  gt log + open PRs + recent merged PRs + worktrees
                    + `git fetch origin main --quiet` (read-only ref update)
2. parse gt log → list of leaf-to-trunk chains
3. pre-detect "fully merged" branches — for every branch that has a
   worktree but no open PR and no recent-merged record, `git rev-list
   --count <branch> ^origin/main`. Result drives partitioning so that
   freshly-merged worktree branches don't masquerade as local-only stacks.
4. for each chain:
     partition into user_segment (your PRs, including local-only worktree
                                  branches that aren't fully merged)
                  + upstream_segment (parent PRs by others)
5. fill synthetic `pr` for local-only branches (`fetchLocalBranchMeta`,
   parallel)
6. fetch upstream PR metadata (gh pr view per branch, parallel)
7. fetch review-thread counts + CI check rollups (one bulk GraphQL query,
   aliased fields per PR — `fetchPrSignalsBulk`). Local-only branches are
   skipped because they don't have PR numbers.
8. kick off session scoring for ALL stacks in parallel up front
   + per-stack `fetchStackBehind` (merge-base + rev-list) in parallel
   + per-stack `checkRestackConflicts` (merge-tree probe) in parallel
9. build PR objects per stack (await each pre-launched scoring/behind/conflict promise)
10. enhanceStackNamesWithClaude() — bulk Claude call for any stack
                                    whose PR-set hash isn't cached
11. detect stale worktrees (parallel Promise.all over worktrees)
12. fetch Jira tickets bulk (chip summaries) via direct REST
13. fetch all assigned-to-me Jira tickets, attach `stack` reference for any
    that already belong to an open stack (the UI's `untouched_jira` wire
    field — name kept for compat; the section is now just "Jira")
14. assemble final model object
```

Every step that touches I/O is parallelized — see "Performance notes".

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
  behind_origin: 9,                     // commits between leaf's fork-point on main and origin/main
  restack_check: null | {ok: true, conflicts: []} | {ok: false, conflicts: ["path/a.ts", ...]},
  top_pr: {num, url},
  counts: {created, merged, approved, pending, changes_requested},
  upstream: null | {n, author, approved, changes_requested, review_required},
  worktree: null | {name, path, branch},
  resume: null | {sid, in_worktree, worktree_name},
  prs: [Pr],            // user's PRs, top-of-stack first
  upstream_prs: [Pr],   // other authors' PRs lower in chain (collapsed in UI)
}

Pr = {
  num,                        // null for is_local: true
  url,                        // null for is_local: true
  branch, title, jira_tag, part_tag,
  is_draft, is_local,         // is_local = worktree exists, no GitHub PR yet
  decision, status_label, status_class,
  human_comments, bot_comments, updated_label, needs_restack,
  checks: null | { state, failing: [name], running, total }, // null on drafts and local-only
}
```

The Jira tickets list (wire field `untouched_jira` — historical name) carries:

```js
{
  rank, key, url, type, summary, priority, updated, updated_label, note,
  sprint: null | { id, name, state, start_date, end_date },
  status: "In Progress",
  status_category: "new" | "indeterminate" | "done",
  stack: null | { stack_key, name },  // populated when the ticket is on an open stack
}
```

### Restack endpoint (`POST /api/restack`)

Body: `{ stack_key: "..." }`. Server-side `restackStack()` is the only thing
that mutates user state; it's heavily guarded:

| Guard | Behavior on failure |
| --- | --- |
| `stack_key` exists in current model | 400 "unknown stack" |
| `stack.upstream` is null | 400 "stack sits on upstream PRs — would skip past them" |
| `stack.worktree.path` is set | 400 "no worktree — run `gt sync` from main checkout" |
| `behind_origin > 0` | 400 "already up to date" |
| `restack_check.ok !== false` (no predicted conflicts) | 400 with conflict file list |
| `git status --porcelain` is empty in the worktree | 400 with the dirty file list |
| `gt restack` exits 0 AND no leftover `.git/rebase-merge` / `rebase-apply` | else: `git rebase --abort` to restore branches, return error |
| `gt submit --stack -u --no-edit --no-interactive` exits 0 | else: return partial-success error (local restack stays — never undone) |

Path is **never** taken from the client — the worktree path is looked up
server-side from the cached model. `getData(true)` is forced before the
guards run so the model is fresh. After success or failure the in-memory
cache is invalidated (`cache.ts = 0`) so the next `/api/data` reflects
reality.

`gt submit --stack -u` (not just `gt submit -u`) is critical: without
`--stack`, gt only pushes trunk-to-current-branch and silently skips
descendants. Default push mode is `--force-with-lease`, which refuses if
anyone else pushed to the branch since our last fetch.

## Caching model

| Cache | Where | TTL | Invalidation |
| --- | --- | --- | --- |
| `cache.data` | in-memory | 30s | `?refresh=1` query param |
| `cache/stack-names.json` | disk | 30 days, but key includes sorted PR-set hash so it auto-busts when a stack's PRs change | ✨ Intelligent click clears the file |
| `cache/recommendations.json` | disk | forever | ⟳ Generate or ✨ Intelligent click |

Jira tickets and the assigned-tickets list are NOT cached on disk — direct
REST is fast enough (~50ms per ticket, <200ms for the bulk search) that every
plain ↻ Refresh fetches them fresh. `POST /api/jira/transition` busts
`cache.data` on success so the new status surfaces immediately.

### Refresh modes

| User action | What gets refetched | Claude calls? |
| --- | --- | --- |
| ↻ Refresh / Auto (configurable: 1/5/10/30 min) | gh, gt, git, Jira REST | none (uses cached stack-names + recs) |
| ✨ Intelligent | All of the above + wipes stack-names cache + regenerates recommendations | yes (stack names + recs) |
| ⟳ Generate (in Action items section) | Just the action items | yes (recs only) |

## Frontend (`public/`)

`index.html` is a static SPA shell with named placeholder elements
(`#summary`, `#active-stacks`, `#untouched-rows`, `#recs-list`,
`#notepad-content`, etc.). The SPA loads as a native ES module via
`<script type="module" src="/app/main.js">` — no bundler. The browser
fetches each `import "./foo.js"` on demand. `render.js` populates the
placeholders by `innerHTML = ...` after fetching `/api/data`.

`public/app/` modules:

| Module | Owns |
| --- | --- |
| `main.js` | DOMContentLoaded wiring + button handlers |
| `store.js` | shared mutable state — `{currentData, cachedUntouchedList, lastFetchTs}` (object pattern so mutations through imports are visible) |
| `storage.js` | every `dashboard.*` localStorage key + getters/setters |
| `dom.js` | `$`, `$$`, `esc`, `truncate`, `relAge` |
| `api.js` | `fetchData`, `fetchRecs`, `intelligentRefresh` |
| `render.js` | every `render*()` function + `render(data)` + `rebuildSidebar(data)` |
| `notepad.js` | `wireMarkdownRemarks`, `renderMarkdown`, `initNotepad`, `applyNotepadVisibility`, `toggleNotepad` |
| `theme.js` | `initTheme()` — wires the header's Auto/Light/Dark cycle button. "Auto" leaves `data-theme` unset so the OS @media query drives styling; Light/Dark sets `data-theme="..."` on `<html>` and persists under `dashboard.theme`. First-paint application is done by an inline `<script>` in `index.html`'s `<head>` to avoid FOUC. |
| `progress.js` | `startRefreshProgress(btn, mode)` / `stopRefreshProgress(btn)` — `rAF` ticker that writes `--refresh-progress` (0..1) onto a button based on `elapsed / median(stored timings)`. `api.js` calls these around each refresh; `topbar.css` turns the variable into a left-to-right background tint fill. Pulses opacity once the elapsed time exceeds the median. Stays a no-op until we have ≥5 recorded samples — first 4 refreshes just show the label change. |
| `jira-state.js` | `openStateMenu`, popover positioning, `handleStateTransition` (optimistic, with revert on failure) |
| `restack-action.js` | `handleRestackClick` — confirm dialog + POST + spinner |
| `refresh.js` | `setupAutoRefresh` (self-rescheduling setTimeout + visibilitychange catch-up), `updateFreshness`, `toggleAllStacks`, `syncStickyTop` |
| `delegates.js` | `wireDelegates()` — idempotent event delegation; runs after every render |

### Layout

Three columns with sticky behavior:

```
┌─────────────────────────────────────────────────────────────────┐
│  header.top  (sticky, top:0, z-index:50, opaque bg)             │
├──────────┬───────────────────────────────────────────┬──────────┤
│ sidebar  │  main-col                                 │ notepad  │
│ (sticky, │  (scrolls)                                │ (sticky, │
│  top:    │                                           │  top:    │
│  --sticky│  - active-section (stack cards)           │  --sticky│
│  -top)   │  - merged-section                         │  -top)   │
│          │  - untouched-section (Jira table)         │          │
│  jump-nav│  - stale-section                          │ markdown │
│  links   │  - recs-section                           │  scratch │
│          │                                           │  pad     │
└──────────┴───────────────────────────────────────────┴──────────┘
```

`--sticky-top` is a CSS variable set by `syncStickyTop()` on load + on resize.
It equals the actual rendered header height + a 16px gap, so the sidebar and
notepad always anchor right under the header even when the action buttons wrap
to a second line.

Responsive collapse:
- ≤1280px: drop the notepad first (back to sidebar | main)
- ≤900px: drop the sidebar too (single column, mobile)

### Stack cards — custom toggle (NOT `<details>/<summary>`)

Each stack card is a plain `<div class="card stack-card">` containing:
- `<div class="stack-summary" data-toggle-card>` — always visible (header)
- `<div class="stack-body">` — visibility controlled by `.expanded` class

A click on `[data-toggle-card]` toggles the `.expanded` class on the parent
card. Clicks bubbling from `[data-stop-toggle]` descendants are ignored
(`if (e.target.closest("[data-stop-toggle]")) return;`).

We tried `<details>/<summary>` first. It broke once we wanted a contenteditable
inside the summary — `<summary>` would steal focus, and Space toggled the
details instead of inserting a space. The custom div toggle has none of those
edge cases.

### Markdown remarks

The per-stack remarks, per-jira-row remarks, and the right-hand notepad all
share `wireMarkdownRemarks(wrap, persistKey, opts)`:

- Storage in localStorage is **raw markdown** (was HTML in earlier versions).
- View mode: `<div class="md-view">` rendered via `marked.parse()` with GFM
  enabled. Click → swaps to edit mode.
- Edit mode: `<textarea class="md-editor">`, autofocused with caret at end,
  auto-resizes on input. Cmd/Ctrl+B / I / K shortcuts wrap selection. Blur or
  Escape or Cmd+Enter commits.

`marked.min.js` is loaded with `defer` in `index.html` so it's available by
the time `DOMContentLoaded` fires. `wireMarkdownRemarks` falls back to
`esc(text).replace(/\n/g, "<br>")` if `window.marked` is somehow undefined.

### Render pipeline

```
fetchData() ──→ render(data) ──┬──→ renderSummary()
                                ├──→ renderStackCard() × N (active)
                                ├──→ renderStackCard() × N (merged)
                                ├──→ renderUntouchedJira()  → renderUntouchedRows()
                                ├──→ renderStaleWorktrees()
                                ├──→ rebuildSidebar()
                                └──→ wireDelegates()  ← attach event listeners

initNotepad()         ─────────────────→ wireMarkdownRemarks (one-time on load)
```

`wireDelegates()` runs after every render and is idempotent. Each loop uses
its OWN flag (e.g. `_jumpWired`, `_copyWired`, `_actionWired`,
`_stopToggleWired`, `_editNameWired`, `_toggleWired`, `_mdWired`,
`_restackWired`, `_statePillWired`). A shared `_wired` flag would collide
when a single element matches multiple selectors (e.g. the stack-name pencil
has both `data-stop-toggle` and `data-edit-name`).

It attaches:
- `click` on `[data-toggle-card]` (card collapse toggle)
- `click` on `[data-jump]` (sidebar nav, expands target card before scrolling)
- `paste` / `blur` / `keydown` on `.stack-remarks` and `.remarks` (markdown
  rich text via `wireMarkdownRemarks`)
- Per-Jira-row remarks
- `click` + propagation-stop on `[data-copy]` (copy commands)
- `click` on `[data-action="complete"]` / `[data-action="restore"]`
- `click`+`mousedown`+keydown stop on `[data-stop-toggle]` (defensive — keeps
  events inside interactive children of the card-summary from triggering the
  card toggle)
- `click` on `[data-edit-name]` (pencil icon — inline rename of stack name)
- `click` on `[data-restack-stack]` (trunk-row Restack button → confirm dialog
  → POST `/api/restack` → spinner → on success refresh data, on error
  surface server message via `alert()`)
- `click` on `[data-state-pill]` (Jira state pill → fetch valid transitions
  from `/api/jira/transitions` → render popover → on selection POST to
  `/api/jira/transition` with optimistic UI update; reverts on failure)

### localStorage keys

All under the `dashboard.*` namespace:

| Key | Purpose |
| --- | --- |
| `dashboard.completed` | JSON array of stack_keys marked complete |
| `dashboard.remarks.stack.<stack_key>` | Per-stack remarks (markdown) |
| `dashboard.remarks.jira.<key>` | Per-Jira-ticket remarks (markdown) |
| `dashboard.notepad` | Right-side scratchpad content (markdown) |
| `dashboard.stack_name_override.<stack_key>` | User's manual rename of a stack |
| `dashboard.lastIntelligentTs` | ms-since-epoch of last ✨ click |
| `dashboard.sprint_filter` | `"current"` / `"all"` / `"none"` / `<sprintId>` |
| `dashboard.stack_filter` | `"without_stack"` / `"with_stack"` / `"all"` (Jira-table stack-presence filter) |
| `dashboard.notepad_hidden` | `"1"` if the right-side notepad column is hidden |
| `dashboard.auto_refresh_ms` | Selected auto-refresh interval in ms (60000/300000/600000/1800000) |
| `dashboard.theme` | `"light"` or `"dark"` if the user picked one. Absent = follow OS via `prefers-color-scheme`. |
| `dashboard.refresh_timings_ms` | JSON array of recent `/api/data` durations in ms (rolling window of 50). Drives the progress fill on the ↻ Refresh button after ≥5 samples accumulate. |
| `dashboard.recs_timings_ms` | Same shape, for `/api/recommendations` (force=true only — cached reads aren't measured). Drives progress on the ⟳ Generate / ✨ Intelligent buttons. |

## Adding features

### To add a new server endpoint

1. In `src/server/routes.js`, add a route inside `handle()`. Look for where
   `/api/health` is wired up — same pattern.
2. If the route needs business logic of its own, give it a module under
   `src/server/` (e.g. `restack.js` is the model for that).
3. If it needs slow data, route it through a cache layer like
   `getRecommendations` does (in-flight dedup + disk persist).

### To add a new section to the UI

1. Add a `<section id="...">` placeholder to `index.html` inside
   `<main class="main-col">`.
2. Add a render function in `public/app/render.js` (e.g., `renderXyz(data)`)
   and call it from `render(data)`.
3. Update `rebuildSidebar(data)` (also in `render.js`) so the section shows
   up in the jump nav.
4. Style it in the appropriate `public/styles/*.css` partial — variables in
   `base.css` already cover light + dark mode. Add a new partial only if
   the section is large enough to warrant one (and add the `@import` to
   `styles.css`).

### To add a new field to stack cards

1. Server-side: enrich the stack model in `src/server/model.js` →
   `buildModel()`.
2. Frontend: add the rendering inside `renderStackCard()` in
   `public/app/render.js`. Stack card structure: `stack-summary` (visible
   always) → `stack-body` (revealed when `.expanded`). Header info goes in
   `stack-summary`, detail in `stack-body`. Anything inside `stack-summary`
   that should NOT toggle the card on click should carry `data-stop-toggle`.

### To add a new persisted user-setting

Use `localStorage` with a `dashboard.*` key. Read/write helper pattern:

```js
const FOO_KEY = "dashboard.foo";
function getFoo() { return localStorage.getItem(FOO_KEY) || "default"; }
function setFoo(v) { localStorage.setItem(FOO_KEY, v); }
```

### To call Claude for a new feature

Import from `src/server/claude.js`: `callClaude(prompt, opts)` spawns the
`claude` CLI, pipes the prompt via stdin, returns stdout. `opts.allowedTools`
accepts a comma-separated MCP tool name list. `opts.model` defaults to
`claude-sonnet-4-6`. Always cache the result on disk via `loadDiskCache` /
`saveDiskCache` (from `src/server/disk-cache.js`) if the answer is expensive
— Claude calls are 5–60s each.

If Claude needs to return structured data, ask for JSON only and use
`parseJsonLoose()` to be tolerant of fences/preamble.

### To add a markdown-backed editable region

Drop a `<div data-md-key="dashboard.your_key" class="..."></div>` into the
DOM and call `wireMarkdownRemarks(div, div.dataset.mdKey, { placeholder: "..." })`
once. The helper takes over the wrap's children — installs a `.md-view` and
a `.md-editor` and toggles between them.

## Performance notes

Plain refresh ≈ 8s. The sequence (after parallelization):

| Stage | Cost |
| --- | --- |
| `gt log` + `gh pr list` + recent merged + worktrees | ~1.5s parallel |
| Upstream `fetchAnyPR` × N + `fetchPRMeta` × N | ~1s parallel (often N=0) |
| `fetchPrSignalsBulk` for all open user PRs | ~2-3s — single aliased GraphQL query returning review threads + CI rollup, **not** one-call-per-PR |
| Session scoring (~60 JSONL files × N stacks) | ~1s — files parallel within scoring, all stacks scored concurrently |
| Stack-name generation | 0s (cached) or ~5s (cold) |
| Jira REST × N + Jira search | <1s parallel |
| Stale-worktree detection | <1s parallel |

Earlier versions did 27 parallel `gh api graphql` subprocess spawns for review
threads, sequential `grep` per session file, and sequential stale-worktree
checks — ~28s baseline.

## Gotchas (things that bit us)

1. **gh's `--author "@me"` returns `[]` under Node child_process.** No clue
   why — works fine from interactive shell. Workaround in `fetchOpenPRs`:
   fetch all open PRs and filter by `author.login` in JS. Always pass
   `--repo revefi/rcode` explicitly because gh's auto-detect from cwd is
   also flaky in the same context.

2. **Atlassian deprecated `/rest/api/3/search`** — must use POST
   `/rest/api/3/search/jql` (see `jiraPost()` and `fetchOpenJiraTickets()`).
   Sprint custom field is `customfield_10020` on revefi.atlassian.net.

3. **`gt log short --no-interactive --classic`** uses Unicode box-drawing
   chars (`↱`, `│`, `─`, `┴`, `┘`, `├`). The regex in `parseGtLog()` accounts
   for these. Indent depth = column count of leading whitespace.

4. **Stack partitioning rule**: leaves are lines whose previous line has
   equal-or-less indent. For each leaf, walk DOWN looking for strictly
   smaller-indent ancestors. Trunk is `main`. A "user segment" stops at the
   first branch that doesn't match an open user PR or recent-merged user PR.

5. **macOS TCC blocks launchd from Desktop / Documents / Downloads.**
   That's why this project lives at `~/dashboard/`, not under `~/Desktop/`.
   TCC also blocks reads of `~/.tool-versions` and `~/.asdfrc`, so launchd
   can't use asdf shims. `start.sh` works around this by hardcoding the
   concrete `node` and `gh` binary paths, and setting an explicit PATH for
   the server's child processes.

6. **Stack cards are NOT `<details>/<summary>`.** They look like one (header
   always visible, body toggles), but they're plain `<div>`s with an
   `.expanded` class. We tried `<details>` first — putting a contenteditable
   inside `<summary>` caused Space-key toggling and focus stealing that
   couldn't be cleanly fought. The custom toggle has none of that.

7. **Recommendations cache file shape ≠ TTL'd disk-cache shape.** Recs are
   stored as `{ts, html}` directly (saved by `saveRecsToDisk`), not the
   `{data, expiresAt}` envelope used by `loadDiskCache/saveDiskCache`. If
   you need to read it programmatically, special-case it.

8. **GitHub TLS handshakes are flaky from CLI.** `shRetry` exists exactly
   for this; wrap any new `gh ...` calls in it.

9. **Per-loop `_wired` flags in `wireDelegates`.** Shared `el._wired = true`
   broke when an element matched multiple loops (the pencil button has both
   `data-stop-toggle` and `data-edit-name`). Always use a per-loop flag name.

10. **`marked.min.js` loads with `defer`.** It's available by the first
    `DOMContentLoaded`, not before. `wireMarkdownRemarks` has a
    `typeof window.marked === "undefined"` fallback for safety.

11. **`gt sync` from the main checkout SKIPS worktree branches** — output
    says `"Skipped syncing branch X because it is checked out in another
    worktree"`. Most user stacks live in worktrees, so `gt sync` from main
    only fast-forwards `main`; the actual restack must happen inside each
    worktree (`gt restack` or `gt sync` there). This is exactly why the
    dashboard's Restack button targets the worktree path, not the main
    checkout.

12. **`gt submit -u` without `--stack` skips descendants.** It pushes
    trunk-to-current-branch only; branches above the current branch in the
    stack are silently left unpushed. Always use `gt submit --stack -u`
    when pushing programmatically. Bit us once during manual recovery —
    only PRs Part 1-3 got pushed before we noticed Parts 4-6 were stale.

13. **`behind_origin` is per-stack, not global.** It's measured as
    `merge-base(leaf, origin/main)..origin/main`. Two stacks based off
    different commits of main can have different counts, even on the
    same dashboard load. Don't compute it once and reuse.

14. **The trunk-row badge is hidden when `stack.upstream` is set.** The
    "behind origin/main" measurement walks past the upstream fork and
    over-reports for stacks built on someone else's PRs. Hiding it avoids
    suggesting a restack that would skip past the upstream author's work.
    The server endpoint also refuses for these stacks as a second line
    of defense.

15. **GitHub's `statusCheckRollup.contexts` returns superseded check runs.**
    When a CI run is preempted (a new push, a re-run, etc.), GitHub leaves
    the old `CheckRun` row in place with `conclusion: CANCELLED` and adds
    a new row for the latest run. Naively iterating `contexts` double-
    counts every check, with the old CANCELLED treated as a failure.
    Even the rollup `state` field is unreliable for the same reason —
    it can return `FAILURE` while `gh pr checks` shows the PR passing.
    `summarizeChecks` deduplicates by name (latest by `startedAt` /
    `createdAt`) and computes its own state from the surviving runs.

16. **Graphite-squashed PRs leave `mergedAt: null` on GitHub.** The PR is
    CLOSED but our `fetchRecentMergedPRs` filters with `merged_at != null`,
    so it misses these. Without an extra check, a freshly-merged worktree
    branch would slip through the `branchToOpenPR` and `branchToMergedPR`
    lookups, hit the `wt` arm of the partitioning, and show up as a
    "Local only" stack — even though it's actually done. The pre-detect
    step in `buildModel` runs `git rev-list --count <branch> ^origin/main`
    for every local-only candidate; branches with 0 unique commits vs
    origin/main are excluded from the user segment. They appear in the
    stale-worktree section instead, which is the right cleanup cue.

17. **Local-only stacks have `pr.number === null`.** When a branch has a
    worktree but no GitHub PR yet, `fetchLocalBranchMeta` synthesizes a
    PR-shaped object with `isLocal: true`, `number: null`, and the title
    pulled from the latest commit subject via `git log`. Downstream code
    that expects a PR number (bulk GraphQL fetch, the graphite URL
    template) explicitly skips or guards against null. The frontend
    renders `📦 Local only` instead of the review/CI status pills.

## Operations

- Server runs under launchd. Plist: `~/Library/LaunchAgents/com.<you>.dashboard.plist`.
  - Start: `launchctl load ~/Library/LaunchAgents/com.<you>.dashboard.plist`
  - Stop:  `launchctl unload ~/Library/LaunchAgents/com.<you>.dashboard.plist`
  - Status: `launchctl list | grep dashboard`
  - Hot restart after code change: `launchctl kickstart -k gui/$(id -u)/com.<you>.dashboard`
- Logs: `/tmp/dashboard.log`, `/tmp/dashboard.err`.
- For `src/server/*.js` or `start.sh` changes you need a restart (the
  4-line `server.js` shim never changes). For `public/app/*.js`,
  `public/styles/*.css`, `public/*.html` — just hard-refresh the browser
  (Cmd+Shift+R).
- The launchd job sets `KeepAlive=true` and `ThrottleInterval=30`, so
  unhandled crashes get auto-restarted with a 30s cooldown.

## Configuration

Three env vars are read from `~/.zshrc` (via `start.sh`'s `grep + eval` pull —
no full zshrc source, so oh-my-zsh side effects are avoided):

- `WORKSPACE_PATH` — **required.** Absolute path to the rcode checkout
  (e.g. `/Users/<you>/Desktop/workspace/rcode`). The server fails fast at
  startup if it's missing.
- `ATLASSIAN_EMAIL` — optional, for Jira REST auth.
- `ATLASSIAN_API_TOKEN` — optional. Get one at
  https://id.atlassian.com/manage-profile/security/api-tokens.

Without the Atlassian pair the dashboard still works — the Jira section and
stack-card chip summaries just don't populate (the UI shows a "Jira not
configured" hint).

`MAIN_SESSIONS_DIR` is derived from `WORKSPACE_PATH` via `encodeProjectDir`,
which mirrors how the `claude` CLI names project dirs under
`~/.claude/projects/` — every non-alphanumeric, non-hyphen character becomes
`-`. Worktree session dirs are computed the same way from
`${REPO}/.claude/worktrees/<name>`.

`revefi/rcode` and `revefi.atlassian.net` are intentionally hardcoded — they're
constants for everyone in the company. If you ever fork this for another org,
those are the only two values to swap.
