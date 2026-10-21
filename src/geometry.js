// Geometry of annotations and content edits, shared by the screen (SVG) and the file (PDF operators).
import { apply, bboxPts, inflate, normBox, fmt, norm, mul, translateM, rotateM } from './util.js';
import { wrapText, ascent, descent, measure } from './fonts.js';

export const PAD = 2, LEADING = 1.2, BASE = 0.95;

/* Boxed annotations (free text, note, image) draw in a local frame (lw x lh, y up) rotated by `rot`,
   so they read upright on a page that was shown rotated when they were made. */
export const ROT = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] };
export function frame(a) {
  const r = norm(a.rot || 0), [x1, y1, x2, y2] = a.rect, w = x2 - x1, h = y2 - y1;
  const lw = r % 180 ? h : w, lh = r % 180 ? w : h;
  const [ma, mb, mc, md] = ROT[r];
  const mx = Math.min(0, lw * ma, lh * mc, lw * ma + lh * mc), my = Math.min(0, lw * mb, lh * md, lw * mb + lh * md);
  return { lw, lh, r, m: [ma, mb, mc, md, x1 - mx, y1 - my] };
}
export function rectFromAnchor(P, lw, lh, r) {
  const [ma, mb, mc, md] = ROT[norm(r)];
  const tx = P[0] - lh * mc, ty = P[1] - lh * md;
  const cx = [0, lw * ma, lh * mc, lw * ma + lh * mc], cy = [0, lw * mb, lh * md, lw * mb + lh * md];
  return [tx + Math.min(...cx), ty + Math.min(...cy), tx + Math.max(...cx), ty + Math.max(...cy)];
}

/* Free text annotations: Helvetica, padded box that grows with the text. */
export function textLayout(a) {
  const f = frame(a);
  const lines = wrapText('Helvetica', a.text, Math.max(6, f.lw - 2 * PAD), a.size);
  return { lines, needH: 2 * PAD + Math.max(1, lines.length) * a.size * LEADING, f };
}
export function fitText(a) {
  const { needH, f } = textLayout(a);
  a.rect = rectFromAnchor(apply(f.m, 0, f.lh), f.lw, needH, f.r);
}

/* Content text (page text written by the editor): anchored at the first baseline, rotated by `rot`
   degrees in user space; lines keep the user's breaks and wrap at `width`. */
export function contentMatrix(e) { return mul(rotateM(e.rot || 0), translateM(e.anchor[0], e.anchor[1])); }
export function contentLayout(e) {
  const lines = (e.text ?? '') === '' ? [] : wrapText(e.font, e.text, Math.max(8, e.width), e.size);
  const asc = ascent(e.font) * e.size, desc = descent(e.font) * e.size;
  const widest = lines.reduce((w, l) => Math.max(w, measure(e.font, l, e.size)), 0);
  const n = Math.max(1, lines.length);
  const local = [0, -(n - 1) * e.leading - desc, Math.max(e.width, widest), asc];
  return { lines, asc, desc, local, widest, m: contentMatrix(e) };
}
export function contentBox(e) {
  const { local, m } = contentLayout(e);
  return bboxPts([apply(m, local[0], local[1]), apply(m, local[2], local[1]), apply(m, local[0], local[3]), apply(m, local[2], local[3])].flat());
}

