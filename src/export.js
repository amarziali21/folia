// Building output PDFs. Content edits are applied per source file (images through the content stream,
// text removal and redaction through MuPDF), then pages are copied into a fresh document so deleted pages
// really go away, comments are written natively and the document tools are applied.
import { L, N } from './lib.js';
import { userError, inflate, boxesIntersect, boxOfMatrix, mul } from './util.js';
import { S, pageOf, editsFor } from './state.js';
import { visualBox } from './geometry.js';
import { importAnnots, writeAnnot, makeRes, nameOf, strRef } from './annots-io.js';
import { applyImageEdits, appendContent, textOps, imageOps, fillOps, uprightImageMatrix, fitInside } from './content.js';
import { hfItems, wmItems, writeOutline, totalRot, displayBox } from './doctools.js';
import { cleanText } from './fonts.js';
import * as engine from './mupdf-client.js';

export const needsEngine = e => (e.kind === 'text' && e.remove?.length) || e.kind === 'redact';

// Apply content edits of one file to a pdf-lib document. pageMap maps source index -> index in `doc`.
async function applyEdits(doc, fileId, pageMap, { preview = false } = {}) {
  const byPage = new Map();
  for (const e of S.edits) {
    if (e.src !== fileId || !pageMap.has(e.idx)) continue;
    if (preview && e.kind === 'redact') continue;
    if (!byPage.has(e.idx)) byPage.set(e.idx, []);
    byPage.get(e.idx).push(e);
  }
  if (!byPage.size) return { doc, renumbered: false, redactions: 0 };
  // A. images drawn by the original content
  for (const [idx, list] of byPage) {
    const imgEdits = list.filter(e => e.kind === 'image').map(e => ({ op: e.op, name: e.name, ctm: e.ctm, A: e.A, deleted: e.deleted || !!e.replaceImageId }));
    if (imgEdits.length) applyImageEdits(doc.getPage(pageMap.get(idx)), imgEdits);
  }
  // B. text removal and redaction (MuPDF)
  const plan = [];
  let redactions = 0;
  for (const [idx, list] of byPage) {
    const textRemove = list.filter(e => e.kind === 'text').flatMap(e => e.remove || []);
    const redact = list.filter(e => e.kind === 'redact').flatMap(e => e.rects);
    redactions += list.filter(e => e.kind === 'redact').length;
    if (textRemove.length || redact.length) plan.push({ idx: pageMap.get(idx), textRemove, redact });
  }
  let renumbered = false;
  if (plan.length) {
    if (!(await engine.startEngine())) throw userError('Text editing and redaction need the MuPDF engine, which did not load. Reload the page and try again.');
    const out = await engine.rewrite(await doc.save({ updateFieldAppearances: false, addDefaultPage: false }), plan);
    doc = await L.PDFDocument.load(out, { updateMetadata: false });
    renumbered = true;
  }
  // C. new content
  for (const [idx, list] of byPage) {
    const page = doc.getPage(pageMap.get(idx));
    const ops = [];
    for (const e of list) {
      if (e.kind === 'text' && (e.text || '').trim()) ops.push(await textOps(doc, page, e));
      else if (e.kind === 'newimage') { const im = S.images.get(e.imageId); if (im) ops.push(await imageOps(doc, page, { id: e.imageId, ...im }, uprightImageMatrix(e.rect, e.rot || 0), e.opacity ?? 1)); }
      else if (e.kind === 'image' && e.replaceImageId && !e.deleted) {
        const im = S.images.get(e.replaceImageId);
        if (im) { const box = boxOfMatrix(mul(e.ctm, e.A || [1, 0, 0, 1, 0, 0])); ops.push(await imageOps(doc, page, { id: e.replaceImageId, ...im }, uprightImageMatrix(fitInside(box, im.w, im.h, e.rot || 0), e.rot || 0))); }
      } else if (e.kind === 'redact' && e.fill !== 'none') ops.push(fillOps(e.rects, e.fill || '#000000'));
    }
    const text = ops.filter(Boolean).join('\n');
    if (text) appendContent(page, text);
  }
  await doc.flush(); // write the fonts and images embedded above: pages are copied from this document without saving it
  return { doc, renumbered, redactions };
}

// One-page PDF of source page (fileId, idx) with its content edits, for on-screen preview.
export async function buildVariant(fileId, idx) {
  const f = S.files.get(fileId);
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const [pg] = await doc.copyPages(f.lib, [idx]);
  doc.addPage(pg);
  const r = await applyEdits(doc, fileId, new Map([[idx, 0]]), { preview: true });
  return r.doc.save({ updateFieldAppearances: false });
}

