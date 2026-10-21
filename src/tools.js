// Tools, pointer interaction, selection, inline editors and the properties strip.
import { $, $$, uid, clamp, esc, fmt, norm, bboxPts, inflate, normBox, inBox, boxesIntersect, apply, mul, inv, boxOfMatrix, rgbToHex, IDENT, rotateM } from './util.js';
import { S, PX, snapshot, pageOf, meta, srcKey, editsFor } from './state.js';
import {
  frame, rectFromAnchor, textLayout, fitText, contentLayout, contentBox, strokeSegs, ellipseSegs, arrowPts, NOTE_BUBBLE, NOTE_LINES,
  svgPath, quadPoly, quadLine, quadHeight, bbox, visualBox, mapPts, transformAnnot, translateAnnot, PAD, LEADING, BASE,
} from './geometry.js';
import { fontName, CSS_FAMILY, ascent, measure, hasUnsupported } from './fonts.js';
import { pageImages } from './content.js';
import { hfItems, wmItems, contentTextSVG, totalRot, displayBox } from './doctools.js';
import {
  views, thumbs, commit, pushUndo, setDirty, toast, modal, store, load, curView, scheduleVariant, variantState, stextCache,
  refreshOverlays, updateStatus, renderThumbOverlay, setThumbOverlay, rebuildThumbs,
} from './app.js';
import { drafts } from './panels.js';
import * as engine from './mupdf-client.js';

/* ------------------------------------------------------------ tool catalogue */
export const TOOL_TYPE = { text: 'text', highlight: 'highlight', underline: 'underline', strike: 'strike', ink: 'ink', note: 'note', rect: 'rect', ellipse: 'ellipse', line: 'line', arrow: 'line', image: 'stamp', sign: 'ink', link: 'link', redactarea: 'redact', redacttext: 'redact', edittext: 'ctext', editimage: 'cimage' };
export const TYPE_LABEL = { text: 'Text box', highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough', ink: 'Pen', note: 'Note', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', stamp: 'Image', link: 'Link' };
const PALETTE = ['#1a1a1a', '#d92d20', '#2346c4', '#13804b', '#e8790c', '#7a3fd1', '#ffffff'];
const HL_PALETTE = ['#ffd400', '#7ee081', '#7cc4ff', '#ff9ccc', '#ffb347'];
const DEF_BASE = {
  text: { color: '#1a1a1a', size: 12 },
  highlight: { color: '#ffd400', opacity: 1 },
  underline: { color: '#2346c4', opacity: 1 },
  strike: { color: '#d92d20', opacity: 1 },
  ink: { color: '#2346c4', width: 2, opacity: 1 },
  note: { color: '#f5b400' },
  rect: { color: '#d92d20', width: 2, opacity: 1, fill: null },
  ellipse: { color: '#d92d20', width: 2, opacity: 1, fill: null },
  line: { color: '#d92d20', width: 2, opacity: 1 },
  stamp: { opacity: 1 },
  link: { color: '#2346c4' },
  ctext: { family: 'sans', bold: false, italic: false, size: 12, color: '#1a1a1a' },
  redact: { fill: '#000000' },
};
export let DEF = structuredClone(DEF_BASE);
export function loadDefaults() {
  try { const saved = JSON.parse(load('folia.defaults') || 'null'); if (saved) for (const k of Object.keys(DEF)) Object.assign(DEF[k], saved[k] || {}); } catch { /* ignore */ }
}

/* ------------------------------------------------------------ model helpers */
export function newAnnot(type, pageId, props) {
  const d = DEF[type] || {};
  return { id: uid(), nm: uid('mg-'), pageId, type, color: d.color || '#000000', opacity: d.opacity ?? 1, contents: '', author: S.author, dirty: true, ...props };
}
const findAnnot = id => S.annots.find(a => a.id === id) || null;
const findEdit = id => S.edits.find(e => e.id === id) || null;
export function selected() {
  if (!S.sel) return null;
  const a = findAnnot(S.sel); if (a) return { kind: 'annot', a };
  const e = findEdit(S.sel); if (e) return { kind: 'edit', e };
  if (S.sel.startsWith('img:')) { const v = virtualImage(S.sel); if (v) return { kind: 'vimage', ...v }; }
  return null;
}
const pageIdOfEdit = e => S.pages.find(p => p.fileId === e.src && p.idx === e.idx)?.id;
const viewsOfSource = (fileId, idx) => S.pages.filter(p => p.fileId === fileId && p.idx === idx).map(p => views.get(p.id)).filter(Boolean);

/* ------------------------------------------------------------ page text (pdf.js) for highlighting, redaction and search */
// Lines of text with the box of every character. MuPDF gives exact glyph boxes; pdf.js is the fallback
// (it only knows where each run of text starts and ends, so character positions are estimated).
async function mupdfLines(page) {
  if (!(await engine.startEngine())) return null;
  const blocks = await pageBlocks(page);
  if (!blocks) return null;
  const lines = [];
  for (const b of blocks) for (const l of b.lines) {
    if (!l.chars?.length || Math.abs(l.dir[1]) > 1e-3 || l.dir[0] <= 0) continue;
    const chars = l.chars.map(ch => { const bb = bboxPts(ch.q); return { c: ch.c, x0: bb[0], x1: bb[2], y0: bb[1], y1: bb[3], base: ch.o[1], h: bb[3] - bb[1] }; });
    lines.push({ base: l.origin[1], h: chars[0].h, chars });
  }
  return lines;
}
export function ensureText(page) {
  const m = meta(page); if (m.text) return m.text;
  m.text = mupdfLines(page).catch(() => null).then(ml => ml && ml.length ? finishLines(m, ml) : pdfjsLines(m));
  return m.text;
}
function finishLines(m, lines) {
  lines.sort((a, b) => b.base - a.base || a.chars[0].x0 - b.chars[0].x0);
  for (const ln of lines) {
    ln.chars.sort((p, q) => p.x0 - q.x0);
    ln.str = ln.chars.map(c => c.c).join('');
    ln.x0 = ln.chars[0].x0; ln.x1 = ln.chars[ln.chars.length - 1].x1; ln.y0 = Math.min(...ln.chars.map(c => c.y0)); ln.y1 = Math.max(...ln.chars.map(c => c.y1));
  }
  m.textReady = lines; return lines;
}
function pdfjsLines(m) {
  return m.proxy.getTextContent().then(tc => {
    const chars = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || a <= 0) continue;
      const h = it.height || Math.abs(d) || 10, str = [...it.str], n = str.length, cw = it.width / n;
      for (let i = 0; i < n; i++) chars.push({ c: str[i], x0: e + i * cw, x1: e + (i + 1) * cw, y0: f - h * 0.24, y1: f + h * 0.88, base: f, h });
    }
    chars.sort((p, q) => (q.base - p.base) || (p.x0 - q.x0));
    const lines = [];
    for (const ch of chars) {
      let ln = lines[lines.length - 1];
      if (!ln || Math.abs(ln.base - ch.base) > Math.min(ln.h, ch.h) * 0.5) { ln = { base: ch.base, h: ch.h, chars: [] }; lines.push(ln); }
      ln.chars.push(ch);
    }
    for (const ln of lines) {
      ln.chars.sort((p, q) => p.x0 - q.x0);
      // insert spaces where the gap between glyphs is wide (pdf.js often omits them)
      const out = [];
      for (const ch of ln.chars) { const prev = out[out.length - 1]; if (prev && prev.c !== ' ' && ch.c !== ' ' && ch.x0 - prev.x1 > ch.h * 0.22) out.push({ c: ' ', x0: prev.x1, x1: ch.x0, y0: ch.y0, y1: ch.y1, base: ch.base, h: ch.h, virtual: true }); out.push(ch); }
      ln.chars = out; ln.str = out.map(c => c.c).join('');
      ln.x0 = out[0].x0; ln.x1 = out[out.length - 1].x1; ln.y0 = Math.min(...out.map(c => c.y0)); ln.y1 = Math.max(...out.map(c => c.y1));
    }
    m.textReady = lines; return lines;
  }).catch(() => (m.textReady = []));
}
function caret(lines, pt) {
  let best = -1, bd = Infinity;
  lines.forEach((ln, i) => {
    const dy = pt[1] < ln.y0 ? ln.y0 - pt[1] : pt[1] > ln.y1 ? pt[1] - ln.y1 : 0;
    const dx = pt[0] < ln.x0 ? ln.x0 - pt[0] : pt[0] > ln.x1 ? pt[0] - ln.x1 : 0;
    const dist = dy * 3 + dx; if (dist < bd) { bd = dist; best = i; }
  });
  if (best < 0 || bd > 36) return null;
  const ln = lines[best]; let k = 0; while (k < ln.chars.length && (ln.chars[k].x0 + ln.chars[k].x1) / 2 < pt[0]) k++;
  return { line: best, k };
}
export function textQuads(page, p1, p2) {
  const lines = meta(page).textReady;
  const a = lines && caret(lines, p1), b = lines && caret(lines, p2);
  if (!a || !b) { const [x1, y1, x2, y2] = normBox(...p1, ...p2); return [[x1, y2, x2, y2, x1, y1, x2, y1]]; }
  const [s, e] = (a.line < b.line || (a.line === b.line && a.k <= b.k)) ? [a, b] : [b, a];
  const quads = [];
  for (let i = s.line; i <= e.line; i++) {
    const ln = lines[i], from = i === s.line ? s.k : 0, to = i === e.line ? e.k : ln.chars.length;
    if (to <= from) continue;
    const cs = ln.chars.slice(from, to), x1 = cs[0].x0, x2 = cs[cs.length - 1].x1, y1 = Math.max(...cs.map(c => c.y1)), y0 = Math.min(...cs.map(c => c.y0));
    quads.push([x1, y1, x2, y1, x1, y0, x2, y0]);
  }
  return quads;
}

