// Bay Club Santa Clara — Court 1 (ball machine) 1-hour availability watcher.
// Runs in GitHub Actions. Two modes:
//   node check.js --try-cached : use cached API headers; if missing/expired, signal need_login
//   node check.js --login      : headless login via Playwright, capture headers, then check
//
// Two alert categories, both >=60 min contiguous free, horizon today +3 days
// (the club's daysAheadLimit), both skipping the user's busy blocks
// (Monday 7-9pm, Tuesday 9am-3pm Pacific):
//   1. Court 1 (ballMachine=true) -- any time of day.
//   2. Every other court -- evenings only, the hour must sit at/after 7pm.
// Notifies via ntfy.sh push. Dedup is per individual slot, so a change on one
// court never re-pushes the slots you were already told about.

process.env.TZ = 'America/Los_Angeles';

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '.state');
const HEADERS_FILE = path.join(STATE_DIR, 'headers.json');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const CLUB = '3bc78448-ec6b-49e1-a2ae-64abd68e646b'; // Bay Club Santa Clara
const QS =
  '&categoryCode=tennis&categoryOptionsId=51d556a3-ef65-4d50-a37a-8843d89b8aa0' +
  '&timeSlotId=37ef7bde-8580-48c3-aced-776ada7c2832&tennisCourtTypeCode=outdoor';
const apiUrl = (d) =>
  `https://connect-api.bayclubs.io/court-booking/api/1.0/courtsheet/${CLUB}/courts?date=${d}${QS}`;

const EVENING_START = 19 * 60; // other courts only count from 7pm on

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_EMAIL = process.env.NTFY_EMAIL; // optional: also forward each alert to this email
const NTFY_TOKEN = process.env.NTFY_TOKEN; // required by ntfy.sh for email forwarding

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function writeJson(f, v) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v));
}
function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

// Returns true only if ntfy accepted the push. Callers must not advance dedup
// state on a false return, or the alert is lost forever.
async function ntfy(title, body, priority = 'high') {
  if (!NTFY_TOPIC) { console.log('NTFY_TOPIC not set; would have sent:', title, body); return true; }
  const headers = { Title: title, Priority: priority, Tags: 'tennis' };
  // ntfy.sh rejects anonymous email sending with 400/40053, and that rejection
  // kills the phone push too. Only attach Email when we can authenticate.
  if (NTFY_TOKEN) {
    headers.Authorization = 'Bearer ' + NTFY_TOKEN;
    if (NTFY_EMAIL) headers.Email = NTFY_EMAIL;
  } else if (NTFY_EMAIL) {
    console.log('NTFY_EMAIL set but NTFY_TOKEN missing; sending push only (email needs an ntfy account).');
  }
  let r;
  try {
    r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, { method: 'POST', headers, body });
  } catch (e) {
    console.error('ntfy push FAILED (network):', e.message || e);
    return false;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('ntfy push FAILED:', r.status, detail.slice(0, 300));
    return false;
  }
  console.log('ntfy push:', r.status, title);
  return true;
}

function dateStr(dt) {
  return (
    dt.getFullYear() + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0')
  );
}
function fmt(m) {
  const hh = Math.floor(m / 60), mm = m % 60;
  const ap = hh >= 12 ? 'PM' : 'AM';
  const h12 = ((hh + 11) % 12) + 1;
  return h12 + ':' + String(mm).padStart(2, '0') + ap;
}

// Merge the API's 30-min availability entries into contiguous free ranges.
function freeRanges(court) {
  const free = (court.availability || [])
    .filter((s) => !s.unavailability)
    .map((s) => [s.fromInMinutes, s.toInMinutes])
    .sort((a, b) => a[0] - b[0]);
  const ranges = [];
  for (const [f, t] of free) {
    if (ranges.length && ranges[ranges.length - 1][1] === f) ranges[ranges.length - 1][1] = t;
    else ranges.push([f, t]);
  }
  return ranges;
}

// The user's standing commitments. Applied to every court, so e.g. a Monday
// 7:30pm opening on Court 5 is correctly ignored.
function applyExclusions(ranges, dow) {
  const excl = [];
  if (dow === 1) excl.push([19 * 60, 21 * 60]); // Monday 7-9pm
  if (dow === 2) excl.push([9 * 60, 15 * 60]);  // Tuesday 9am-3pm
  let usable = ranges;
  for (const [ef, et] of excl) {
    const next = [];
    for (const [f, t] of usable) {
      if (t <= ef || f >= et) { next.push([f, t]); continue; }
      if (f < ef) next.push([f, ef]);
      if (t > et) next.push([et, t]);
    }
    usable = next;
  }
  return usable;
}

