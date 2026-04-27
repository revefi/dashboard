# Live dashboard (personal)

Self-updating PR/stack dashboard. Polls `gt log`, `gh pr list`, Claude session
files, and Jira itself — no Claude tokens at runtime except for the explicit
🧠 Intelligent and ⟳ Generate buttons.

Lives outside the rcode repo so it has its own git history and isn't affected
by repo operations. The `REPO` / `SESSIONS_ROOT` constants in `server.js` point
back at rcode for shell calls.

## Run

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

## Features

- **Auto-refresh every 10 minutes** of stack/PR/Jira data (toggle in header).
  Auto-refresh **never** triggers Claude calls.
- **↻ Refresh** button forces a fresh data fetch (still no Claude).
- **⟳ Generate** in the Recommendations section calls `claude -p` to
  regenerate. Cached to disk in `cache/recommendations.json` so it survives
  restart. Auto-refresh leaves it alone — only the explicit click regenerates.
- **Mark stack complete** → moves to "Merged stacks" with a
  `git worktree remove` copy button.
- **Untouched Jira** table with per-row "working today" toggle + rich-text
  remarks (persisted in localStorage).
- **Per-stack remarks** (rich text, persisted in localStorage).
- **Jira chips** on each stack — clickable "REV-XXXX — Title" pills.
- **Stale worktree detection** with worktree-remove commands.

## Data sources

- `gt log short --no-interactive --classic` — stack tree
- `gh pr list` — open PRs (filtered to me, client-side)
- `gh api repos/revefi/rcode/pulls?state=closed` — recent merges
- `gh api graphql` — unresolved review threads per PR
- `gh pr view <n>` — upstream PR metadata
- `git worktree list --porcelain` — worktrees
- `~/.claude/projects/.../.jsonl` — session files (grep-scored per stack)
- `revefi.atlassian.net/rest/api/3/...` — Jira tickets and summaries
- `claude -p` — recommendations (manual trigger only)

## Caching

| Data                   | TTL                                            | Refresh trigger                |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| `/api/data`            | 30s server-side                                | header **↻ Refresh** or 10m    |
| Stack names            | disk, keyed by stack's PR set (auto-busts)     | **🧠 Intelligent** click       |
| `/api/recommendations` | disk-persisted forever                         | **⟳ Generate** click           |

Jira tickets and the Untouched Jira list have **no cache** — every plain
↻ Refresh fetches them fresh via direct REST (~50ms per ticket, ~200ms for the
search). They were cached for 12h in an earlier iteration; that cache was
removed once direct REST started working.

## Auto-start on login

Wired up via launchd. The plist invokes `start.sh`, which sources asdf (so the
`node` shim resolves under launchd's bare PATH) and pulls `ATLASSIAN_*` from
`~/.zshrc`. Both files live in this directory:

- `start.sh` — launchd wrapper script
- `~/Library/LaunchAgents/com.varun.dashboard.plist` — launchd job definition

To control it:

```sh
launchctl load   ~/Library/LaunchAgents/com.varun.dashboard.plist   # start
launchctl unload ~/Library/LaunchAgents/com.varun.dashboard.plist   # stop
launchctl list | grep dashboard                                      # status
```

`KeepAlive` is on, so launchd auto-restarts on crash (with a 30s throttle).
Logs at `/tmp/dashboard.log` and `/tmp/dashboard.err`.

> Note on location: the dashboard lives at `~/dashboard/` (not under
> `~/Desktop/`) because macOS TCC blocks launchd from executing scripts inside
> `~/Desktop/`, `~/Documents/`, or `~/Downloads/` without an explicit Privacy
> & Security grant. The home dir doesn't have that restriction.

## Notes

- Directory lives at `~/dashboard/`. Initialize it as its own git repo
  (`git init`) if you want history/backup.
- The `claude` CLI must be on `$PATH` for Recommendations to work. Uses your
  active Claude session for billing.
