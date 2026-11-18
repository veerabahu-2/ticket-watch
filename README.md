# ticket-watch

Watches District for ticket booking to open on a configured list of movies
(Chennai), theatre by theatre, and pushes a phone notification via ntfy +
Telegram naming exactly which theatre(s) just opened.

Avengers: Doomsday is currently tracked for Chennai. District
is checked automatically; use BookMyShow’s native **Interested** notification
for BookMyShow availability, because it blocks cloud polling with a CAPTCHA.

Project folder:

```text
/Users/veerabahu/Library/CloudStorage/OneDrive-TalenticaSoftware(I)Pvt.Ltd/personal_projects/ticket-watch
```

## Two pollers, one state

- **Mac fast path.** `scripts/local-run.sh` runs every 30 seconds through the
  launchd agent `~/Library/LaunchAgents/com.veerabahu.ticket-watch.plist`, in
  its own clone at `~/ticket-watch-runner` (outside OneDrive). It reads
  `TELEGRAM_CHAT_ID` (and optional `NTFY_TOPIC`) from
  `~/.config/ticket-watch/env` and the bot token from the keychain item
  `TELEGRAM_BOT_TOKEN`. Log: `~/Library/Logs/ticket-watch.log`. It runs only
  while the Mac is awake.
- **GitHub backup.** cron-job.org sends a `workflow_dispatch` to `poll.yml`
  every 3 minutes, which starts within seconds (GitHub's own `schedule` on
  this repo ran hours apart, so it is kept only as a last fallback). The repo
  is public so Actions minutes are free.
- Both pollers call `scripts/sync-state.sh`, which merges `state.json` with
  `origin/main` as a union of `knownTheatres` (via `scripts/merge-state.mjs`)
  and retries the push. It runs `git reset --hard`, so it refuses to run
  outside CI or the runner clone.
- Theatres are keyed as `cinema:<id>`, because District links the same cinema
  as `name-c/<id>` in JSON-LD and `name-CD<id>` on the rendered page.

The launchd agent `com.veerabahu.ticket-watch.awake` runs `caffeinate -s`, so
the Mac does not sleep while it is on power (a closed lid still sleeps unless
an external display is connected).

To stop the Mac poller: `launchctl bootout gui/$(id -u)/com.veerabahu.ticket-watch`.
To let the Mac sleep again: `launchctl bootout gui/$(id -u)/com.veerabahu.ticket-watch.awake`.

## How it works

- `.github/workflows/poll.yml` requests a run every 7 minutes via GitHub
  Actions — independent of any local machine being on. The schedule starts at
  minute 3 to avoid GitHub's highest-load time at the start of each hour.
  GitHub schedules are best-effort and can still be delayed or dropped.
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
- If District has not yet published the movie's individual Chennai page, the
  monitor discovers it from the Chennai movie catalogue on every poll. It
  begins theatre-level checking automatically once the page appears.
- If District blocks GitHub Actions directly, the monitor retries the same
  public District page through Jina Reader. This fallback only receives the
  public District URL and keeps the cloud monitor usable without credentials.
- BookMyShow is **not** auto-checked — its site returns a Cloudflare 403 to
  any non-browser request, confirmed by testing. Its link is included in
  every notification as a manual-check nudge instead, since both platforms
  typically open booking around the same time for a release like this.
- `state.json` tracks, per movie, the set of theatres already seen open
  (`district.knownTheatres`) so each theatre only triggers one notification,
  plus a consecutive-"unknown"-checks counter that fires a one-time "this
  might be broken, go check manually" alert if District's page structure
  changes underneath the script.
- Each poll checks every movie in `config.json`'s `movies` array and sends one
  notification per newly-opened theatre.
- Notifications go out on both ntfy and Telegram from the same run, via
  `src/notify.js`. Both channels are attempted independently. Any configured
  channel failure fails the poll so the theatre is not marked as notified and
  the next poll retries it. The GitHub workflow also requires both channels'
  secrets instead of silently skipping a channel when a secret is missing.

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

The District URL must be the city-specific showtimes URL, for example
`.../jana-nayagan-movie-tickets-in-chennai-MV188681`. Generic movie landing
URLs are rejected because they can look healthy while omitting all showtimes.

`state.json` is keyed by movie `id`, each holding
`district.knownTheatres` (theatre keys already notified), `unknownStreak`,
and `brokenAlertSent`.

To track a new movie: add an entry to `config.movies` and a matching
`"<id>": { "district": { "knownTheatres": [], "unknownStreak": 0, "brokenAlertSent": false } }`
entry to `state.json`.
