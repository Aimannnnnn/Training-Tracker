// Static server + shared-state API + login for the Valencia marathon tracker.
// - Serves the live Desktop HTML on every non-API route (edits show up immediately).
// - Injects a small sync shim so progress is stored on THIS PC and shared across devices.
// - Simple single-user login (session cookie) protects both the page and the API.
// - GET  /api/state    -> returns the saved state JSON (or "{}")  [auth required]
// - POST /api/state    -> overwrites the saved state with the request body [auth required]
// - GET  /login        -> login form
// - POST /api/login    -> checks credentials, sets session cookie
// - POST /api/logout   -> clears session cookie
// - POST /api/health   -> ingests Apple Health exports from the Health Auto Export
//                         iOS app (same X-Log-Key); raw payloads land in health/.
// - POST /api/log-run  -> auto-imports one run from the iOS Shortcuts automation,
//                         authenticated by a separate long-lived key (X-Log-Key
//                         header), not the browser session cookie.
// - GET  /strava/connect, /strava/callback -> collegamento OAuth a Strava (admin)
// - GET  /api/strava/status, POST /api/strava/sync -> stato e import manuale;
//                         l'import gira anche da solo ogni 15 minuti (strava.js).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const strava = require('./strava.js');

// TRACKER_HTML lets each machine point at its own copy (e.g. a Desktop file that's
// edited by hand); falls back to the snapshot bundled in this repo so a fresh clone
// works out of the box.
const DESKTOP_FILE = path.join(os.homedir(), 'Desktop', 'valencia-marathon-tracker.html');
const FILE  = process.env.TRACKER_HTML || (fs.existsSync(DESKTOP_FILE) ? DESKTOP_FILE : path.join(__dirname, 'tracker.html'));
const STATE = path.join(__dirname, 'state.json');
const AUTH  = path.join(__dirname, 'auth.json');
const HEALTH_DIR = path.join(__dirname, 'health');
const CREDENTIALS_OUT = path.join(__dirname, 'CREDENTIALS.txt');
const PORT  = process.env.PORT ? Number(process.env.PORT) : 8787;
const COOKIE_NAME = 'vsid';

// I soli file serviti senza sessione: quelli che servono a iOS per trattare il
// tracker come un'app invece che come un segnalibro. Elenco chiuso e scritto a
// mano - nessuna cartella statica, quindi nessun modo di risalire il filesystem.
const ICONS = path.join(__dirname, 'icons');
const PUBLIC_ASSETS = {
  '/manifest.webmanifest':        { file: path.join(__dirname, 'manifest.webmanifest'), type: 'application/manifest+json; charset=utf-8' },
  '/icons/icon-180.png':          { file: path.join(ICONS, 'icon-180.png'),          type: 'image/png' },
  '/icons/icon-192.png':          { file: path.join(ICONS, 'icon-192.png'),          type: 'image/png' },
  '/icons/icon-512.png':          { file: path.join(ICONS, 'icon-512.png'),          type: 'image/png' },
  '/icons/icon-512-maskable.png': { file: path.join(ICONS, 'icon-512-maskable.png'), type: 'image/png' },
};

// Porta riservata all'accesso dal tailnet. Serve una porta SEPARATA, non un ramo dentro la
// stessa: la 8787 riceve anche il traffico pubblico via Funnel, e li' un estraneo potrebbe
// spedire l'header di identita' che si e' inventato. Su questa porta arriva solo cio' che
// Tailscale ha gia' autenticato, perche' e' esposta esclusivamente con "tailscale serve".
const TAILNET_PORT = process.env.TAILNET_PORT ? Number(process.env.TAILNET_PORT) : 8788;

// Chi puo' entrare senza password da li'. Vuoto = chiunque sia nel tailnet.
const TAILNET_USERS = (process.env.TAILNET_USERS || '')
  .split(',').map(u => u.trim().toLowerCase()).filter(Boolean);

