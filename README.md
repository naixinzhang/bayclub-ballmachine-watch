# Bay Club court watch

Watches **Bay Club Santa Clara** outdoor tennis courts for a contiguous **1-hour
opening** and sends a push notification via [ntfy](https://ntfy.sh). Never books
anything — alerts only.

## What counts as a hit

Defined by the `RULES` table at the top of `check.js`; each rule pushes under its
own title so they stay distinguishable on your phone.

| Rule | Courts | When | Priority |
| --- | --- | --- | --- |
| `ballmachine` | Court 1 (the only ball-machine court) | any time of day | high |
| `evening` | Courts 2–9 | 7pm → close | default |
| `weekend-morning` | Courts 2–9 | Sat & Sun, 8–11am | default |

- Horizon: today + 3 days (the club's booking limit).
- Free time is **clipped** to the rule's window, not discarded: 6:30–8:00pm alerts
  as `7:00PM-8:00PM`. By the same rule 10:30–11:30am does *not* qualify for the
  8–11am window — only 30 minutes of it lands inside.
- Starts snap up to the 30-minute booking grid, and the hour must still fit after
  snapping.
- Standing commitments are excluded from every rule: **Monday 7pm–close** and
  **Tuesday 9am–3pm**.
- Dedup is per slot (`date|court|window`), so one court changing never re-pushes
  the slots you were already told about.

## Reliability

Three independent layers, because this thing has failed quietly before:

1. **Session cache** — API headers are cached between runs; a headless Playwright
   login only happens when they expire.
2. **Failure alert** — any run that fails pushes a high-priority notice with a link
   to the run, throttled to one per 6 hours (a broken watcher fails every 15 min).
   A run that completes re-arms it.
3. **Heartbeat** — every successful run pings `HEALTHCHECK_URL`. This is the only
   layer that catches the watcher *never starting*, which is exactly what happened
   on 2026-09-01 when the Apps Script trigger silently wasn't created.

## Triggering

The real trigger is a **Google Apps Script** time-based trigger firing every 15
minutes (GitHub's free-tier cron gets throttled to a handful of runs per day). It
POSTs a `workflow_dispatch` to the GitHub API. The cron in `check.yml` remains as
a degraded backup.

## One-time setup

1. **Phone**: install the ntfy app, subscribe to the topic in the `NTFY_TOPIC`
   secret. Treat the topic name like a password — anyone who knows it can read and
   send these notifications.
2. **Secrets** (Settings → Secrets and variables → Actions, or `gh secret set NAME --body '...'`):
   | Secret | Required | Purpose |
   | --- | --- | --- |
   | `BAYCLUB_USERNAME` | yes | Bay Club Connect member ID |
   | `BAYCLUB_PASSWORD` | yes | Bay Club Connect password |
   | `NTFY_TOPIC` | yes | ntfy topic name |
   | `HEALTHCHECK_URL` | no | dead-man's switch ping URL (see below) |
   | `NTFY_TOKEN` | no | ntfy account token; required for email forwarding |
   | `NTFY_EMAIL` | no | address to also forward alerts to (needs `NTFY_TOKEN`) |

   Set secrets with `--body` or the web UI. An interactive `gh secret set` in a
   non-interactive shell silently stores an **empty** value.
3. **Test**: Actions tab → "Bay Club ball machine watch" → Run workflow.

> The workflow is still named *"ball machine watch"* from when that was all it
> did. Left alone deliberately: the Apps Script trigger dispatches this workflow,
> and a silently broken trigger is the exact failure this repo keeps getting
> bitten by. Rename only after confirming how the script addresses it.

### Enabling the heartbeat

Without `HEALTHCHECK_URL` the heartbeat step is skipped and everything else works
normally — but nothing will notice if the watcher stops running altogether.

1. Sign up at [healthchecks.io](https://healthchecks.io) (free tier is plenty).
2. New check → **Period 20 minutes**, **Grace 25 minutes**. That alerts roughly 45
   minutes after the pings stop, i.e. after ~3 missed 15-minute ticks.
3. Copy its ping URL and store it:
   `gh secret set HEALTHCHECK_URL --body 'https://hc-ping.com/<uuid>'`
4. Point the check's notification at the same ntfy topic so dead-man alerts land
   with everything else: in healthchecks.io add a **Webhook** integration,
   `POST https://ntfy.sh/<your-topic>` with body `Bay Club watcher has stopped running`.

## Notes

- Cron is UTC; when PST returns in November the backup window shifts an hour
  earlier locally.
- GitHub disables schedules in repos with no activity for 60 days — any commit
  re-arms it. The Apps Script trigger is unaffected.
- The repo is public, so Actions minutes are unmetered. All credentials live in
  secrets; nothing sensitive is committed.
- `checkAvailability` is driven by `RULES`, so adding a watch window means adding a
  rule, not editing the loop.