/* ------------------------------------------------------------ structured text (MuPDF) for editing */
export function pageBlocks(p) {
  const key = srcKey(p.fileId, p.idx);
  if (!stextCache.has(key)) {
    stextCache.set(key, (async () => {
      if (!(await engine.startEngine())) return null;
      const f = S.files.get(p.fileId);
      if (!engine.isLoaded(f.id)) await engine.loadFile(f.id, f.baseBytes);
      const r = await engine.stext(f.id, p.idx);
      return splitBlocks(r.blocks);
    })().catch(e => { console.error(e); return null; }));
  }
  return stextCache.get(key);
}
// MuPDF groups lines that are close together; split them where the font, the size or the spacing changes
// so a heading and the paragraph under it are edited separately.
function splitBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    let cur = null;
    for (const l of b.lines) {
      if (!l.font) continue;
      const prev = cur && cur.lines[cur.lines.length - 1];
      const gap = prev ? Math.hypot(l.origin[0] - prev.origin[0], l.origin[1] - prev.origin[1]) : 0;
      const same = prev && Math.abs((l.size || 0) - (prev.size || 0)) <= Math.max(0.5, prev.size * 0.08) && l.font.name === prev.font.name
        && angleOf(l.dir) === angleOf(prev.dir) && gap < Math.max(l.size, prev.size) * 1.9;
      if (!same) { cur = { lines: [] }; out.push(cur); }
      cur.lines.push(l);
    }
  }
  for (const g of out) g.bbox = bboxPts(g.lines.flatMap(l => [l.bbox[0], l.bbox[1], l.bbox[2], l.bbox[3]]));
  return out;
}
const angleOf = v => norm(Math.atan2(v[1], v[0]) * 180 / Math.PI);
const isAxis = v => { const a = Math.atan2(v[1], v[0]) * 180 / Math.PI; return Math.abs(a - Math.round(a / 90) * 90) < 2; };
function familyOf(font) {
  const n = (font?.name || '').replace(/^[A-Z]{6}\+/, '');
  if (font?.mono || /courier|mono|consol|menlo/i.test(n)) return 'mono';
  if (font?.serif || /times|serif|garamond|georgia|cambria|book|minion|palatino|roman/i.test(n) && !/sans/i.test(n)) return 'serif';
  return 'sans';
}
function editFromBlock(p, block) {
  const lines = block.lines.filter(l => l.font && l.chars.length);
  if (!lines.length) return null;
  const dir = lines[0].dir;
  if (!isAxis(dir) || lines.some(l => angleOf(l.dir) !== angleOf(dir))) return { error: 'This text is slanted: only horizontal or vertical text can be edited.' };
  const rot = angleOf(dir), R = rotateM(rot), Ri = inv(R);
  const first = lines[0], size = first.size || 12;
  const local = (pt, o) => apply(Ri, pt[0] - o[0], pt[1] - o[1]);
  // leading from baseline distances
  const ups = lines.map(l => local(l.origin, first.origin)[1]);
  const gaps = ups.slice(1).map((u, i) => ups[i] - u).filter(g => g > size * 0.5).sort((a, b) => a - b);
  const leading = gaps.length ? gaps[Math.floor(gaps.length / 2)] : size * 1.2;
  const fam = familyOf(first.font), fn = (first.font.name || '').replace(/^[A-Z]{6}\+/, '');
  const bold = !!first.font.bold || /bold|black|heavy|semibold|demi/i.test(fn), italic = !!first.font.italic || /italic|oblique/i.test(fn);
  const font = fontName(fam, bold, italic);
  const remove = [];
  let blockW = 0;
  for (const l of lines) {
    let x0 = Infinity, x1 = -Infinity;
    for (const ch of l.chars) { const q = ch.q; for (let i = 0; i < 8; i += 2) { const [lx] = local([q[i], q[i + 1]], l.origin); x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); } }
    const s = l.size || size;
    const corners = [[x0 - 0.5, -0.12 * s], [x1 + 0.5, -0.12 * s], [x0 - 0.5, 0.6 * s], [x1 + 0.5, 0.6 * s]].map(([x, y]) => { const v = apply(R, x, y); return [v[0] + l.origin[0], v[1] + l.origin[1]]; });
    remove.push(bboxPts(corners.flat()));
    const off = local(l.origin, first.origin)[0];
    blockW = Math.max(blockW, off + x1);
  }
  const text = lines.map(l => l.text.replace(/\s+$/, '')).join('\n');
  if (hasUnsupported(text)) return { error: 'This text uses characters the standard fonts do not contain (for example non-Latin letters or math symbols): editing it would lose them.' };
  const subW = Math.max(...text.split('\n').map(t => measure(font, t, size)));
  if (lines.length === 1) { // a single line may grow up to the opposite margin of the page
    const v = meta(p).view, xs = [[v[0], v[1]], [v[2], v[1]], [v[0], v[3]], [v[2], v[3]]].map(c => local(c, first.origin)[0]);
    blockW = Math.max(blockW, Math.max(...xs) + Math.min(...xs));
  }
  return {
    id: uid('e'), kind: 'text', src: p.fileId, idx: p.idx, blockKey: block.bbox.map(v => Math.round(v)).join(','),
    remove, anchor: first.origin.slice(), rot, font, size, leading, width: Math.max(blockW, subW) + 1,
    text, origText: text, color: rgbToHex(first.color) || '#000000', family: fam, bold, italic,
  };
}

/* ------------------------------------------------------------ images on the page */
const imageCache = new Map();
export function detectedImages(p) {
  const key = srcKey(p.fileId, p.idx);
  if (!imageCache.has(key)) { let list = []; try { list = pageImages(S.files.get(p.fileId).lib.getPage(p.idx)); } catch (e) { console.warn(e); } imageCache.set(key, list); }
  return imageCache.get(key);
}
export const clearImageCache = () => imageCache.clear();
function virtualImage(sel) {
  const [, fileId, idx, op] = sel.split(':');
  const p = S.pages.find(q => q.fileId === fileId && q.idx === +idx); if (!p) return null;
  const im = detectedImages(p).find(x => x.op === +op); if (!im) return null;
  return { p, im };
}
const placement = e => mul(e.ctm, e.A || IDENT);
function imageTargets(p) { // [{ box, M?, edit?, im?, kind }]
  const out = [];
  for (const im of detectedImages(p)) {
    const e = S.edits.find(x => x.kind === 'image' && x.src === p.fileId && x.idx === p.idx && x.op === im.op);
    if (e?.deleted) continue;
    const M = e ? placement(e) : im.ctm;
    out.push({ box: boxOfMatrix(M), edit: e || null, im, kind: 'image' });
  }
  for (const e of editsFor(p.fileId, p.idx)) if (e.kind === 'newimage') out.push({ box: e.rect.slice(), edit: e, kind: 'newimage' });
  return out;
}
function ensureImageEdit(p, im) {
  let e = S.edits.find(x => x.kind === 'image' && x.src === p.fileId && x.idx === p.idx && x.op === im.op);
  if (!e) { e = { id: uid('e'), kind: 'image', src: p.fileId, idx: p.idx, op: im.op, name: im.name, ctm: im.ctm.slice(), A: IDENT.slice(), px: im.px, rot: totalRot(p), deleted: false, replaceImageId: null }; S.edits.push(e); }
  return e;
}

