#!/bin/bash
# Local fast-path poller, started by launchd every 2 minutes.
# Runs in its own clone (~/ticket-watch-runner) and shares state.json with the
# GitHub workflow through git, so each theatre is notified only once.
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.." || exit 1

ENV_FILE="$HOME/.config/ticket-watch/env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  TELEGRAM_BOT_TOKEN="$(security find-generic-password -s TELEGRAM_BOT_TOKEN -w 2>/dev/null)"
fi
export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID NTFY_TOPIC
export REQUIRE_TELEGRAM=true

git pull -q --rebase --autostash || echo "git pull failed; polling with local state"

node src/poll.js || exit 1

if [ -n "$(git status --porcelain state.json)" ]; then
  git add state.json
  git commit -q -m "chore: update state (local) [skip ci]"
  git push -q || { git pull -q --rebase && git push -q; } || echo "git push failed; will retry next run"
fi
