#!/bin/bash
# Syncs state.json with origin/main without rebasing, so a conflict can never
# leave the clone stuck. The local file is merged into the remote one
# (union of knownTheatres), and with --push the result is committed and pushed.
# Usage: scripts/sync-state.sh [--push "commit message"]
set -uo pipefail

# Braces make bash read the whole file before running, because git reset
# may rewrite this file while it runs.
{
# git reset --hard discards local work, so only run in CI or the runner clone.
if [ -z "${CI:-}${TICKET_WATCH_RUNNER:-}" ]; then
  echo "sync-state.sh runs only in CI or the runner clone (TICKET_WATCH_RUNNER=1)"
  exit 1
fi

cd "$(dirname "$0")/.." || exit 1

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.merged"' EXIT

for attempt in 1 2 3 4 5; do
  cp state.json "$tmp"
  git fetch -q origin main || { echo "git fetch failed"; exit 1; }
  git reset -q --hard origin/main
  node scripts/merge-state.mjs "$tmp" state.json > "$tmp.merged" && mv "$tmp.merged" state.json

  if [ "${1:-}" != "--push" ] || [ -z "$(git status --porcelain state.json)" ]; then
    exit 0
  fi

  git add state.json
  git commit -q -m "${2:-chore: update state [skip ci]}"
  git push -q origin HEAD:main && exit 0
  echo "push rejected (attempt $attempt); retrying"
  sleep $((attempt * 2))
done

echo "git push failed after retries"
exit 1
exit
}
