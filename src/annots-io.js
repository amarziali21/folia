// Reading and writing native PDF annotations (comments and links).
import { L, N } from './lib.js';
import { uid, clamp, fmt, norm, rgbToHex, hexToRgb, rgbOp, bboxPts, inflate, normBox } from './util.js';
import {
  frame, textLayout, ROT, PAD, LEADING, BASE, strokeSegs, ellipseSegs, arrowPts, NOTE_BUBBLE, NOTE_LINES,
  pdfPath, quadPoly, quadLine, quadHeight,
} from './geometry.js';

const lk = (ctx, v) => v instanceof L.PDFRef ? ctx.lookup(v) : v;
const numOf = (ctx, v) => { v = lk(ctx, v); return v instanceof L.PDFNumber ? v.asNumber() : NaN; };
const gNum = (ctx, d, k, def) => { const v = lk(ctx, d.get(N(k))); return v instanceof L.PDFNumber ? v.asNumber() : def; };
const gNums = (ctx, d, k) => { const v = lk(ctx, d.get(N(k))); if (!(v instanceof L.PDFArray)) return null; const r = v.asArray().map(x => numOf(ctx, x)); return r.every(Number.isFinite) ? r : null; };
export const nameOf = v => v instanceof L.PDFName ? v.decodeText() : null;
const gName = (ctx, d, k) => nameOf(lk(ctx, d.get(N(k))));
const gText = (ctx, d, k) => { const v = lk(ctx, d.get(N(k))); return (v instanceof L.PDFString || v instanceof L.PDFHexString) ? v.decodeText() : null; };
export const refStr = r => `${r.objectNumber} ${r.generationNumber}`;
export const strRef = s => { const [n, g] = s.split(' ').map(Number); return L.PDFRef.of(n, g); };

function borderWidth(ctx, d) {
  const bs = lk(ctx, d.get(N('BS')));
  if (bs instanceof L.PDFDict) { const w = gNum(ctx, bs, 'W', NaN); if (Number.isFinite(w)) return w; }
  const b = gNums(ctx, d, 'Border'); if (b && b.length >= 3) return b[2];
  return null;
}
function apRot(ctx, d) {
  const ap = lk(ctx, d.get(N('AP'))); if (!(ap instanceof L.PDFDict)) return 0;
  const n = lk(ctx, ap.get(N('N'))); const dict = n instanceof L.PDFDict ? n : n?.dict; if (!(dict instanceof L.PDFDict)) return 0;
  const m = gNums(ctx, dict, 'Matrix'); if (!m || m.length < 4) return 0;
  const ang = Math.atan2(m[1], m[0]);
  return Math.abs(Math.cos(ang)) < 1e-3 || Math.abs(Math.sin(ang)) < 1e-3 ? norm(ang * 180 / Math.PI) : 0;
}
function linkTarget(ctx, d, pageRefs) {
  let dest = lk(ctx, d.get(N('Dest')));
  const a = lk(ctx, d.get(N('A')));
  if (!dest && a instanceof L.PDFDict) {
    const s = gName(ctx, a, 'S');
    if (s === 'URI') { const u = gText(ctx, a, 'URI'); return u ? { url: u } : null; }
    if (s === 'GoTo') dest = lk(ctx, a.get(N('D')));
    else return null;
  }
  if (dest instanceof L.PDFArray) {
    const first = dest.get(0);
    if (first instanceof L.PDFRef) { const i = pageRefs.get(refStr(first)); return i === undefined ? null : { pageIdx: i }; }
    if (first instanceof L.PDFNumber) return { pageIdx: first.asNumber() };
  }
  return null;
}

