// Page content streams: a small tokenizer that finds the images a page draws (with their placement),
// rewrites those drawing operators to move, resize or delete images, and helpers that append new content
// (text, images, filled boxes) to a page.
import { L, N } from './lib.js';
import { apply, mul, inv, boxOfMatrix, mStr, fmt, rgbOp, hexToRgb, IDENT } from './util.js';
import { contentLayout, frame } from './geometry.js';
import { cleanText } from './fonts.js';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

/* ---------- reading ---------- */
function streamBytes(ctx, obj) {
  const s = obj instanceof L.PDFRef ? ctx.lookup(obj) : obj;
  if (!s) return new Uint8Array(0);
  if (s instanceof L.PDFRawStream) return L.decodePDFRawStream(s).decode();
  if (typeof s.getContents === 'function') return s.getContents(); // PDFContentStream / PDFFlateStream (unencoded)
  return new Uint8Array(0);
}
export function pageContentBytes(page) {
  const ctx = page.doc.context, c = page.node.get(N('Contents'));
  const parts = [];
  const obj = c instanceof L.PDFRef ? ctx.lookup(c) : c;
  if (obj instanceof L.PDFArray) for (const r of obj.asArray()) parts.push(streamBytes(ctx, r));
  else if (obj) parts.push(streamBytes(ctx, c));
  const total = parts.reduce((s, p) => s + p.length + 1, 0), out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}

// Tokenize a content stream into operators with their operand tokens and byte range.
export function tokenize(bytes) {
  const ops = [], n = bytes.length;
  let i = 0, args = [], opStart = -1;
  const str = (a, b) => { let s = ''; for (let k = a; k < b; k++) s += String.fromCharCode(bytes[k]); return s; };
  while (i < n) {
    const c = bytes[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++; continue; } // comment
    const start = i;
    if (opStart < 0) opStart = start;
    if (c === 40) { // literal string
      let depth = 0;
      for (; i < n; i++) {
        const b = bytes[i];
        if (b === 92) { i++; continue; }
        if (b === 40) depth++;
        else if (b === 41) { depth--; if (depth === 0) { i++; break; } }
      }
      args.push({ t: 'str', s: start, e: i }); continue;
    }
    if (c === 60 && bytes[i + 1] === 60) { args.push({ t: 'delim', v: '<<' }); i += 2; continue; }
    if (c === 62 && bytes[i + 1] === 62) { args.push({ t: 'delim', v: '>>' }); i += 2; continue; }
    if (c === 60) { while (i < n && bytes[i] !== 62) i++; i++; args.push({ t: 'hex', s: start, e: i }); continue; }
    if (c === 91 || c === 93 || c === 123 || c === 125) { args.push({ t: 'delim', v: String.fromCharCode(c) }); i++; continue; }
    if (c === 47) { // name
      i++; while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++;
      args.push({ t: 'name', v: str(start + 1, i).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }); continue;
    }
    // number or operator keyword
    while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++;
    if (i === start) { i++; continue; } // stray delimiter
    const word = str(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { args.push({ t: 'num', v: parseFloat(word) }); continue; }
    if (word === 'true' || word === 'false' || word === 'null') { args.push({ t: 'kw', v: word }); continue; }
    if (word === 'BI') { // inline image: skip to EI
      let j = i;
      while (j < n) {
        if (bytes[j] === 73 && bytes[j + 1] === 68 && WS.has(bytes[j - 1]) && (j + 2 >= n || WS.has(bytes[j + 2]))) { j += 3; break; }
        j++;
      }
      while (j < n) {
        if (bytes[j] === 69 && bytes[j + 1] === 73 && WS.has(bytes[j - 1]) && (j + 2 >= n || WS.has(bytes[j + 2]) )) { j += 2; break; }
        j++;
      }
      ops.push({ op: 'BI', args: [], s: opStart, e: j }); args = []; opStart = -1; i = j; continue;
    }
    ops.push({ op: word, args, s: opStart, e: i });
    args = []; opStart = -1;
  }
  return ops;
}

function lookupXObject(ctx, resources, name) {
  if (!(resources instanceof L.PDFDict)) return null;
  const xo = resources.lookupMaybe(N('XObject'), L.PDFDict); if (!xo) return null;
  const ref = xo.get(N(name)); const obj = ref instanceof L.PDFRef ? ctx.lookup(ref) : ref;
  return obj ? { ref, obj } : null;
}
const subtypeOf = obj => { const d = obj?.dict; const st = d && d.get(N('Subtype')); return st instanceof L.PDFName ? st.decodeText() : null; };

// Images drawn directly by the page content (not inside form XObjects), with their user-space placement.
export function pageImages(page) {
  const ctx = page.doc.context;
  const resources = page.node.getInheritableAttribute(N('Resources'));
  const res = resources instanceof L.PDFRef ? ctx.lookup(resources) : resources;
  const ops = tokenize(pageContentBytes(page));
  const out = []; let ctm = IDENT.slice(); const stack = [];
  ops.forEach((o, k) => {
    if (o.op === 'q') stack.push(ctm.slice());
    else if (o.op === 'Q') ctm = stack.pop() || IDENT.slice();
    else if (o.op === 'cm' && o.args.length === 6 && o.args.every(a => a.t === 'num')) ctm = mul(o.args.map(a => a.v), ctm);
    else if (o.op === 'Do' && o.args[0]?.t === 'name') {
      const x = lookupXObject(ctx, res, o.args[0].v);
      if (x && subtypeOf(x.obj) === 'Image') {
        const w = x.obj.dict.lookup(N('Width')), h = x.obj.dict.lookup(N('Height'));
        out.push({ op: k, name: o.args[0].v, ctm: ctm.slice(), bbox: boxOfMatrix(ctm), px: [w?.asNumber?.() || 0, h?.asNumber?.() || 0] });
      }
    }
  });
  return out;
}

/* ---------- rewriting image operators ---------- */
const sameM = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3 * Math.max(1, Math.abs(v)));
// edits: [{ op, name, ctm, A, deleted }] where A is a user-space affine applied after the original placement.
export function applyImageEdits(page, edits) {
  if (!edits.length) return 0;
  const bytes = pageContentBytes(page), ops = tokenize(bytes);
  const repl = [], found = pageImages(page);
  for (const e of edits) {
    const o = ops[e.op];
    if (!o || o.op !== 'Do' || o.args[0]?.v !== e.name) continue;
    const im = found.find(x => x.op === e.op);
    if (!im || !sameM(im.ctm, e.ctm)) continue;
    let text = '';
    if (!e.deleted && e.A) {
      const X = mul(mul(e.ctm, e.A), inv(e.ctm));
      text = `q ${mStr(X)} cm /${e.name} Do Q`;
    } else if (!e.deleted) continue;
    repl.push({ s: o.s, e: o.e, text });
  }
  if (!repl.length) return 0;
  repl.sort((a, b) => b.s - a.s);
  let out = bytes;
  for (const r of repl) {
    const t = new TextEncoder().encode(' ' + r.text + ' ');
    const nb = new Uint8Array(out.length - (r.e - r.s) + t.length);
    nb.set(out.subarray(0, r.s), 0); nb.set(t, r.s); nb.set(out.subarray(r.e), r.s + t.length);
    out = nb;
  }
  const ctx = page.doc.context;
  page.node.set(N('Contents'), ctx.obj([ctx.register(ctx.flateStream(out))]));
  return repl.length;
}

