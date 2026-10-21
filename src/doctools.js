// Document tools: headers and footers (with Bates numbering), watermarks, bookmarks.
// Layout functions return content-text items in user space, used both by the preview and by the export.
import { L, N } from './lib.js';
import { makeViewport, apply, fmt, esc, norm, hexToRgb } from './util.js';
import { measure, ascent, descent, CSS_FAMILY } from './fonts.js';
import { contentLayout } from './geometry.js';
import { S, meta } from './state.js';

export const totalRot = p => norm(meta(p).rotate + p.rot);
export function displayBox(p) {
  const v = meta(p).view;
  if (!p.crop) return v.slice();
  const c = p.crop, b = [Math.max(v[0], c[0]), Math.max(v[1], c[1]), Math.min(v[2], c[2]), Math.min(v[3], c[3])];
  return b[2] > b[0] && b[3] > b[1] ? b : v.slice();
}

// A frame in display space (origin top left, y down, in points) for page p.
function dispFrame(p) {
  const vp = makeViewport(displayBox(p), 1, totalRot(p));
  const o = vp.convertToPdfPoint(0, 0), x1 = vp.convertToPdfPoint(1, 0);
  const theta = Math.atan2(x1[1] - o[1], x1[0] - o[0]) * 180 / Math.PI;
  return { vp, W: vp.width, H: vp.height, theta };
}

export const HF_SLOTS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
export const HF_TOKENS = [['{pagina}', 'numero di pagina'], ['{totale}', 'pagine totali'], ['{data}', 'data di oggi'], ['{file}', 'nome del file'], ['{bates}', 'numero Bates']];
export function pageInRange(spec, i, total) {
  if (!spec || spec === 'all') return true;
  const m = String(spec).match(/^\s*(\d*)\s*-\s*(\d*)\s*$/);
  if (m) { const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : total; return i + 1 >= a && i + 1 <= b; }
  const set = String(spec).split(/[,;\s]+/).filter(Boolean).map(Number);
  return set.includes(i + 1);
}
function hfText(t, hf, i, total, fileName, batesIndex) {
  const date = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const b = hf.bates || {};
  const bates = (b.prefix || '') + String((+b.start || 1) + batesIndex).padStart(+b.digits || 6, '0') + (b.suffix || '');
  return t.replace(/\{pagina\}/g, String((+hf.startNumber || 1) + i)).replace(/\{totale\}/g, String((+hf.startNumber || 1) + total - 1))
    .replace(/\{data\}/g, date).replace(/\{file\}/g, fileName || '').replace(/\{bates\}/g, bates);
}
// i = index of the page in the output, total = output page count
export function hfItems(hf, p, i, total, fileName) {
  if (!hf || !pageInRange(hf.range, i, total)) return [];
  let batesIndex = 0;
  for (let k = 0; k < i; k++) if (pageInRange(hf.range, k, total)) batesIndex++;
  const { vp, W, H, theta } = dispFrame(p), font = 'Helvetica', size = +hf.size || 9, mg = +hf.margin || 28;
  const asc = ascent(font) * size, desc = descent(font) * size, out = [];
  for (const slot of HF_SLOTS) {
    const raw = hf.slots?.[slot]; if (!raw || !raw.trim()) continue;
    const text = hfText(raw, hf, i, total, fileName, batesIndex).replace(/\n/g, ' ');
    const w = measure(font, text, size);
    const x = slot[1] === 'l' ? mg : slot[1] === 'c' ? (W - w) / 2 : W - mg - w;
    const y = slot[0] === 't' ? mg + asc : H - mg - desc;
    out.push({ text, anchor: vp.convertToPdfPoint(x, y), rot: theta, font, size, leading: size * 1.2, width: w + 10, color: hf.color || '#333333' });
  }
  return out;
}
export function wmItems(wm, p, i, total) {
  if (!wm || !wm.text?.trim() || !pageInRange(wm.range, i, total)) return [];
  const { vp, W, H, theta } = dispFrame(p), font = 'Helvetica-Bold', size = +wm.size || 60;
  const text = wm.text.replace(/\n/g, ' '), w = measure(font, text, size);
  const C = vp.convertToPdfPoint(W / 2, H / 2), rot = theta + (+wm.angle || 0), r = rot * Math.PI / 180;
  const b = [Math.cos(r), Math.sin(r)], up = [-b[1], b[0]], capMid = 0.36 * size;
  const anchor = [C[0] - b[0] * w / 2 - up[0] * capMid, C[1] - b[1] * w / 2 - up[1] * capMid];
  return [{ text, anchor, rot, font, size, leading: size * 1.2, width: w + 10, color: wm.color || '#d92d20', opacity: +wm.opacity || 0.25, behind: !!wm.behind }];
}

