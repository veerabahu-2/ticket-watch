# ticket-watch

Watches District for ticket booking to open on a configured list of movies
(Chennai), theatre by theatre, and pushes a phone notification via ntfy +
Telegram naming exactly which theatre(s) just opened.

Project folder:

```text
/Users/veerabahu/Library/CloudStorage/OneDrive-TalenticaSoftware(I)Pvt.Ltd/personal_projects/ticket-watch
```

## How it works

- `.github/workflows/poll.yml` runs `src/poll.js` on a schedule (every 7
  minutes) via GitHub Actions — independent of any local machine being on.
- `src/sources/district.js` fetches each movie's District page and parses
  the server-rendered `<script type="application/ld+json">` blocks. A movie
  page with open bookings has one `ScreeningEvent` block per showtime, each
  naming its theatre under `location`; a not-yet-open page has none. This
  was confirmed directly: an already-running movie returned 50 ScreeningEvent
  blocks across 41 distinct theatres, while both not-yet-released movies
  currently tracked return zero. (An earlier version tried
  `initialState.mdpV2.sessions` from District's `__NEXT_DATA__` blob, but
  that field turned out to be populated client-side after page load — even
  an already-open movie showed it empty on a plain fetch — so it was
  replaced with this structural signal.)
- BookMyShow is **not** auto-checked — its site returns a Cloudflare 403 to
  any non-browser request, confirmed by testing. Its link is included in
  every notification as a manual-check nudge instead, since both platforms
  typically open booking around the same time for a release like this.
- `state.json` tracks, per movie, the set of theatres already seen open
  (`district.knownTheatres`) so each theatre only triggers one notification,
  plus a consecutive-"unknown"-checks counter that fires a one-time "this
  might be broken, go check manually" alert if District's page structure
  changes underneath the script.
- Each poll checks every movie in `config.json`'s `movies` array. If a
  movie's newly-open theatres are found, they're batched into **one**
  notification per movie per poll (not one push per theatre) — otherwise a
  release opening city-wide in a single poll would fire dozens of pushes at
  once. A theatre that opens later, in a subsequent poll, gets its own
  separate notification.
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

`config.json` has a top-level `movies` array; each entry has `id`, `title`,
`city`, `district: { url, contentId }` (contentId is the numeric ID in the
District URL, e.g. `MV188681` → `188681`), and `bookmyshow: { url, note }`
for the manual-check link. `pollIntervalCron` and
`unknownStreakAlertThreshold` apply to every movie.

`state.json` is keyed by movie `id`, each holding
`district.knownTheatres` (theatre keys already notified), `unknownStreak`,
and `brokenAlertSent`.

To track a new movie: add an entry to `config.movies` and a matching
`"<id>": { "district": { "knownTheatres": [], "unknownStreak": 0, "brokenAlertSent": false } }`
entry to `state.json`.
