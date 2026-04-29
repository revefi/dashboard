# Live dashboard (personal)

Self-updating PR/stack dashboard. Polls `gt log`, `gh pr list`, Claude session
files, and Jira itself — no Claude tokens at runtime except for the explicit
🧠 Intelligent and ⟳ Generate buttons.

Lives at `~/dashboard/` with its own private GitHub repo
(<https://github.com/varunpatil-rvf/dashboard>). The `REPO` / `SESSIONS_ROOT`
constants at the top of `server.js` point back at rcode for shell calls.

## Run

Auto-starts at login under launchd. To start manually:

```sh
cd ~/dashboard
node server.js
# Then open http://localhost:7787
```

## One-time setup (Jira)

The server reads two env vars from your shell. Set them in `~/.zshrc` (or
equivalent) so every shell session and the dashboard pick them up:

```sh
export ATLASSIAN_EMAIL="you@revefi.com"
export ATLASSIAN_API_TOKEN="<token>"
```

Get a token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
Then `source ~/.zshrc` (or open a new terminal) and start the server.

Without these vars the dashboard still works — Jira chips and the Untouched
Jira section just won't populate. Recommendations still work without Jira.

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
│          │   · recommendations                     │             │
└──────────┴─────────────────────────────────────────┴─────────────┘
```

Responsive: notepad drops at ≤1280px, sidebar drops at ≤900px (mobile).

## Features

### Stack cards
- **Default collapsed** — click summary to expand. **Collapse all / Expand all**
  toggle in the header.
- Always-visible header: `#N` index, name, top PR link, worktree, Jira chips,
  status pill, counts (created / approved / pending / changes-requested),
  total comments (`💬 12 comments` — red if any human comments).
- **Per-PR CI rollup** in the expanded list: green `✓ checks` when all pass,
  red `✗ N failing` (with the failing check names in the tooltip), or amber
  `● running` while jobs are in progress. Suppressed for drafts. Pulled from
  GitHub's `statusCheckRollup` in the same bulk GraphQL request as the
  review-thread counts, so it costs nothing extra.
- **Copy-branch button** (`⎘`) on every PR row — one-click clipboard copy of
  the branch name, briefly flips to ✓ on success. Tooltip shows the full
  branch name on hover. Auto-hidden on narrow widths (shows only when
  viewport ≥ 1600px or the notepad is hidden) to keep the row uncluttered.
- **Draft chip** — drafts show a single `📝 Draft` chip in place of the
  review pill (which would otherwise misleadingly say "Needs review" on a
  PR that isn't ready yet).
- Always-visible body: ✓ Mark complete button, 💻 `cldr <session>` resume copy,
  📝 markdown Remarks.
- Expand to see the per-PR list (with status, thread counts, draft markers)
  and any upstream PRs by other authors (collapsed by default).
- **✎ Rename a stack** — pencil icon on hover. Inline edit, persists in
  localStorage, takes priority over Claude-generated names. Reflected in the
  sidebar nav too.
- **Mark complete** → moves to "Merged stacks" with a `git worktree remove`
  copy button.
- **One-click restack onto origin/main** — every stack card's `main (trunk)`
  row shows how many commits its base is behind `origin/main`. If the stack
  has a worktree and isn't built on someone else's PRs, an `↻ Restack` button
  appears next to the count. Click → confirm → spinner → the server runs
  `gt restack` in the worktree, then `gt submit --stack -u` to force-push
  (with-lease) the rebased branches. On merge conflict the rebase auto-aborts
  and your branches are unchanged; on push conflict the local restack stays
  and you retry the push manually. Hidden on stacks with upstream PRs (the
  count would be misleading there).
- **Pre-flight conflict prediction** — alongside the behind count, each stack
  shows `✓ mergeable` (green) or `✗ conflicts: <files>` (red, with the full
  list in the tooltip). Computed via `git merge-tree --write-tree` — a
  read-only in-memory 3-way merge against `origin/main`. When conflicts are
  predicted the Restack button is disabled and the server endpoint also
  refuses, so you find out before you click rather than from a half-aborted
  rebase.

### Untouched Jira
- Per-row "working today" toggle, markdown remarks, type badge, sprint cell.
- **Sprint filter dropdown** — defaults to "Current sprint" (the most-active
  sprint by ticket count, with active state preferred). Switchable to All / No
  sprint / individual sprints.
- **Remarks migration** — if you wrote a note for `REV-XXXX` in the Untouched
  table, then later a PR stack appears tagged with that key, the note migrates
  into the stack's Remarks (with a `↳ from REV-XXXX` annotation).

### Refresh model
- **Auto-refresh every 10 minutes** of stack/PR/Jira data (toggle in header).
  Never triggers Claude.
- **↻ Refresh** button — same as auto, on demand. Shows `· Ns ago` next to
  it.
- **🧠 Intelligent** — wipes stack-name cache and regenerates recommendations.
  Uses Claude. Shows `· intel Nm ago` so you know how stale that side is.
- **⟳ Generate** in the Recommendations section — regenerates only recs.

### Markdown notepad + remarks
- Right-side scratchpad and every remarks field (per-stack, per-Jira-row) are
  full markdown — GFM via [`marked`](https://marked.js.org/).
- Click → textarea with raw markdown, autofocused. Auto-resizes with content.
- Blur / Escape / Cmd+Enter → save + render.
- Edit-mode shortcuts: `Cmd/Ctrl+B`, `Cmd/Ctrl+I`, `Cmd/Ctrl+K` wrap the
  selection.
- Notepad persists at `dashboard.notepad` in localStorage.
- **`📓 Hide notepad` toggle** in the sticky header reclaims the third column
  for the main content when you need more horizontal space (e.g. wide tables
  in remarks). Persists across reloads.

### Other
- **Jira chips** on each stack — clickable "REV-XXXX — Title" pills.
- **Sidebar jump nav** — click any section or stack name to scroll into
  view (auto-expands the target card).
- **Stale worktree detection** with worktree-remove copy commands.
- **Resume session** — `cldr <session-id>` (or `cd worktree && cldr` if the
  session lived in a worktree).

## Data sources

- `gt log short --no-interactive --classic` — stack tree
- `gh pr list` — open PRs (fetched without `--author`, filtered client-side)
- `gh api repos/revefi/rcode/pulls?state=closed` — recent merges
- `gh api graphql` — review-thread counts for ALL open PRs in **one** aliased
  GraphQL query (one round-trip, not one per PR)
- `gh pr view <n>` — upstream PR metadata
- `git worktree list --porcelain` — worktrees
- `git fetch origin main --quiet` + `git rev-list --count` — per-stack
  "behind origin/main" measurement (read-only; never modifies branches)
- `git merge-tree --write-tree --name-only` — per-stack conflict prediction
  for the Restack button (read-only; writes loose objects but no refs)
- `~/.claude/projects/.../.jsonl` — session files (parallel grep-scored per stack)
- `revefi.atlassian.net/rest/api/3/...` — Jira tickets and search via REST
- `claude -p` — recommendations + stack name generation

Plain refresh end-to-end is ~8s. Most of that is the bulk GraphQL response
time and a few `gh` subprocess spawns.

## Caching

| Data                   | TTL                                            | Refresh trigger                |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| `/api/data`            | 30s server-side                                | header **↻ Refresh** or 10m    |
| Stack names            | disk, keyed by stack's PR set (auto-busts)     | **🧠 Intelligent** click       |
| `/api/recommendations` | disk-persisted forever                         | **⟳ Generate** click           |

Jira tickets and the Untouched Jira list have **no cache** — every plain
↻ Refresh fetches them fresh via direct REST (~50ms per ticket, ~200ms for
the search).

## Auto-start on login

Wired up via launchd. The plist invokes `start.sh`, which:
- Hardcodes the concrete `node` binary path (`~/.asdf/installs/nodejs/<ver>/bin/node`).
  asdf shims don't work because launchd's TCC profile blocks reads of
  `~/.tool-versions` and `~/.asdfrc`.
- Sets an explicit `PATH` covering `gt`, `gh`, `git`, `claude`, etc.
- Pulls `ATLASSIAN_*` exports from `~/.zshrc` via `grep + eval` (no full zshrc
  source — avoids oh-my-zsh side effects).

```sh
launchctl load   ~/Library/LaunchAgents/com.varun.dashboard.plist   # start
launchctl unload ~/Library/LaunchAgents/com.varun.dashboard.plist   # stop
launchctl list | grep dashboard                                      # status
launchctl kickstart -k gui/$(id -u)/com.varun.dashboard               # hot restart
```

`KeepAlive` is on, so launchd auto-restarts on crash (with a 30s throttle).
Logs at `/tmp/dashboard.log` and `/tmp/dashboard.err`.

> Note on location: the dashboard lives at `~/dashboard/` (not under
> `~/Desktop/`) because macOS TCC blocks launchd from executing scripts inside
> `~/Desktop/`, `~/Documents/`, or `~/Downloads/` without an explicit Privacy
> & Security grant. The home dir doesn't have that restriction.

## Notes

- The `claude` CLI must be on `$PATH` for stack name generation and
  Recommendations to work. Uses your active Claude session for billing.
- See `CLAUDE.md` for the full codebase guide (architecture, file map,
  caching model, gotchas, performance notes).
- After a `node` upgrade via `asdf install nodejs <new>`, edit one line in
  `start.sh` to point `NODE_BIN` at the new install path.