/* ------------------------------------------------------------ overlay drawing */
export function annSVG(a) {
  const op = a.opacity ?? 1;
  switch (a.type) {
    case 'highlight': return `<path d="${svgPath(a.quads.flatMap(quadPoly))}" fill="${a.color}" fill-opacity="${op}"/>`;
    case 'underline': case 'strike': return `<g stroke="${a.color}" stroke-linecap="round" opacity="${op}">${a.quads.map(q => { const [x1, y1, x2, y2] = quadLine(q, a.type); return `<path d="M${fmt(x1)} ${fmt(y1)} L${fmt(x2)} ${fmt(y2)}" stroke-width="${fmt(Math.max(0.6, quadHeight(q) * 0.07))}"/>`; }).join('')}</g>`;
    case 'ink': return `<g fill="none" stroke="${a.color}" stroke-width="${fmt(a.width)}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}">${a.strokes.map(s => `<path d="${svgPath(strokeSegs(s))}"/>`).join('')}</g>`;
    case 'rect': { const [x1, y1, x2, y2] = a.rect; return `<rect x="${fmt(x1)}" y="${fmt(y1)}" width="${fmt(x2 - x1)}" height="${fmt(y2 - y1)}" fill="${a.fill || 'none'}" stroke="${a.color}" stroke-width="${fmt(a.width)}" opacity="${op}"/>`; }
    case 'ellipse': return `<path d="${svgPath(ellipseSegs(a.rect))}" fill="${a.fill || 'none'}" stroke="${a.color}" stroke-width="${fmt(a.width)}" opacity="${op}"/>`;
    case 'line': {
      const p = a.pts, ah = a.arrow ? arrowPts(p, a.width) : null;
      return `<g fill="none" stroke="${a.color}" stroke-width="${fmt(a.width)}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}"><path d="M${fmt(p[0])} ${fmt(p[1])} L${fmt(p[2])} ${fmt(p[3])}"/>${ah ? `<path d="M${ah.slice(0, 2).map(fmt).join(' ')} L${ah.slice(2, 4).map(fmt).join(' ')} L${ah.slice(4).map(fmt).join(' ')}"/>` : ''}</g>`;
    }
    case 'text': {
      const { lines, f } = textLayout(a), s = a.size;
      const t = lines.map((ln, i) => `<text transform="translate(${fmt(PAD)} ${fmt(f.lh - PAD - s * BASE - i * s * LEADING)}) scale(1 -1)" font-size="${fmt(s)}" fill="${a.color}" font-family="Helvetica, Arial, sans-serif" xml:space="preserve">${esc(ln)}</text>`).join('');
      const empty = !(a.text || '').trim() ? `<rect width="${fmt(f.lw)}" height="${fmt(f.lh)}" fill="none" stroke="#8a93a3" stroke-width="0.6" stroke-dasharray="3 2"/>` : '';
      return `<g transform="matrix(${f.m.map(fmt).join(' ')})">${empty}${t}</g>`;
    }
    case 'note': {
      const f = frame(a);
      return `<g transform="matrix(${f.m.map(fmt).join(' ')}) scale(${fmt(f.lw / 20)} ${fmt(f.lh / 20)})"><path d="${svgPath(NOTE_BUBBLE)}" fill="${a.color}" stroke="#383838" stroke-width="0.9" stroke-linejoin="round"/><path d="${svgPath(NOTE_LINES)}" stroke="#383838" stroke-width="1.1" stroke-linecap="round"/></g>`;
    }
    case 'stamp': {
      const f = frame(a), im = S.images.get(a.imageId); if (!im) return '';
      return `<g transform="matrix(${f.m.map(fmt).join(' ')})" opacity="${op}"><image href="${im.url}" width="${fmt(f.lw)}" height="${fmt(f.lh)}" preserveAspectRatio="none" transform="translate(0 ${fmt(f.lh)}) scale(1 -1)"/></g>`;
    }
    case 'link': { const [x1, y1, x2, y2] = a.rect; return `<rect class="lnk" x="${fmt(x1)}" y="${fmt(y1)}" width="${fmt(x2 - x1)}" height="${fmt(y2 - y1)}" fill="rgb(35 70 196 / .08)" stroke="#2346c4" stroke-width="0.8" stroke-dasharray="3 2"/>`; }
  }
  return '';
}
function redactSVG(e) {
  const preview = S.showRedactPreview;
  return e.rects.map(r => `<rect x="${fmt(r[0])}" y="${fmt(r[1])}" width="${fmt(r[2] - r[0])}" height="${fmt(r[3] - r[1])}" ${preview
    ? `fill="${e.fill === 'none' ? '#ffffff' : (e.fill || '#000')}"`
    : 'fill="url(#mgHatch)" stroke="#d92d20" stroke-width="1"'}/>`).join('');
}
function pendingEditSVG(e) { // shown until the rendered preview of the page catches up
  if (e.kind === 'text') {
    const mask = (e.remove || []).map(r => `<rect x="${fmt(r[0])}" y="${fmt(r[1] - 1)}" width="${fmt(r[2] - r[0])}" height="${fmt(r[3] - r[1] + 2)}" fill="#fff"/>`).join('');
    return mask + contentTextSVG(e);
  }
  if (e.kind === 'newimage') { const im = S.images.get(e.imageId); if (!im) return ''; const f = frame(e); return `<g transform="matrix(${f.m.map(fmt).join(' ')})"><image href="${im.url}" width="${fmt(f.lw)}" height="${fmt(f.lh)}" preserveAspectRatio="none" transform="translate(0 ${fmt(f.lh)}) scale(1 -1)"/></g>`; }
  if (e.kind === 'image') { const b = e.deleted ? boxOfMatrix(e.ctm) : boxOfMatrix(placement(e)); return `<rect x="${fmt(b[0])}" y="${fmt(b[1])}" width="${fmt(b[2] - b[0])}" height="${fmt(b[3] - b[1])}" fill="none" stroke="#2346c4" stroke-dasharray="4 3" stroke-width="1"/>`; }
  return '';
}
const HATCH = '<defs><pattern id="mgHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgb(217 45 32 / .16)"/><line x1="0" y1="0" x2="0" y2="6" stroke="rgb(217 45 32 / .55)" stroke-width="1.4"/></pattern></defs>';
function docSVG(p) {
  const i = S.pages.indexOf(p), total = S.pages.length, fileName = S.files.get(p.fileId).name.replace(/\.pdf$/i, '');
  const hf = drafts.hf !== undefined ? drafts.hf : S.doc.hf, wm = drafts.wm !== undefined ? drafts.wm : S.doc.wm;
  let out = '';
  for (const it of wmItems(wm, p, i, total)) out += contentTextSVG(it);
  for (const it of hfItems(hf, p, i, total, fileName)) out += contentTextSVG(it);
  if (p.crop) {
    const v = meta(p).view, c = displayBox(p);
    out += `<path fill-rule="evenodd" fill="rgb(16 20 30 / .5)" d="M${fmt(v[0])} ${fmt(v[1])}H${fmt(v[2])}V${fmt(v[3])}H${fmt(v[0])}Z M${fmt(c[0])} ${fmt(c[1])}H${fmt(c[2])}V${fmt(c[3])}H${fmt(c[0])}Z"/><rect x="${fmt(c[0])}" y="${fmt(c[1])}" width="${fmt(c[2] - c[0])}" height="${fmt(c[3] - c[1])}" fill="none" stroke="#2346c4" stroke-width="1" stroke-dasharray="5 3"/>`;
  }
  return out;
}
function overlayMarkup(p, vp, { skipId = null, thumb = false } = {}) {
  const T = `matrix(${vp.transform.map(fmt).join(' ')})`; let hl = '', an = '';
  for (const a of S.annots) {
    if (a.pageId !== p.id || a.id === skipId) continue;
    if (a.type === 'link' && thumb) continue;
    if (a.type === 'highlight') hl += annSVG(a); else an += annSVG(a);
  }
  const edits = editsFor(p.fileId, p.idx), pending = variantState(p.fileId, p.idx) === 'pending';
  let ed = '';
  if (pending) for (const e of edits) if (e.kind !== 'redact' && e.id !== skipId) ed += pendingEditSVG(e);
  for (const e of edits) if (e.kind === 'redact') an += redactSVG(e);
  return { doc: `<g transform="${T}">${ed}${docSVG(p)}</g>`, hl: `<g transform="${T}">${hl}</g>`, an: `${HATCH}<g transform="${T}">${an}</g>` };
}
export function renderOverlay(pv) {
  const { doc, hl, an } = overlayMarkup(pv.page, pv.vp, { skipId: S.editing });
  for (const [svg, html] of [[pv.doc, doc], [pv.hl, hl], [pv.ann, an]]) { svg.setAttribute('viewBox', `0 0 ${fmt(pv.vp.width)} ${fmt(pv.vp.height)}`); svg.innerHTML = html; }
  const th = thumbs.get(pv.page.id); if (th) renderThumbOverlay(th);
}
setThumbOverlay(th => {
  const { doc, hl, an } = overlayMarkup(th.page, th.vp, { thumb: true });
  for (const [svg, html] of [[th.doc, doc], [th.hl, hl], [th.ann, an]]) { svg.setAttribute('viewBox', `0 0 ${fmt(th.vp.width)} ${fmt(th.vp.height)}`); svg.innerHTML = html; }
});
export const refreshPage = id => { const pv = views.get(id); if (pv) renderOverlay(pv); };
function refreshEdit(e) { for (const pv of viewsOfSource(e.src, e.idx)) renderOverlay(pv); }
function editChanged(e) { scheduleVariant(e.src, e.idx); refreshEdit(e); }

/* ------------------------------------------------------------ pointer interaction */
let drag = null;
export const isDragging = () => !!drag;
const pdfPt = (pv, e) => { const r = pv.el.getBoundingClientRect(); return pv.vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top); };
const scrPt = (pv, x, y) => pv.vp.convertToViewportPoint(x, y);
export function screenBox(pv, b) { const [ax, ay] = scrPt(pv, b[0], b[1]), [bx, by] = scrPt(pv, b[2], b[3]); return normBox(ax, ay, bx, by); }
function pdfBoxFromScreen(pv, sb) { const [ax, ay] = pv.vp.convertToPdfPoint(sb[0], sb[1]), [bx, by] = pv.vp.convertToPdfPoint(sb[2], sb[3]); return normBox(ax, ay, bx, by); }
function distSeg(x1, y1, x2, y2, px, py) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function hitAnnot(a, [x, y], tol) {
  switch (a.type) {
    case 'ink': return a.strokes.some(s => { if (s.length === 2) return Math.hypot(x - s[0], y - s[1]) <= a.width / 2 + tol; for (let i = 0; i + 3 < s.length; i += 2) if (distSeg(s[i], s[i + 1], s[i + 2], s[i + 3], x, y) <= a.width / 2 + tol) return true; return false; });
    case 'line': return distSeg(...a.pts, x, y) <= a.width / 2 + tol;
    case 'highlight': case 'underline': case 'strike': return a.quads.some(q => inBox(bboxPts(q), x, y, tol / 3));
    case 'rect': case 'ellipse': return inBox(a.rect, x, y, a.width / 2 + tol / 2);
    default: return inBox(a.rect, x, y, tol / 3);
  }
}
function hitTest(pv, pt, filter = () => true) {
  const tol = 6 / pv.vp.scale;
  for (let i = S.annots.length - 1; i >= 0; i--) { const a = S.annots[i]; if (a.pageId === pv.page.id && filter(a) && hitAnnot(a, pt, tol)) return a; }
  return null;
}
const hitRedact = (p, pt) => editsFor(p.fileId, p.idx).filter(e => e.kind === 'redact').reverse().find(e => e.rects.some(r => inBox(r, pt[0], pt[1], 1))) || null;
const hitTextEdit = (p, pt) => editsFor(p.fileId, p.idx).filter(e => e.kind === 'text').reverse().find(e => inBox(contentBox(e), pt[0], pt[1], 2) || (e.remove || []).some(r => inBox(r, pt[0], pt[1], 1))) || null;
function hitBlock(blocks, pt) { if (!blocks) return null; for (const b of blocks) if (inBox(b.bbox, pt[0], pt[1], 2)) return b; return null; }
function hitImage(p, pt) { const t = imageTargets(p); for (let i = t.length - 1; i >= 0; i--) if (inBox(t[i].box, pt[0], pt[1], 1)) return t[i]; return null; }

