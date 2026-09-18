#!/usr/bin/env node
/**
 * Genera le icone della PWA del tracker.
 *
 * Nessuna dipendenza: né Pillow né ImageMagick sono installati, qui o sul Pi,
 * ma Node c'è in entrambi i posti (è quello che fa girare il tracker). Il PNG
 * viene scritto a mano — IHDR + IDAT sgonfiato con lo zlib di Node + IEND — e
 * il disegno è vettoriale, valutato per pixel con una distanza dal segmento,
 * quindi scala a qualunque dimensione senza sgranare.
 *
 *   node icons/make-icons.js
 *
 * Rigenerare solo se si cambiano colori o forma: i PNG sono committati.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// La palette vera del tracker, presa da :root in tracker.html.
const BG = [0x0d, 0x0f, 0x0e];
const ACCENT = [0xc8, 0xf0, 0x60];

// ---------------------------------------------------------------- PNG

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgb: Buffer di size*size*3, senza canale alfa — le icone sono piene. */
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type 2 = truecolor RGB
  // 10,11,12 = compression/filter/interlace, tutti 0

  // Ogni scanline è preceduta dal byte del filtro. Filtro 0 = nessuno:
  // le icone sono grandi campiture piatte, zlib le comprime lo stesso bene.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- disegno

/** Distanza dal punto (px,py) al segmento (ax,ay)-(bx,by). */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Una V di chevron sull'accento.
 *
 * @param size   lato in pixel
 * @param inset  quanto la V sta dentro il quadrato (0.62 normale, 0.46 maskable:
 *               le icone maskable vengono ritagliate, e solo il 40% centrale del
 *               lato è garantito visibile su tutte le maschere di Android)
 */
function drawIcon(size, inset) {
  const rgb = Buffer.alloc(size * size * 3);
  const c = size / 2;
  const half = (size * inset) / 2;

  // I tre vertici della V, in coordinate assolute.
  const ax = c - half,        ay = c - half * 0.78;
  const bx = c,               by = c + half * 0.86;
  const dx2 = c + half,       dy2 = c - half * 0.78;

  const stroke = size * inset * 0.20;   // spessore del tratto
  const r = stroke / 2;
  const aa = size / 256;                // ampiezza della sfumatura di bordo

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = Math.min(
        distToSegment(px, py, ax, ay, bx, by),
        distToSegment(px, py, bx, by, dx2, dy2)
      );
      // 1 dentro il tratto, 0 fuori, sfumato su una banda larga 2*aa.
      let cov = (r + aa - d) / (2 * aa);
      cov = Math.max(0, Math.min(1, cov));

      const [rr, gg, bb] = cov === 0 ? BG : mix(BG, ACCENT, cov);
      const o = (y * size + x) * 3;
      rgb[o] = rr; rgb[o + 1] = gg; rgb[o + 2] = bb;
    }
  }
  return rgb;
}

// ---------------------------------------------------------------- main

const OUT = __dirname;
const targets = [
  { file: 'icon-180.png', size: 180, inset: 0.62 },   // apple-touch-icon
  { file: 'icon-192.png', size: 192, inset: 0.62 },
  { file: 'icon-512.png', size: 512, inset: 0.62 },
  { file: 'icon-512-maskable.png', size: 512, inset: 0.46 },
];

for (const t of targets) {
  const png = encodePng(t.size, drawIcon(t.size, t.inset));
  fs.writeFileSync(path.join(OUT, t.file), png);
  console.log(`${t.file.padEnd(24)} ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
