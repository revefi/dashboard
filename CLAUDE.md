# CLAUDE.md — Dashboard codebase guide

Personal PR/stack dashboard for Revefi work. Replaces running `/daily-start`
repeatedly throughout the day. A small Node server polls `gh`, `gt`, Jira REST,
and Claude session files; a vanilla-JS SPA renders the result. Lives at
`~/dashboard/`, its own private GitHub repo, not tied to any single project
except via configured absolute paths in `server.js` (`REPO`, `SESSIONS_ROOT`).

## Files

```
~/dashboard/
├── server.js                main HTTP server (zero deps, single file)
├── start.sh                 launchd wrapper (sets PATH, sources zshrc creds)
├── public/
│   ├── index.html           SPA shell — three-column layout
│   ├── app.js               all client logic (vanilla JS, single file)
│   ├── styles.css           all styling — CSS variables for light + dark
│   ├── marked.min.js        markdown parser (GFM), ~40KB, served as static
│   └── favicon.ico
├── cache/                   gitignored
│   ├── recommendations.json    Claude-generated recs (manual refresh only)
│   └── stack-names.json        Claude-named stacks, keyed by PR-set hash
├── README.md                user-facing docs
└── CLAUDE.md                (this file — codebase guide for future edits)

~/Library/LaunchAgents/
└── com.varun.dashboard.plist   launchd job; runs ~/dashboard/start.sh on login
```

There are no `node_modules` and no build step on either side — Node 22's built-in
`http` module + `fetch` are sufficient on the server, and the frontend is plain
HTML/CSS/JS plus the dropped-in `marked.min.js`. The `claude` CLI is shelled out
for AI-shaped work (recommendations, stack name generation).

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
   │   /api/restack (POST)  ← gt restack + gt submit    │
   │   /api/health          ← lightweight status        │
   │   /  /styles.css /app.js /marked.min.js /favicon   │
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

## server.js anatomy

Sections, in order, separated by `// ----------` banner comments:

| Section | What it does |
| --- | --- |
| **constants** | `REPO`, `SESSIONS_ROOT`, `PORT`, `CACHE_DIR`, file paths |
| **shell helpers** | `sh()`, `shRetry()`, `shWithInput()` — promisified `exec` / `spawn` with retry / stdin pipe |
| **gt log parsing** | `parseGtLog()`, `buildStacksFromGtLog()` — text → tree |
| **worktrees** | `fetchWorktrees()` from `git worktree list --porcelain` |
| **PRs** | `fetchOpenPRs`, `fetchRecentMergedPRs`, `fetchAnyPR`, `fetchPRMeta`, `fetchReviewThreadsBulk` (one aliased GraphQL query for all PRs) |
| **trunk freshness** | `fetchOriginMain` (read-only `git fetch origin main`), `fetchStackBehind(branch)` (per-stack count of commits ahead of the stack's fork point on origin/main) |
| **restack action** | `restackStack(stackKey)` — guarded `gt restack` + `gt submit --stack -u` in the stack's worktree; `isRebaseInProgress(wt)` (rebase-state probe); `readJson(req)` (POST-body parser) |
| **Claude CLI** | `callClaude()`, `parseJsonLoose()`, disk-cache helpers |
| **Jira** | `jiraGet/jiraPost`, `fetchJiraTickets`, `fetchOpenJiraTickets` (direct REST only — Claude/MCP fallback was removed once REST was stable) |
| **session scoring** | `scoreSessionsForStack()` greps Claude session JSONLs (parallel `Promise.all`) |
| **title parsing** | `parseTitle()` strips `[REV-XXXX][Part N]` prefix |
| **model assembly** | `buildModel()` — the main pipeline |
| **stack-name generation** | `enhanceStackNamesWithClaude()` (Claude bulk call, cached) |
| **caching** | `getData()`, `clearClaudeBackedCaches()` |
| **recommendations** | `getRecommendations()`, prompt construction, disk cache |
| **HTTP** | `serveStatic()`, `MIME` table, route dispatch |

### `buildModel()` pipeline (the hot path)

```
1. parallel fetch:  gt log + open PRs + recent merged PRs + worktrees
                    + `git fetch origin main --quiet` (read-only ref update)
2. parse gt log → list of leaf-to-trunk chains
3. for each chain:
     partition into user_segment (your PRs)
                  + upstream_segment (parent PRs by others)
4. fetch upstream PR metadata (gh pr view per branch, parallel)
5. fetch review-thread counts (one bulk GraphQL query, aliased fields per PR)
6. kick off session scoring for ALL stacks in parallel up front
   + per-stack `fetchStackBehind` (merge-base + rev-list) in parallel
7. build PR objects per stack (await each pre-launched scoring/behind promise)
8. enhanceStackNamesWithClaude() — bulk Claude call for any stack
                                    whose PR-set hash isn't cached
9. detect stale worktrees (parallel Promise.all over worktrees)
10. fetch Jira tickets bulk (chip summaries) via direct REST
11. fetch open Jira list (untouched section)
12. assemble final model object
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

### Restack endpoint (`POST /api/restack`)

Body: `{ stack_key: "..." }`. Server-side `restackStack()` is the only thing
that mutates user state; it's heavily guarded:

| Guard | Behavior on failure |
| --- | --- |
| `stack_key` exists in current model | 400 "unknown stack" |
| `stack.upstream` is null | 400 "stack sits on upstream PRs — would skip past them" |
| `stack.worktree.path` is set | 400 "no worktree — run `gt sync` from main checkout" |
| `behind_origin > 0` | 400 "already up to date" |
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
| `cache/stack-names.json` | disk | 30 days, but key includes sorted PR-set hash so it auto-busts when a stack's PRs change | 🧠 Intelligent click clears the file |
| `cache/recommendations.json` | disk | forever | ⟳ Generate or 🧠 Intelligent click |

Jira tickets and the Untouched Jira list are NOT cached on disk — direct REST
is fast enough (~50ms per ticket, <200ms for the bulk search) that every plain
↻ Refresh fetches them fresh.

### Refresh modes

| User action | What gets refetched | Claude calls? |
| --- | --- | --- |
| ↻ Refresh / Auto (10m) | gh, gt, git, Jira REST | none (uses cached stack-names + recs) |
| 🧠 Intelligent | All of the above + wipes stack-names cache + regenerates recommendations | yes (stack names + recs) |
| ⟳ Generate (in Recs section) | Just recommendations | yes (recs only) |

## Frontend (`public/`)

`index.html` is a static SPA shell with named placeholder elements
(`#summary`, `#active-stacks`, `#untouched-rows`, `#recs-list`,
`#notepad-content`, etc.). `app.js` populates them by `innerHTML = ...` after
fetching `/api/data`.

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
`_restackWired`). A shared `_wired` flag would collide when a single element
matches multiple selectors (e.g. the stack-name pencil has both
`data-stop-toggle` and `data-edit-name`).