function capture(e, pv) {
  e.preventDefault();
  pv.el.setPointerCapture(e.pointerId);
  pv.el.onpointermove = ev => onPointerMove(ev);
  pv.el.onpointerup = pv.el.onpointercancel = ev => onPointerUp(ev);
}
export async function onPointerDown(e, pv) {
  if (e.button !== 0) return;
  if (e.target.closest('.pv-forms > *, .handle, .ed-text, .ed-content, .note-pop, .pop')) return;
  closeEditors();
  S.cur = pv.page.id;
  const pt = pdfPt(pv, e), tool = S.tool, p = pv.page;
  switch (tool) {
    case 'select': {
      const hit = hitTest(pv, pt);
      select(hit ? hit.id : null);
      if (!hit) return;
      drag = { kind: 'move', pv, a: hit, start: pt, orig: structuredClone(hit), snap: snapshot(), moved: false };
      break;
    }
    case 'link': {
      const hit = hitTest(pv, pt, a => a.type === 'link');
      if (hit) { select(hit.id); drag = { kind: 'move', pv, a: hit, start: pt, orig: structuredClone(hit), snap: snapshot(), moved: false }; break; }
      select(null); drag = { kind: 'link', pv, start: pt, cur: pt }; break;
    }
    case 'text': case 'note': drag = { kind: tool, pv, start: pt, sx: e.clientX }; break;
    case 'rect': case 'ellipse': case 'line': case 'arrow': case 'crop': case 'redactarea':
      if (tool === 'redactarea') { const r = hitRedact(p, pt); if (r) { select(r.id); drag = { kind: 'moveedit', pv, e: r, start: pt, orig: structuredClone(r), snap: snapshot(), moved: false }; break; } select(null); }
      drag = { kind: tool, pv, start: pt, cur: pt }; break;
    case 'highlight': case 'underline': case 'strike': case 'redacttext':
      if (tool === 'redacttext') { const r = hitRedact(p, pt); if (r) { select(r.id); return; } select(null); }
      drag = { kind: tool, pv, start: pt, cur: pt }; ensureText(p); break;
    case 'ink': drag = { kind: 'ink', pv, pts: [pt[0], pt[1]] }; break;
    case 'edittext': {
      e.preventDefault(); // keep the focus in the editor that opens below
      const ed = hitTextEdit(p, pt);
      if (ed) { select(ed.id); drag = { kind: 'moveedit', pv, e: ed, start: pt, orig: structuredClone(ed), snap: snapshot(), moved: false, clickOpen: true }; break; }
      if (!engine.engine.available && engine.engine.error) { toast('Text editing needs the MuPDF engine, which did not load.', 'error'); return; }
      const blocks = await pageBlocks(p);
      if (blocks === null) { toast('Could not read the text on this page.', 'error'); return; }
      const b = hitBlock(blocks, pt);
      if (b) {
        const key = b.bbox.map(v => Math.round(v)).join(',');
        const existing = S.edits.find(x => x.kind === 'text' && x.src === p.fileId && x.idx === p.idx && x.blockKey === key);
        if (existing) { select(existing.id); openContentEditor(existing); return; }
        const ne = editFromBlock(p, b);
        if (!ne) return;
        if (ne.error) { toast(ne.error, 'error'); return; }
        openContentEditor(ne, { isNew: true });
      } else newContentText(pv, pt);
      return;
    }
    case 'editimage': {
      const t = hitImage(p, pt);
      if (!t) { select(null); return; }
      S.sel = t.edit ? t.edit.id : `img:${p.fileId}:${p.idx}:${t.im.op}`; renderSelection(); renderProps();
      drag = { kind: 'moveimage', pv, t, start: pt, snap: snapshot(), moved: false, box0: t.box.slice(), orig: t.edit ? structuredClone(t.edit) : null };
      break;
    }
    default: return;
  }
  capture(e, pv);
}
function onPointerMove(e) {
  if (!drag) return;
  const { pv } = drag, pt = pdfPt(pv, e);
  showCursor(e, pv);
  switch (drag.kind) {
    case 'move': {
      const dx = pt[0] - drag.start[0], dy = pt[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) * pv.vp.scale < 2) return;
      drag.moved = true;
      Object.assign(drag.a, structuredClone(drag.orig)); translateAnnot(drag.a, dx, dy);
      renderOverlay(pv); renderSelection(); break;
    }
    case 'moveedit': {
      const dx = pt[0] - drag.start[0], dy = pt[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) * pv.vp.scale < 3) return;
      drag.moved = true;
      Object.assign(drag.e, structuredClone(drag.orig));
      if (drag.e.kind === 'redact') drag.e.rects = drag.e.rects.map(r => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
      else if (drag.e.kind === 'text') drag.e.anchor = [drag.e.anchor[0] + dx, drag.e.anchor[1] + dy];
      if (drag.e.kind === 'text') { S.editing = drag.e.id; ghostText(pv, drag.e); } else renderOverlay(pv);
      renderSelection(); break;
    }
    case 'moveimage': {
      const dx = pt[0] - drag.start[0], dy = pt[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) * pv.vp.scale < 3) return;
      drag.moved = true; drag.cur = [drag.box0[0] + dx, drag.box0[1] + dy, drag.box0[2] + dx, drag.box0[3] + dy];
      ghostBox(pv, drag.cur); break;
    }
    case 'ink': {
      const n = drag.pts.length, lx = drag.pts[n - 2], ly = drag.pts[n - 1];
      if (Math.hypot(pt[0] - lx, pt[1] - ly) * pv.vp.scale >= 1.5) drag.pts.push(pt[0], pt[1]);
      preview(pv, annSVG(newAnnot('ink', pv.page.id, { strokes: [drag.pts], width: DEF.ink.width })));
      break;
    }
    case 'resize': doResize(e); break;
    default:
      if (['rect', 'ellipse', 'line', 'arrow', 'highlight', 'underline', 'strike', 'link', 'crop', 'redactarea', 'redacttext'].includes(drag.kind)) { drag.cur = pt; previewDraft(pv, drag); }
  }
}
function previewDraft(pv, d) {
  if (d.kind === 'crop' || d.kind === 'redactarea' || d.kind === 'link') {
    const r = normBox(...d.start, ...d.cur);
    const style = d.kind === 'crop' ? 'fill="rgb(35 70 196 / .08)" stroke="#2346c4" stroke-dasharray="5 3"' : d.kind === 'link' ? 'fill="rgb(35 70 196 / .1)" stroke="#2346c4" stroke-dasharray="3 2"' : 'fill="url(#mgHatchP)" stroke="#d92d20"';
    preview(pv, `<rect x="${fmt(r[0])}" y="${fmt(r[1])}" width="${fmt(r[2] - r[0])}" height="${fmt(r[3] - r[1])}" ${style} stroke-width="${fmt(1 / pv.vp.scale * 1.5)}"/>`);
    return;
  }
  if (d.kind === 'redacttext') { const q = textQuads(d.pv.page, d.start, d.cur); preview(pv, q.map(x => { const b = bboxPts(x); return `<rect x="${fmt(b[0])}" y="${fmt(b[1])}" width="${fmt(b[2] - b[0])}" height="${fmt(b[3] - b[1])}" fill="url(#mgHatchP)" stroke="#d92d20" stroke-width="0.8"/>`; }).join('')); return; }
  const a = draftShape(d); if (a) preview(pv, annSVG(a), a.type === 'highlight');
}
function draftShape(d) {
  const [x1, y1] = d.start, [x2, y2] = d.cur, page = d.pv.page.id;
  if (d.kind === 'rect' || d.kind === 'ellipse') return newAnnot(d.kind, page, { rect: normBox(x1, y1, x2, y2), width: DEF[d.kind].width, fill: DEF[d.kind].fill });
  if (d.kind === 'line' || d.kind === 'arrow') return newAnnot('line', page, { pts: [x1, y1, x2, y2], width: DEF.line.width, arrow: d.kind === 'arrow' });
  if (d.kind === 'highlight' || d.kind === 'underline' || d.kind === 'strike') return newAnnot(d.kind, page, { quads: textQuads(d.pv.page, d.start, d.cur) });
  return null;
}
function onPointerUpBase(e) {
  if (!drag) return;
  const d = drag; drag = null;
  const { pv } = d, p = pv.page;
  pv.el.onpointermove = pv.el.onpointerup = pv.el.onpointercancel = null;
  clearPreview(pv);
  const pt = pdfPt(pv, e), scale = pv.vp.scale;
  switch (d.kind) {
    case 'move': case 'resize':
      if (d.moved) {
        if (d.a) d.a.dirty = true;
        pushUndo(d.snap); setDirty();
        if (d.e) editChanged(d.e); else renderOverlay(pv);
        renderSelection();
      }
      break;
    case 'moveedit':
      S.editing = null;
      if (d.moved) { pushUndo(d.snap); setDirty(); editChanged(d.e); renderSelection(); }
      else { renderOverlay(pv); if (d.clickOpen && d.e.kind === 'text') openContentEditor(d.e); }
      break;
    case 'moveimage': {
      pv.ui.querySelector('.drag-ghost')?.remove();
      if (!d.moved) break;
      const nb = d.cur, cb = d.box0;
      const M = [(nb[2] - nb[0]) / (cb[2] - cb[0] || 1), 0, 0, (nb[3] - nb[1]) / (cb[3] - cb[1] || 1), 0, 0];
      M[4] = nb[0] - cb[0] * M[0]; M[5] = nb[1] - cb[1] * M[3];
      let ed;
      if (d.t.kind === 'newimage') { ed = d.t.edit; ed.rect = nb.slice(); }
      else { ed = d.t.edit || ensureImageEdit(p, d.t.im); ed.A = mul(ed.A || IDENT, M); }
      S.sel = ed.id;
      pushUndo(d.snap); setDirty(); editChanged(ed); renderSelection(); renderProps();
      break;
    }
    case 'ink':
      if (d.pts.length >= 2) addAnnot(newAnnot('ink', p.id, { strokes: [d.pts], width: DEF.ink.width }), false);
      break;
    case 'text': {
      const w = Math.abs(e.clientX - d.sx) / scale;
      createText(pv, d.start, w > 24 ? w : 200);
      break;
    }
    case 'note': {
      const r = totalRot(p);
      const a = newAnnot('note', p.id, { rect: rectFromAnchor(d.start, 20, 20, r), rot: r });
      const snap = snapshot(); S.annots.push(a); renderOverlay(pv); select(a.id);
      pushUndo(snap); setDirty(); setTool('select');
      openNoteEditor(a);
      break;
    }
    case 'link': {
      const r = normBox(...d.start, ...pt);
      if ((r[2] - r[0]) * scale < 6 || (r[3] - r[1]) * scale < 6) { toast('Drag a rectangle over the area that should be clickable.'); break; }
      openLinkPopover(pv, r, null);
      break;
    }
    case 'crop': {
      const r = normBox(...d.start, ...pt);
      if ((r[2] - r[0]) * scale < 20 || (r[3] - r[1]) * scale < 20) break;
      openCropPopover(pv, r);
      break;
    }
    case 'redactarea': {
      const r = normBox(...d.start, ...pt);
      if ((r[2] - r[0]) * scale < 3 || (r[3] - r[1]) * scale < 3) break;
      addRedaction(p, [r]);
      break;
    }
    case 'redacttext': {
      const q = textQuads(p, d.start, pt); const rects = q.map(bboxPts).filter(b => (b[2] - b[0]) * scale > 2);
      if (rects.length) addRedaction(p, rects.map(b => inflate(b, 0.5)));
      break;
    }
    default: {
      d.cur = pt;
      const a = draftShape(d); if (!a) break;
      const b = bbox(a), big = Math.max(b[2] - b[0], b[3] - b[1]) * scale;
      if (a.quads) { if (a.quads.length && big > 3) addAnnot(a, false); }
      else if (big > 4) addAnnot(a, false);
    }
  }
}
export function addRedaction(p, rects, label = '') {
  const e = { id: uid('e'), kind: 'redact', src: p.fileId, idx: p.idx, rects, fill: DEF.redact.fill, label };
  commit(() => S.edits.push(e));
  refreshEdit(e); updateStatus(); select(e.id);
  return e;
}
function addAnnot(a, switchToSelect = true) {
  commit(() => S.annots.push(a));
  refreshPage(a.pageId); select(a.id);
  if (switchToSelect) setTool('select');
}
export function onDblClick(e, pv) {
  if (S.tool !== 'select') return;
  const a = hitTest(pv, pdfPt(pv, e));
  if (a?.type === 'text') openTextEditor(a);
  else if (a?.type === 'note') openNoteEditor(a);
  else if (a?.type === 'link') openLinkPopover(pv, a.rect, a);
}
function preview(pv, inner, multiply = false) {
  let svg = pv.ui.querySelector('.pv-prev');
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'pv-prev'); pv.ui.appendChild(svg); }
  svg.setAttribute('viewBox', `0 0 ${fmt(pv.vp.width)} ${fmt(pv.vp.height)}`);
  svg.innerHTML = HATCH.replace('mgHatch', 'mgHatchP') + `<g transform="matrix(${pv.vp.transform.map(fmt).join(' ')})"${multiply ? ' style="mix-blend-mode:multiply"' : ''}>${inner}</g>`;
}
function clearPreview(pv) { pv.ui.querySelector('.pv-prev')?.remove(); }
function ghostBox(pv, box) {
  let g = pv.ui.querySelector('.drag-ghost'); if (!g) { g = document.createElement('div'); g.className = 'drag-ghost'; pv.ui.appendChild(g); }
  const sb = screenBox(pv, box); Object.assign(g.style, { left: sb[0] + 'px', top: sb[1] + 'px', width: sb[2] - sb[0] + 'px', height: sb[3] - sb[1] + 'px' });
}
function ghostText(pv, e) { renderOverlay(pv); preview(pv, contentTextSVG(e)); }
export function showCursor(e, pv) {
  const [x, y] = pdfPt(pv, e);
  $('#stCursor').textContent = `x ${Math.round(x)} · y ${Math.round(y)} pt`;
  hover(pv, [x, y]);
}
let hoverTok = 0;
async function hover(pv, pt) {
  const tool = S.tool; if (tool !== 'edittext' && tool !== 'editimage') return;
  const tok = ++hoverTok, p = pv.page;
  let box = null;
  if (tool === 'editimage') box = hitImage(p, pt)?.box || null;
  else {
    const ed = hitTextEdit(p, pt);
    if (ed) box = contentBox(ed);
    else if (engine.engine.available) { const b = hitBlock(await pageBlocks(p), pt); if (b) box = b.bbox; }
  }
  if (tok !== hoverTok) return;
  let h = pv.ui.querySelector('.hover-box');
  if (!box) { h?.remove(); pv.el.style.cursor = ''; return; }
  if (!h) { h = document.createElement('div'); h.className = 'hover-box'; pv.ui.appendChild(h); }
  const sb = inflate(screenBox(pv, box), 2);
  Object.assign(h.style, { left: sb[0] + 'px', top: sb[1] + 'px', width: sb[2] - sb[0] + 'px', height: sb[3] - sb[1] + 'px' });
  pv.el.style.cursor = tool === 'edittext' ? 'text' : 'move';
}

