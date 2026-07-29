// Static server + shared-state API + login for the Valencia marathon tracker.
// - Serves the live Desktop HTML on every non-API route (edits show up immediately).
// - Injects a small sync shim so progress is stored on THIS PC and shared across devices.
// - Simple single-user login (session cookie) protects both the page and the API.
// - GET  /api/state    -> returns the saved state JSON (or "{}")  [auth required]
// - POST /api/state    -> overwrites the saved state with the request body [auth required]
// - GET  /login        -> login form
// - POST /api/login    -> checks credentials, sets session cookie
// - POST /api/logout   -> clears session cookie
// - POST /api/log-run  -> auto-imports one run from the iOS Shortcuts automation,
//                         authenticated by a separate long-lived key (X-Log-Key
//                         header), not the browser session cookie.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// TRACKER_HTML lets each machine point at its own copy (e.g. a Desktop file that's
// edited by hand); falls back to the snapshot bundled in this repo so a fresh clone
// works out of the box.
const DESKTOP_FILE = path.join(os.homedir(), 'Desktop', 'valencia-marathon-tracker.html');
const FILE  = process.env.TRACKER_HTML || (fs.existsSync(DESKTOP_FILE) ? DESKTOP_FILE : path.join(__dirname, 'tracker.html'));
const STATE = path.join(__dirname, 'state.json');
const AUTH  = path.join(__dirname, 'auth.json');
const CREDENTIALS_OUT = path.join(__dirname, 'CREDENTIALS.txt');
const PORT  = process.env.PORT ? Number(process.env.PORT) : 8787;
const COOKIE_NAME = 'vsid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni

// Mirrors the plan structure in tracker.html (PLAN_START, WEEKS day pattern) so
// the server can map a run's calendar date to a (week, run) slot on its own,
// without parsing the HTML. Keep in sync if the weekly day pattern ever changes.
const PLAN_START = new Date('2026-06-09');
const TOTAL_WEEKS = 26;
const DAY_OFFSET = { 'Lunedì': -1, 'Martedì': 0, 'Mercoledì': 1, 'Giovedì': 2, 'Venerdì': 3, 'Sabato': 4, 'Domenica': 5 };
const WEEK_DAYS = (weekIdx) => weekIdx === 0 ? ['Martedì', 'Giovedì', 'Sabato'] : ['Lunedì', 'Martedì', 'Venerdì', 'Domenica'];
function runDateFor(weekIdx, dayName) {
  const d = new Date(PLAN_START);
  d.setDate(d.getDate() + weekIdx * 7 + (DAY_OFFSET[dayName] ?? 0));
  return d;
}
function sameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
// Finds the (week, run) slot whose scheduled day matches the given date, only
// considering weeks near "now" and slots not already logged, so a run on an
// unexpected weekday doesn't silently overwrite something else.
function findRunSlot(date, state) {
  const approxWeek = Math.max(0, Math.min(Math.floor((date - PLAN_START) / (7 * 86400000)), TOTAL_WEEKS - 1));
  for (const wi of [approxWeek, approxWeek - 1, approxWeek + 1]) {
    if (wi < 0 || wi >= TOTAL_WEEKS) continue;
    const days = WEEK_DAYS(wi);
    for (let ri = 0; ri < days.length; ri++) {
      if (sameCalendarDay(runDateFor(wi, days[ri]), date)) {
        const key = `w${wi}_r${ri}`;
        if (!state[key]) return { weekIdx: wi, runIdx: ri, key, day: days[ri] };
      }
    }
  }
  return null;
}

