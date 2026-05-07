#!/bin/bash
# Snapshot harness for the dashboard refactor.
#
#   tools/snapshot.sh init     capture current state into tmp/baseline/
#   tools/snapshot.sh check    capture current state into tmp/after/ and
#                              diff against tmp/baseline/. Exit non-zero if
#                              any structural diff appears.
#
# DOM snapshot is captured separately by the agent via Playwright MCP into
# tmp/<mode>/dom.html — this script only handles HTTP API capture.

set -euo pipefail

MODE="${1:-check}"
case "$MODE" in
  init) OUT="tmp/baseline" ;;
  check) OUT="tmp/after" ;;
  *) echo "usage: $0 {init|check}" >&2; exit 2 ;;
esac

DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL="${DASHBOARD_URL:-http://localhost:7787}"
FILTER="$DIR/tools/snapshot-filter.jq"
TARGET="$DIR/$OUT"

# Reset only the api/ dir; preserve dom.html (captured separately via
# Playwright MCP) and any other files an operator may have stashed there.
rm -rf "$TARGET/api"
mkdir -p "$TARGET/api"

if ! curl -sf "$URL/api/health" > /dev/null; then
  echo "ERROR: dashboard not reachable at $URL" >&2
  exit 1
fi

# Warm the in-memory cache so the second call is the canonical snapshot.
curl -sf "$URL/api/data" > /dev/null
curl -sf "$URL/api/data" | jq -S -f "$FILTER" > "$TARGET/api/data.json"
curl -sf "$URL/api/recommendations" | jq -S -f "$FILTER" > "$TARGET/api/recommendations.json"
curl -sf "$URL/api/health" | jq -S -f "$FILTER" > "$TARGET/api/health.json"

# /api/jira/transitions takes a real ticket key — pull one from the snapshot.
KEY="$(jq -r '.untouched_jira[0].key // empty' "$TARGET/api/data.json")"
if [[ -n "$KEY" ]]; then
  curl -sf "$URL/api/jira/transitions?key=$KEY" \
    | jq -S -f "$FILTER" \
    > "$TARGET/api/jira-transitions.json"
fi

# Static assets — captured for cross-check; obviously diff after the split.
curl -sf "$URL/" > "$TARGET/index.html"

echo "Captured $TARGET ($(find "$TARGET" -type f | wc -l | tr -d ' ') files)"

if [[ "$MODE" == "check" ]]; then
  BASELINE="$DIR/tmp/baseline"
  if [[ ! -d "$BASELINE" ]]; then
    echo "ERROR: no baseline at $BASELINE — run '$0 init' first" >&2
    exit 1
  fi
  echo
  echo "=== diff baseline → after (api only; index.html will diff post-split) ==="
  if diff -ur "$BASELINE/api" "$TARGET/api"; then
    echo "OK: no structural drift in API responses."
  else
    echo
    echo "FAIL: structural drift detected. Inspect the diff above." >&2
    exit 1
  fi
fi