/* ------------------------------------------------------------ selection and handles */
export function select(id) {
  if (S.sel === id) { renderSelection(); return; }
  S.sel = id; renderSelection(); renderProps();
}
export function renderSelection() {
  for (const pv of views.values()) pv.ui.querySelectorAll('.sel, .handle').forEach(n => n.remove());
  const s = selected(); if (!s) return;
  let pv, box, hs = [], target;
  if (s.kind === 'annot') {
    const a = s.a; if (S.editing === a.id) return;
    pv = views.get(a.pageId); if (!pv) return;
    box = visualBox(a); target = { a };
    if (a.type === 'line') { const [ax, ay] = scrPt(pv, a.pts[0], a.pts[1]), [bx, by] = scrPt(pv, a.pts[2], a.pts[3]); hs.push(['p0', ax, ay], ['p1', bx, by]); }
    else if (a.type === 'text') { const g = screenBox(pv, bbox(a)); hs.push(['w', g[0], (g[1] + g[3]) / 2], ['e', g[2], (g[1] + g[3]) / 2]); }
    else if (['rect', 'ellipse', 'ink', 'stamp', 'link'].includes(a.type)) { const g = screenBox(pv, bbox(a)); hs.push(['nw', g[0], g[1]], ['ne', g[2], g[1]], ['sw', g[0], g[3]], ['se', g[2], g[3]]); }
  } else {
    const e = s.e || null;
    const p = s.kind === 'vimage' ? s.p : pageOf(pageIdOfEdit(e));
    pv = p && views.get(p.id); if (!pv) return;
    if (s.kind === 'vimage') { box = s.im.bbox; target = { vimage: s }; }
    else if (e.kind === 'text') { if (S.editing === e.id) return; box = contentBox(e); target = { e }; }
    else if (e.kind === 'image') { if (e.deleted) return; box = boxOfMatrix(placement(e)); target = { e }; }
    else if (e.kind === 'newimage') { box = e.rect; target = { e }; }
    else if (e.kind === 'redact') { box = bboxPts(e.rects.flat()); target = { e }; }
    const g = screenBox(pv, box);
    if (e?.kind === 'text') { const mid = (g[1] + g[3]) / 2; hs.push(['w', g[0], mid], ['e', g[2], mid]); }
    else if (s.kind === 'vimage' || e.kind === 'image' || e.kind === 'newimage') hs.push(['nw', g[0], g[1]], ['ne', g[2], g[1]], ['sw', g[0], g[3]], ['se', g[2], g[3]]);
  }
  const sb = inflate(screenBox(pv, box), 3);
  const el = document.createElement('div'); el.className = 'sel';
  Object.assign(el.style, { left: sb[0] + 'px', top: sb[1] + 'px', width: sb[2] - sb[0] + 'px', height: sb[3] - sb[1] + 'px' });
  pv.ui.appendChild(el);
  for (const [h, x, y] of hs) {
    const el2 = document.createElement('div'); el2.className = 'handle'; el2.dataset.h = h;
    el2.style.left = x + 'px'; el2.style.top = y + 'px';
    el2.style.cursor = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', w: 'ew-resize', e: 'ew-resize' }[h] || 'move';
    el2.addEventListener('pointerdown', ev => startResize(ev, pv, target, h, box));
    pv.ui.appendChild(el2);
  }
}
function startResize(e, pv, target, h, box) {
  e.stopPropagation(); e.preventDefault();
  drag = { kind: 'resize', pv, h, box0: box.slice(), sb0: screenBox(pv, box), snap: snapshot(), moved: false, ...target };
  if (target.a) drag.orig = structuredClone(target.a);
  if (target.e) drag.orig = structuredClone(target.e);
  pv.el.setPointerCapture(e.pointerId);
  pv.el.onpointermove = ev => onPointerMove(ev);
  pv.el.onpointerup = pv.el.onpointercancel = ev => onPointerUp(ev);
}
function doResize(e) {
  const d = drag, { pv, h } = d, r = pv.el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  d.moved = true;
  if (d.a) Object.assign(d.a, structuredClone(d.orig));
  if (d.e) Object.assign(d.e, structuredClone(d.orig));
  const keepRatio = !!(d.vimage || d.e?.kind === 'image' || d.e?.kind === 'newimage' || d.a?.type === 'stamp');
  const boxFor = () => {
    let [x1, y1, x2, y2] = d.sb0;
    if (h.includes('w')) x1 = x; if (h.includes('e')) x2 = x;
    if (h === 'nw' || h === 'ne') y1 = y; if (h === 'sw' || h === 'se') y2 = y;
    const sb = normBox(x1, y1, x2, y2);
    if (sb[2] - sb[0] < 8) sb[2] = sb[0] + 8;
    if (sb[3] - sb[1] < 8) sb[3] = sb[1] + 8;
    if (keepRatio) { const ratio = (d.sb0[3] - d.sb0[1]) / (d.sb0[2] - d.sb0[0]), hh = (sb[2] - sb[0]) * ratio; if (h.includes('n')) sb[1] = sb[3] - hh; else sb[3] = sb[1] + hh; }
    return sb;
  };
  if (d.a) {
    const a = d.a;
    if (h === 'p0' || h === 'p1') { const p = pv.vp.convertToPdfPoint(x, y), i = h === 'p0' ? 0 : 2; a.pts[i] = p[0]; a.pts[i + 1] = p[1]; }
    else {
      const sb = boxFor();
      if (a.type === 'text') { sb[1] = d.sb0[1]; sb[3] = d.sb0[3]; }
      transformAnnot(a, d.box0, pdfBoxFromScreen(pv, sb));
      if (a.type === 'text') fitText(a);
    }
    renderOverlay(pv); renderSelection(); return;
  }
  if (d.e?.kind === 'text') { // width handles, along the text direction
    const ed = d.e, p = pv.vp.convertToPdfPoint(x, y), R = rotateM(ed.rot || 0), Ri = inv(R);
    const lx = apply(Ri, p[0] - ed.anchor[0], p[1] - ed.anchor[1])[0];
    if (h === 'e') ed.width = Math.max(12, lx);
    else { const shift = Math.min(lx, d.orig.width - 12); const v = apply(R, shift, 0); ed.anchor = [d.orig.anchor[0] + v[0], d.orig.anchor[1] + v[1]]; ed.width = d.orig.width - shift; }
    S.editing = ed.id; ghostText(pv, ed); renderSelection(); return;
  }
  const sb = boxFor();
  d.cur = pdfBoxFromScreen(pv, sb);
  ghostBox(pv, d.cur);
  // the image edit is written when the pointer goes up (see finishImageResize)
  d.finish = () => {
    const nb = d.cur, cb = d.box0;
    const M = [(nb[2] - nb[0]) / (cb[2] - cb[0] || 1), 0, 0, (nb[3] - nb[1]) / (cb[3] - cb[1] || 1), 0, 0];
    M[4] = nb[0] - cb[0] * M[0]; M[5] = nb[1] - cb[1] * M[3];
    let ed;
    if (d.e?.kind === 'newimage') { ed = d.e; ed.rect = nb.slice(); }
    else { ed = d.e || ensureImageEdit(d.vimage.p, d.vimage.im); ed.A = mul(ed.A || IDENT, M); }
    S.sel = ed.id; return ed;
  };
}
// resize end for images and text edits, everything else goes to onPointerUpBase
function onPointerUp(e) {
  const d = drag;
  if (d && d.kind === 'resize' && (d.e || d.vimage)) {
    drag = null;
    const { pv } = d;
    pv.el.onpointermove = pv.el.onpointerup = pv.el.onpointercancel = null;
    pv.ui.querySelector('.drag-ghost')?.remove(); clearPreview(pv); S.editing = null;
    if (!d.moved) { renderOverlay(pv); return; }
    const ed = d.finish ? d.finish() : d.e;
    pushUndo(d.snap); setDirty(); editChanged(ed); renderSelection(); renderProps();
    return;
  }
  onPointerUpBase(e);
}
export function deleteSelected() {
  const s = selected(); if (!s) return;
  if (s.kind === 'annot') {
    commit(() => { S.annots = S.annots.filter(x => x.id !== s.a.id); });
    S.sel = null; refreshPage(s.a.pageId);
  } else if (s.kind === 'vimage') {
    commit(() => { const e = ensureImageEdit(s.p, s.im); e.deleted = true; });
    S.sel = null; scheduleVariant(s.p.fileId, s.p.idx); refreshPage(s.p.id);
  } else {
    const e = s.e;
    commit(() => {
      if (e.kind === 'image') e.deleted = true;
      else if (e.kind === 'text' && e.remove?.length) e.text = '';
      else S.edits = S.edits.filter(x => x.id !== e.id);
    });
    S.sel = null; editChanged(e); updateStatus();
  }
  renderSelection(); renderProps();
}
function revertEdit(e) {
  commit(() => { S.edits = S.edits.filter(x => x.id !== e.id); });
  S.sel = null; editChanged(e); renderSelection(); renderProps(); updateStatus();
}

