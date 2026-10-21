// Small helpers shared by every module. Coordinates follow the PDF convention:
// matrices are [a b c d e f] and points are row vectors, so p' = p × M.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const uid = (p = 'a') => p + Math.random().toString(36).slice(2, 9) + (Date.now() % 1e6).toString(36);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = n => { const v = Math.round(n * 1000) / 1000; return Object.is(v, -0) ? '0' : String(v); };
export const norm = r => ((Math.round(r / 90) * 90) % 360 + 360) % 360;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function hexToRgb(h) {
  h = String(h || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(a) {
  if (!a || !a.length) return null;
  let rgb = a;
  if (a.length === 1) rgb = [a[0], a[0], a[0]];
  if (a.length === 4) { const k = a[3]; rgb = [(1 - a[0]) * (1 - k), (1 - a[1]) * (1 - k), (1 - a[2]) * (1 - k)]; }
  if (rgb.length !== 3) return null;
  return '#' + rgb.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}
export const rgbOp = (hex, stroke) => hexToRgb(hex).map(fmt).join(' ') + (stroke ? ' RG' : ' rg');

export function bboxPts(p) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { x1 = Math.min(x1, p[i]); x2 = Math.max(x2, p[i]); y1 = Math.min(y1, p[i + 1]); y2 = Math.max(y2, p[i + 1]); }
  return [x1, y1, x2, y2];
}
export const inflate = (b, d) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
export const normBox = (a, b, c, d) => [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
export const boxesIntersect = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
export const inBox = (b, x, y, t = 0) => x >= b[0] - t && x <= b[2] + t && y >= b[1] - t && y <= b[3] + t;
export function userError(msg) { const e = new Error(msg); e.user = true; return e; }

/* ---------- matrices ---------- */
export const IDENT = [1, 0, 0, 1, 0, 0];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];
export function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return IDENT.slice();
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export const translateM = (x, y) => [1, 0, 0, 1, x, y];
export function rotateM(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0].map(v => Math.abs(v) < 1e-12 ? 0 : v); }
export function boxOfMatrix(m) { // bounding box of the unit square mapped by m
  const p = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)].flat();
  return bboxPts(p);
}
export const mStr = m => m.map(fmt).join(' ');

/* ---------- a viewport that matches pdf.js PageViewport for any box ---------- */
export function makeViewport(box, scale, rotation) {
  const [x1, y1, x2, y2] = box, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const rot = norm(rotation);
  let A, B, C, D;
  switch (rot) {
    case 180: A = -1; B = 0; C = 0; D = 1; break;
    case 90: A = 0; B = 1; C = 1; D = 0; break;
    case 270: A = 0; B = -1; C = -1; D = 0; break;
    default: A = 1; B = 0; C = 0; D = -1;
  }
  let ox, oy, width, height;
  if (A === 0) { ox = Math.abs(cy - y1) * scale; oy = Math.abs(cx - x1) * scale; width = (y2 - y1) * scale; height = (x2 - x1) * scale; }
  else { ox = Math.abs(cx - x1) * scale; oy = Math.abs(cy - y1) * scale; width = (x2 - x1) * scale; height = (y2 - y1) * scale; }
  const transform = [A * scale, B * scale, C * scale, D * scale, ox - A * scale * cx - C * scale * cy, oy - B * scale * cx - D * scale * cy];
  const invT = inv(transform);
  return {
    box, scale, rotation: rot, width, height, transform,
    convertToViewportPoint: (x, y) => apply(transform, x, y),
    convertToPdfPoint: (x, y) => apply(invT, x, y),
  };
}

/* ---------- files ---------- */
export function crc32(bytes) {
  let table = crc32.t;
  if (!table) { table = crc32.t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// Minimal ZIP writer (stored, no compression): PDFs are already compressed.
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
export const safeName = s => String(s || 'documento').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'documento';
export function parseRanges(spec, max) { // "1-3, 5, 8-" -> [[0,1,2],[4],[7..max-1]]
  const out = [];
  for (const part of String(spec).split(/[,;]+/)) {
    const t = part.trim(); if (!t) continue;
    const m = t.match(/^(\d*)\s*-\s*(\d*)$/);
    let a, b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : max; }
    else if (/^\d+$/.test(t)) { a = b = +t; }
    else return null;
    if (a < 1 || b > max || a > b) return null;
    const r = []; for (let i = a; i <= b; i++) r.push(i - 1); out.push(r);
  }
  return out.length ? out : null;
}
