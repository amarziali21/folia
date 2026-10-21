// Metrics of the 14 standard PDF fonts (we use the 12 Latin ones). The same widths drive the on-screen
// layout and the content written into the file, so line breaks match exactly.
import { L } from './lib.js';

export const FAMILIES = { sans: 'Helvetica', serif: 'Times', mono: 'Courier' };
const NAMES = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};
export const CSS_FAMILY = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};
const metrics = new Map();
let encoder = null;

export async function initFonts() {
  const doc = await L.PDFDocument.create();
  for (const list of Object.values(NAMES)) for (const n of list) metrics.set(n, await doc.embedFont(n));
  encoder = metrics.get('Helvetica');
}
export function fontName(family = 'sans', bold = false, italic = false) {
  return NAMES[family in NAMES ? family : 'sans'][(bold ? 1 : 0) + (italic ? 2 : 0)];
}
export const fontOf = name => metrics.get(name) || metrics.get('Helvetica');
export function ascent(name) { const f = fontOf(name).embedder.font; return f.Ascender / 1000; }
export function descent(name) { const f = fontOf(name).embedder.font; return -f.Descender / 1000; }
export const measure = (name, s, size) => fontOf(name).widthOfTextAtSize(s, size);

const encOk = new Map();
export function canEnc(ch) {
  if (encOk.has(ch)) return encOk.get(ch);
  let ok = true; try { encoder.encodeText(ch); } catch { ok = false; }
  encOk.set(ch, ok); return ok;
}
const SUBST = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ', '…': '...', '•': '-' };
export function cleanText(t) {
  return Array.from(String(t || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    '))
    .map(c => c === '\n' || canEnc(c) ? c : (SUBST[c] && [...SUBST[c]].every(canEnc) ? SUBST[c] : '?')).join('');
}
export function hasUnsupported(t) { return Array.from(String(t || '')).some(c => c !== '\n' && c !== '\r' && c !== '\t' && !canEnc(c) && !SUBST[c]); }

function wrapPara(name, para, maxW, size) {
  const lines = []; let line = '';
  const w = s => measure(name, s, size);
  const breakLong = word => { let cur = ''; for (const ch of word) { if (cur && w(cur + ch) > maxW) { lines.push(cur); cur = ch; } else cur += ch; } return cur; };
  for (const tok of para.split(/(\s+)/)) {
    if (!tok) continue;
    if (w(line + tok) <= maxW) { line += tok; continue; }
    if (/^\s+$/.test(tok)) { lines.push(line); line = ''; continue; }
    if (line.trim()) lines.push(line.trimEnd());
    line = w(tok) > maxW ? breakLong(tok) : tok;
  }
  lines.push(line.trimEnd());
  return lines;
}
export function wrapText(name, text, maxW, size) {
  const out = [];
  for (const p of cleanText(text).split('\n')) out.push(...(p === '' ? [''] : wrapPara(name, p, maxW, size)));
  return out;
}