// ---- credentials ----
// auth.json holds a list of users, each with a role: 'admin' (read/write) or
// 'readonly' (view only — the server rejects their POST /api/state regardless
// of what the client sends). On first run (no auth.json yet), create one admin
// login: from AUTH_USERNAME/AUTH_PASSWORD env vars if set, otherwise a random
// password written once to CREDENTIALS.txt (gitignored — read it, note the
// password, then delete the file).
function bootstrapAuth() {
  if (!fs.existsSync(AUTH)) {
    const username = process.env.AUTH_USERNAME || 'aiman';
    const password = process.env.AUTH_PASSWORD || crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    fs.writeFileSync(AUTH, JSON.stringify({ users: [{ username, salt, hash, role: 'admin' }] }, null, 2));
    if (!process.env.AUTH_PASSWORD) {
      fs.writeFileSync(CREDENTIALS_OUT, `username: ${username}\npassword: ${password}\n(cancella questo file dopo averla salvata altrove)\n`);
      console.log('Credenziali generate — vedi ' + CREDENTIALS_OUT);
    }
  }
  // logKey authenticates the separate /api/log-run ingestion endpoint (used by
  // the iOS Shortcuts automation) — independent of the user login system.
  const auth = loadAuth();
  if (auth && !auth.logKey) {
    auth.logKey = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(AUTH, JSON.stringify(auth, null, 2));
    fs.appendFileSync(CREDENTIALS_OUT, `log-run key: ${auth.logKey}\n`);
    console.log('Chiave log-run generata — vedi ' + CREDENTIALS_OUT);
  }
}
bootstrapAuth();

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH, 'utf8')); } catch (e) { return null; }
}
function findUser(username) {
  const auth = loadAuth();
  if (!auth || !auth.users) return null;
  return auth.users.find(u => u.username === username) || null;
}
function checkPassword(username, password) {
  const user = findUser(username);
  if (!user) return null;
  const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
  // timing-safe compare
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return user;
}

// ---- sessions (in-memory; lost on server restart -> user logs in again) ----
const sessions = new Map(); // token -> {role, expires}
function newSession(role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function validSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const parts = header.split(';').map(s => s.trim());
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx > -1 && p.slice(0, idx) === name) return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

// Sync shim injected right after <body>. Runs BEFORE the app's own script, using a
// synchronous request so localStorage is populated before the tracker reads it.
// readonly is baked in server-side per session, so the client can hide edit
// controls — but the real enforcement is the server rejecting POST /api/state
// for readonly sessions regardless of what a client sends (see the handler below).
function buildShim(readonly) {
  return `<script>
window.IS_READONLY = ${readonly ? 'true' : 'false'};
(function(){
  var KEY='valencia_2026';
  function sGet(){try{var x=new XMLHttpRequest();x.open('GET','/api/state',false);x.send();if(x.status===200)return (x.responseText||'').trim();if(x.status===401){location.href='/login';}}catch(e){}return '';}
  function sPut(v){if(window.IS_READONLY)return;try{var p=new XMLHttpRequest();p.open('POST','/api/state',true);p.setRequestHeader('Content-Type','application/json');p.send(v);}catch(e){}}
  function empty(s){return !s||s==='null'||s==='{}';}
  var srv=sGet(), loc=localStorage.getItem(KEY);
  if(!empty(srv)){ localStorage.setItem(KEY,srv); }   // server wins when it has data
  else if(!empty(loc)){ sPut(loc); }                  // otherwise seed server from this device
  var _set=localStorage.setItem.bind(localStorage);
  localStorage.setItem=function(k,v){ _set(k,v); if(k===KEY) sPut(v); };  // mirror every save

  document.addEventListener('DOMContentLoaded', function(){
    if(window.IS_READONLY){
      var badge=document.createElement('div');
      badge.textContent='SOLA LETTURA';
      badge.style.cssText='position:fixed;bottom:14px;right:82px;z-index:2000;padding:7px 12px;background:rgba(240,160,48,0.12);border:1px solid rgba(240,160,48,0.3);border-radius:6px;color:#F0A030;font-size:10px;letter-spacing:0.06em;font-family:Inter,sans-serif;';
      document.body.appendChild(badge);
    }
    var b=document.createElement('button');
    b.textContent='Esci';
    b.style.cssText='position:fixed;bottom:14px;right:14px;z-index:2000;padding:7px 12px;background:#161918;border:1px solid rgba(255,255,255,0.11);border-radius:6px;color:#7A8078;font-size:11px;cursor:pointer;font-family:Inter,sans-serif;';
    b.onclick=function(){ fetch('/api/logout',{method:'POST'}).then(function(){ location.href='/login'; }); };
    document.body.appendChild(b);
  });
})();
</script>`;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - Valencia Tracker</title>
<style>
:root{--bg:#0D0F0E;--surface:#161918;--surface-raised:#1E2220;--accent:#C8F060;--text:#F0EDE6;--text-sec:#7A8078;--border:rgba(255,255,255,0.07);--danger:#E8614A;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Inter',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:2rem;width:100%;max-width:340px;}
h1{font-size:16px;margin-bottom:1.25rem;color:var(--text);}
label{font-size:12px;color:var(--text-sec);display:block;margin-bottom:5px;}
input{width:100%;background:var(--surface-raised);border:1px solid var(--border);border-radius:6px;padding:9px 10px;color:var(--text);font-size:14px;margin-bottom:1rem;outline:none;}
input:focus{border-color:rgba(200,240,96,0.3);}
button{width:100%;padding:10px;background:var(--accent);color:#0D0F0E;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;}
button:hover{opacity:0.9;}
.err{color:var(--danger);font-size:12px;margin-bottom:1rem;display:none;}
</style></head>
<body>
<div class="card">
  <h1>AIMAN &rarr; VALENCIA 2026</h1>
  <div class="err" id="err">Credenziali non valide.</div>
  <form id="f">
    <label>Username</label>
    <input id="u" name="username" autocomplete="username" autofocus>
    <label>Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit">Entra</button>
  </form>
</div>
<script>
document.getElementById('f').addEventListener('submit', function(e){
  e.preventDefault();
  fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
    username: document.getElementById('u').value,
    password: document.getElementById('p').value
  })}).then(function(r){
    if (r.ok) { location.href = '/'; }
    else { document.getElementById('err').style.display = 'block'; }
  });
});
</script>
</body></html>`;

function readState() {
  try { return fs.readFileSync(STATE, 'utf8') || '{}'; } catch (e) { return '{}'; }
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}; Path=/`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
}