/* ------------------------------------------------------------ editors */
export function closeEditors() { $$('.ed-text, .ed-content, .note-pop, .pop').forEach(el => el._commit ? el._commit() : el.remove()); }
function createText(pv, P, width) {
  const r = totalRot(pv.page), size = DEF.text.size;
  const a = newAnnot('text', pv.page.id, { rect: rectFromAnchor(P, width, 2 * PAD + size * LEADING, r), rot: r, text: '', size, color: DEF.text.color });
  const snap = snapshot();
  S.annots.push(a); S.sel = a.id;
  setTool('select');
  openTextEditor(a, snap, true);
}
export function openTextEditor(a, snap = snapshot(), isNew = false) {
  closeEditors();
  const pv = views.get(a.pageId); if (!pv) return;
  S.editing = a.id; S.sel = a.id; renderOverlay(pv); renderSelection(); renderProps();
  const f = frame(a), sc = pv.vp.scale, sb = screenBox(pv, a.rect), upright = f.r === totalRot(pv.page);
  const ta = document.createElement('textarea'); ta.className = 'ed-text'; ta.value = a.text || '';
  ta.setAttribute('aria-label', 'Comment text'); ta.spellcheck = true;
  Object.assign(ta.style, { left: sb[0] + 'px', top: sb[1] + 'px', width: (upright ? f.lw * sc : sb[2] - sb[0]) + 'px', minHeight: (sb[3] - sb[1]) + 'px',
    font: `${a.size * sc}px/${LEADING} Helvetica, Arial, sans-serif`, color: a.color, padding: `${PAD * sc}px` });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', e => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); } e.stopPropagation(); });
  let done = false;
  ta._commit = () => {
    if (done) return; done = true;
    const t = ta.value.replace(/\s+$/, ''); ta.remove(); S.editing = null;
    if (!t.trim()) { S.annots = S.annots.filter(x => x.id !== a.id); S.sel = null; if (!isNew) { pushUndo(snap); setDirty(); } }
    else if (t !== a.text || isNew) { a.text = t; a.dirty = true; fitText(a); pushUndo(snap); setDirty(); if (hasUnsupported(t)) toast('Some characters are not available in the standard fonts and will be replaced.'); }
    renderOverlay(pv); renderSelection(); renderProps();
  };
  ta.addEventListener('blur', () => ta._commit());
  pv.ui.appendChild(ta); grow();
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}
export function openNoteEditor(a) {
  closeEditors();
  const pv = views.get(a.pageId); if (!pv) return;
  const sb = screenBox(pv, a.rect), pop = document.createElement('div'); pop.className = 'note-pop';
  const left = clamp(sb[2] + 8, 4, Math.max(4, pv.vp.width - 248)), top = clamp(sb[1], 4, Math.max(4, pv.vp.height - 150));
  Object.assign(pop.style, { left: left + 'px', top: top + 'px' });
  pop.innerHTML = `<textarea id="noteText" aria-label="Note text" placeholder="Write a note…"></textarea><div class="row"><button class="btn ghost danger-link" type="button" data-act="del">Delete note</button><button class="btn" type="button" data-act="ok">Done</button></div>`;
  const ta = pop.querySelector('textarea'); ta.value = a.contents || '';
  const snap = snapshot(); let done = false;
  pop._commit = () => {
    if (done) return; done = true; pop.remove();
    if (ta.value !== (a.contents || '')) { a.contents = ta.value; a.dirty = true; pushUndo(snap); setDirty(); renderProps(); }
  };
  pop.addEventListener('pointerdown', e => e.stopPropagation());
  pop.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') pop._commit(); });
  pop.querySelector('[data-act="ok"]').onclick = () => pop._commit();
  pop.querySelector('[data-act="del"]').onclick = () => { done = true; pop.remove(); select(a.id); deleteSelected(); };
  pop.addEventListener('focusout', e => { if (!pop.contains(e.relatedTarget)) setTimeout(() => { if (!pop.contains(document.activeElement)) pop._commit(); }, 0); });
  pv.ui.appendChild(pop); ta.focus();
}

// Inline editor for page text. Positioned over the first line, rotated with the text.
function newContentText(pv, pt) {
  const p = pv.page, d = DEF.ctext, font = fontName(d.family, d.bold, d.italic), size = d.size, rot = totalRot(p);
  const up = apply(rotateM(rot), 0, 1), asc = ascent(font) * size;
  const e = { id: uid('e'), kind: 'text', src: p.fileId, idx: p.idx, remove: [], anchor: [pt[0] - up[0] * asc, pt[1] - up[1] * asc], rot, font, size, leading: size * 1.25, width: 220, text: '', origText: '', color: d.color, family: d.family, bold: d.bold, italic: d.italic };
  openContentEditor(e, { isNew: true });
}
export function openContentEditor(e, { isNew = false } = {}) {
  closeEditors();
  const pv = viewsOfSource(e.src, e.idx)[0]; if (!pv) return;
  const snap = snapshot();
  if (isNew) S.edits.push(e);
  S.editing = e.id; S.sel = e.id; renderOverlay(pv); renderSelection(); renderProps();
  const sc = pv.vp.scale, m = mul(rotateM(e.rot || 0), [1, 0, 0, 1, e.anchor[0], e.anchor[1]]);
  const asc = ascent(e.font) * e.size;
  const tl = scrPt(pv, ...apply(m, 0, asc)), tr = scrPt(pv, ...apply(m, 1, asc));
  const ang = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
  const fam = e.font.startsWith('Times') ? 'serif' : e.font.startsWith('Courier') ? 'mono' : 'sans';
  const ta = document.createElement('textarea'); ta.className = 'ed-content'; ta.value = e.text || '';
  ta.setAttribute('aria-label', 'Page text'); ta.spellcheck = true; ta.wrap = 'soft';
  const lines = Math.max(1, (e.text || '').split('\n').length);
  Object.assign(ta.style, {
    left: tl[0] + 'px', top: tl[1] + 'px', width: Math.max(40, e.width * sc + 4) + 'px', minHeight: (lines * e.leading * sc + 4) + 'px',
    transform: `rotate(${ang}rad)`, fontFamily: CSS_FAMILY[fam], fontWeight: /Bold/.test(e.font) ? 700 : 400, fontStyle: /Italic|Oblique/.test(e.font) ? 'italic' : 'normal',
    fontSize: e.size * sc + 'px', lineHeight: e.leading * sc + 'px', color: e.color,
  });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', ev => { if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); ta.blur(); } ev.stopPropagation(); });
  ta.addEventListener('pointerdown', ev => ev.stopPropagation());
  let done = false;
  ta._commit = () => {
    if (done) return; done = true;
    const t = ta.value.replace(/\s+$/, ''); ta.remove(); S.editing = null;
    const fromBlock = (e.remove || []).length > 0;
    if (isNew && (fromBlock ? t === e.origText : !t.trim())) { S.edits = S.edits.filter(x => x.id !== e.id); S.sel = null; }
    else if (!isNew && !fromBlock && !t.trim()) { S.edits = S.edits.filter(x => x.id !== e.id); S.sel = null; pushUndo(snap); setDirty(); }
    else if (t !== e.text || isNew) {
      e.text = t; pushUndo(snap); setDirty();
      if (hasUnsupported(t)) toast('Some characters are not available in the standard fonts and will be replaced.');
    }
    editChanged(e); renderSelection(); renderProps();
  };
  ta.addEventListener('blur', () => ta._commit());
  pv.ui.appendChild(ta); grow();
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

function popover(pv, anchorBox, html) {
  closeEditors();
  const sb = screenBox(pv, anchorBox), pop = document.createElement('div'); pop.className = 'pop';
  Object.assign(pop.style, { left: clamp(sb[0], 4, Math.max(4, pv.vp.width - 290)) + 'px', top: clamp(sb[3] + 8, 4, Math.max(4, pv.vp.height - 170)) + 'px' });
  pop.innerHTML = html;
  pop.addEventListener('pointerdown', ev => ev.stopPropagation());
  pop.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') pop.remove(); });
  pv.ui.appendChild(pop);
  return pop;
}
function openLinkPopover(pv, rect, existing) {
  const isUrl = existing ? !!existing.url : true;
  const pageNo = existing?.targetPage ? S.pages.findIndex(p => p.id === existing.targetPage) + 1 : '';
  const pop = popover(pv, rect, `<div class="pop-title">${existing ? 'Edit link' : 'New link'}</div>
    <label class="radio"><input type="radio" name="lk" value="url" ${isUrl ? 'checked' : ''}> Web address</label>
    <input type="text" id="lkUrl" placeholder="https://…" value="${esc(existing?.url || '')}">
    <label class="radio"><input type="radio" name="lk" value="page" ${!isUrl ? 'checked' : ''}> Page in this document</label>
    <input type="number" id="lkPage" min="1" max="${S.pages.length}" placeholder="1–${S.pages.length}" value="${pageNo}">
    <div class="row"><button class="btn" type="button" data-act="no">Cancel</button><button class="btn primary" type="button" data-act="ok">${existing ? 'Update' : 'Create link'}</button></div>`);
  const url = pop.querySelector('#lkUrl'), pg = pop.querySelector('#lkPage');
  url.addEventListener('focus', () => { pop.querySelector('[value="url"]').checked = true; });
  pg.addEventListener('focus', () => { pop.querySelector('[value="page"]').checked = true; });
  pop.querySelector('[data-act="no"]').onclick = () => pop.remove();
  pop.querySelector('[data-act="ok"]').onclick = () => {
    const mode = pop.querySelector('input[name="lk"]:checked').value;
    let props;
    if (mode === 'url') {
      let u = url.value.trim(); if (!u) { url.focus(); return; }
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u) ? 'mailto:' : 'https://') + u;
      props = { url: u, targetPage: null };
    } else {
      const n = +pg.value; if (!(n >= 1 && n <= S.pages.length)) { pg.focus(); return; }
      props = { url: '', targetPage: S.pages[n - 1].id };
    }
    pop.remove();
    if (existing) { commit(() => { Object.assign(existing, props, { dirty: true }); }); refreshPage(existing.pageId); renderProps(); }
    else addAnnot(newAnnot('link', pv.page.id, { rect, ...props }), false);
  };
  (isUrl ? url : pg).focus();
}
function openCropPopover(pv, rect) {
  const n = S.selPages.size;
  const pop = popover(pv, rect, `<div class="pop-title">Crop</div><p class="pop-note">Cropping hides the area outside; the content stays in the file.</p>
    <div class="col"><button class="btn" type="button" data-act="this">This page</button>${n > 1 ? `<button class="btn" type="button" data-act="sel">The ${n} selected pages</button>` : ''}<button class="btn" type="button" data-act="all">All pages</button><button class="btn ghost" type="button" data-act="no">Cancel</button></div>`);
  const apply = list => { pop.remove(); commit(() => list.forEach(p => { p.crop = rect.map(v => Math.round(v * 100) / 100); })); for (const p of list) { const v = views.get(p.id); if (v) renderOverlay(v); } rebuildThumbs(); updateStatus(); toast(list.length === 1 ? 'Page cropped.' : `${list.length} pages cropped.`); };
  pop.querySelector('[data-act="this"]').onclick = () => apply([pv.page]);
  pop.querySelector('[data-act="sel"]')?.addEventListener('click', () => apply(S.pages.filter(p => S.selPages.has(p.id))));
  pop.querySelector('[data-act="all"]').onclick = () => apply(S.pages.slice());
  pop.querySelector('[data-act="no"]').onclick = () => pop.remove();
}

