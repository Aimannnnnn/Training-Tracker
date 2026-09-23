// Import automatico delle corse da Strava.
//
// Chiavi e token vivono in strava.json accanto a server.js (gitignored, 0600).
// L'import riempie le sedute del piano giorno per giorno, senza mai toccare
// quello che l'utente ha scritto a mano: note, RPE, scarpa e "saltata" restano,
// e una seduta che ha gia' una distanza non viene sovrascritta.
const fs = require('fs');
const path = require('path');
const { planSlots, addDays } = require('./plan.js');

const CONF = path.join(__dirname, 'strava.json');
const API = 'https://www.strava.com/api/v3';
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
// Il primo giro parte dall'inizio del piano: le corse gia' ricostruite a mano
// (import del 25 ago e del 3 set) vengono riconosciute da alreadyLogged() e saltate.
const DEFAULT_SINCE = '2026-06-08';

function readConf() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch (e) { return {}; }
}
function writeConf(c) {
  fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });
}

function isConfigured() { const c = readConf(); return !!(c.clientId && c.clientSecret); }
function isConnected() { const c = readConf(); return !!(c.refresh_token); }
// Il giro automatico parte solo con autoSync:true in strava.json: il primo import
// si guarda prima in anteprima, poi si accende.
function autoSyncOn() { const c = readConf(); return !!(c.refresh_token && c.autoSync); }

function authorizeUrl(redirectUri, state) {
  const c = readConf();
  const q = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirectUri, response_type: 'code',
    approval_prompt: 'auto', scope: 'read,activity:read_all', state,
  });
  return 'https://www.strava.com/oauth/authorize?' + q;
}

async function tokenRequest(params) {
  const c = readConf();
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Strava token ' + r.status + ': ' + JSON.stringify(j.errors || j.message || j));
  return j;
}

async function exchangeCode(code, scope) {
  if (!String(scope || '').includes('activity:read')) {
    throw new Error("permesso 'activity:read_all' non concesso: senza, Strava non mostra le attivita'");
  }
  const j = await tokenRequest({ code, grant_type: 'authorization_code' });
  const c = readConf();
  Object.assign(c, {
    access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at,
    scope, athlete: j.athlete ? { id: j.athlete.id, name: `${j.athlete.firstname || ''} ${j.athlete.lastname || ''}`.trim() } : null,
    connectedAt: new Date().toISOString(),
  });
  writeConf(c);
  return c.athlete;
}

async function accessToken() {
  const c = readConf();
  if (!c.refresh_token) throw new Error('Strava non collegato');
  if (c.access_token && c.expires_at && c.expires_at - 300 > Date.now() / 1000) return c.access_token;
  const j = await tokenRequest({ refresh_token: c.refresh_token, grant_type: 'refresh_token' });
  Object.assign(c, { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at });
  writeConf(c);
  return c.access_token;
}

async function api(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + await accessToken() } });
  if (r.status === 429) throw new Error('limite richieste Strava raggiunto, riprova tra 15 minuti');
  if (!r.ok) throw new Error('Strava ' + p.split('?')[0] + ' -> ' + r.status);
  return r.json();
}

// ---- dalla corsa Strava alla seduta del piano ----

const num = v => Number(String(v || '').replace(',', '.')) || 0;
const hasData = e => e && num(e.dist) > 0;