const cssFont = name => {
  const fam = name.startsWith('Times') ? 'serif' : name.startsWith('Courier') ? 'mono' : 'sans';
  const bold = /Bold/.test(name), italic = /Italic|Oblique/.test(name);
  return `font-family:${CSS_FAMILY[fam].replace(/"/g, "'")};font-weight:${bold ? 700 : 400};font-style:${italic ? 'italic' : 'normal'}`;
};
// SVG for content text (user space; the caller wraps it in the viewport transform)
export function contentTextSVG(e, extra = '') {
  const { lines, m } = contentLayout(e);
  const op = e.opacity != null && e.opacity < 1 ? ` opacity="${fmt(e.opacity)}"` : '';
  return `<g transform="matrix(${m.map(fmt).join(' ')})"${op}${extra}>` + lines.map((ln, i) =>
    `<text transform="translate(0 ${fmt(-i * e.leading)}) scale(1 -1)" font-size="${fmt(e.size)}" fill="${e.color}" style="${cssFont(e.font)}" xml:space="preserve">${esc(ln)}</text>`).join('') + '</g>';
}

/* ---------- bookmarks ---------- */
export async function readOutline(pdf, pageIds) {
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { outline = null; }
  if (!outline) return [];
  const out = [];
  const resolve = async dest => {
    try {
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) return null;
      const ref = dest[0];
      if (typeof ref === 'number') return ref;
      if (ref && typeof ref === 'object') return await pdf.getPageIndex(ref);
    } catch { return null; }
    return null;
  };
  const walk = async (items, level) => {
    for (const it of items) {
      const idx = it.dest ? await resolve(it.dest) : null;
      out.push({ id: 'b' + Math.random().toString(36).slice(2, 10), title: (it.title || '').trim() || 'Senza titolo', pageId: idx != null ? pageIds[idx] ?? null : null, level });
      if (it.items?.length && level < 8) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 0);
  return out;
}

export function writeOutline(doc, items, pageRefOf) {
  const ctx = doc.context;
  const list = items.map(b => ({ ...b, ref: pageRefOf(b.pageId) })).filter(b => b.ref);
  if (!list.length) return false;
  // rebuild the tree from levels (levels can jump; clamp to parent + 1)
  const root = { kids: [], level: -1 }, stack = [root];
  for (const b of list) {
    while (stack.length > 1 && stack[stack.length - 1].level >= b.level) stack.pop();
    const node = { ...b, level: stack[stack.length - 1].level + 1, kids: [] };
    stack[stack.length - 1].kids.push(node); stack.push(node);
  }
  const outlinesRef = ctx.nextRef();
  const count = n => n.kids.reduce((s, k) => s + 1 + count(k), 0);
  const build = (parentRef, kids) => {
    const refs = kids.map(() => ctx.nextRef());
    kids.forEach((k, i) => {
      const d = ctx.obj({ Title: L.PDFHexString.fromText(k.title), Parent: parentRef });
      d.set(N('Dest'), ctx.obj([k.ref, N('XYZ'), L.PDFNull, L.PDFNull, L.PDFNull]));
      if (i > 0) d.set(N('Prev'), refs[i - 1]);
      if (i < kids.length - 1) d.set(N('Next'), refs[i + 1]);
      if (k.kids.length) { const [f, l] = build(refs[i], k.kids); d.set(N('First'), f); d.set(N('Last'), l); d.set(N('Count'), ctx.obj(count(k))); }
      ctx.assign(refs[i], d);
    });
    return [refs[0], refs[refs.length - 1]];
  };
  const [first, last] = build(outlinesRef, root.kids);
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: count(root) }));
  doc.catalog.set(N('Outlines'), outlinesRef);
  doc.catalog.set(N('PageMode'), N('UseOutlines'));
  return true;
}
export { hexToRgb, apply };
