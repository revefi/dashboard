#!/bin/bash
# Wrapper invoked by launchd. launchd doesn't inherit shell init, so we have to:
#   - pin a node binary directly (asdf shims fail under launchd's TCC profile —
#     it can't read ~/.tool-versions),
#   - set PATH so the server's child processes (`gt`, `gh`, `git`, `claude`,
#     `grep`, `jq`) resolve,
#   - pull ATLASSIAN_* and WORKSPACE_PATH from ~/.zshrc.

set -e

# Concrete tool paths. Update if you upgrade via asdf or move install location.
NODE_BIN="/Users/varun/.asdf/installs/nodejs/24.13.1/bin/node"
GH_DIR="/Users/varun/.asdf/installs/github-cli/2.86.0/bin"

# PATH for the server's shell-out calls. Order matters: prefer Homebrew over
# system. Includes Homebrew (gt, jq, git), gh's concrete asdf install dir,
# ~/.local/bin (where `claude` lives), and the system base.
export PATH="/opt/homebrew/bin:$GH_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Pull only the env vars we need (ATLASSIAN_*, WORKSPACE_PATH) from zshrc —
# no oh-my-zsh side effects, secrets stay where they already live (zshrc),
# not in this script.
eval "$(grep -E '^export (ATLASSIAN_|WORKSPACE_PATH=)' "$HOME/.zshrc")"

cd "$(dirname "$0")"
exec "$NODE_BIN" server.js
