# ticket-watch

Watches for Jana Nayagan (Chennai) ticket booking to open on District, and
pushes a phone notification via ntfy + Telegram the moment it does.

Project folder:

```text
/Users/veerabahu/Library/CloudStorage/OneDrive-TalenticaSoftware(I)Pvt.Ltd/personal_projects/ticket-watch
```

## How it works

- `.github/workflows/poll.yml` runs `src/poll.js` on a schedule (every 7
  minutes) via GitHub Actions — independent of any local machine being on.
- `src/sources/district.js` fetches the District movie page and reads the
  embedded Next.js `__NEXT_DATA__` session data (`initialState.mdpV2.sessions`).
  That object is empty before booking opens and gets populated with real
  showtime entries once tickets go on sale — a structural signal, not text
  matching. If that data shape ever changes, it falls back to matching text
  indicators configured in `config.json`.
- BookMyShow is **not** auto-checked — its site returns a Cloudflare 403 to
  any non-browser request, confirmed by testing. Its link is included in
  every notification as a manual-check nudge instead, since both platforms
  typically open booking around the same time for a release like this.
- `state.json` tracks whether District was already open (to notify only
  once) and how many consecutive checks came back "unknown" (to send a
  one-time "this might be broken, go check manually" alert if the site
  structure changes underneath the script).
- Notifications go out on both ntfy and Telegram from the same run, via
  `src/notify.js`. Either channel failing doesn't block the other.

## Setup

1. Create a free ntfy.sh topic name (private/obscure string) — no account
   needed, just pick a topic and subscribe to it in the ntfy app.
2. Create a Telegram bot via @BotFather to get a bot token, then message the
   bot once and use `https://api.telegram.org/bot<TOKEN>/getUpdates` to read
   back your chat ID.
3. Set repository secrets: `NTFY_TOPIC`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`.
4. The scheduled workflow runs automatically once pushed. Trigger a manual
   run from the Actions tab (`workflow_dispatch`) to test end to end.

## Run locally

```bash
node src/poll.js
```

Reads/writes `config.json` and `state.json` in the project root. No env vars
set means notifications are skipped with a warning (safe to dry-run).

## Config

`config.json` holds the movie, city, District URL + `contentId` (the numeric
ID in the District URL, e.g. `MV188681` → `188681`), the poll cron, text
fallback indicators, and the unknown-streak threshold before a
"check might be broken" alert fires.