// Bookable 1-hour windows: clipped to `notBefore` (7pm for non-ball-machine
// courts) and to now for today, snapped up to the 30-min booking grid, and
// only kept if a full hour still fits after that snapping.
function hourWindows(ranges, notBefore, nowMin) {
  const floor = Math.max(notBefore, nowMin);
  const out = [];
  for (const [f, t] of ranges) {
    const start = Math.ceil(Math.max(f, floor) / 30) * 30;
    if (t - start >= 60) out.push(fmt(start) + '-' + fmt(t));
  }
  return out;
}

// "TENNIS 1" and "Tennis 2" both come back from the API; normalise for display.
function courtName(c) {
  return String(c.name || '').trim().replace(/^tennis\b/i, 'Tennis');
}

// Returns {ok, loggedOut, ballMachine, evening, errors}
async function checkAvailability(headers) {
  const ballMachine = [], evening = [], errors = [];
  const now = new Date();
  for (let d = 0; d <= 3; d++) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const ds = dateStr(dt);
    let r;
    try {
      r = await fetch(apiUrl(ds), { headers });
    } catch (e) { errors.push(ds + ': ' + e); continue; }
    if (r.status === 401 || r.status === 403) return { ok: false, loggedOut: true };
    if (!r.ok) { errors.push(ds + ': HTTP ' + r.status); continue; }
    const j = await r.json();
    const items = j.items || [];
    if (!items.length) { errors.push(ds + ': no courts returned'); continue; }
    if (!items.some((c) => c.ballMachine)) errors.push(ds + ': no ball machine court');

    const dow = dt.getDay();
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
    const nowMin = d === 0 ? now.getHours() * 60 + now.getMinutes() : -1;

    for (const c of items) {
      const usable = applyExclusions(freeRanges(c), dow);
      // Court 1 is watched all day; every other court only from 7pm.
      const wins = hourWindows(usable, c.ballMachine ? 0 : EVENING_START, nowMin);
      if (!wins.length) continue;
      const bucket = c.ballMachine ? ballMachine : evening;
      bucket.push({ date: ds, day, court: courtName(c), windows: wins });
    }
  }
  return { ok: true, ballMachine, evening, errors };
}

// ---- dedup -----------------------------------------------------------------
// Keyed per slot (date|court|window) rather than on the whole result set: with
// nine courts in play a single booking elsewhere would otherwise re-push every
// slot you had already been told about.
function slotKeys(hit) {
  return hit.windows.map((w) => `${hit.date}|${hit.court}|${w}`);
}

function pickNew(hits, announced) {
  const fresh = [];
  for (const h of hits) {
    const windows = h.windows.filter((w) => !announced[`${h.date}|${h.court}|${w}`]);
    if (windows.length) fresh.push({ ...h, windows });
  }
  return fresh;
}

// One line per date: "Sat 09-13: Tennis 5 7:30PM-8:30PM, Tennis 7 8PM-9PM"
function formatHits(hits, withCourt) {
  const byDate = new Map();
  for (const h of hits) {
    if (!byDate.has(h.date)) byDate.set(h.date, { day: h.day, parts: [] });
    const label = withCourt ? h.court + ' ' : '';
    for (const w of h.windows) byDate.get(h.date).parts.push(label + w);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => `${v.day} ${date.slice(5)}: ${v.parts.join(', ')}`);
}

const BOOK_URL = 'https://bayclubconnect.com/racquet-sports/create-booking/' + CLUB;

