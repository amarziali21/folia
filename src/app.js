// Core of the editor: files, page views, rendering (with previews of content edits), history, open and save.
import { L, pdfjs, PDFJS_OPTS } from './lib.js';
import { $, uid, clamp, esc, fmt, norm, userError, safeName, makeViewport } from './util.js';
import { S, hist, PX, snapshot, loadSnapshot, pageOf, meta, srcKey, editsFor } from './state.js';
import { buildPdf, buildVariant, prepareFile } from './export.js';
import { readOutline, totalRot } from './doctools.js';
import * as engine from './mupdf-client.js';
import { renderOverlay, renderSelection, renderProps, closeEditors, onPointerDown, onDblClick, showCursor, isDragging } from './tools.js';
import { renderBookmarks, renderDrawer } from './panels.js';

export const views = new Map();   // pageId -> page view
export const thumbs = new Map();  // pageId -> thumbnail view
export { totalRot };

/* ------------------------------------------------------------ toasts and dialogs */
export function toast(msg, kind = 'info', ms = 4200) {
  const t = document.createElement('div'); t.className = 'toast' + (kind === 'error' ? ' error' : ''); t.textContent = msg; t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const box = $('#toasts'); box.appendChild(t); while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => t.remove(), ms);
}
export function modal(html, setup) {
  return new Promise(res => {
    const m = $('#modal');
    m.innerHTML = `<div class="panel" role="dialog" aria-modal="true">${html}</div>`;
    m.hidden = false;
    const done = v => { m.hidden = true; m.innerHTML = ''; document.removeEventListener('keydown', onKey, true); res(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    setup(m.firstElementChild, done);
  });
}
export function confirmBox(title, body, okLabel) {
  return modal(`<h2>${esc(title)}</h2><p>${esc(body)}</p><div class="row"><button class="btn" type="button" data-act="no">Cancel</button><button class="btn primary" type="button" data-act="yes">${esc(okLabel)}</button></div>`,
    (p, done) => { p.querySelector('[data-act="no"]').onclick = () => done(false); const y = p.querySelector('[data-act="yes"]'); y.onclick = () => done(true); y.focus(); }).then(v => !!v);
}
function passwordBox(title, body, label) {
  return modal(`<h2>${esc(title)}</h2><p>${esc(body)}</p><label class="stack">${esc(label)}<input type="password" id="pwInput" autocomplete="off"></label><p class="err" id="pwErr" hidden></p><div class="row"><button class="btn" type="button" data-act="no">Cancel</button><button class="btn primary" type="button" data-act="yes">Unlock</button></div>`,
    (p, done) => {
      const inp = p.querySelector('#pwInput');
      p.querySelector('[data-act="no"]').onclick = () => done(null);
      const ok = () => done(inp.value);
      p.querySelector('[data-act="yes"]').onclick = ok;
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
      inp.focus();
    });
}
export function store(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
export function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

/* ------------------------------------------------------------ history */
export function pushUndo(snap) { hist.undo.push(snap); if (hist.undo.length > 150) hist.undo.shift(); hist.redo.length = 0; updateHistUI(); }
export function commit(fn) { const snap = snapshot(); fn(); pushUndo(snap); setDirty(); }
function restore(snap) {
  loadSnapshot(snap);
  if (S.sel && !S.annots.some(a => a.id === S.sel) && !S.edits.some(e => e.id === S.sel)) S.sel = null;
  for (const id of [...S.selPages]) if (!pageOf(id)) S.selPages.delete(id);
  rebuildViews(); refreshAllVariants();
}
export function undo() { closeEditors(); if (!hist.undo.length) return; hist.redo.push(snapshot()); restore(hist.undo.pop()); setDirty(); updateHistUI(); }
export function redo() { closeEditors(); if (!hist.redo.length) return; hist.undo.push(snapshot()); restore(hist.redo.pop()); setDirty(); updateHistUI(); }
export function updateHistUI() { $('#btnUndo').disabled = !hist.undo.length; $('#btnRedo').disabled = !hist.redo.length; }
export function setDirty(v = true) { S.dirty = v; if (v) S.isSample = false; updateTitle(); updateStatus(); }
export function updateTitle() {
  const names = [...new Set(S.pages.map(p => S.files.get(p.fileId).name))];
  $('#docName').textContent = names.length ? names[0] + (names.length > 1 ? ` + ${names.length - 1}` : '') : 'No document';
  $('#docName').title = names.join(', ');
  $('#sampleChip').hidden = !S.isSample;
  $('#lockChip').hidden = !(S.doc.protect && (S.doc.protect.user || S.doc.protect.owner));
  $('#dirtyDot').hidden = !S.dirty;
  document.title = (S.dirty ? '• ' : '') + (names[0] || 'Folia') + ' – Folia';
}

/* ------------------------------------------------------------ opening files */
async function unlock(bytes, name) {
  if (!(await engine.startEngine())) throw userError(`"${name}" is protected: opening it needs the MuPDF engine, which did not load.`);
  const info = await engine.inspect(bytes);
  let msg = '';
  for (;;) {
    const pw = await passwordBox(info.needsPassword ? 'Password-protected PDF' : 'Restricted PDF',
      (msg ? msg + ' ' : '') + (info.needsPassword ? `Enter the password to open "${name}".` : `"${name}" restricts editing. Enter the permissions password to edit it.`),
      info.needsPassword ? 'Password' : 'Permissions password');
    if (pw == null) throw userError(`Opening "${name}" was cancelled.`);
    const r = await engine.decrypt(bytes, pw, !info.needsPassword);
    if (r.ok) return r.bytes;
    msg = r.reason === 'owner' ? 'This password does not allow editing.' : 'Wrong password.';
  }
}
async function loadPdfFile(bytes, name) {
  let prep;
  try { prep = await prepareFile(bytes); }
  catch (e) {
    if (/encrypt/i.test(e?.message || '') || e?.name === 'EncryptedPDFError') prep = await prepareFile(await unlock(bytes, name));
    else throw userError(`"${name}" is not a readable PDF.`);
  }
  const { lib, imported, baseBytes } = prep;
  let pdf;
  try { pdf = await pdfjs.getDocument({ data: baseBytes.slice(), ...PDFJS_OPTS }).promise; }
  catch (e) { console.error(e); throw userError(`"${name}" cannot be displayed.`); }
  const count = Math.min(pdf.numPages, lib.getPageCount());
  const file = { id: uid('f'), name, lib, pdf, baseBytes, pages: [], imported };
  for (let i = 0; i < count; i++) {
    const proxy = await pdf.getPage(i + 1);
    let widgets = [];
    try {
      widgets = (await proxy.getAnnotations({ intent: 'display' }))
        .filter(w => w.annotationType === pdfjs.AnnotationType.WIDGET && w.fieldName && !w.hidden && !w.pushButton && w.fieldType !== 'Sig');
    } catch { widgets = []; }
    file.pages.push({ proxy, view: proxy.view.slice(), rotate: norm(proxy.rotate || 0), widgets, text: null });
  }
  return file;
}
function fieldInfo(fileId, w) {
  const key = `${fileId}|${w.fieldName}`;
  if (!S.fields.has(key)) {
    let type = 'text', initial = '';
    if (w.fieldType === 'Btn' && w.checkBox) { type = 'check'; initial = !!w.fieldValue && w.fieldValue !== 'Off'; }
    else if (w.fieldType === 'Btn' && w.radioButton) { type = 'radio'; initial = w.fieldValue && w.fieldValue !== 'Off' ? w.fieldValue : ''; }
    else if (w.fieldType === 'Ch') { type = 'choice'; initial = Array.isArray(w.fieldValue) ? (w.fieldValue[0] ?? '') : (w.fieldValue ?? ''); }
    else initial = Array.isArray(w.fieldValue) ? w.fieldValue.join(', ') : (w.fieldValue ?? '');
    S.fields.set(key, { type, initial, options: w.options || [] });
  }
  return key;
}
// items: [{ name, bytes }]. replace: start a new document. insertAt: index in S.pages (default: end).
export async function openFiles(items, { replace = false, sample = false, insertAt = null, quiet = false } = {}) {
  const loaded = [];
  for (const it of items) {
    if (!quiet && (items.length > 1 || it.bytes.length > 4e6)) toast(`Opening "${it.name}"…`);
    try { loaded.push(await loadPdfFile(it.bytes, it.name)); }
    catch (e) { toast(e.user ? e.message : `Could not open "${it.name}".`, 'error'); console.error(e); }
  }
  if (!loaded.length) return false;
  const snap = replace ? null : snapshot();
  if (replace) {
    closeEditors();
    for (const f of S.files.values()) { try { f.pdf.destroy(); } catch { /* closed */ } engine.unloadFile(f.id).catch(() => {}); }
    for (const v of variants.values()) { try { v.pdf?.destroy(); } catch { /* closed */ } }
    variants.clear(); stextCache.clear();
    S.files.clear(); S.pages = []; S.annots = []; S.edits = []; S.bookmarks = []; S.doc = { meta: null, hf: null, wm: null, protect: null };
    S.fields.clear(); S.formValues = {}; S.sel = null; S.selPages.clear();
    hist.undo = []; hist.redo = [];
    for (const v of views.values()) v.el.remove(); views.clear();
    S.isSample = sample;
  }
  let at = insertAt == null ? S.pages.length : clamp(insertAt, 0, S.pages.length);
  for (const f of loaded) {
    S.files.set(f.id, f);
    const newPages = f.pages.map((pg, idx) => ({ id: uid('p'), fileId: f.id, idx, rot: 0, crop: null }));
    S.pages.splice(at, 0, ...newPages); at += newPages.length;
    const ids = newPages.map(p => p.id);
    for (const m of f.imported) {
      if (m.pageIdx >= ids.length) continue;
      m.pageId = ids[m.pageIdx]; delete m.pageIdx;
      if (m.type === 'link' && m.targetIdx != null) { m.targetPage = ids[m.targetIdx] ?? null; delete m.targetIdx; if (!m.targetPage && !m.url) continue; }
      S.annots.push(m);
    }
    f.pages.forEach(pg => pg.widgets.forEach(w => fieldInfo(f.id, w)));
    S.bookmarks.push(...await readOutline(f.pdf, ids));
  }
  if (replace) { S.dirty = false; S.cur = S.pages[0]?.id || null; fitWidth(false); }
  else { pushUndo(snap); setDirty(); S.isSample = false; }
  updateTitle();
  rebuildViews();
  if (replace) $('#desk').scrollTop = 0;
  else views.get(S.pages.find(p => p.fileId === loaded[0].id)?.id)?.el.scrollIntoView({ block: 'start' });
  return true;
}
export async function readFiles(fileList) {
  const out = [];
  for (const f of fileList) {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast(`"${f.name}" is not a PDF.`, 'error'); continue; }
    out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}
export async function openReplace(fileList) {
  const items = await readFiles(fileList); if (!items.length) return;
  if (S.dirty && !(await confirmBox('Open another PDF?', 'Unsaved changes to this document will be lost.', 'Open without saving'))) return;
  const [first, ...rest] = items;
  if (await openFiles([first], { replace: true }) && rest.length) await openFiles(rest);
}
export async function openAppend(fileList, insertAt = null) {
  const items = await readFiles(fileList); if (!items.length) return;
  if (S.isSample && !S.dirty) { const [first, ...rest] = items; if (await openFiles([first], { replace: true }) && rest.length) await openFiles(rest); return; }
  if (await openFiles(items, { insertAt })) toast(items.length === 1 ? 'PDF inserted into the document.' : `${items.length} PDFs inserted into the document.`);
}
export async function insertBlankPage() {
  const p = pageOf(S.cur) || S.pages[S.pages.length - 1]; if (!p) return;
  const vp = makeViewport(meta(p).view, 1, totalRot(p));
  const doc = await L.PDFDocument.create(); doc.addPage([vp.width, vp.height]);
  const at = S.pages.indexOf(p) + 1;
  if (await openFiles([{ name: 'Blank page', bytes: await doc.save() }], { insertAt: at, quiet: true })) {
    S.cur = S.pages[at].id; views.get(S.cur)?.el.scrollIntoView({ block: 'start' }); toast('Blank page inserted.');
  }
}

/* ------------------------------------------------------------ content-edit previews (variants) */
export const variants = new Map();   // srcKey -> { hash, pdf, proxy }
const variantJobs = new Map();       // srcKey -> timer
export const stextCache = new Map(); // srcKey -> Promise<blocks>
const editHash = (fileId, idx) => JSON.stringify(editsFor(fileId, idx).filter(e => e.kind !== 'redact'));
export function variantState(fileId, idx) {
  const h = editHash(fileId, idx), v = variants.get(srcKey(fileId, idx));
  if (h === '[]') return 'none';
  return v && v.hash === h ? 'ready' : 'pending';
}
export function proxyFor(p) {
  const v = variants.get(srcKey(p.fileId, p.idx));
  return v && v.proxy && variantState(p.fileId, p.idx) === 'ready' ? v.proxy : meta(p).proxy;
}
function renderKey(p) { const v = variants.get(srcKey(p.fileId, p.idx)); return `${S.zoom}|${totalRot(p)}|${v && variantState(p.fileId, p.idx) === 'ready' ? v.hash.length + ':' + hashStr(v.hash) : '-'}`; }
const hashStr = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
export function scheduleVariant(fileId, idx, delay = 120) {
  const key = srcKey(fileId, idx);
  clearTimeout(variantJobs.get(key));
  variantJobs.set(key, setTimeout(async () => {
    variantJobs.delete(key);
    const h = editHash(fileId, idx);
    const old = variants.get(key);
    if (h === '[]') {
      if (old) { variants.delete(key); try { old.pdf?.destroy(); } catch { /* closed */ } refreshSource(fileId, idx); }
      return;
    }
    if (old && old.hash === h) return;
    try {
      const bytes = await buildVariant(fileId, idx);
      if (editHash(fileId, idx) !== h) return; // changed meanwhile; a newer job is queued
      const pdf = await pdfjs.getDocument({ data: bytes, ...PDFJS_OPTS }).promise;
      const proxy = await pdf.getPage(1);
      const prev = variants.get(key);
      variants.set(key, { hash: h, pdf, proxy });
      if (prev) { try { prev.pdf?.destroy(); } catch { /* closed */ } }
    } catch (e) {
      console.error(e);
      toast(e.user ? e.message : 'Could not preview the edit.', 'error');
    }
    refreshSource(fileId, idx);
  }, delay));
}
export function refreshAllVariants() {
  const keys = new Set(S.edits.filter(e => e.kind !== 'redact').map(e => srcKey(e.src, e.idx)));
  for (const k of variants.keys()) keys.add(k);
  for (const k of keys) { const i = k.lastIndexOf('|'); scheduleVariant(k.slice(0, i), +k.slice(i + 1), 0); }
}
function refreshSource(fileId, idx) {
  for (const p of S.pages) {
    if (p.fileId !== fileId || p.idx !== idx) continue;
    const pv = views.get(p.id); if (pv) { renderOverlay(pv); if (pv.visible) requestCanvas(pv); }
    const th = thumbs.get(p.id); if (th) { th.key = null; requestThumb(th); }
  }
}

/* ------------------------------------------------------------ page views */
const renderQ = { main: [], thumb: [], active: 0 };
function enqueue(kind, fn) { renderQ[kind].push(fn); pump(); }
function pump() {
  while (renderQ.active < 2 && (renderQ.main.length || renderQ.thumb.length)) {
    const fn = renderQ.main.shift() || renderQ.thumb.shift(); renderQ.active++;
    Promise.resolve().then(fn).catch(() => {}).finally(() => { renderQ.active--; pump(); });
  }
}
let deskObs = null;
function observer() {
  if (!deskObs) deskObs = new IntersectionObserver(entries => {
    for (const e of entries) { const pv = e.target._pv; if (!pv) continue; pv.visible = e.isIntersecting; if (pv.visible) requestCanvas(pv); }
  }, { root: $('#desk'), rootMargin: '900px 0px' });
  return deskObs;
}
function createView(p) {
  const el = document.createElement('div'); el.className = 'pv'; el.dataset.id = p.id;
  el.innerHTML = '<canvas></canvas><svg class="pv-doc"></svg><svg class="pv-hl"></svg><svg class="pv-ann"></svg><div class="pv-forms"></div><div class="pv-ui"></div>';
  const pv = { el, page: p, canvas: el.children[0], doc: el.children[1], hl: el.children[2], ann: el.children[3], forms: el.children[4], ui: el.children[5], visible: false, key: null, want: null, task: null };
  el._pv = pv;
  el.addEventListener('pointerdown', e => onPointerDown(e, pv));
  el.addEventListener('dblclick', e => onDblClick(e, pv));
  el.addEventListener('pointermove', e => { if (!isDragging()) showCursor(e, pv); });
  el.addEventListener('pointerleave', () => { pv.ui.querySelectorAll('.hover-box').forEach(n => n.remove()); });
  observer().observe(el);
  return pv;
}
export function updateView(pv) {
  const p = pv.page, m = meta(p);
  pv.vp = m.proxy.getViewport({ scale: S.zoom * PX, rotation: totalRot(p) });
  pv.el.style.width = pv.vp.width + 'px'; pv.el.style.height = pv.vp.height + 'px';
  renderOverlay(pv); renderForms(pv);
  if (pv.visible) requestCanvas(pv);
}
export function requestCanvas(pv) {
  const key = renderKey(pv.page);
  if (pv.key === key || pv.want === key) return;
  pv.want = key;
  enqueue('main', () => renderCanvas(pv, key));
}
async function renderCanvas(pv, key) {
  if (pv.want !== key || !views.has(pv.page.id)) return;
  if (pv.task) { try { pv.task.cancel(); } catch { /* finished */ } }
  const vp = proxyFor(pv.page).getViewport({ scale: S.zoom * PX, rotation: totalRot(pv.page) });
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  while (vp.width * vp.height * dpr * dpr > 1.6e7 && dpr > 0.5) dpr *= 0.75;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(vp.width * dpr)); c.height = Math.max(1, Math.floor(vp.height * dpr));
  const task = proxyFor(pv.page).render({ canvas: c, viewport: vp, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0], annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS });
  pv.task = task;
  try {
    await task.promise;
    if (pv.want !== key) return;
    pv.canvas.replaceWith(c); pv.canvas = c; pv.key = key; pv.want = null;
  } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); if (pv.want === key) pv.want = null; }
}
export function rebuildViews() {
  const box = $('#pages'), ids = new Set(S.pages.map(p => p.id));
  for (const [id, pv] of views) if (!ids.has(id)) { observer().unobserve(pv.el); pv.el.remove(); views.delete(id); }
  for (const p of S.pages) { let pv = views.get(p.id); if (!pv) { pv = createView(p); views.set(p.id, pv); } pv.page = p; box.appendChild(pv.el); updateView(pv); }
  if (!S.cur || !ids.has(S.cur)) S.cur = S.pages[0]?.id || null;
  rebuildThumbs(); renderSelection(); renderProps(); updateStatus(); updateHistUI(); updateTitle(); renderBookmarks(); renderDrawer();
}
export function refreshOverlays() { for (const pv of views.values()) renderOverlay(pv); for (const th of thumbs.values()) renderThumbOverlay(th); }

