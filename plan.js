// Legge il piano (PLAN_START + WEEKS) direttamente da tracker.html.
//
// Il piano vive dentro la pagina come letterale JavaScript ed e' li' che si
// modifica: tenerne una copia qui significherebbe due fonti che divergono (e'
// gia' successo: i giorni scritti a mano in server.js erano rimasti quelli di
// giugno). Lo valuta Node, lo stesso motore per cui e' scritto, con la stessa
// tecnica di ~/allenamento/estrai_piano.js.
const fs = require('fs');

let cache = { mtimeMs: -1, file: null, plan: null };

// Trova la fine del letterale camminando le parentesi quadre e saltando stringhe
// e commenti: un apostrofo in un commento ("dall'inizio") preso per stringa si
// mangerebbe meta' del piano.
function literalEnd(src, open) {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) return -1; continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j); if (j < 0) return -1; j++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      j++;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

function loadPlan(file) {
  const st = fs.statSync(file);
  if (cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.plan;
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/const\s+PLAN_START\s*=\s*new Date\('([0-9-]+)'\)/);
  const at = src.indexOf('const WEEKS');
  if (!m || at < 0) throw new Error('PLAN_START o WEEKS non trovati in ' + file);
  const open = src.indexOf('[', at);
  const end = literalEnd(src, open);
  if (end < 0) throw new Error('letterale WEEKS non chiuso');
  const weeks = eval(src.slice(open, end));
  const plan = { planStart: m[1], weeks };
  cache = { mtimeMs: st.mtimeMs, file, plan };
  return plan;
}

// Stessa aritmetica di getRunDate() nella pagina, ma restituita come giorno di
// calendario 'YYYY-MM-DD': confrontare stringhe evita ogni sorpresa di fuso.
const DAY_OFFSET = { 'Lunedì': 0, 'Martedì': 1, 'Mercoledì': 2, 'Giovedì': 3, 'Venerdì': 4, 'Sabato': 5, 'Domenica': 6 };
function addDays(ymd, n) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Tutte le sedute del piano, con chiave di stato e giorno di calendario.
function planSlots(file) {
  const { planStart, weeks } = loadPlan(file);
  const out = [];
  weeks.forEach((w, wi) => (w.runs || []).forEach((r, ri) => {
    out.push({
      key: `w${wi}_r${ri}`, weekIdx: wi, runIdx: ri,
      day: r.day, type: r.type, km: r.km,
      date: addDays(planStart, wi * 7 + (DAY_OFFSET[r.day] ?? 0)),
    });
  }));
  return out;
}

module.exports = { loadPlan, planSlots, addDays };