http.createServer((req, res) => {
  const session = validSession(getCookie(req, COOKIE_NAME));

  if (req.url === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
    return;
  }

  if (req.url === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body || '{}');
        const user = checkPassword(username, password);
        if (user) {
          setSessionCookie(res, newSession(user.role));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
        }
      } catch (e) {
        res.writeHead(400); res.end('{"ok":false}');
      }
    });
    return;
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    const token = getCookie(req, COOKIE_NAME);
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (req.url === '/api/log-run' && req.method === 'POST') {
    const auth = loadAuth();
    const providedKey = req.headers['x-log-key'];
    const validKey = auth && auth.logKey && providedKey &&
      Buffer.byteLength(providedKey) === Buffer.byteLength(auth.logKey) &&
      crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(auth.logKey));
    if (!validKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"invalid log key"}');
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const distanceKm = Number(payload.distanceKm);
        const durationSec = Number(payload.durationSec);
        if (!distanceKm || !durationSec) throw new Error('distanceKm and durationSec are required');
        const date = payload.date ? new Date(payload.date) : new Date();
        if (isNaN(date.getTime())) throw new Error('invalid date');

        const state = JSON.parse(readState());
        const slot = findRunSlot(date, state);
        if (!slot) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"no matching empty slot found near this date"}');
          return;
        }

        const paceSec = durationSec / distanceKm;
        const pace = `${Math.floor(paceSec / 60)}:${String(Math.round(paceSec % 60)).padStart(2, '0')}`;
        state[slot.key] = {
          dist: String(Math.round(distanceKm * 100) / 100),
          pace,
          hrAvg: payload.hrAvg ? String(Math.round(payload.hrAvg)) : '',
          hrMax: payload.hrMax ? String(Math.round(payload.hrMax)) : '',
          rpe: null,
          notes: 'Auto-importato da Apple Health (Shortcuts).',
          shoe: '',
          loggedAt: date.toISOString()
        };
        fs.writeFileSync(STATE, JSON.stringify(state));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slot: slot.key, day: slot.day, week: slot.weekIdx + 1 }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Everything below requires a valid session.
  if (!session) {
    if (req.url.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"unauthorized"}');
    } else {
      res.writeHead(302, { Location: '/login' });
      res.end();
    }
    return;
  }

  if (req.url === '/api/state') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readState());
      return;
    }
    if (req.method === 'POST') {
      if (session.role === 'readonly') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"readonly"}');
        return;
      }
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on('end', () => {
        try {
          JSON.parse(body || '{}');           // validate before writing
          fs.writeFileSync(STATE, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400); res.end('{"ok":false}');
        }
      });
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  fs.readFile(FILE, 'utf8', (err, html) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Tracker file not found: ' + FILE); return; }
    const injected = html.replace('<body>', '<body>\n' + buildShim(session.role === 'readonly'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injected);
  });
}).listen(PORT, '127.0.0.1', () => console.log('Serving tracker + sync API on http://127.0.0.1:' + PORT));