/* ------------------------------------------------------------ form fields on top of the page */
export function renderForms(pv) {
  const m = meta(pv.page), box = pv.forms; box.innerHTML = '';
  const rot = totalRot(pv.page), side = rot % 180 !== 0;
  for (const w of m.widgets) {
    const key = `${pv.page.fileId}|${w.fieldName}`, info = S.fields.get(key); if (!info) continue;
    const a = pv.vp.convertToViewportPoint(w.rect[0], w.rect[1]), b = pv.vp.convertToViewportPoint(w.rect[2], w.rect[3]);
    const L0 = Math.min(a[0], b[0]), T0 = Math.min(a[1], b[1]), Wd = Math.abs(a[0] - b[0]), Ht = Math.abs(a[1] - b[1]);
    const val = key in S.formValues ? S.formValues[key] : info.initial;
    let el;
    if (info.type === 'check') { el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!val; }
    else if (info.type === 'radio') { el = document.createElement('input'); el.type = 'radio'; el.name = 'r-' + key; el.checked = val === w.buttonValue; el.value = w.buttonValue; }
    else if (info.type === 'choice') {
      el = document.createElement('select');
      for (const o of (w.options || [])) { const op = document.createElement('option'); op.value = o.exportValue; op.textContent = o.displayValue ?? o.exportValue; el.appendChild(op); }
      el.value = val;
    } else {
      el = document.createElement(w.multiLine ? 'textarea' : 'input');
      if (!w.multiLine) el.type = 'text';
      el.value = val ?? '';
      if (w.maxLen) el.maxLength = w.maxLen;
      const hh = side ? Wd : Ht;
      el.style.fontSize = Math.max(8, Math.min(w.multiLine ? 12 * S.zoom * PX : hh * 0.62, 16 * S.zoom * PX)) + 'px';
    }
    el.disabled = !!w.readOnly;
    el.title = w.alternativeText || w.fieldName;
    el.setAttribute('aria-label', w.alternativeText || w.fieldName);
    el.dataset.key = key;
    let ew = side ? Ht : Wd, eh = side ? Wd : Ht;
    if (info.type === 'check' || info.type === 'radio') ew = eh = Math.min(Wd, Ht);
    Object.assign(el.style, { left: L0 + (Wd - ew) / 2 + 'px', top: T0 + (Ht - eh) / 2 + 'px', width: ew + 'px', height: eh + 'px', transform: rot ? `rotate(${rot}deg)` : '' });
    el.addEventListener('change', () => {
      const v = info.type === 'check' ? el.checked : el.value;
      commit(() => { S.formValues[key] = v; });
      for (const other of views.values()) if (other !== pv && other.page.fileId === pv.page.fileId) renderForms(other);
      if (info.type !== 'text') renderForms(pv);
    });
    box.appendChild(el);
  }
}