function paceOf(meters, seconds) {
  const s = Math.round(seconds / (meters / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// start_date_local arriva come "2026-09-22T19:03:11Z": l'ora e' gia' locale
// nonostante la Z, quindi i primi 10 caratteri sono il giorno giusto.
const localDay = a => String(a.start_date_local).slice(0, 10);

// Una corsa gia' registrata a mano (anche in una seduta di un giorno vicino,
// capita di spostare un'uscita) non va importata una seconda volta.
function alreadyLogged(a, state, slots) {
  const km = a.distance / 1000, day = localDay(a);
  return slots.some(s => {
    const e = state[s.key];
    if (!hasData(e)) return false;
    if (e.stravaId === a.id) return true;
    const near = [addDays(day, -1), day, addDays(day, 1)].includes(s.date);
    return near && Math.abs(num(e.dist) - km) <= Math.max(0.3, km * 0.03);
  });
}

// La seduta dello stesso giorno se c'e'; altrimenti quella del giorno prima o
// dopo (un'uscita spostata di un giorno). Mai una seduta saltata o gia' piena,
// e il riposo solo come ultima scelta.
function pickSlot(a, state, slots, exactOnly) {
  const day = localDay(a);
  const free = s => { const e = state[s.key]; return !e || (!e.skipped && !hasData(e)); };
  for (const d of exactOnly ? [day] : [addDays(day, -1), addDays(day, 1)]) {
    const c = slots.filter(s => s.date === d && free(s));
    const best = c.find(s => s.type !== 'rest') || (d === day ? c[0] : null);
    if (best) return best;
  }
  return null;
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean); }
// Scarpa Strava -> scarpa del tracker per nome ("ASICS Novablast 6" -> shoe_novablast6).
// Il numero del modello deve coincidere, altrimenti NB5 e NB6 si confondono.
function matchShoe(gearName, shoes) {
  const g = norm(gearName);
  const digits = g.filter(t => /^\d+$/.test(t));
  let best = null, score = 0;
  for (const s of shoes || []) {
    if (s.retired) continue;
    const n = norm(s.name);
    if (digits.some(d => !n.includes(d))) continue;
    const sc = g.filter(t => n.includes(t)).length;
    if (sc > score) { best = s; score = sc; } else if (sc === score) best = null;
  }
  return score >= 2 ? best : null;
}

// Scarica le corse. Non scrive nulla: la scrittura la fa sync(), nello stesso giro
// sincrono in cui rilegge lo stato, cosi' nessun salvataggio dal browser puo'
// infilarsi in mezzo.
async function fetchRuns(sinceDay) {
  const after = Math.floor(new Date(sinceDay + 'T00:00:00Z').getTime() / 1000) - 86400;
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/athlete/activities?after=${after}&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all.filter(a => RUN_TYPES.has(a.sport_type || a.type) && a.distance > 0);
}

async function gearNames(runs) {
  const ids = [...new Set(runs.map(a => a.gear_id).filter(Boolean))];
  if (!ids.length) return {};
  const me = await api('/athlete');
  const map = {};
  for (const g of me.shoes || []) map[g.id] = g.name;
  return map;
}

// since: niente prima di questo giorno, ne' corse ne' sedute. Le settimane
// precedenti sono gia' state sistemate a mano e restano come sono.
function plan(runs, gear, state, trackerFile, since = '0000-00-00') {
  const slots = planSlots(trackerFile).filter(s => s.date >= since);
  runs = runs.filter(a => localDay(a) >= since);
  const work = { ...state };
  const imported = [], skipped = [], unmatched = [];
  const sorted = [...runs].sort((x, y) => String(x.start_date).localeCompare(String(y.start_date)));
  const todo = sorted.filter(a => {
    if (!alreadyLogged(a, work, slots)) return true;
    skipped.push({ id: a.id, day: localDay(a) });
    return false;
  });
  // Due giri: prima ogni corsa nel suo giorno esatto, poi le rimaste nel giorno
  // accanto. In un giro solo, un'uscita del giovedi' si prenderebbe la seduta del
  // venerdi' prima che arrivi la corsa del venerdi' vera.
  const place = (a, s) => {
    const info = { id: a.id, day: localDay(a), km: Math.round(a.distance / 10) / 100, name: a.name };
    const prev = work[s.key] || {};
    const shoe = prev.shoe || (a.gear_id && gear[a.gear_id] ? (matchShoe(gear[a.gear_id], state.shoes) || {}).id : '') || '';
    work[s.key] = {
      ...prev,
      dist: String(Math.round(a.distance / 10) / 100),
      pace: paceOf(a.distance, a.moving_time || a.elapsed_time),
      hrAvg: prev.hrAvg || (a.average_heartrate ? String(Math.round(a.average_heartrate)) : ''),
      hrMax: prev.hrMax || (a.max_heartrate ? String(Math.round(a.max_heartrate)) : ''),
      rpe: prev.rpe ?? null,
      notes: prev.notes || '',
      shoe,
      loggedAt: prev.loggedAt || new Date(a.start_date).toISOString(),
      source: 'strava', stravaId: a.id,
    };
    imported.push({ ...info, slot: s.key, planned: s.date, merged: !!state[s.key] });
  };
  const left = [];
  for (const a of todo) { const s = pickSlot(a, work, slots, true); if (s) place(a, s); else left.push(a); }
  for (const a of left) {
    const s = pickSlot(a, work, slots, false);
    if (s) place(a, s);
    else unmatched.push({ id: a.id, day: localDay(a), km: Math.round(a.distance / 10) / 100, name: a.name });
  }
  imported.sort((x, y) => x.day.localeCompare(y.day));
  return { work, imported, skipped, unmatched };
}

let running = null;
// readState/writeState sono quelle di server.js: un solo punto che tocca state.json.
async function sync({ readState, writeState, trackerFile, dryRun = false, since } = {}) {
  if (running) return running;
  running = (async () => {
    const c = readConf();
    const from = since || c.syncFrom || DEFAULT_SINCE;
    const runs = await fetchRuns(from);
    const gear = await gearNames(runs);
    // Da qui in poi tutto sincrono: rilettura, calcolo e scrittura senza pause.
    const state = JSON.parse(readState());
    const r = plan(runs, gear, state, trackerFile, from);
    if (!dryRun && r.imported.length) {
      r.work._rev = (Number(state._rev) || 0) + 1;
      writeState(JSON.stringify(r.work));
    }
    if (!dryRun) {
      const c2 = readConf();
      c2.lastSyncAt = new Date().toISOString();
      c2.lastResult = { imported: r.imported, unmatched: r.unmatched };
      // Le corse "di troppo" restano visibili finche' esistono, il resto e' storia.
      writeConf(c2);
    }
    return { ok: true, dryRun, from, found: runs.length, imported: r.imported, skipped: r.skipped.length, unmatched: r.unmatched };
  })();
  try { return await running; } finally { running = null; }
}

function status() {
  const c = readConf();
  return {
    configured: !!(c.clientId && c.clientSecret), connected: !!c.refresh_token,
    athlete: c.athlete || null, lastSyncAt: c.lastSyncAt || null,
    lastImported: (c.lastResult && c.lastResult.imported || []).length,
    unmatched: (c.lastResult && c.lastResult.unmatched) || [],
  };
}

// Un salvataggio dal browser manda TUTTO lo stato. Una scheda aperta da prima
// dell'ultimo import (il suo _rev e' piu' vecchio) cancellerebbe le corse appena
// arrivate: qui si rimettono, tenendo pero' note/RPE/scarpa scritte dall'utente.
// Con _rev aggiornato invece vince il browser, cosi' una cancellazione voluta resta.
function protectImports(incoming, disk) {
  const dRev = Number(disk._rev) || 0;
  if ((Number(incoming._rev) || 0) >= dRev) return incoming;
  for (const [k, e] of Object.entries(disk)) {
    if (!e || typeof e !== 'object' || !e.stravaId) continue;
    const inc = incoming[k];
    if (inc && inc.stravaId === e.stravaId) continue;
    incoming[k] = { ...e };
    if (inc) for (const f of ['notes', 'rpe', 'shoe']) if (inc[f] !== undefined && inc[f] !== '' && inc[f] !== null) incoming[k][f] = inc[f];
  }
  incoming._rev = dRev;
  return incoming;
}

module.exports = { isConfigured, isConnected, autoSyncOn, authorizeUrl, exchangeCode, sync, status, protectImports, matchShoe, plan };