async function notifyIfNew(result) {
  const state = readJson(STATE_FILE, {});
  // Drop slots for dates that have passed so the map cannot grow without bound.
  const today = dateStr(new Date());
  const announced = {};
  for (const [k, v] of Object.entries(state.announced || {})) {
    if (k.split('|')[0] >= today) announced[k] = v;
  }

  if (result.errors && result.errors.length) console.log('errors:', result.errors);

  const alerts = [
    {
      hits: pickNew(result.ballMachine, announced),
      title: 'Bay Club ball machine Court 1 AVAILABLE',
      withCourt: false,
      priority: 'high',
    },
    {
      hits: pickNew(result.evening, announced),
      title: 'Bay Club evening court AVAILABLE (7pm+)',
      withCourt: true,
      priority: 'default',
    },
  ];

  if (!alerts.some((a) => a.hits.length)) {
    const open = result.ballMachine.length + result.evening.length;
    console.log(open ? `Nothing new; ${open} known slot(s) still open.` : 'No qualifying windows. Quiet tick.');
  }

  let failed = false;
  for (const a of alerts) {
    if (!a.hits.length) continue;
    const lines = formatHits(a.hits, a.withCourt);
    const sent = await ntfy(a.title, lines.join('\n') + '\nBook: ' + BOOK_URL, a.priority);
    if (!sent) {
      // Leave these slots unmarked so the next run retries instead of
      // silently marking them as already announced.
      console.error('Alert NOT delivered; leaving state so the next run retries:', a.title);
      failed = true;
      continue;
    }
    for (const h of a.hits) for (const k of slotKeys(h)) announced[k] = true;
    console.log('Notified:', a.title, '|', lines.join(' | '));
  }

  state.announced = announced;
  delete state.lastHitsKey; // superseded by per-slot dedup
  state.loginFailNotified = false;
  writeJson(STATE_FILE, state);
  if (failed) process.exitCode = 1;
}

async function login() {
  const user = process.env.BAYCLUB_USERNAME, pass = process.env.BAYCLUB_PASSWORD;
  if (!user || !pass) throw new Error('BAYCLUB_USERNAME / BAYCLUB_PASSWORD secrets not set');
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let captured = null;
    page.on('request', (req) => {
      if (captured || !req.url().includes('connect-api.bayclubs.io')) return;
      const h = req.headers();
      if (h['authorization'] && h['ocp-apim-subscription-key']) {
        captured = {
          Accept: 'application/json',
          Authorization: h['authorization'],
          'Ocp-Apim-Subscription-Key': h['ocp-apim-subscription-key'],
        };
      }
    });
    await page.goto('https://bayclubconnect.com/account/login/connect?returnUrl=%2Fhome%2Fdashboard');
    await page.fill('input[placeholder*="Member ID" i]', user);
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("LOG IN")');
    // Wait for the app to make any authenticated API call
    const deadline = Date.now() + 45000;
    while (!captured && Date.now() < deadline) {
      if (page.url().includes('/account/login') && Date.now() > deadline - 30000) {
        // still on login page after 15s — probably bad credentials
        const err = await page.textContent('body').catch(() => '');
        if (/invalid|incorrect|wrong/i.test(err || '')) throw new Error('Login rejected (check credentials)');
      }
      await page.waitForTimeout(500);
    }
    if (!captured) {
      // nudge: booking page always triggers API calls
      await page.goto('https://bayclubconnect.com/racquet-sports/create-booking/' + CLUB);
      const d2 = Date.now() + 20000;
      while (!captured && Date.now() < d2) await page.waitForTimeout(500);
    }
    if (!captured) throw new Error('Logged in but could not capture API headers');
    writeJson(HEADERS_FILE, captured);
    console.log('Login OK, headers captured.');
    return captured;
  } finally {
    await browser.close();
  }
}

(async () => {
  const mode = process.argv[2] || '--try-cached';

  if (mode === '--try-cached') {
    const headers = readJson(HEADERS_FILE, null);
    if (!headers) { console.log('No cached headers.'); setOutput('need_login', 'true'); return; }
    const result = await checkAvailability(headers);
    if (result.loggedOut) { console.log('Cached session expired.'); setOutput('need_login', 'true'); return; }
    setOutput('need_login', 'false');
    await notifyIfNew(result);
    return;
  }

  if (mode === '--login') {
    let headers;
    try {
      headers = await login();
    } catch (e) {
      const state = readJson(STATE_FILE, {});
      if (!state.loginFailNotified) {
        const sent = await ntfy('Bay Club watcher: login FAILED', String(e.message || e) + ' — checks are paused until this is fixed.', 'high');
        if (sent) {
          state.loginFailNotified = true;
          writeJson(STATE_FILE, state);
        }
      }
      throw e;
    }
    const result = await checkAvailability(headers);
    if (result.loggedOut) throw new Error('Fresh login still rejected by API');
    await notifyIfNew(result);
    return;
  }

  throw new Error('Unknown mode: ' + mode);
})().catch((e) => { console.error(e); process.exit(1); });
