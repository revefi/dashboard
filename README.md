# Live dashboard

A self-updating PR/stack dashboard for your daily Revefi workflow. Watches your
open Graphite stacks, GitHub PRs, CI checks, Jira tickets, stale worktrees, and
Claude sessions — refreshes every 10 minutes (or on demand) without burning
Claude tokens.

Runs as a tiny local web server. Open <http://localhost:7787> in any browser.

---

## Getting started

### 1. Check prerequisites

You probably already have everything from the Revefi toolchain. Verify:

```sh
node --version    # v22+ recommended (anything ≥ 18 works)
git --version     # 2.38+ — needed for merge-tree --write-tree
gh --version      # GitHub CLI, authenticated to revefi/rcode
gt --version      # Graphite CLI
claude --version  # optional — only used by 🧠 Intelligent + ⟳ Generate buttons
```

Quick sanity check that the CLIs can reach the things the dashboard polls:

```sh
gh pr list --repo revefi/rcode --limit 1   # should print one of your team's PRs
gt log short --no-interactive --classic | head -3   # should print stack tree
```

If both produce output without prompting for auth, you're set.

### 2. Configure environment variables

Add these to `~/.zshrc` (or your shell init file):

```sh
# Absolute path to your rcode checkout — wherever you cloned it.
export WORKSPACE_PATH=/path/to/your/rcode

# Atlassian credentials — power the Untouched Jira section, per-stack
# Jira chips, and ticket-title context. Get a token at
# https://id.atlassian.com/manage-profile/security/api-tokens.
export ATLASSIAN_EMAIL="you@revefi.com"
export ATLASSIAN_API_TOKEN="<token>"
```

Then `source ~/.zshrc` (or open a new terminal). The server fails fast at
startup if `WORKSPACE_PATH` is missing.

### 3. Run the server

```sh
cd ~/dashboard
node server.js
```

You should see:

```
Live dashboard listening on http://localhost:7787
Open in browser, or run:  open http://localhost:7787
Jira: configured
```

Open the URL in your browser. You're done.

### 4. (Optional) Auto-start on login

If you'd rather not run `node server.js` manually each day, wire it up via
launchd:

```sh
launchctl load   ~/Library/LaunchAgents/com.<you>.dashboard.plist   # start at login
launchctl unload ~/Library/LaunchAgents/com.<you>.dashboard.plist   # stop
launchctl list | grep dashboard                                     # status
launchctl kickstart -k gui/$(id -u)/com.<you>.dashboard              # hot restart
```

`KeepAlive=true` makes launchd auto-restart on crash with a 30s throttle. Logs
land at `/tmp/dashboard.log` and `/tmp/dashboard.err`.

`start.sh` is the launchd entry point. It pins a concrete `node` binary path
(asdf shims don't work under launchd's TCC profile) and sources the
`WORKSPACE_PATH` + `ATLASSIAN_*` exports from `~/.zshrc` via `grep + eval` —
no full zshrc source, so your oh-my-zsh setup is never loaded.

> **Why ~/dashboard/ and not ~/Desktop/?** macOS TCC blocks launchd from
> executing scripts inside `~/Desktop/`, `~/Documents/`, or `~/Downloads/`
> without an explicit Privacy & Security grant. The home directory has no such
> restriction.

After a `node` upgrade (`asdf install nodejs <new>`), update one line in
`start.sh` to point `NODE_BIN` at the new install path.

---

## Features

### Stack cards

Each open stack you own shows as one card, ordered by status priority (review
comments → ready to merge → blocked → awaiting review).

- **Default collapsed** — click the summary to expand. **Collapse all / Expand
  all** toggle in the header.
- **Always visible** even when collapsed: the index `#N`, name, top PR link,
  worktree, Jira chips, status pill, counts (created / approved / pending /
  changes-requested), total comment count, the ✓ Mark complete button,
  💻 `claude --resume <session>` copy, and 📝 markdown Remarks.
- **Per-PR CI rollup** in the expanded list: green `✓ checks` when all pass,
  red `✗ N failing` (with the failing check names in the tooltip), or amber
  `● running` while jobs are in progress. Suppressed for drafts.
- **Draft chip** — drafts show a single `📝 Draft` chip in place of the review
  pill, since "Needs review" is misleading on a PR that isn't ready yet.
- **Copy-branch button** (`⎘`) on every PR row — one-click clipboard copy of
  the branch name, briefly flips to ✓. Tooltip shows the full branch name.
  Auto-hidden on narrow widths (shows when viewport ≥ 1600px or the notepad is
  hidden).
- **One-click restack onto origin/main** — every stack's `main (trunk)` row
  shows how many commits its base is behind. If the stack has a worktree and
  isn't on top of someone else's PRs, an `↻ Restack` button appears. Click →
  confirm → the server runs `gt restack` + `gt submit --stack -u` in the
  worktree. Merge conflicts auto-abort, leaving branches unchanged.
- **Pre-flight conflict prediction** — `✓ mergeable` (green) or
  `✗ conflicts: <files>` (red, full list in tooltip). Computed via a read-only
  `git merge-tree --write-tree`. The Restack button is disabled when conflicts
  are predicted, so you find out before you click.
- **✎ Rename a stack** — pencil icon on hover. Persists in localStorage, takes
  priority over Claude-generated names, reflected in the sidebar nav.
- **Mark complete** moves the card to "Merged stacks" with a `git worktree
  remove` copy button.

### Untouched Jira

Tickets assigned to you that aren't attached to any open stack — the queue of
"things to start next."