/* ------------------------------------------------------------ thumbnails */
let thumbObs = null;
function tObserver() {
  if (!thumbObs) thumbObs = new IntersectionObserver(entries => {
    for (const e of entries) { const th = e.target._th; if (th && e.isIntersecting) requestThumb(th); }
  }, { root: $('#thumbs'), rootMargin: '400px 0px' });
  return thumbObs;
}
export function rebuildThumbs() {
  const ol = $('#thumbs'), ids = new Set(S.pages.map(p => p.id));
  for (const [id, th] of thumbs) if (!ids.has(id)) { tObserver().unobserve(th.el); th.el.remove(); thumbs.delete(id); }
  S.pages.forEach((p, i) => {
    let th = thumbs.get(p.id);
    if (!th) th = createThumb(p);
    th.page = p;
    const vp = meta(p).proxy.getViewport({ scale: 1, rotation: totalRot(p) }), sc = 124 / Math.max(vp.width, vp.height * 0.78);
    th.vp = meta(p).proxy.getViewport({ scale: sc, rotation: totalRot(p) });
    th.box.style.width = th.vp.width + 'px'; th.box.style.height = th.vp.height + 'px';
    th.num.textContent = i + 1;
    th.el.setAttribute('aria-selected', S.selPages.has(p.id) ? 'true' : 'false');
    th.el.classList.toggle('cur', S.cur === p.id);
    th.el.setAttribute('aria-label', `Page ${i + 1}`);
    ol.appendChild(th.el);
    renderThumbOverlay(th);
    if (th.key !== renderKey(p)) requestThumb(th);
  });
  const n = S.selPages.size;
  $('#railNote').textContent = n ? (n === 1 ? '1 page selected' : `${n} pages selected`) : `${S.pages.length} ${S.pages.length === 1 ? 'page' : 'pages'}`;
}
let thumbHooks = null;
export function setThumbHooks(h) { thumbHooks = h; }
function createThumb(p) {
  const el = document.createElement('li'); el.className = 'th'; el.draggable = true; el.tabIndex = 0; el.dataset.id = p.id;
  el.innerHTML = '<div class="th-page"><canvas></canvas><svg class="pv-doc"></svg><svg class="pv-hl"></svg><svg></svg></div><span class="th-num"></span>';
  const svgs = el.querySelectorAll('svg');
  const th = { el, page: p, box: el.children[0], canvas: el.querySelector('canvas'), doc: svgs[0], hl: svgs[1], ann: svgs[2], num: el.children[1], key: null, want: null };
  el._th = th;
  thumbHooks?.(th);
  thumbs.set(p.id, th); tObserver().observe(el);
  return th;
}
export function requestThumb(th) {
  const key = renderKey(th.page); if (th.key === key || th.want === key) return; th.want = key;
  enqueue('thumb', async () => {
    if (th.want !== key || !thumbs.has(th.page.id)) return;
    const c = document.createElement('canvas'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.ceil(th.vp.width * dpr); c.height = Math.ceil(th.vp.height * dpr);
    try {
      const proxy = proxyFor(th.page), vp = proxy.getViewport({ scale: th.vp.scale, rotation: totalRot(th.page) });
      await proxy.render({ canvas: c, viewport: vp, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0], annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise;
      if (th.want !== key) return;
      th.canvas.replaceWith(c); th.canvas = c; th.key = key; th.want = null;
    } catch { if (th.want === key) th.want = null; }
  });
}
let thumbOverlayFn = null;
export function setThumbOverlay(fn) { thumbOverlayFn = fn; }
export function renderThumbOverlay(th) { if (th.vp && thumbOverlayFn) thumbOverlayFn(th); }

/* ------------------------------------------------------------ zoom, status */
export function fitWidth(apply = true) {
  const desk = $('#desk'), maxW = Math.max(...S.pages.map(p => meta(p).proxy.getViewport({ scale: 1, rotation: totalRot(p) }).width), 300);
  setZoom(clamp((desk.clientWidth - 40) / (maxW * PX), 0.25, 1.25), apply);
}
export const curView = () => views.get(S.cur) || views.get(S.pages[0]?.id);
export function setZoom(z, apply = true, anchor) {
  z = clamp(Math.round(z * 100) / 100, 0.25, 4);
  const desk = $('#desk'), pv = curView();
  const rel = pv && apply ? (desk.scrollTop - pv.el.offsetTop) / pv.el.offsetHeight : 0;
  const ax = anchor ? (desk.scrollLeft + anchor[0]) / Math.max(1, desk.scrollWidth) : null;
  S.zoom = z; $('#zoomVal').textContent = Math.round(z * 100) + '%';
  if (!apply) return;
  closeEditors();
  for (const v of views.values()) updateView(v);
  renderSelection();
  if (pv) desk.scrollTop = pv.el.offsetTop + rel * pv.el.offsetHeight;
  if (ax !== null) desk.scrollLeft = ax * desk.scrollWidth - anchor[0];
  updateStatus();
}
const ZSTEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
export const zoomStep = dir => setZoom(dir > 0 ? (ZSTEPS.find(s => s > S.zoom + 0.001) ?? 4) : ([...ZSTEPS].reverse().find(s => s < S.zoom - 0.001) ?? 0.25));
const FORMATS = [['A5', 148, 210], ['A4', 210, 297], ['A3', 297, 420], ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6]];
export function updateStatus() {
  const p = pageOf(S.cur);
  const red = S.edits.filter(e => e.kind === 'redact').length;
  $('#stRedact').textContent = red ? `${red} ${red === 1 ? 'redaction' : 'redactions'} to apply on save` : '';
  $('#stEngine').textContent = engine.engine.available ? `MuPDF ${engine.engine.version || ''}`.trim() : (engine.engine.error ? 'Text editing unavailable' : '');
  if (!p) { $('#stPage').textContent = '—'; $('#stFormat').textContent = ''; return; }
  const i = S.pages.indexOf(p), v = p.crop || meta(p).view, rot = totalRot(p);
  let w = (v[2] - v[0]) * 25.4 / 72, h = (v[3] - v[1]) * 25.4 / 72; if (rot % 180) [w, h] = [h, w];
  const f = FORMATS.find(([, a, b]) => (Math.abs(a - w) < 2 && Math.abs(b - h) < 2) || (Math.abs(a - h) < 2 && Math.abs(b - w) < 2));
  $('#stPage').innerHTML = `Page <b>${i + 1}</b> of ${S.pages.length}`;
  $('#stFormat').textContent = `${f ? f[0] + ' ' + (w > h ? 'landscape' : 'portrait') + ' · ' : ''}${Math.round(w)} × ${Math.round(h)} mm${p.crop ? ' · cropped' : ''}${rot ? ` · rotated ${rot}°` : ''}`;
  for (const th of thumbs.values()) th.el.classList.toggle('cur', th.page.id === S.cur);
}

/* ------------------------------------------------------------ saving */
const downloadsCap = (window.claude && typeof window.claude.use === 'function') ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
export async function offerFile(data, filename, { markClean = false, type = 'application/pdf' } = {}) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const dl = await downloadsCap;
  if (dl) {
    try { await dl.save({ filename, data: blob }); if (markClean) setDirty(false); toast(`Saved "${filename}".`); }
    catch (e) { toast(e?.code === 'declined' ? 'Save cancelled.' : 'Saving is not available in this view.', e?.code === 'declined' ? 'info' : 'error'); }
    return;
  }
  if (window.showSaveFilePicker && !navigator.webdriver) {
    try {
      const ext = filename.split('.').pop();
      const h = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: ext.toUpperCase(), accept: { [type]: ['.' + ext] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      if (markClean) setDirty(false); toast(`Saved "${h.name}".`); return;
    } catch (e) { if (e?.name === 'AbortError') return; /* fall back to a download */ }
  }
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  if (markClean) setDirty(false);
  toast(`Downloaded "${filename}".`);
}
export const baseName = () => safeName(S.files.get(S.pages[0]?.fileId)?.name);
let saving = false;
export async function savePdf() {
  if (saving || !S.pages.length) return;
  closeEditors(); saving = true; const btn = $('#btnSave'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const { bytes, warnings, redactions } = await buildPdf(S.pages.map(p => p.id), { forSave: true });
    if (warnings.length) toast(warnings.join('. ') + '.', 'error', 6000);
    if (redactions) toast(`${redactions} ${redactions === 1 ? 'redaction' : 'redactions'} applied: the covered content was removed from the file.`);
    await offerFile(bytes, `${baseName()}${S.isSample ? '' : '-edited'}.pdf`, { markClean: true });
  } catch (e) { toast(e.user ? e.message : 'Saving failed.', 'error'); console.error(e); }
  finally { saving = false; btn.textContent = 'Save PDF'; btn.disabled = false; }
}
