# Bay Club ball machine watch

Watches **Bay Club Santa Clara, Court 1 (the ball machine court)** for a contiguous
**1-hour opening** and sends a push notification via [ntfy](https://ntfy.sh).

- Checks every 20 minutes, 6:00am–2:00am Pacific (off 2–6am to save Actions minutes)
- Horizon: today + 3 days (the club's booking limit)
- Skips: Monday 7–9pm, Tuesday 9am–3pm
- Session token is cached between runs; a headless login only happens when it expires
- The same set of open slots is only pushed once (no repeat spam)
- Never books anything — alerts only

## One-time setup

1. **Phone**: install the ntfy app (iOS/Android), subscribe to the topic stored in the
   `NTFY_TOPIC` repo secret. Treat the topic name like a password — anyone who knows it
   can see/send these notifications.
2. **Secrets** (Settings → Secrets and variables → Actions, or `gh secret set`):
   - `BAYCLUB_USERNAME` — your Bay Club Connect member ID/username
   - `BAYCLUB_PASSWORD` — your Bay Club Connect password
   - `NTFY_TOPIC` — the ntfy topic name
3. **Test**: Actions tab → "Bay Club ball machine watch" → Run workflow.

## Notes

- Cron is UTC; when PST returns in November the window shifts an hour earlier locally
  (edit the cron in `.github/workflows/check.yml` if you care).
- GitHub disables schedules in repos with no activity for 60 days — any commit re-arms it.
- Usage: ~60 one-minute runs/day ≈ 1,860 min/month, under the 2,000 free minutes for
  private repos. Login runs take ~2–3 minutes but are rare thanks to the token cache.