/* ---------- appending content ---------- */
function makeCache(doc) {
  if (!doc._mg) doc._mg = { fonts: new Map(), images: new Map(), gs: new Map() };
  return doc._mg;
}
async function fontKey(doc, page, name) {
  const c = makeCache(doc);
  if (!c.fonts.has(name)) c.fonts.set(name, await doc.embedFont(name));
  const font = c.fonts.get(name);
  return { font, key: page.node.newFontDictionary('MgF', font.ref).asString().slice(1) };
}
function gsKey(doc, page, opacity) {
  const c = makeCache(doc), k = fmt(opacity);
  if (!c.gs.has(k)) c.gs.set(k, doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: +k, ca: +k })));
  return page.node.newExtGState('MgGS', c.gs.get(k)).asString().slice(1);
}
export async function imageKey(doc, page, im) {
  const c = makeCache(doc);
  if (!c.images.has(im.id)) c.images.set(im.id, im.kind === 'jpg' ? await doc.embedJpg(im.bytes) : await doc.embedPng(im.bytes));
  const img = c.images.get(im.id);
  return page.node.newXObject('MgIm', img.ref).asString().slice(1);
}
export function appendContent(page, text, { behind = false } = {}) {
  const ctx = page.doc.context;
  page.node.normalize();
  const ref = ctx.register(ctx.flateStream(text));
  const arr = page.node.Contents();
  if (behind && arr instanceof L.PDFArray) arr.insert(0, ref);
  else page.node.addContentStream(ref);
}

export async function textOps(doc, page, e, opacity = 1) {
  const { font, key } = await fontKey(doc, page, e.font);
  const { lines, m } = contentLayout(e);
  if (!lines.length) return '';
  const gs = opacity < 1 ? `/${gsKey(doc, page, opacity)} gs ` : '';
  const body = lines.map((ln, i) => (i ? `0 ${fmt(-e.leading)} Td ` : '') + `${font.encodeText(cleanText(ln)).toString()} Tj`).join(' ');
  return `q ${gs}${mStr(m)} cm BT /${key} ${fmt(e.size)} Tf ${rgbOp(e.color)} 0 0 Td ${body} ET Q`;
}
export async function imageOps(doc, page, im, M, opacity = 1) { // M maps the unit square to user space
  const key = await imageKey(doc, page, im);
  const gs = opacity < 1 ? `/${gsKey(doc, page, opacity)} gs ` : '';
  return `q ${gs}${mStr(M)} cm /${key} Do Q`;
}
export function fillOps(rects, color) {
  if (!rects.length) return '';
  return `q ${rgbOp(color)} ` + rects.map(r => `${fmt(r[0])} ${fmt(r[1])} ${fmt(r[2] - r[0])} ${fmt(r[3] - r[1])} re`).join(' ') + ' f Q';
}
// Unit-square matrix for an image in rect, upright for a page displayed with `rot`.
export function uprightImageMatrix(rect, rot) {
  const f = frame({ rect, rot });
  return [f.lw * f.m[0], f.lw * f.m[1], f.lh * f.m[2], f.lh * f.m[3], f.m[4], f.m[5]];
}
export function fitInside(box, iw, ih, rot) { // centered "contain" fit, aspect from image pixels
  const side = ((rot % 180) + 180) % 180 === 90;
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const aw = side ? ih : iw, ah = side ? iw : ih;
  const k = Math.min(bw / aw, bh / ah), w = aw * k, h = ah * k;
  const x = box[0] + (bw - w) / 2, y = box[1] + (bh - h) / 2;
  return [x, y, x + w, y + h];
}
export { hexToRgb, apply };