/* ------------------------------------------------------------ images, signatures */
function visibleCenter(pv) {
  const d = $('#desk').getBoundingClientRect(), r = pv.el.getBoundingClientRect();
  const x1 = Math.max(d.left, r.left), x2 = Math.min(d.right, r.right), y1 = Math.max(d.top, r.top), y2 = Math.min(d.bottom, r.bottom);
  if (x2 <= x1 || y2 <= y1) return [r.width / 2, r.height / 2];
  return [(x1 + x2) / 2 - r.left, (y1 + y2) / 2 - r.top];
}
export async function readImage(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let kind = /png$/i.test(file.type) ? 'png' : /jpe?g$/i.test(file.type) ? 'jpg' : null, bytes = buf;
  const url = URL.createObjectURL(new Blob([buf], { type: file.type }));
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  if (!kind) {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
    bytes = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer()); kind = 'png';
  }
  const id = uid('i'); S.images.set(id, { bytes, kind, url, w: img.naturalWidth, h: img.naturalHeight });
  return id;
}
export async function addImageFile(file, asContent = false) {
  try {
    const id = await readImage(file), im = S.images.get(id);
    const pv = curView(); if (!pv) return;
    const r = totalRot(pv.page), lw = Math.min(220, im.w * 0.75), lh = lw * im.h / im.w, sc = pv.vp.scale;
    const [cx, cy] = visibleCenter(pv), P = pv.vp.convertToPdfPoint(cx - lw * sc / 2, cy - lh * sc / 2);
    const rect = rectFromAnchor(P, lw, lh, r);
    if (asContent) {
      const p = pv.page, e = { id: uid('e'), kind: 'newimage', src: p.fileId, idx: p.idx, imageId: id, rect, rot: r, opacity: 1 };
      commit(() => S.edits.push(e)); S.sel = e.id; editChanged(e); setTool('editimage'); renderSelection(); renderProps();
    } else addAnnot(newAnnot('stamp', pv.page.id, { rect, rot: r, imageId: id, opacity: 1 }));
  } catch (e) { toast('Could not read the image. Use PNG, JPEG, WebP or GIF.', 'error'); console.error(e); }
}
async function replaceImage(sel, file) {
  try {
    const id = await readImage(file);
    let ed;
    commit(() => {
      if (sel.kind === 'vimage') ed = ensureImageEdit(sel.p, sel.im);
      else ed = sel.e;
      if (ed.kind === 'newimage') ed.imageId = id; else { ed.replaceImageId = id; ed.deleted = false; }
    });
    S.sel = ed.id; editChanged(ed); renderSelection(); renderProps();
  } catch (e) { toast('Could not read the image. Use PNG, JPEG, WebP or GIF.', 'error'); console.error(e); }
}
export function openSignaturePad() {
  modal(`<h2 id="sigTitle">Draw your signature</h2><p>Sign in the box with the mouse, a finger or a pen. It is inserted as vector strokes that you can move and resize.</p><canvas class="pad" id="sigPad"></canvas><div class="row"><button class="btn ghost" type="button" data-act="clear">Clear</button><button class="btn" type="button" data-act="cancel">Cancel</button><button class="btn primary" type="button" data-act="ok">Insert signature</button></div>`, (panel, done) => {
    const c = panel.querySelector('#sigPad'), dpr = window.devicePixelRatio || 1, strokes = []; let cur = null;
    const draw = () => {
      const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, c.width, c.height);
      g.strokeStyle = '#c8ced8'; g.lineWidth = 1; g.beginPath(); g.moveTo(20, c.height / dpr - 40); g.lineTo(c.width / dpr - 20, c.height / dpr - 40); g.stroke();
      g.strokeStyle = '#1b2a7a'; g.lineWidth = 2.4; g.lineCap = g.lineJoin = 'round';
      for (const s of strokes) { g.beginPath(); g.moveTo(s[0], s[1]); for (let i = 2; i < s.length; i += 2) g.lineTo(s[i], s[i + 1]); if (s.length === 2) g.lineTo(s[0] + 0.1, s[1]); g.stroke(); }
    };
    const fit = () => { const r = c.getBoundingClientRect(); c.width = r.width * dpr; c.height = r.height * dpr; draw(); };
    const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.onpointerdown = e => { c.setPointerCapture(e.pointerId); cur = pos(e); strokes.push(cur); draw(); };
    c.onpointermove = e => { if (!cur) return; const [x, y] = pos(e); const n = cur.length; if (Math.hypot(x - cur[n - 2], y - cur[n - 1]) >= 1.5) { cur.push(x, y); draw(); } };
    c.onpointerup = c.onpointercancel = () => { cur = null; };
    requestAnimationFrame(fit);
    panel.querySelector('[data-act="clear"]').onclick = () => { strokes.length = 0; draw(); };
    panel.querySelector('[data-act="cancel"]').onclick = () => { done(null); setTool('select'); };
    panel.querySelector('[data-act="ok"]').onclick = () => {
      if (!strokes.length) { toast('Draw the signature before inserting it.', 'error'); return; }
      const pv = curView(); done(true); setTool('select'); if (!pv) return;
      const b = bboxPts(strokes.flat()), bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
      const k = 150 * pv.vp.scale / Math.max(bw, bh * 2.2);
      const [cx, cy] = visibleCenter(pv);
      const pdfStrokes = strokes.map(s => mapPts(s, (x, y) => pv.vp.convertToPdfPoint(cx + (x - (b[0] + b[2]) / 2) * k, cy + (y - (b[1] + b[3]) / 2) * k)));
      addAnnot(newAnnot('ink', pv.page.id, { strokes: pdfStrokes, width: 1.4, color: '#1b2a7a', opacity: 1, contents: 'Signature' }));
    };
  });
}

