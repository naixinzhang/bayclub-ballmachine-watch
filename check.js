// Bay Club Santa Clara — Court 1 (ball machine) 1-hour availability watcher.
// Runs in GitHub Actions. Two modes:
//   node check.js --try-cached : use cached API headers; if missing/expired, signal need_login
//   node check.js --login      : headless login via Playwright, capture headers, then check
//
// Criteria: Court 1 (ballMachine=true) only, >=60 min contiguous free,
// excluding Monday 7-9pm and Tuesday 9am-3pm Pacific. Horizon: today +3 days
// (the club's daysAheadLimit). Notifies via ntfy.sh push, deduped so the same
// set of open slots is only pushed once.

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

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_EMAIL = process.env.NTFY_EMAIL; // optional: also forward each alert to this email

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

async function ntfy(title, body, priority = 'high') {
  if (!NTFY_TOPIC) { console.log('NTFY_TOPIC not set; would have sent:', title, body); return; }
  const headers = { Title: title, Priority: priority, Tags: 'tennis' };
  if (NTFY_EMAIL) headers.Email = NTFY_EMAIL;
  const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
    method: 'POST',
    headers,
    body,
  });
  console.log('ntfy push:', r.status, title);
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

// Returns {ok, loggedOut, hits, errors}
async function checkAvailability(headers) {
  const hits = [], errors = [];
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
    const c1 = (j.items || []).find((c) => c.ballMachine);
    if (!c1) { errors.push(ds + ': no ball machine court'); continue; }

    const free = (c1.availability || [])
      .filter((s) => !s.unavailability)
      .map((s) => [s.fromInMinutes, s.toInMinutes])
      .sort((a, b) => a[0] - b[0]);
    const ranges = [];
    for (const [f, t] of free) {
      if (ranges.length && ranges[ranges.length - 1][1] === f) ranges[ranges.length - 1][1] = t;
      else ranges.push([f, t]);
    }

    const dow = dt.getDay();
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

    const nowMin = d === 0 ? now.getHours() * 60 + now.getMinutes() : -1;
    const wins = usable
      .filter(([f, t]) => t - f >= 60 && t - Math.max(f, nowMin) >= 60)
      .map(([f, t]) => fmt(nowMin > f ? Math.ceil(nowMin / 30) * 30 : f) + '-' + fmt(t));
    if (wins.length) {
      hits.push({
        date: ds,
        day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
        windows: wins,
      });
    }
  }
  return { ok: true, hits, errors };
}

async function notifyIfNew(result) {
  const state = readJson(STATE_FILE, {});
  const key = JSON.stringify(result.hits);
  if (result.errors && result.errors.length) console.log('errors:', result.errors);
  if (result.hits.length === 0) {
    console.log('No 1-hour ball machine windows. Quiet tick.');
  } else if (key === state.lastHitsKey) {
    console.log('Slots unchanged since last notification; not re-pushing.', key);
  } else {
    const lines = result.hits.map((h) => `${h.day} ${h.date}: ${h.windows.join(', ')}`);
    await ntfy(
      'Bay Club ball machine Court 1 AVAILABLE',
      lines.join('\n') + '\nBook: https://bayclubconnect.com/racquet-sports/create-booking/' + CLUB
    );
    console.log('Notified:', lines.join(' | '));
  }
  state.lastHitsKey = key;
  state.loginFailNotified = false;
  writeJson(STATE_FILE, state);
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
        await ntfy('Bay Club watcher: login FAILED', String(e.message || e) + ' — checks are paused until this is fixed.', 'high');
        state.loginFailNotified = true;
        writeJson(STATE_FILE, state);
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