It attaches:
- `click` on `[data-toggle-card]` (card collapse toggle)
- `click` on `[data-jump]` (sidebar nav, expands target card before scrolling)
- `paste` / `blur` / `keydown` on `.stack-remarks` and `.remarks` (markdown
  rich text via `wireMarkdownRemarks`)
- Per-row jira working-today checkbox + remarks
- `click` + propagation-stop on `[data-copy]` (copy commands)
- `click` on `[data-action="complete"]` / `[data-action="restore"]`
- `click`+`mousedown`+keydown stop on `[data-stop-toggle]` (defensive — keeps
  events inside interactive children of the card-summary from triggering the
  card toggle)
- `click` on `[data-edit-name]` (pencil icon — inline rename of stack name)
- `click` on `[data-restack-stack]` (trunk-row Restack button → confirm dialog
  → POST `/api/restack` → spinner → on success refresh data, on error
  surface server message via `alert()`)

### localStorage keys

All under the `dashboard.*` namespace:

| Key | Purpose |
| --- | --- |
| `dashboard.completed` | JSON array of stack_keys marked complete |
| `dashboard.remarks.stack.<stack_key>` | Per-stack remarks (markdown) |
| `dashboard.remarks.jira.<key>` | Per-Jira-ticket remarks (markdown) |
| `dashboard.notepad` | Right-side scratchpad content (markdown) |
| `dashboard.stack_name_override.<stack_key>` | User's manual rename of a stack |
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

1. Add a `<section id="...">` placeholder to `index.html` inside `<main class="main-col">`.
2. Add a render function in `app.js` (e.g., `renderXyz(data)`) and call it
   from `render(data)`.
3. Update `rebuildSidebar(data)` so the section shows up in the jump nav.
4. Style it in `styles.css` — variables already cover light + dark mode.

### To add a new field to stack cards

1. Server-side: enrich the stack model in `buildModel()`.
2. Frontend: add the rendering inside `renderStackCard()` in `app.js`. Stack
   card structure: `stack-summary` (visible always) → `stack-body` (revealed
   when `.expanded`). Header info goes in `stack-summary`, detail in
   `stack-body`. Anything inside `stack-summary` that should NOT toggle the
   card on click should carry `data-stop-toggle`.

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
tool name list. `opts.model` defaults to `claude-haiku-4-5`. Always cache the
result on disk via `loadDiskCache` / `saveDiskCache` if the answer is expensive
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
| `fetchReviewThreadsBulk` for all open user PRs | ~2-3s — single aliased GraphQL query, **not** one-call-per-PR |
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

## Operations

- Server runs under launchd. Plist: `~/Library/LaunchAgents/com.varun.dashboard.plist`.
  - Start: `launchctl load ~/Library/LaunchAgents/com.varun.dashboard.plist`
  - Stop:  `launchctl unload ~/Library/LaunchAgents/com.varun.dashboard.plist`
  - Status: `launchctl list | grep dashboard`
  - Hot restart after code change: `launchctl kickstart -k gui/$(id -u)/com.varun.dashboard`
- Logs: `/tmp/dashboard.log`, `/tmp/dashboard.err`.
- For server.js or start.sh changes you need a restart. For `public/*.js`,
  `public/*.css`, `public/*.html` — just hard-refresh the browser (Cmd+Shift+R).
- The launchd job sets `KeepAlive=true` and `ThrottleInterval=30`, so
  unhandled crashes get auto-restarted with a 30s cooldown.

## Configuration

Two env vars must be in the launchd job's environment for full functionality:

- `ATLASSIAN_EMAIL` — for Jira REST auth
- `ATLASSIAN_API_TOKEN` — get one at https://id.atlassian.com/manage-profile/security/api-tokens

Both are sourced from `~/.zshrc` by `start.sh` (via `grep -E '^export ATLASSIAN_' "$HOME/.zshrc"` then `eval`) so they don't need to live in the launchd plist itself. Without them, the dashboard still works — the Untouched Jira section and stack-card chip summaries just don't populate (the UI shows a "Jira not configured" hint).

The `REPO` and `SESSIONS_ROOT` constants at the top of `server.js` point at
the rcode repo and your Claude project sessions dir. Change these if you ever
repurpose the dashboard for a different project.