/* ------------------------------------------------------------ properties strip */
let propSnap = null;
const swatches = (pal, cur, id = 'pColor') => `<span class="sw" role="group" aria-label="Colour">${pal.map(c => `<button type="button" data-color="${c}" style="background:${c}" aria-label="Colour ${c}" aria-pressed="${cur === c}"></button>`).join('')}<input type="color" id="${id}" value="${cur || '#000000'}" aria-label="Custom colour"></span>`;
const HINTS = {
  select: 'Click a comment to change it. Double-click a text box, a note or a link to rewrite it.',
  edittext: 'Click a block of text on the page to edit it, or click an empty spot to add text.',
  editimage: 'Click an image on the page to move, resize, replace or delete it.',
  redactarea: 'Drag a rectangle over the area to remove. Redactions are applied when you save.',
  redacttext: 'Drag along the text to remove. Redactions are applied when you save.',
  link: 'Drag a rectangle over the area that should open a web address or another page.',
  crop: 'Drag a rectangle over the area to keep. You can apply it to one or more pages.',
};
export function renderProps() {
  const el = $('#props'), s = selected();
  let type = null, obj = null;
  if (s?.kind === 'annot') { obj = s.a; type = s.a.type; }
  else if (s?.kind === 'edit') { obj = s.e; type = { text: 'ctext', image: 'cimage', newimage: 'cnewimage', redact: 'redact' }[s.e.kind]; }
  else if (s?.kind === 'vimage') type = 'cimage';
  else type = TOOL_TYPE[S.tool];
  const author = `<label class="fld">Author <input type="text" id="pAuthor" placeholder="Your name" value="${esc(S.author)}"></label>`;
  if (!type || ((S.tool === 'image' || S.tool === 'sign') && !s) || (type === 'cimage' && !s) || (type === 'ctext' && !s && S.tool !== 'edittext')) {
    el.innerHTML = `<span class="hint">${esc(HINTS[S.tool] || '')}</span>${S.mode === 'comment' ? author : ''}`;
    $('#pAuthor')?.addEventListener('change', e => { S.author = e.target.value.trim(); store('folia.author', S.author); });
    return;
  }
  let h = '';
  const on = (id, ev, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(ev, fn); };
  if (type === 'ctext') {
    const d = obj || DEF.ctext;
    const fam = obj ? (obj.font.startsWith('Times') ? 'serif' : obj.font.startsWith('Courier') ? 'mono' : 'sans') : d.family;
    const bold = obj ? /Bold/.test(obj.font) : d.bold, italic = obj ? /Italic|Oblique/.test(obj.font) : d.italic;
    h += `<span class="what">Page text${obj ? '' : ' <span class="hint">· settings for new text</span>'}</span>
      <label class="fld">Font <select id="pFam"><option value="sans">Sans (Helvetica)</option><option value="serif">Serif (Times)</option><option value="mono">Mono (Courier)</option></select></label>
      <span class="seg"><button type="button" id="pBold" aria-pressed="${bold}" title="Bold"><b>B</b></button><button type="button" id="pItalic" aria-pressed="${italic}" title="Italic"><i>I</i></button></span>
      <label class="fld">Size <input type="number" id="pSize" min="4" max="144" step="0.5" value="${fmt(obj ? obj.size : d.size)}"> pt</label>
      ${swatches(PALETTE, obj ? obj.color : d.color)}`;
    if (obj) h += `<button class="btn" type="button" id="pEditText">Edit text</button>${obj.remove?.length ? `<button class="btn ghost" type="button" id="pRevert">Restore original</button>` : ''}<button class="btn ghost danger-link" type="button" id="pDelete">Delete text</button>`;
    el.innerHTML = h;
    $('#pFam').value = fam;
    const restyle = (f, b, i) => setProp('font', fontName(f, b, i), true, { family: f, bold: b, italic: i });
    on('pFam', 'change', e => restyle(e.target.value, $('#pBold').getAttribute('aria-pressed') === 'true', $('#pItalic').getAttribute('aria-pressed') === 'true'));
    on('pBold', 'click', e => { const v = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', v); restyle($('#pFam').value, v, $('#pItalic').getAttribute('aria-pressed') === 'true'); });
    on('pItalic', 'click', e => { const v = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', v); restyle($('#pFam').value, $('#pBold').getAttribute('aria-pressed') === 'true', v); });
    on('pSize', 'change', e => { const v = clamp(+e.target.value || 12, 4, 144); e.target.value = v; setProp('size', v, true); });
    on('pEditText', 'click', () => openContentEditor(obj));
    on('pRevert', 'click', () => revertEdit(obj));
    on('pDelete', 'click', deleteSelected);
  } else if (type === 'cimage' || type === 'cnewimage') {
    const label = type === 'cnewimage' ? 'Added image' : (obj?.replaceImageId ? 'Replaced image' : 'Page image');
    h += `<span class="what">${label}</span><button class="btn" type="button" id="pReplace">Replace…</button>`;
    if (type === 'cnewimage') h += `<label class="fld">Opacity <input type="range" id="pOpacity" min="10" max="100" step="5" value="${Math.round((obj.opacity ?? 1) * 100)}"><output id="oOpacity">${Math.round((obj.opacity ?? 1) * 100)}%</output></label>`;
    if (obj && type === 'cimage') h += `<button class="btn ghost" type="button" id="pRevert">Restore original</button>`;
    h += `<button class="btn ghost danger-link" type="button" id="pDelete">Delete image</button><span class="hint">Drag to move, use the corners to resize.</span>`;
    el.innerHTML = h;
    on('pReplace', 'click', () => { const inp = $('#fileReplace'); inp.value = ''; inp.onchange = () => { if (inp.files[0]) replaceImage(selected(), inp.files[0]); }; inp.click(); });
    on('pRevert', 'click', () => revertEdit(obj));
    on('pDelete', 'click', deleteSelected);
    on('pOpacity', 'input', e => { setProp('opacity', e.target.value / 100, false); $('#oOpacity').textContent = e.target.value + '%'; }); on('pOpacity', 'change', e => setProp('opacity', e.target.value / 100, true));
  } else if (type === 'redact') {
    const fill = obj ? obj.fill : DEF.redact.fill;
    h += `<span class="what">Redaction${obj ? '' : ' <span class="hint">· drag on the page</span>'}</span>
      <label class="fld">Fill <select id="pFill"><option value="#000000">Black</option><option value="#ffffff">White</option><option value="none">None (remove only)</option></select></label>
      <label class="fld"><input type="checkbox" id="pRedPrev" ${S.showRedactPreview ? 'checked' : ''}> Show final result</label>`;
    if (obj) h += `<button class="btn ghost danger-link" type="button" id="pDelete">Remove mark</button>`;
    h += `<span class="hint">Text, images and graphics under the marked areas are removed from the file when you save.</span>`;
    el.innerHTML = h;
    $('#pFill').value = fill || '#000000';
    on('pFill', 'change', e => setProp('fill', e.target.value, true));
    on('pRedPrev', 'change', e => { S.showRedactPreview = e.target.checked; refreshOverlays(); });
    on('pDelete', 'click', deleteSelected);
  } else if (type === 'link') {
    h += `<span class="what">Link</span>`;
    if (obj) {
      const tgt = obj.url ? esc(obj.url) : (obj.targetPage && S.pages.findIndex(p => p.id === obj.targetPage) >= 0 ? `page ${S.pages.findIndex(p => p.id === obj.targetPage) + 1}` : 'a deleted page');
      h += `<span class="hint">Opens ${tgt}</span><button class="btn" type="button" id="pEditLink">Change destination</button><button class="btn ghost danger-link" type="button" id="pDelete">Delete</button>`;
    } else h += `<span class="hint">${esc(HINTS.link)}</span>`;
    el.innerHTML = h;
    on('pEditLink', 'click', () => { const pv = views.get(obj.pageId); if (pv) openLinkPopover(pv, obj.rect, obj); });
    on('pDelete', 'click', deleteSelected);
  } else {
    const d = obj || DEF[type] || {}, label = obj && obj.type === 'line' && obj.arrow ? 'Arrow' : (S.tool === 'arrow' && !obj ? 'Arrow' : TYPE_LABEL[type]);
    const pal = type === 'highlight' ? HL_PALETTE : PALETTE;
    h += `<span class="what">${esc(label)}${obj ? '' : ' <span class="hint">· settings</span>'}</span>`;
    if (type !== 'stamp') h += swatches(pal, d.color);
    if (['ink', 'rect', 'ellipse', 'line'].includes(type)) h += `<label class="fld">Width <input type="range" id="pWidth" min="0.5" max="12" step="0.5" value="${d.width}"><output id="oWidth">${fmt(d.width)} pt</output></label>`;
    if (['ink', 'rect', 'ellipse', 'line', 'highlight', 'underline', 'strike', 'stamp'].includes(type)) h += `<label class="fld">Opacity <input type="range" id="pOpacity" min="10" max="100" step="5" value="${Math.round((d.opacity ?? 1) * 100)}"><output id="oOpacity">${Math.round((d.opacity ?? 1) * 100)}%</output></label>`;
    if (type === 'rect' || type === 'ellipse') h += `<label class="fld"><input type="checkbox" id="pFillOn" ${d.fill ? 'checked' : ''}> Fill</label><span class="sw"><input type="color" id="pFill" value="${d.fill || '#fff3b0'}" aria-label="Fill colour"></span>`;
    if (type === 'text') h += `<label class="fld">Size <input type="number" id="pSize" min="5" max="96" step="1" value="${fmt(d.size)}"> pt</label>`;
    if (obj && type !== 'text' && type !== 'note') h += `<label class="fld">Comment <input type="text" id="pComment" placeholder="Shown in PDF readers" value="${esc(obj.contents || '')}"></label>`;
    if (obj && type === 'note') h += `<button class="btn" type="button" id="pEditNote">Edit note</button>`;
    if (obj && type === 'text') h += `<button class="btn" type="button" id="pEditText">Edit text</button>`;
    if (obj) h += `<button class="btn ghost danger-link" type="button" id="pDelete">Delete</button>`;
    el.innerHTML = h;
    on('pWidth', 'input', e => { setProp('width', +e.target.value, false); $('#oWidth').textContent = fmt(+e.target.value) + ' pt'; }); on('pWidth', 'change', e => setProp('width', +e.target.value, true));
    on('pOpacity', 'input', e => { setProp('opacity', e.target.value / 100, false); $('#oOpacity').textContent = e.target.value + '%'; }); on('pOpacity', 'change', e => setProp('opacity', e.target.value / 100, true));
    on('pFillOn', 'change', e => setProp('fill', e.target.checked ? $('#pFill').value : null, true));
    on('pFill', 'input', e => { $('#pFillOn').checked = true; setProp('fill', e.target.value, false); }); on('pFill', 'change', e => setProp('fill', e.target.value, true));
    on('pSize', 'change', e => { const v = clamp(+e.target.value || 12, 5, 96); e.target.value = v; setProp('size', v, true); });
    on('pComment', 'input', e => setProp('contents', e.target.value, false)); on('pComment', 'change', e => setProp('contents', e.target.value, true));
    on('pEditNote', 'click', () => openNoteEditor(obj));
    on('pEditText', 'click', () => openTextEditor(obj));
    on('pDelete', 'click', deleteSelected);
  }
  el.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { setProp('color', b.dataset.color, true); el.querySelectorAll('[data-color]').forEach(x => x.setAttribute('aria-pressed', x === b)); $('#pColor').value = b.dataset.color; });
  on('pColor', 'input', e => setProp('color', e.target.value, false)); on('pColor', 'change', e => setProp('color', e.target.value, true));
}
function setProp(key, val, final, extra = {}) {
  const s = selected();
  const target = s?.kind === 'annot' ? s.a : s?.kind === 'edit' ? s.e : null;
  if (target) {
    if (!propSnap) propSnap = snapshot();
    target[key] = val; Object.assign(target, extra);
    if (s.kind === 'annot') { target.dirty = true; if (target.type === 'text' && key === 'size') fitText(target); refreshPage(target.pageId); }
    else if (final) editChanged(target); else refreshEdit(target);
    renderSelection();
    if (final) { pushUndo(propSnap); propSnap = null; setDirty(); }
  }
  // defaults for new objects
  const type = s?.kind === 'annot' ? s.a.type : s?.kind === 'edit' ? { text: 'ctext', redact: 'redact' }[s.e.kind] : TOOL_TYPE[S.tool];
  if (type === 'ctext') { if (key === 'font') Object.assign(DEF.ctext, extra); else if (key === 'size' || key === 'color') DEF.ctext[key] = val; }
  else if (key !== 'contents' && DEF[type] && !(s?.a?.type === 'ink' && s.a.contents === 'Signature')) DEF[type][key] = val;
  if (final) store('folia.defaults', JSON.stringify(DEF));
}

/* ------------------------------------------------------------ tools */
export function setTool(t) {
  if (t === 'image') { const f = $('#fileImg'); f.value = ''; f.dataset.content = ''; f.click(); return; }
  if (t === 'addimage') { const f = $('#fileImg'); f.value = ''; f.dataset.content = '1'; f.click(); return; }
  if (t === 'sign') { closeEditors(); select(null); openSignaturePad(); return; }
  closeEditors();
  S.tool = t; document.body.dataset.tool = t;
  $$('#tools [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === t));
  if (t !== 'select' && t !== 'edittext' && t !== 'editimage') { S.sel = null; renderSelection(); }
  for (const pv of views.values()) { pv.ui.querySelectorAll('.hover-box').forEach(n => n.remove()); pv.el.style.cursor = ''; }
  if ((t === 'edittext' || t === 'redactarea' || t === 'redacttext') && !engine.engine.available) {
    engine.startEngine().then(ok => { updateStatus(); if (!ok) toast('This tool needs the MuPDF engine, which did not load.', 'error'); });
  }
  if (t === 'edittext') { const pv = curView(); if (pv) pageBlocks(pv.page); }
  renderProps();
}