/* Paths */
export function strokeSegs(p) {
  const n = p.length / 2;
  if (n === 1) return [['M', p[0], p[1]], ['L', p[0] + 0.01, p[1]]];
  const segs = [['M', p[0], p[1]]];
  if (n === 2) { segs.push(['L', p[2], p[3]]); return segs; }
  let cx = p[0], cy = p[1];
  for (let i = 1; i < n - 1; i++) {
    const qx = p[2 * i], qy = p[2 * i + 1], ex = (qx + p[2 * i + 2]) / 2, ey = (qy + p[2 * i + 3]) / 2;
    segs.push(['C', cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey]);
    cx = ex; cy = ey;
  }
  segs.push(['L', p[2 * n - 2], p[2 * n - 1]]);
  return segs;
}
export function ellipseSegs([x1, y1, x2, y2]) {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = (x2 - x1) / 2, ry = (y2 - y1) / 2, k = 0.5523;
  return [['M', cx + rx, cy], ['C', cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry], ['C', cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy],
    ['C', cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry], ['C', cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy], ['Z']];
}
export function arrowPts(p, w) {
  const [x1, y1, x2, y2] = p, len = Math.max(7, w * 4), ang = Math.atan2(y2 - y1, x2 - x1), sp = 0.48;
  return [x2 - len * Math.cos(ang - sp), y2 - len * Math.sin(ang - sp), x2, y2, x2 - len * Math.cos(ang + sp), y2 - len * Math.sin(ang + sp)];
}
export const NOTE_BUBBLE = [['M', 3, 18], ['L', 17, 18], ['C', 17.6, 18, 18, 17.6, 18, 17], ['L', 18, 7], ['C', 18, 6.4, 17.6, 6, 17, 6], ['L', 9.5, 6], ['L', 5, 2.4], ['L', 5.8, 6], ['L', 3, 6], ['C', 2.4, 6, 2, 6.4, 2, 7], ['L', 2, 17], ['C', 2, 17.6, 2.4, 18, 3, 18], ['Z']];
export const NOTE_LINES = [['M', 5, 14.6], ['L', 15, 14.6], ['M', 5, 11.8], ['L', 15, 11.8], ['M', 5, 9], ['L', 11.5, 9]];
export const svgPath = segs => segs.map(s => s[0] + (s.length > 1 ? ' ' + s.slice(1).map(fmt).join(' ') : '')).join(' ');
export const pdfPath = segs => segs.map(s => s[0] === 'Z' ? 'h' : s.slice(1).map(fmt).join(' ') + ' ' + { M: 'm', L: 'l', C: 'c' }[s[0]]).join(' ');
// Quad points order: x1 y1 (upper left) x2 y2 (upper right) x3 y3 (lower left) x4 y4 (lower right)
export const quadPoly = q => [['M', q[0], q[1]], ['L', q[2], q[3]], ['L', q[6], q[7]], ['L', q[4], q[5]], ['Z']];
export function quadLine(q, which) { // underline (bottom edge, slightly raised) or strike-out (middle)
  const t = which === 'strike' ? 0.5 : 0.12;
  const lx = q[4] + (q[0] - q[4]) * t, ly = q[5] + (q[1] - q[5]) * t, rx = q[6] + (q[2] - q[6]) * t, ry = q[7] + (q[3] - q[7]) * t;
  return [lx, ly, rx, ry];
}
export const quadHeight = q => Math.hypot(q[0] - q[4], q[1] - q[5]);

/* Annotation boxes and transforms */
export function bbox(a) {
  if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') return bboxPts(a.quads.flat());
  if (a.type === 'ink') return bboxPts(a.strokes.flat());
  if (a.type === 'line') return normBox(...a.pts);
  return a.rect.slice();
}
export function visualBox(a) {
  const b = bbox(a);
  if (a.type === 'line') return inflate(a.arrow ? bboxPts([...a.pts, ...arrowPts(a.pts, a.width)]) : b, a.width / 2);
  if (a.type === 'ink' || a.type === 'rect' || a.type === 'ellipse') return inflate(b, a.width / 2);
  return b;
}
export function mapPts(arr, fn) { const o = []; for (let i = 0; i < arr.length; i += 2) o.push(...fn(arr[i], arr[i + 1])); return o; }
export function transformAnnot(a, from, to) {
  const fw = from[2] - from[0], fh = from[3] - from[1];
  const sx = fw < 1e-6 ? 1 : (to[2] - to[0]) / fw, sy = fh < 1e-6 ? 1 : (to[3] - to[1]) / fh;
  const fn = (x, y) => [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy];
  if (a.quads) a.quads = a.quads.map(q => mapPts(q, fn));
  else if (a.type === 'ink') a.strokes = a.strokes.map(s => mapPts(s, fn));
  else if (a.type === 'line') a.pts = mapPts(a.pts, fn);
  else { const [x1, y1] = fn(a.rect[0], a.rect[1]), [x2, y2] = fn(a.rect[2], a.rect[3]); a.rect = normBox(x1, y1, x2, y2); }
}
export function translateAnnot(a, dx, dy) { const b = bbox(a); transformAnnot(a, b, [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]); }
