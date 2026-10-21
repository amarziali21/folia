// MuPDF runs here, off the main thread. It is loaded on demand from vendor/mupdf-<version>/.
// Everything that crosses the boundary uses PDF user space (origin bottom left, y up).
let mupdf = null;
const docs = new Map(); // fileId -> { doc, pages: Map(idx -> PDFPage) }

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const bboxPts = p => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (let i = 0; i < p.length; i += 2) { a = Math.min(a, p[i]); c = Math.max(c, p[i]); b = Math.min(b, p[i + 1]); d = Math.max(d, p[i + 1]); } return [a, b, c, d]; };
const rectTo = (m, r) => bboxPts([...apply(m, r[0], r[1]), ...apply(m, r[2], r[1]), ...apply(m, r[0], r[3]), ...apply(m, r[2], r[3])]);
const quadTo = (m, q) => [...apply(m, q[0], q[1]), ...apply(m, q[2], q[3]), ...apply(m, q[4], q[5]), ...apply(m, q[6], q[7])];
const flatQuad = q => Array.isArray(q[0]) ? q.flat() : q;

function open(bytes) {
  return new mupdf.PDFDocument(bytes);
}
function getDoc(fileId) {
  const d = docs.get(fileId);
  if (!d) throw new Error('file not loaded: ' + fileId);
  return d;
}

const handlers = {
  async init({ url }) {
    const mod = await import(url);
    mupdf = mod.default && mod.default.PDFDocument ? mod.default : mod;
    return { version: mupdf.version || null };
  },
  load({ fileId, bytes }) {
    const old = docs.get(fileId); if (old) { try { old.doc.destroy(); } catch {} }
    docs.set(fileId, { doc: open(bytes), pages: new Map() });
    return true;
  },
  unload({ fileId }) {
    const d = docs.get(fileId); if (d) { try { d.doc.destroy(); } catch {} docs.delete(fileId); }
    return true;
  },
  // Text lines of a page, grouped in blocks, with font, size and colour of their first character.
  stext({ fileId, idx }) {
    const d = getDoc(fileId);
    const page = d.doc.loadPage(idx);
    const T = page.getTransform();
    const st = page.toStructuredText('preserve-whitespace');
    const blocks = []; let block = null, line = null;
    st.walk({
      beginTextBlock(bbox) { block = { bbox: rectTo(T, bbox), lines: [] }; },
      endTextBlock() { if (block && block.lines.length) blocks.push(block); block = null; },
      beginLine(bbox, wmode, dir) {
        const d0 = apply(T, 0, 0), d1 = apply(T, dir[0], dir[1]);
        line = { bbox: rectTo(T, bbox), wmode, dir: [d1[0] - d0[0], d1[1] - d0[1]], text: '', chars: [] };
      },
      endLine() { if (line && block && line.text.trim()) block.lines.push(line); line = null; },
      onChar(c, origin, font, size, quad, color) {
        if (!line) return;
        const o = apply(T, origin[0], origin[1]);
        if (!line.font) {
          line.font = { name: font.getName(), bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono() };
          line.size = size; line.color = color; line.origin = o;
        }
        line.text += c;
        line.chars.push({ c, o, q: quadTo(T, flatQuad(quad)) });
      },
    });
    st.destroy?.();
    page.destroy?.();
    return { blocks };
  },
  // plan: [{ idx, textRemove: [rect], redact: [rect] }] in user space. Returns new file bytes.
  rewrite({ bytes, plan }) {
    const doc = open(bytes);
    try {
      for (const p of plan) {
        const page = doc.loadPage(p.idx);
        const Ti = inv(page.getTransform());
        const mark = rects => { for (const r of rects) { const a = page.createAnnotation('Redact'); a.setRect(rectTo(Ti, r)); } };
        if (p.textRemove?.length) {
          mark(p.textRemove);
          page.applyRedactions(false, 0 /* images: keep */, 0 /* line art: keep */, 0 /* text: remove */);
        }
        if (p.redact?.length) {
          mark(p.redact);
          page.applyRedactions(false, 2 /* images: covered pixels */, 1 /* line art: if covered */, 0 /* text: remove */);
        }
      }
      const out = doc.saveToBuffer('garbage=compact,compress').asUint8Array().slice();
      return out;
    } finally { doc.destroy(); }
  },
  inspect({ bytes }) {
    const doc = open(bytes);
    try { return { encrypted: true, needsPassword: doc.needsPassword() }; } finally { doc.destroy(); }
  },
  // Returns decrypted bytes, or { auth } when the password is wrong / not enough.
  decrypt({ bytes, password, needOwner }) {
    const doc = open(bytes);
    try {
      let auth = 1;
      if (password != null || doc.needsPassword()) auth = doc.authenticatePassword(password || '');
      if (!auth) return { ok: false, reason: 'password' };
      if (needOwner && !(auth & 4)) return { ok: false, reason: 'owner' };
      return { ok: true, bytes: doc.saveToBuffer('encrypt=none,garbage').asUint8Array().slice() };
    } finally { doc.destroy(); }
  },
  encrypt({ bytes, user, owner, permissions }) {
    const doc = open(bytes);
    try {
      const opts = ['encrypt=aes-256', `permissions=${permissions | 0}`];
      if (user) opts.push(`user-password=${user}`);
      opts.push(`owner-password=${owner || user}`);
      return doc.saveToBuffer(opts.join(',')).asUint8Array().slice();
    } finally { doc.destroy(); }
  },
};

self.onmessage = async ev => {
  const { id, method, args } = ev.data;
  try {
    const result = await handlers[method](args || {});
    const transfer = result instanceof Uint8Array ? [result.buffer] : result?.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