- **Sprint filter dropdown** — defaults to "Current sprint" (most-active
  sprint, active state preferred). Switchable to All / No sprint / individual
  sprints.
- Per-row "working today" toggle, markdown remarks, type badge, sprint cell.
- **Remarks migration** — if you wrote a note for `REV-XXXX` in this table and
  later open a PR stack tagged with that key, the note migrates into the
  stack's Remarks (with a `↳ from REV-XXXX` annotation).

### Refresh model

| Trigger | What refreshes | Uses Claude? |
| --- | --- | --- |
| **↻ Refresh** / Auto (10m) | gh, gt, git, Jira REST | no |
| **🧠 Intelligent** | All of the above + wipes stack-name cache + regenerates recommendations | yes |
| **⟳ Generate** in the Action items section | Just the action items | yes |

The two timestamps in the header (`· Ns ago`, `· intel Nm ago`) tell you how
stale each side is.

### Markdown notepad + remarks

- Right-side scratchpad and every remarks field (per-stack, per-Jira-row) are
  full markdown — GFM via [`marked`](https://marked.js.org/).
- Click → textarea, autofocused, auto-resizing.
  Blur / Escape / Cmd+Enter to save.
- Edit-mode shortcuts: `Cmd/Ctrl+B`, `Cmd/Ctrl+I`, `Cmd/Ctrl+K` wrap the
  selection.
- **`📓 Hide notepad` toggle** in the header reclaims the third column for the
  main content when you need more horizontal space. Persists across reloads.

### Other niceties

- **Jira chips** on each stack — clickable "REV-XXXX — Title" pills.
- **Sidebar jump nav** — click any section or stack name to scroll into view
  (auto-expands the target card).
- **Stale worktree detection** with `git worktree remove` copy commands.
- **Resume session** — copies `claude --resume <session-id>` (or
  `cd worktree && claude --resume` for worktree-based sessions).

---

## Layout

Three sticky columns — header, sidebar, and notepad all stay in place while
the main column scrolls.

```
┌──────────────────────────────────────────────────────────────────┐
│  header  (title · ↻ Refresh · Auto · 🧠 Intelligent · timestamps)│ ← sticky
├──────────┬─────────────────────────────────────────┬─────────────┤
│ sidebar  │  main column                            │ notepad     │
│  · jump  │   · stat summary                        │  · markdown │
│    nav   │   · active stacks                       │    scratch  │
│  · stack │   · merged stacks                       │    pad      │
│    list  │   · untouched Jira (sprint-filtered)    │             │
│          │   · stale worktrees                     │             │
│          │   · action items                        │             │
└──────────┴─────────────────────────────────────────┴─────────────┘
```

Responsive: notepad drops at ≤1280px, sidebar drops at ≤900px (mobile).

---

## Technical reference

### HTTP endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /api/data` | The full dashboard model — stacks, untouched Jira, stale worktrees, totals. Server-cached for 30s. `?refresh=1` forces. `?intelligent=1` also wipes Claude-backed disk caches. |
| `GET /api/recommendations` | Claude-generated recommendation list (HTML `<li>`s). Disk-persisted indefinitely. `?refresh=1` regenerates. |
| `POST /api/restack` | One-click restack handler. Body: `{ stack_key }`. Runs `gt restack` + `gt submit --stack -u` in the stack's worktree. Refuses on dirty trees, predicted conflicts, upstream-PR stacks, or up-to-date stacks. |
| `GET /api/health` | Lightweight status — cache age, recs cache state, Jira-configured flag. |
| `GET /` + static | Serves `public/` — index, app.js, styles, `marked.min.js`, favicon. |

### Data sources

- `gt log short --no-interactive --classic` — stack tree
- `gh pr list` — open PRs (fetched without `--author`, filtered by your gh
  login client-side)
- `gh api repos/revefi/rcode/pulls?state=closed` — recent merges
- `gh api graphql` — **one** aliased GraphQL query per refresh fetches review
  threads + CI `statusCheckRollup` for every open user PR in a single
  round-trip (not one call per PR)
- `gh pr view <n>` — upstream PR metadata
- `git worktree list --porcelain` — worktrees
- `git fetch origin main --quiet` + `git rev-list --count` — per-stack
  "behind origin/main" measurement (read-only; never modifies branches)
- `git merge-tree --write-tree --name-only` — per-stack conflict prediction
  (read-only; writes loose objects, no refs)
- `~/.claude/projects/.../.jsonl` — session files (parallel grep-scored per
  stack)
- `revefi.atlassian.net/rest/api/3/...` — Jira tickets and search via REST
- `claude -p` — recommendations + stack name generation (only on 🧠 / ⟳ clicks)

Plain refresh ≈ 8s end-to-end. Most of that is GitHub's GraphQL response time
plus a few `gh` subprocess spawns.

### Caching

| Data | TTL | Invalidation |
| --- | --- | --- |
| `/api/data` | 30s in-memory | header **↻ Refresh** or auto-refresh tick |
| Stack names | disk, keyed by stack's sorted PR-set hash (auto-busts on PR change) | **🧠 Intelligent** click |
| `/api/recommendations` | disk, no expiry | **⟳ Generate** click |

Jira tickets and the Untouched Jira list have **no cache** — every plain
↻ Refresh fetches them fresh via direct REST (~50ms per ticket, ~200ms for
the search).

### Codebase guide

For architecture, file map, gotchas, performance notes, and "how to add a
feature" recipes — see [`CLAUDE.md`](./CLAUDE.md). It's written for both
humans and Claude Code, so you can drop in and ask Claude to make changes.