// Tailscale aggiunge questo header quando fa da proxy per una richiesta del tailnet, dopo aver
// autenticato il dispositivo. Essere nel tailnet e' gia' il login: chiederne un altro sopra
// significa mettere una seconda serratura su una porta gia' chiusa a chiave.
function tailnetSession(req, trusted) {
  if (!trusted) return null;
  const login = (req.headers['tailscale-user-login'] || '').trim();
  if (!login) return null;
  if (TAILNET_USERS.length && !TAILNET_USERS.includes(login.toLowerCase())) {
    console.log('utente del tailnet rifiutato: ' + login);
    return null;
  }
  return { role: 'admin', expires: Date.now() + 60000, tailnet: login };
}
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

  var LG=(function(){try{return localStorage.getItem('valencia_lang')==='en'?'en':'it';}catch(e){return 'it';}})();

  document.addEventListener('DOMContentLoaded', function(){
    if(window.IS_READONLY){
      var badge=document.createElement('div');
      badge.textContent=(LG==='en'?'READ ONLY':'SOLA LETTURA');
      badge.style.cssText='position:fixed;bottom:14px;right:82px;z-index:2000;padding:7px 12px;background:rgba(240,160,48,0.12);border:1px solid rgba(240,160,48,0.3);border-radius:6px;color:#F0A030;font-size:10px;letter-spacing:0.06em;font-family:Inter,sans-serif;';
      document.body.appendChild(badge);
    }
    if(!window.IS_READONLY){
      // Strava: collega la prima volta, poi "sincronizza ora". Dopo un import si
      // ricarica la pagina, perche' il tracker legge lo stato solo all'avvio.
      var sv=document.createElement('button');
      var svCss='position:fixed;bottom:14px;right:82px;z-index:2000;padding:7px 12px;background:#161918;border:1px solid rgba(252,76,2,0.35);border-radius:6px;color:#FC4C02;font-size:11px;cursor:pointer;font-family:Inter,sans-serif;';
      sv.style.cssText=svCss;
      sv.textContent='Strava';
      function toast(msg){var t=document.createElement('div');t.textContent=msg;t.style.cssText='position:fixed;bottom:52px;right:14px;z-index:2001;max-width:320px;padding:9px 12px;background:#1E2220;border:1px solid rgba(255,255,255,0.11);border-radius:6px;color:#F0EDE6;font-size:12px;line-height:1.4;font-family:Inter,sans-serif;';document.body.appendChild(t);setTimeout(function(){t.remove();},7000);}
      var st=null;
      fetch('/api/strava/status').then(function(r){return r.json();}).then(function(s){
        st=s;
        if(!s.configured){sv.remove();return;}
        sv.textContent=s.connected?(LG==='en'?'Sync Strava':'Sincronizza Strava'):(LG==='en'?'Connect Strava':'Collega Strava');
        if(s.connected&&s.lastSyncAt){var d=new Date(s.lastSyncAt);sv.title=(LG==='en'?'Last sync ':'Ultimo controllo ')+d.toLocaleString(LG==='en'?'en-GB':'it-IT');}
      }).catch(function(){});
      sv.onclick=function(){
        if(st&&!st.connected){location.href='/strava/connect';return;}
        sv.disabled=true;sv.textContent='…';
        fetch('/api/strava/sync',{method:'POST'}).then(function(r){return r.json();}).then(function(r){
          if(!r.ok){toast('Strava: '+r.error);sv.disabled=false;sv.textContent='Strava';return;}
          var extra=r.unmatched.length?(LG==='en'?' · '+r.unmatched.length+' run(s) with no planned session that day':' · '+r.unmatched.length+' corse senza una seduta in quel giorno'):'';
          if(r.imported.length){sessionStorage.setItem('stravaMsg',(LG==='en'?'Imported ':'Importate ')+r.imported.length+(LG==='en'?' run(s)':' corse')+extra);location.reload();}
          else{toast((LG==='en'?'Nothing new':'Niente di nuovo')+extra);sv.disabled=false;sv.textContent=(LG==='en'?'Sync Strava':'Sincronizza Strava');}
        }).catch(function(){toast('Strava: errore di rete');sv.disabled=false;});
      };
      document.body.appendChild(sv);
      var q=new URLSearchParams(location.search).get('strava');
      if(q){history.replaceState(null,'','/');toast(q==='ok'?(LG==='en'?'Strava connected':'Strava collegato'):'Strava: '+q);}
      try{var m=sessionStorage.getItem('stravaMsg');if(m){sessionStorage.removeItem('stravaMsg');toast(m);}}catch(e){}
    }
    var b=document.createElement('button');
    b.textContent=(LG==='en'?'Log out':'Esci');
    b.style.cssText='position:fixed;bottom:14px;right:14px;z-index:2000;padding:7px 12px;background:#161918;border:1px solid rgba(255,255,255,0.11);border-radius:6px;color:#7A8078;font-size:11px;cursor:pointer;font-family:Inter,sans-serif;';
    b.onclick=function(){ fetch('/api/logout',{method:'POST'}).then(function(){ location.href='/login'; }); };
    document.body.appendChild(b);
  });
})();
</script>`;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Login - Valencia Tracker</title>
<!-- Gli stessi tag PWA di tracker.html, ripetuti qui perche' e' questa la pagina
     che iOS vede quando si aggiunge l'app alla schermata Home da disconnessi:
     start_url e' "/", che senza sessione redirige proprio su /login. Senza il
     manifest anche qui, l'installazione fatta da sloggati nasce come segnalibro. -->
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<meta name="theme-color" content="#0D0F0E">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Valencia">
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
  <div id="langrow" style="text-align:right;margin-bottom:0.75rem;"><select id="lg" style="width:auto;margin:0;padding:4px 6px;font-size:11px;background:var(--surface-raised);color:var(--text);border:1px solid var(--border);border-radius:6px;"><option value="it">IT · Italiano</option><option value="en">EN · English</option></select></div>
  <form id="f">
    <label>Username</label>
    <input id="u" name="username" autocomplete="username" autofocus>
    <label>Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password">
    <button type="submit" id="sb">Entra</button>
  </form>
</div>
<script>
(function(){
  var sel=document.getElementById('lg');
  function cur(){try{return localStorage.getItem('valencia_lang')==='en'?'en':'it';}catch(e){return 'it';}}
  function apply(L){
    document.documentElement.lang=L;
    document.getElementById('err').textContent = (L==='en')?'Invalid credentials.':'Credenziali non valide.';
    document.getElementById('sb').textContent  = (L==='en')?'Sign in':'Entra';
  }
  sel.value=cur(); apply(cur());
  sel.addEventListener('change', function(){
    try{localStorage.setItem('valencia_lang', sel.value);}catch(e){}
    apply(sel.value);
  });
})();
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

// ---- Strava ----
// L'indirizzo di ritorno dell'OAuth deve essere quello da cui l'utente e' partito:
// la sessione del tailnet (senza cookie) non esiste sull'URL pubblico, e viceversa.
// Strava controlla solo il dominio, quindi va bene anche con la porta :8446.
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://homeserver.tail098b53.ts.net';
function baseUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return /^(127\.|localhost)/.test(host) || !host ? PUBLIC_BASE : 'https://' + host;
}
const oauthStates = new Map(); // state -> scadenza, contro il CSRF sul callback
const stravaDeps = { readState, writeState: body => fs.writeFileSync(STATE, body), trackerFile: FILE };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function handleStrava(req, res, session) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/strava/status' && req.method === 'GET') {
    return sendJson(res, 200, strava.status());
  }
  if (session.role !== 'admin') return sendJson(res, 403, { ok: false, error: 'readonly' });

  if (url.pathname === '/strava/connect' && req.method === 'GET') {
    if (!strava.isConfigured()) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Manca strava.json con clientId e clientSecret.'); return; }
    const st = crypto.randomBytes(16).toString('hex');
    oauthStates.set(st, Date.now() + 10 * 60000);
    res.writeHead(302, { Location: strava.authorizeUrl(baseUrl(req) + '/strava/callback', st) });
    res.end();
    return;
  }
  if (url.pathname === '/strava/callback' && req.method === 'GET') {
    const st = url.searchParams.get('state');
    const exp = oauthStates.get(st);
    oauthStates.delete(st);
    const back = msg => { res.writeHead(302, { Location: '/?strava=' + encodeURIComponent(msg) }); res.end(); };
    if (!exp || exp < Date.now()) return back('errore: richiesta scaduta, riprova');
    if (url.searchParams.get('error')) return back('annullato');
    // Solo il collegamento: il primo import lo lancia il bottone (o il giro dei 15
    // minuti), cosi' prima si puo' guardare un'anteprima con sync({dryRun:true}).
    strava.exchangeCode(url.searchParams.get('code'), url.searchParams.get('scope'))
      .then(() => back('ok'))
      .catch(e => { console.log('[strava] ' + e.message); back('errore: ' + e.message); });
    return;
  }
  if (url.pathname === '/api/strava/sync' && req.method === 'POST') {
    strava.sync(stravaDeps)
      .then(r => sendJson(res, 200, r))
      .catch(e => sendJson(res, 502, { ok: false, error: e.message }));
    return;
  }
  res.writeHead(404); res.end();
}

// Controllo periodico: una richiesta ogni 15 minuti, lontanissima dai limiti di Strava.
setInterval(() => {
  if (!strava.autoSyncOn()) return;
  strava.sync(stravaDeps)
    .then(r => { if (r.imported.length) console.log('[strava] importate: ' + r.imported.map(i => i.day + ' ' + i.km + ' km -> ' + i.slot).join(', ')); })
    .catch(e => console.log('[strava] sync fallita: ' + e.message));
}, 15 * 60000).unref();

const handleRequest = (req, res, trustTailnet) => {
  const session = validSession(getCookie(req, COOKIE_NAME)) || tailnetSession(req, trustTailnet);

  // HEAD come GET: i controlli di stato (il siteMonitor di Homepage) usano HEAD.
  // Senza questo ramo un HEAD /login cadeva nel redirect qui sotto, che rimanda
  // a /login: un ciclo infinito, e il pallino del riquadro restava rosso.
  // Node scarta da solo il corpo di una risposta a HEAD.
  if (req.url === '/login' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
    return;
  }

  // Manifest e icone della PWA: SOPRA il controllo di sessione, di proposito.
  //
  // iOS chiede il manifest senza i cookie di sessione. Se cadesse nel redirect
  // verso /login riceverebbe un 302, e invece di segnalare un errore ripiegherebbe
  // in silenzio sull'icona-screenshot da segnalibro: la pagina si aprirebbe ancora
  // dentro Safari, con la barra degli indirizzi, e sembrerebbe che i meta tag non
  // funzionino. Qui dentro non c'e' nulla di privato - un nome, dei colori e una V.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const asset = PUBLIC_ASSETS[req.url.split('?')[0]];
    if (asset) {
      fs.readFile(asset.file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, {
          'Content-Type': asset.type,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(data);
      });
      return;
    }
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

  // POST /api/health -> ingestion of Apple Health data pushed by the
  // "Health Auto Export" iOS app (REST API automation). Same long-lived key as
  // /api/log-run. Payloads are stored raw under health/ ; each workout also gets
  // its own file so a single run can be analysed without loading the whole dump.
  // Deliberately does NOT write into state.json: the Shortcuts automation
  // already fills the run slots, and two writers would fight over the same slot.
  if (req.url === '/api/health' && req.method === 'POST') {
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
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 40e6) { req.destroy(); return; }   // Watch workouts are small; 40 MB is a generous ceiling.
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(HEALTH_DIR, 'payload-' + stamp + '.json'), JSON.stringify(payload));

        const workouts = (payload.data && payload.data.workouts) || payload.workouts || [];
        const saved = [];
        workouts.forEach((w, i) => {
          const name = String(w.name || w.workoutActivityType || 'workout');
          const start = new Date(w.start || w.startDate || Date.now());
          const day = isNaN(start.getTime()) ? stamp : start.toISOString().slice(0, 10);
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const file = 'workout-' + day + '-' + slug + '-' + (String(w.id || i).slice(0, 8)) + '.json';
          fs.writeFileSync(path.join(HEALTH_DIR, file), JSON.stringify(w));
          saved.push(file);
        });

        const metrics = (payload.data && payload.data.metrics) || payload.metrics || [];
        console.log('[health] ricevuto: ' + workouts.length + ' workout, ' + metrics.length + ' metriche (' + Math.round(size / 1024) + ' KB)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, workouts: saved.length, metrics: metrics.length }));
      } catch (e) {
        console.log('[health] errore: ' + e.message);
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

  if (req.url.startsWith('/strava/') || req.url.startsWith('/api/strava/')) {
    handleStrava(req, res, session);
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
          const incoming = JSON.parse(body || '{}');   // validate before writing
          const disk = JSON.parse(readState());
          fs.writeFileSync(STATE, JSON.stringify(strava.protectImports(incoming, disk)));
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
};

// Porta pubblica (via Funnel): login con utente e password, come sempre.
http.createServer((req, res) => handleRequest(req, res, false))
    .listen(PORT, '127.0.0.1', () => console.log('Tracker + API su http://127.0.0.1:' + PORT + ' (login richiesto)'));

// Porta del tailnet (via tailscale serve): l'identita' la garantisce Tailscale.
http.createServer((req, res) => handleRequest(req, res, true))
    .listen(TAILNET_PORT, '127.0.0.1', () => console.log('Accesso tailnet su http://127.0.0.1:' + TAILNET_PORT + ' (senza login)'));