const SUPPORTED = ['Highlight', 'Underline', 'StrikeOut', 'Ink', 'Square', 'Circle', 'Line', 'FreeText', 'Text', 'Link'];
export function parseAnnot(ctx, d, pageRefs) {
  const st = gName(ctx, d, 'Subtype');
  if (!SUPPORTED.includes(st)) return null;
  if (gNum(ctx, d, 'F', 0) & 2) return null;
  if (d.get(N('IRT'))) return null;
  const color = rgbToHex(gNums(ctx, d, 'C'));
  const base = { id: uid(), color: color || '#000000', opacity: clamp(gNum(ctx, d, 'CA', 1), 0, 1), contents: gText(ctx, d, 'Contents') || '',
    author: gText(ctx, d, 'T') || '', nm: gText(ctx, d, 'NM') || uid('mg-'), dirty: false };
  const w = borderWidth(ctx, d);
  const r0 = gNums(ctx, d, 'Rect'); const rect = r0 && r0.length === 4 ? normBox(...r0) : null;
  switch (st) {
    case 'Highlight': case 'Underline': case 'StrikeOut': {
      const q = gNums(ctx, d, 'QuadPoints'); if (!q || q.length < 8 || q.length % 8) return null;
      const quads = []; for (let i = 0; i < q.length; i += 8) quads.push(q.slice(i, i + 8));
      const type = st === 'Highlight' ? 'highlight' : st === 'Underline' ? 'underline' : 'strike';
      return { ...base, type, quads, color: color || (type === 'highlight' ? '#ffd400' : '#d92d20') };
    }
    case 'Ink': {
      const il = lk(ctx, d.get(N('InkList'))); if (!(il instanceof L.PDFArray)) return null;
      const strokes = il.asArray().map(s => { s = lk(ctx, s); return s instanceof L.PDFArray ? s.asArray().map(x => numOf(ctx, x)) : []; })
        .filter(s => s.length >= 2 && s.length % 2 === 0 && s.every(Number.isFinite));
      if (!strokes.length) return null;
      return { ...base, type: 'ink', strokes, width: w ?? 1 };
    }
    case 'Square': case 'Circle': {
      if (!rect || d.get(N('BE'))) return null;
      const ww = w ?? 1, rd = gNums(ctx, d, 'RD'), ins = rd && rd.length === 4 ? rd : [ww / 2, ww / 2, ww / 2, ww / 2];
      const r = [rect[0] + ins[0], rect[1] + ins[1], rect[2] - ins[2], rect[3] - ins[3]];
      if (r[2] <= r[0] || r[3] <= r[1]) return null;
      return { ...base, type: st === 'Square' ? 'rect' : 'ellipse', rect: r, width: ww, fill: rgbToHex(gNums(ctx, d, 'IC')) };
    }
    case 'Line': {
      const l = gNums(ctx, d, 'L'); if (!l || l.length !== 4 || d.get(N('LL'))) return null;
      const le = lk(ctx, d.get(N('LE'))); let s = 'None', e = 'None';
      if (le instanceof L.PDFArray) { s = nameOf(lk(ctx, le.get(0))) || 'None'; e = nameOf(lk(ctx, le.get(1))) || 'None'; }
      if (s !== 'None' || !['None', 'OpenArrow', 'ClosedArrow'].includes(e)) return null;
      return { ...base, type: 'line', pts: l, width: w ?? 1, arrow: e !== 'None' };
    }
    case 'FreeText': {
      if (!rect) return null;
      const it = gName(ctx, d, 'IT'); if ((it && it !== 'FreeText') || d.get(N('CL'))) return null;
      const rot = gNum(ctx, d, 'Rotate', NaN); if (Number.isFinite(rot) && rot % 90) return null;
      const da = gText(ctx, d, 'DA') || '', ds = gText(ctx, d, 'DS') || '';
      const size = parseFloat((da.match(/([\d.]+)\s+Tf/) || [])[1]) || parseFloat((ds.match(/([\d.]+)\s*pt/) || [])[1]) || 12;
      let col = (ds.match(/color\s*:\s*(#[0-9a-f]{6})/i) || [])[1];
      if (!col) { const m = [...da.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/g)].pop(); if (m) col = rgbToHex([+m[1], +m[2], +m[3]]); else { const g = da.match(/([\d.]+)\s+g\b/); if (g) col = rgbToHex([+g[1]]); } }
      return { ...base, type: 'text', rect, rot: Number.isFinite(rot) ? norm(rot) : apRot(ctx, d), text: base.contents, contents: '', size: clamp(size, 4, 144), color: col || '#000000' };
    }
    case 'Text':
      if (!rect) return null;
      return { ...base, type: 'note', rect, rot: apRot(ctx, d), color: color || '#f5b400' };
    case 'Link': {
      if (!rect) return null;
      const t = linkTarget(ctx, d, pageRefs); if (!t) return null;
      return { ...base, type: 'link', rect, color: '#2346c4', url: t.url || '', targetIdx: t.pageIdx ?? null, targetPage: null };
    }
  }
  return null;
}

// Lifts the supported annotations out of the pages (so the viewer does not draw them twice) and returns
// them as model objects. Untouched ones are written back byte for byte on save.
export function importAnnots(lib) {
  const ctx = lib.context, found = [], pageRefs = new Map();
  lib.getPages().forEach((p, i) => pageRefs.set(refStr(p.ref), i));
  lib.getPages().forEach((page, idx) => {
    const arr = page.node.Annots(); if (!arr) return;
    const entries = arr.asArray(), drop = new Set(), here = [];
    for (const ref of entries) {
      if (!(ref instanceof L.PDFRef)) continue;
      const d = ctx.lookup(ref); if (!(d instanceof L.PDFDict)) continue;
      let m = null; try { m = parseAnnot(ctx, d, pageRefs); } catch { m = null; }
      if (!m) continue;
      const pop = d.get(N('Popup'));
      m.origRef = refStr(ref); m.popupRef = pop instanceof L.PDFRef ? refStr(pop) : null; m.pageIdx = idx;
      if (m.type === 'link') { m.origRef = null; m.dirty = true; } // links are rewritten so their targets follow the new page order
      drop.add(refStr(ref)); if (m.popupRef) drop.add(m.popupRef);
      here.push(m);
    }
    if (!here.length) return;
    page.node.set(N('Annots'), ctx.obj(entries.filter(e => !(e instanceof L.PDFRef && drop.has(refStr(e))))));
    found.push(...here);
  });
  return found;
}

/* ---------- writing ---------- */
export function makeRes(doc, images) {
  let font = null; const imgs = new Map();
  return {
    font: async () => font || (font = await doc.embedFont(L.StandardFonts.Helvetica)),
    image: async id => { if (imgs.has(id)) return imgs.get(id); const im = images.get(id); const e = im.kind === 'jpg' ? await doc.embedJpg(im.bytes) : await doc.embedPng(im.bytes); imgs.set(id, e); return e; },
  };
}
function apForm(ctx, content, bbox, resources, matrix) {
  const dict = { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox.map(v => +fmt(v)) };
  if (matrix) dict.Matrix = matrix;
  if (resources) dict.Resources = resources;
  return ctx.register(ctx.flateStream(content, dict));
}
const gsRes = (op, extra = {}) => ({ ExtGState: { GS0: { Type: 'ExtGState', CA: +fmt(op), ca: +fmt(op), ...extra } } });

// opts.pageRef(pageId) -> PDFRef of the target page in the output document (links)
export async function writeAnnot(doc, page, a, res, opts = {}) {
  const ctx = doc.context;
  const d = { Type: 'Annot', F: 4, P: page.ref, M: L.PDFString.fromDate(new Date()), NM: L.PDFString.of(String(a.nm || uid('mg-')).replace(/[()\\]/g, '')) };
  if (a.author && a.type !== 'link') d.T = L.PDFHexString.fromText(a.author);
  if (a.contents && a.type !== 'text' && a.type !== 'link') d.Contents = L.PDFHexString.fromText(a.contents);
  const C = hexToRgb(a.color).map(v => +fmt(v)), op = a.opacity ?? 1;
  let rect, ap;
  switch (a.type) {
    case 'highlight': {
      rect = inflate(bboxPts(a.quads.flat()), 0.5);
      const content = `/GS0 gs ${rgbOp(a.color)} ` + a.quads.map(q => pdfPath(quadPoly(q))).join(' ') + ' f';
      ap = apForm(ctx, content, rect, gsRes(op, { BM: 'Multiply' }));
      Object.assign(d, { Subtype: 'Highlight', QuadPoints: a.quads.flat().map(v => +fmt(v)), C, CA: +fmt(op) });
      break;
    }
    case 'underline': case 'strike': {
      rect = inflate(bboxPts(a.quads.flat()), 1);
      const content = `/GS0 gs ${rgbOp(a.color, true)} 1 J ` + a.quads.map(q => { const [x1, y1, x2, y2] = quadLine(q, a.type); return `${fmt(Math.max(0.6, quadHeight(q) * 0.07))} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`; }).join(' ');
      ap = apForm(ctx, content, rect, gsRes(op));
      Object.assign(d, { Subtype: a.type === 'underline' ? 'Underline' : 'StrikeOut', QuadPoints: a.quads.flat().map(v => +fmt(v)), C, CA: +fmt(op) });
      break;
    }
    case 'ink': {
      rect = inflate(bboxPts(a.strokes.flat()), a.width / 2 + 1);
      const content = `/GS0 gs ${fmt(a.width)} w 1 J 1 j ${rgbOp(a.color, true)} ` + a.strokes.map(s => pdfPath(strokeSegs(s)) + ' S').join(' ');
      ap = apForm(ctx, content, rect, gsRes(op));
      Object.assign(d, { Subtype: 'Ink', InkList: a.strokes.map(s => s.map(v => +fmt(v))), BS: { W: +fmt(a.width), S: 'S' }, C, CA: +fmt(op) });
      break;
    }
    case 'rect': case 'ellipse': {
      const inset = a.width / 2 + 0.5; rect = inflate(a.rect, inset);
      const [x1, y1, x2, y2] = a.rect;
      const shape = a.type === 'rect' ? `${fmt(x1)} ${fmt(y1)} ${fmt(x2 - x1)} ${fmt(y2 - y1)} re` : pdfPath(ellipseSegs(a.rect));
      const content = `/GS0 gs ${fmt(a.width)} w ${rgbOp(a.color, true)} ` + (a.fill ? `${rgbOp(a.fill)} ` : '') + shape + (a.fill ? ' B' : ' S');
      ap = apForm(ctx, content, rect, gsRes(op));
      Object.assign(d, { Subtype: a.type === 'rect' ? 'Square' : 'Circle', BS: { W: +fmt(a.width), S: 'S' }, RD: [inset, inset, inset, inset].map(v => +fmt(v)), C, CA: +fmt(op) });
      if (a.fill) d.IC = hexToRgb(a.fill).map(v => +fmt(v));
      break;
    }
    case 'line': {
      const ah = a.arrow ? arrowPts(a.pts, a.width) : [];
      rect = inflate(bboxPts([...a.pts, ...ah]), a.width + 1);
      let content = `/GS0 gs ${fmt(a.width)} w 1 J 1 j ${rgbOp(a.color, true)} ${fmt(a.pts[0])} ${fmt(a.pts[1])} m ${fmt(a.pts[2])} ${fmt(a.pts[3])} l S`;
      if (a.arrow) content += ` ${fmt(ah[0])} ${fmt(ah[1])} m ${fmt(ah[2])} ${fmt(ah[3])} l ${fmt(ah[4])} ${fmt(ah[5])} l S`;
      ap = apForm(ctx, content, rect, gsRes(op));
      Object.assign(d, { Subtype: 'Line', L: a.pts.map(v => +fmt(v)), LE: ['None', a.arrow ? 'OpenArrow' : 'None'], BS: { W: +fmt(a.width), S: 'S' }, C, CA: +fmt(op) });
      break;
    }
    case 'text': {
      const font = await res.font();
      const { lines, f } = textLayout(a);
      const s = a.size, lead = s * LEADING;
      const body = lines.map((ln, i) => (i ? `0 ${fmt(-lead)} Td ` : '') + `${font.encodeText(ln).toString()} Tj`).join(' ');
      const content = `/Tx BMC q BT /Helv ${fmt(s)} Tf ${rgbOp(a.color)} ${fmt(PAD)} ${fmt(f.lh - PAD - s * BASE)} Td ${body} ET Q EMC`;
      rect = a.rect;
      ap = apForm(ctx, content, [0, 0, f.lw, f.lh], { Font: { Helv: font.ref } }, f.r ? [...ROT[f.r], 0, 0] : null);
      Object.assign(d, { Subtype: 'FreeText', Contents: L.PDFHexString.fromText(a.text || ''),
        DA: L.PDFString.of(`${rgbOp(a.color)} /Helv ${fmt(s)} Tf`),
        DS: L.PDFString.of(`font: Helvetica,sans-serif ${fmt(s)}pt;text-align:left;color:${a.color}`), BS: { W: 0 } });
      if (f.r) d.Rotate = f.r;
      break;
    }
    case 'note': {
      const f = frame(a); rect = a.rect;
      const sc = `${fmt(f.lw / 20)} 0 0 ${fmt(f.lh / 20)} 0 0 cm`;
      const content = `q ${sc} ${rgbOp(a.color)} 0.22 0.22 0.22 RG 0.9 w 1 j ${pdfPath(NOTE_BUBBLE)} B 1.1 w 1 J ${pdfPath(NOTE_LINES)} S Q`;
      ap = apForm(ctx, content, [0, 0, f.lw, f.lh], null, f.r ? [...ROT[f.r], 0, 0] : null);
      Object.assign(d, { Subtype: 'Text', Name: 'Comment', Open: false, C });
      break;
    }
    case 'stamp': {
      const img = await res.image(a.imageId), f = frame(a); rect = a.rect;
      const content = `/GS0 gs q ${fmt(f.lw)} 0 0 ${fmt(f.lh)} 0 0 cm /Im0 Do Q`;
      ap = apForm(ctx, content, [0, 0, f.lw, f.lh], { XObject: { Im0: img.ref }, ...gsRes(op) }, f.r ? [...ROT[f.r], 0, 0] : null);
      Object.assign(d, { Subtype: 'Stamp', Name: 'Image', CA: +fmt(op) });
      if (f.r) d.Rotate = f.r;
      break;
    }
    case 'link': {
      rect = a.rect;
      Object.assign(d, { Subtype: 'Link', Border: [0, 0, 0], H: 'I' });
      delete d.M;
      if (a.url) d.A = { S: 'URI', URI: L.PDFString.of(a.url) };
      else {
        const target = a.targetPage && opts.pageRef ? opts.pageRef(a.targetPage) : null;
        if (!target) return; // target page not in this document
        d.Dest = [target, 'XYZ', null, null, null];
      }
      break;
    }
    default: return;
  }
  d.Rect = rect.map(v => +fmt(v));
  if (ap) d.AP = { N: ap };
  const obj = ctx.obj(d);
  if (d.Dest) obj.set(N('Dest'), ctx.obj([d.Dest[0], N('XYZ'), L.PDFNull, L.PDFNull, L.PDFNull]));
  const ref = ctx.register(obj);
  page.node.addAnnot(ref);
}