function redactRectsFor(fileId, idx) {
  return editsFor(fileId, idx).filter(e => e.kind === 'redact').flatMap(e => e.rects);
}

export async function buildPdf(pageIds, { forSave = false } = {}) {
  const list = pageIds.map(pageOf).filter(Boolean);
  if (!list.length) throw userError('There are no pages to save.');
  const warnings = [];
  // working document per source file
  const libs = new Map(), renum = new Set();
  let redactions = 0;
  for (const fid of new Set(list.map(p => p.fileId))) {
    const f = S.files.get(fid);
    const idxs = new Set(list.filter(p => p.fileId === fid).map(p => p.idx));
    if (S.edits.some(e => e.src === fid && idxs.has(e.idx))) {
      const work = await L.PDFDocument.load(f.baseBytes, { updateMetadata: false });
      const r = await applyEdits(work, fid, new Map([...idxs].map(i => [i, i])));
      libs.set(fid, r.doc); if (r.renumbered) renum.add(fid); redactions += r.redactions;
    } else libs.set(fid, f.lib);
  }
  const out = await L.PDFDocument.create({ updateMetadata: false });
  const copiers = new Map();
  const cp = fid => {
    if (!copiers.has(fid)) {
      const lib = libs.get(fid), c = L.PDFObjectCopier.for(lib.context, out.context);
      const used = new Set(list.filter(p => p.fileId === fid).map(p => p.idx));
      lib.getPages().forEach((pg, i) => { if (!used.has(i)) c.traversedObjects.set(pg.ref, L.PDFNull); });
      copiers.set(fid, c);
    }
    return copiers.get(fid);
  };
  const seeded = list.map(p => { const lib = libs.get(p.fileId), src = lib.getPage(p.idx), c = cp(p.fileId), ref = out.context.nextRef(); c.traversedObjects.set(src.ref, ref); return { p, src, c, ref }; });
  const refOfPage = new Map(seeded.map(s => [s.p.id, s.ref]));
  const res = makeRes(out, S.images), outPages = [];
  const total = seeded.length;
  let dropped = 0;
  for (const [i, s] of seeded.entries()) {
    const node = s.c.copy(s.src.node);
    out.context.assign(s.ref, node);
    const page = L.PDFPage.of(node, s.ref, out);
    out.addPage(page);
    page.setRotation(L.degrees(totalRot(s.p)));
    if (s.p.crop) { const b = displayBox(s.p); page.setCropBox(b[0], b[1], b[2] - b[0], b[3] - b[1]); }
    // document tools drawn as page content
    const fileName = S.files.get(s.p.fileId).name.replace(/\.pdf$/i, '');
    const wm = wmItems(S.doc.wm, s.p, i, total), hf = hfItems(S.doc.hf, s.p, i, total, fileName);
    for (const it of wm) appendContent(page, await textOps(out, page, it, it.opacity), { behind: it.behind });
    if (hf.length) appendContent(page, (await Promise.all(hf.map(it => textOps(out, page, it)))).join('\n'));
    // comments
    const red = redactRectsFor(s.p.fileId, s.p.idx);
    for (const a of S.annots) {
      if (a.pageId !== s.p.id) continue;
      if (red.length && red.some(r => boxesIntersect(inflate(visualBox(a), 0), r))) { dropped++; continue; }
      if (a.origRef && !a.dirty && !renum.has(s.p.fileId)) {
        page.node.addAnnot(s.c.copy(strRef(a.origRef)));
        if (a.popupRef) page.node.addAnnot(s.c.copy(strRef(a.popupRef)));
      } else await writeAnnot(out, page, a, res, { pageRef: id => refOfPage.get(id) || null });
    }
    outPages.push(page);
  }
  if (dropped) warnings.push(`${dropped} ${dropped === 1 ? 'comment was' : 'comments were'} removed because the redactions cover ${dropped === 1 ? 'it' : 'them'}`);
  // form fields whose widgets are on the kept pages
  const widgets = new Set();
  for (const page of outPages) for (const r of page.node.Annots()?.asArray() || []) {
    if (r instanceof L.PDFRef) { const d = out.context.lookup(r); if (d instanceof L.PDFDict && nameOf(d.get(N('Subtype'))) === 'Widget') widgets.add(r); }
  }
  if (widgets.size) {
    const fields = []; let base = null;
    const hasWidget = (ctx, ref, c, depth) => {
      if (depth > 24) return false;
      const m = c.traversedObjects.get(ref); if (m && widgets.has(m)) return true;
      const d = ctx.lookup(ref); if (!(d instanceof L.PDFDict)) return false;
      const kids = d.lookupMaybe(N('Kids'), L.PDFArray);
      return !!kids && kids.asArray().some(k => k instanceof L.PDFRef && hasWidget(ctx, k, c, depth + 1));
    };
    for (const [fid, c] of copiers) {
      const lib = libs.get(fid), af = lib.catalog.lookupMaybe(N('AcroForm'), L.PDFDict);
      const fl = af && af.lookupMaybe(N('Fields'), L.PDFArray); if (!fl) continue;
      for (const fr of fl.asArray()) if (fr instanceof L.PDFRef && hasWidget(lib.context, fr, c, 0)) fields.push(c.copy(fr));
      if (!base) base = { af, c };
    }
    if (fields.length) {
      const acro = out.context.obj({ Fields: fields });
      for (const k of ['DA', 'Q', 'DR', 'NeedAppearances']) { const v = base.af.get(N(k)); if (v !== undefined) acro.set(N(k), base.c.copy(v)); }
      out.catalog.set(N('AcroForm'), out.context.register(acro));
    }
  }
  // bookmarks
  if (S.bookmarks.length) writeOutline(out, S.bookmarks, id => refOfPage.get(id));
  // document information
  const first = libs.get(list[0].fileId), m = S.doc.meta;
  try {
    const t = m ? m.title : first.getTitle(), au = m ? m.author : first.getAuthor(), su = m ? m.subject : first.getSubject(), kw = m ? m.keywords : first.getKeywords();
    if (t) out.setTitle(t); if (au) out.setAuthor(au); if (su) out.setSubject(su); if (kw) out.setKeywords(Array.isArray(kw) ? kw : String(kw).split(/[,;]\s*/).filter(Boolean));
  } catch { /* unreadable info dictionary */ }
  out.setProducer('Margine PDF'); out.setModificationDate(new Date());
  // form values typed in the editor
  if (Object.keys(S.formValues).length && out.catalog.get(N('AcroForm'))) {
    let form = null; try { form = out.getForm(); } catch { warnings.push('the form could not be read'); }
    if (form) for (const [key, v] of Object.entries(S.formValues)) {
      const name = key.slice(key.indexOf('|') + 1);
      let fld = null; try { fld = form.getField(name); } catch { continue; }
      try {
        if (fld instanceof L.PDFTextField) fld.setText(cleanText(v));
        else if (fld instanceof L.PDFCheckBox) v ? fld.check() : fld.uncheck();
        else if (fld instanceof L.PDFRadioGroup) v ? fld.select(v) : fld.clear();
        else if (fld instanceof L.PDFDropdown || fld instanceof L.PDFOptionList) { const ch = S.fields.get(key)?.options?.find(o => o.exportValue === v); fld.select(ch?.displayValue && fld.getOptions().includes(ch.displayValue) ? ch.displayValue : v); }
      } catch { warnings.push(`field "${name}" could not be filled in`); }
    }
  }
  let bytes;
  try { bytes = await out.save({ updateFieldAppearances: true }); }
  catch {
    try { out.getForm().acroForm.dict.set(N('NeedAppearances'), L.PDFBool.True); } catch { /* no form */ }
    bytes = await out.save({ updateFieldAppearances: false });
  }
  // protection
  const pr = S.doc.protect;
  if (forSave && pr && (pr.user || pr.owner)) {
    if (!(await engine.startEngine())) throw userError('Password protection needs the MuPDF engine, which did not load.');
    bytes = await engine.encrypt(bytes, { user: pr.user || '', owner: pr.owner || pr.user, permissions: permissionBits(pr) });
  }
  return { bytes, warnings, redactions };
}

export function permissionBits(pr) {
  let p = -3904; // reserved bits set, nothing granted
  const allow = pr.allow || {};
  if (!pr.owner) return -4; // no restrictions: everything allowed
  if (allow.print) p |= 4 | 2048;
  if (allow.edit) p |= 8 | 1024;
  if (allow.copy) p |= 16;
  if (allow.comment) p |= 32 | 256;
  p |= 512; // accessibility
  return p;
}

/* ---------- opening ---------- */
export async function prepareFile(bytes) {
  const lib = await L.PDFDocument.load(bytes, { updateMetadata: false });
  const imported = importAnnots(lib);
  const baseBytes = imported.length ? await lib.save({ updateFieldAppearances: false, addDefaultPage: false }) : bytes;
  return { lib, imported, baseBytes };
}
