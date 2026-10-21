// Side panels (search and redaction, header and footer, watermark, properties, protection, split),
// the bookmarks list and the page operations of the rail.
import { $, $$, uid, esc, fmt, clamp, bboxPts, inflate, parseRanges, makeZip, safeName } from './util.js';
import { S, pageOf, meta, snapshot } from './state.js';
import { HF_SLOTS, HF_TOKENS } from './doctools.js';
import {
  views, thumbs, commit, toast, rebuildViews, rebuildThumbs, refreshOverlays, updateStatus, updateTitle, offerFile, baseName,
  setThumbHooks, openAppend, setDirty, pushUndo,
} from './app.js';
import { buildPdf } from './export.js';
import { ensureText, addRedaction, newAnnot, select, closeEditors, renderSelection } from './tools.js';
import * as engine from './mupdf-client.js';

export const drafts = { hf: undefined, wm: undefined };
let drawer = null; // name of the open panel

/* ------------------------------------------------------------ drawer */
const TITLES = { search: 'Find and redact', hf: 'Header and footer', wm: 'Watermark', props: 'Document properties', protect: 'Protection', split: 'Split the document' };
export function openDrawer(name) {
  closeEditors();
  if (drawer === name) { closeDrawer(); return; }
  drafts.hf = undefined; drafts.wm = undefined;
  drawer = name;
  $('#drawer').hidden = false;
  document.body.classList.add('has-drawer');
  $('#drawerTitle').textContent = TITLES[name];
  const old = $('#drawerBody'), body = old.cloneNode(false); // a fresh element drops the previous panel's listeners
  old.replaceWith(body);
  ({ search: searchPanel, hf: hfPanel, wm: wmPanel, props: propsPanel, protect: protectPanel, split: splitPanel })[name](body);
  refreshOverlays();
}
export function closeDrawer() {
  drawer = null; drafts.hf = undefined; drafts.wm = undefined; hits = []; renderHits();
  $('#drawer').hidden = true; document.body.classList.remove('has-drawer');
  refreshOverlays();
}
export function renderDrawer() { if (drawer === 'split') splitSummary(); }

/* ------------------------------------------------------------ search and redact */
const PATTERNS = {
  email: ['Email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  phone: ['Phone numbers', /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?|\b\d{2,4}[\s./-])\d{3,4}[\s.-]?\d{3,4}\b/g],
  iban: ['IBAN', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g],
  cf: ['Italian tax codes', /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi],
  piva: ['Italian VAT numbers', /\b(?:IT\s?)?\d{11}\b/g],
  date: ['Dates', /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b/g],
};
let hits = [], curHit = -1;
function searchPanel(body) {
  body.innerHTML = `
    <label class="stack">Text to find<input type="search" id="sq" placeholder="Word or phrase" autocomplete="off"></label>
    <label class="fld"><input type="checkbox" id="sCase"> Match case</label>
    <div class="stack"><span class="lbl">Or find personal data</span><div class="chips">${Object.entries(PATTERNS).map(([k, [l]]) => `<label class="chip-check"><input type="checkbox" value="${k}"> ${l}</label>`).join('')}</div></div>
    <div class="row start"><button class="btn primary" type="button" id="sGo">Find</button><span class="hint" id="sCount"></span></div>
    <ol class="results" id="sResults"></ol>
    <div class="row start" id="sActions" hidden><button class="btn" type="button" id="sAll">Select all</button><button class="btn danger" type="button" id="sRedact">Mark for redaction</button><button class="btn" type="button" id="sHl">Highlight</button></div>
    <p class="note">Redaction permanently removes the text, images and graphics under the marked areas when you save the PDF.${engine.engine.available || !engine.engine.error ? '' : ' <b>The MuPDF engine is not available: redaction will not work.</b>'}</p>`;
  const run = async () => {
    const q = $('#sq').value, cs = $('#sCase').checked, pats = $$('.chips input:checked').map(i => i.value);
    if (!q.trim() && !pats.length) { $('#sCount').textContent = 'Type some text or choose a kind of data.'; return; }
    $('#sCount').textContent = 'Ricerca…';
    const res = [];
    const rx = [];
    if (q.trim()) rx.push(['text', new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), cs ? 'g' : 'gi')]);
    for (const k of pats) rx.push([PATTERNS[k][0], new RegExp(PATTERNS[k][1].source, PATTERNS[k][1].flags)]);
    for (const p of S.pages) {
      const lines = await ensureText(p);
      lines.forEach(ln => {
        for (const [kind, re] of rx) {
          re.lastIndex = 0; let m;
          while ((m = re.exec(ln.str))) {
            if (!m[0].length) { re.lastIndex++; continue; }
            const cs2 = ln.chars.slice(m.index, m.index + m[0].length).filter(c => !c.virtual);
            if (!cs2.length) continue;
            const box = [Math.min(...cs2.map(c => c.x0)), Math.min(...cs2.map(c => c.y0)), Math.max(...cs2.map(c => c.x1)), Math.max(...cs2.map(c => c.y1))];
            const from = Math.max(0, m.index - 24), snippet = (from ? '…' : '') + ln.str.slice(from, m.index) + '\u0001' + m[0] + '\u0002' + ln.str.slice(m.index + m[0].length, m.index + m[0].length + 24);
            res.push({ id: uid('h'), pageId: p.id, box, text: m[0], kind, snippet, on: true });
          }
        }
      });
    }
    hits = res; curHit = -1;
    $('#sCount').textContent = res.length ? `${res.length} ${res.length === 1 ? 'result' : 'results'}` : 'No results';
    $('#sActions').hidden = !res.length;
    const ol = $('#sResults'); ol.innerHTML = '';
    for (const h of res) {
      const li = document.createElement('li');
      const n = S.pages.findIndex(p => p.id === h.pageId) + 1;
      li.innerHTML = `<input type="checkbox" checked aria-label="Include"><button type="button" class="res"><span class="res-pg">p. ${n}</span><span class="res-tx">${esc(h.snippet).replace('\u0001', '<mark>').replace('\u0002', '</mark>')}</span></button>`;
      li.querySelector('input').onchange = e => { h.on = e.target.checked; renderHits(); };
      li.querySelector('button').onclick = () => goHit(res.indexOf(h));
      ol.appendChild(li);
    }
    renderHits();
    if (res.length) goHit(0);
  };
  $('#sGo').onclick = run;
  $('#sq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  $('#sAll').onclick = () => { const all = !hits.every(h => h.on); hits.forEach(h => { h.on = all; }); $$('#sResults input').forEach(i => { i.checked = all; }); renderHits(); };
  $('#sRedact').onclick = () => {
    const chosen = hits.filter(h => h.on); if (!chosen.length) return;
    const snap = snapshot();
    const byPage = new Map();
    for (const h of chosen) { if (!byPage.has(h.pageId)) byPage.set(h.pageId, []); byPage.get(h.pageId).push(inflate(h.box, 1)); }
    for (const [pid, rects] of byPage) { const p = pageOf(pid); S.edits.push({ id: uid('e'), kind: 'redact', src: p.fileId, idx: p.idx, rects, fill: '#000000', label: 'search' }); }
    pushUndo(snap); setDirty();
    refreshOverlays(); updateStatus();
    toast(`${chosen.length} ${chosen.length === 1 ? 'result' : 'results'} marked for redaction.`);
  };
  $('#sHl').onclick = () => {
    const chosen = hits.filter(h => h.on); if (!chosen.length) return;
    commit(() => { for (const h of chosen) { const [x1, y1, x2, y2] = h.box; S.annots.push(newAnnot('highlight', h.pageId, { quads: [[x1, y2, x2, y2, x1, y1, x2, y1]] })); } });
    refreshOverlays(); toast(`${chosen.length} ${chosen.length === 1 ? 'highlight' : 'highlights'} added.`);
  };
  setTimeout(() => $('#sq').focus(), 0);
}
function goHit(i) {
  if (i < 0 || i >= hits.length) return;
  curHit = i; const h = hits[i], pv = views.get(h.pageId); if (!pv) return;
  S.cur = h.pageId;
  const [x, y] = pv.vp.convertToViewportPoint(h.box[0], h.box[3]);
  const desk = $('#desk');
  desk.scrollTo({ top: pv.el.offsetTop + y - desk.clientHeight / 3, left: Math.max(0, pv.el.offsetLeft + x - 40), behavior: 'smooth' });
  $$('#sResults li').forEach((li, k) => li.classList.toggle('cur', k === i));
  renderHits(); updateStatus();
}
export function renderHits() {
  for (const pv of views.values()) pv.ui.querySelectorAll('.hit').forEach(n => n.remove());
  hits.forEach((h, i) => {
    const pv = views.get(h.pageId); if (!pv || !h.on) return;
    const a = pv.vp.convertToViewportPoint(h.box[0], h.box[1]), b = pv.vp.convertToViewportPoint(h.box[2], h.box[3]);
    const el = document.createElement('div'); el.className = 'hit' + (i === curHit ? ' cur' : '');
    Object.assign(el.style, { left: Math.min(a[0], b[0]) + 'px', top: Math.min(a[1], b[1]) + 'px', width: Math.abs(a[0] - b[0]) + 'px', height: Math.abs(a[1] - b[1]) + 'px' });
    pv.ui.appendChild(el);
  });
}

/* ------------------------------------------------------------ header and footer */
const HF_DEFAULT = { slots: { tl: '', tc: '', tr: '', bl: '', bc: 'Page {page} of {total}', br: '' }, size: 9, color: '#333333', margin: 28.35, startNumber: 1, range: 'all', bates: { prefix: 'DOC', start: 1, digits: 6, suffix: '' } };
const SLOT_LABEL = { tl: 'Top left', tc: 'Top centre', tr: 'Top right', bl: 'Bottom left', bc: 'Bottom centre', br: 'Bottom right' };
function hfPanel(body) {
  const d = structuredClone(S.doc.hf || HF_DEFAULT);
  drafts.hf = d;
  body.innerHTML = `
    <div class="slots">${HF_SLOTS.map(k => `<label class="stack">${SLOT_LABEL[k]}<input type="text" data-slot="${k}" value="${esc(d.slots[k] || '')}"></label>`).join('')}</div>
    <div class="stack"><span class="lbl">Insert into the active field</span><div class="chips">${HF_TOKENS.map(([t, l]) => `<button type="button" class="chip" data-tok="${t}" title="${esc(l)}">${esc(l)}</button>`).join('')}</div></div>
    <div class="grid2">
      <label class="stack">Size (pt)<input type="number" id="hfSize" min="5" max="36" step="0.5" value="${d.size}"></label>
      <label class="stack">Colour<input type="color" id="hfColor" value="${d.color}"></label>
      <label class="stack">Margin (mm)<input type="number" id="hfMargin" min="2" max="60" step="1" value="${Math.round(d.margin * 25.4 / 72)}"></label>
      <label class="stack">First number<input type="number" id="hfStart" min="0" step="1" value="${d.startNumber}"></label>
    </div>
    <label class="stack">Pages<input type="text" id="hfRange" placeholder="all, or 2-10" value="${d.range === 'all' ? '' : esc(d.range)}"></label>
    <details ${d.slots && Object.values(d.slots).some(v => /\{bates\}/.test(v)) ? 'open' : ''}><summary>Bates numbering</summary>
      <div class="grid2">
        <label class="stack">Prefix<input type="text" id="bPrefix" value="${esc(d.bates.prefix)}"></label>
        <label class="stack">Suffix<input type="text" id="bSuffix" value="${esc(d.bates.suffix)}"></label>
        <label class="stack">Start number<input type="number" id="bStart" min="0" value="${d.bates.start}"></label>
        <label class="stack">Digits<input type="number" id="bDigits" min="1" max="12" value="${d.bates.digits}"></label>
      </div>
      <p class="note">Insert "Bates number" into one of the fields, for example ${esc(d.bates.prefix)}${'0'.repeat(Math.max(0, d.bates.digits - 1))}1.</p>
    </details>
    <div class="row start"><button class="btn primary" type="button" id="hfApply">Apply</button>${S.doc.hf ? '<button class="btn danger-link ghost" type="button" id="hfRemove">Remove</button>' : ''}</div>
    <p class="note">The text is written into the page content when you save. The preview is on the pages.</p>`;
  let active = body.querySelector('[data-slot="bc"]');
  const sync = () => {
    $$('[data-slot]', body).forEach(i => { d.slots[i.dataset.slot] = i.value; });
    d.size = clamp(+$('#hfSize').value || 9, 5, 36); d.color = $('#hfColor').value; d.margin = clamp(+$('#hfMargin').value || 10, 2, 60) * 72 / 25.4;
    d.startNumber = +$('#hfStart').value || 1; d.range = $('#hfRange').value.trim() || 'all';
    d.bates = { prefix: $('#bPrefix').value, suffix: $('#bSuffix').value, start: +$('#bStart').value || 1, digits: clamp(+$('#bDigits').value || 6, 1, 12) };
    if (Object.values(d.slots).some(v => v.includes('{bates}'))) body.querySelector('details').open = true;
    refreshOverlays();
  };
  body.addEventListener('input', sync);
  $$('[data-slot]', body).forEach(i => i.addEventListener('focus', () => { active = i; }));
  $$('[data-tok]', body).forEach(b => b.addEventListener('click', () => {
    const i = active, t = b.dataset.tok, s = i.selectionStart ?? i.value.length;
    i.value = i.value.slice(0, s) + t + i.value.slice(i.selectionEnd ?? s); i.focus(); i.setSelectionRange(s + t.length, s + t.length); sync();
  }));
  $('#hfApply').onclick = () => { sync(); const v = structuredClone(d); commit(() => { S.doc.hf = Object.values(v.slots).some(x => x.trim()) ? v : null; }); closeDrawer(); toast(S.doc.hf ? 'Header and footer applied.' : 'Header and footer removed.'); };
  $('#hfRemove')?.addEventListener('click', () => { commit(() => { S.doc.hf = null; }); closeDrawer(); toast('Header and footer removed.'); });
}

/* ------------------------------------------------------------ watermark */
const WM_DEFAULT = { text: 'DRAFT', size: 72, color: '#d92d20', opacity: 0.2, angle: 45, behind: false, range: 'all' };
function wmPanel(body) {
  const d = structuredClone(S.doc.wm || WM_DEFAULT);
  drafts.wm = d;
  body.innerHTML = `
    <label class="stack">Text<input type="text" id="wmText" value="${esc(d.text)}"></label>
    <div class="grid2">
      <label class="stack">Size (pt)<input type="number" id="wmSize" min="8" max="300" value="${d.size}"></label>
      <label class="stack">Colour<input type="color" id="wmColor" value="${d.color}"></label>
      <label class="stack">Rotation<select id="wmAngle"><option value="0">Horizontal</option><option value="45">Diagonal ↗</option><option value="-45">Diagonal ↘</option><option value="90">Vertical</option></select></label>
      <label class="stack">Layer<select id="wmLayer"><option value="0">Over the content</option><option value="1">Behind the content</option></select></label>
    </div>
    <label class="stack">Opacity <output id="wmOpOut">${Math.round(d.opacity * 100)}%</output><input type="range" id="wmOp" min="5" max="100" step="5" value="${Math.round(d.opacity * 100)}"></label>
    <label class="stack">Pages<input type="text" id="wmRange" placeholder="all, or 1-3" value="${d.range === 'all' ? '' : esc(d.range)}"></label>
    <div class="row start"><button class="btn primary" type="button" id="wmApply">Apply</button>${S.doc.wm ? '<button class="btn danger-link ghost" type="button" id="wmRemove">Remove</button>' : ''}</div>
    <p class="note">"Behind the content" is not visible on pages with a solid background, such as scans.</p>`;
  $('#wmAngle').value = String(d.angle); $('#wmLayer').value = d.behind ? '1' : '0';
  const sync = () => {
    d.text = $('#wmText').value; d.size = clamp(+$('#wmSize').value || 72, 8, 300); d.color = $('#wmColor').value; d.angle = +$('#wmAngle').value;
    d.behind = $('#wmLayer').value === '1'; d.opacity = +$('#wmOp').value / 100; $('#wmOpOut').textContent = $('#wmOp').value + '%'; d.range = $('#wmRange').value.trim() || 'all';
    refreshOverlays();
  };
  body.addEventListener('input', sync); body.addEventListener('change', sync);
  $('#wmApply').onclick = () => { sync(); const v = structuredClone(d); commit(() => { S.doc.wm = v.text.trim() ? v : null; }); closeDrawer(); toast(S.doc.wm ? 'Watermark applied.' : 'Watermark removed.'); };
  $('#wmRemove')?.addEventListener('click', () => { commit(() => { S.doc.wm = null; }); closeDrawer(); toast('Watermark removed.'); });
}

/* ------------------------------------------------------------ properties */
function propsPanel(body) {
  const first = S.files.get(S.pages[0]?.fileId)?.lib;
  const get = k => { try { return first?.[k]?.() || ''; } catch { return ''; } };
  const m = S.doc.meta || { title: get('getTitle'), author: get('getAuthor'), subject: get('getSubject'), keywords: get('getKeywords') };
  const files = [...new Set(S.pages.map(p => S.files.get(p.fileId).name))];
  body.innerHTML = `
    <label class="stack">Title<input type="text" id="mTitle" value="${esc(m.title)}"></label>
    <label class="stack">Author<input type="text" id="mAuthor" value="${esc(m.author)}"></label>
    <label class="stack">Subject<input type="text" id="mSubject" value="${esc(m.subject)}"></label>
    <label class="stack">Keywords<input type="text" id="mKeywords" placeholder="separated by commas" value="${esc(Array.isArray(m.keywords) ? m.keywords.join(', ') : m.keywords)}"></label>
    <dl class="facts"><dt>Pages</dt><dd>${S.pages.length}</dd><dt>Source files</dt><dd>${files.map(esc).join('<br>')}</dd><dt>Comments</dt><dd>${S.annots.length}</dd><dt>Content edits</dt><dd>${S.edits.filter(e => e.kind !== 'redact').length}</dd><dt>Bookmarks</dt><dd>${S.bookmarks.length}</dd></dl>
    <div class="row start"><button class="btn primary" type="button" id="mApply">Apply</button></div>`;
  $('#mApply').onclick = () => {
    const v = { title: $('#mTitle').value.trim(), author: $('#mAuthor').value.trim(), subject: $('#mSubject').value.trim(), keywords: $('#mKeywords').value.trim() };
    commit(() => { S.doc.meta = v; }); closeDrawer(); toast('Properties updated.');
  };
}

/* ------------------------------------------------------------ protection */
function protectPanel(body) {
  const p = S.doc.protect || { user: '', owner: '', allow: { print: true, copy: false, edit: false, comment: true } };
  const off = !engine.engine.available && engine.engine.error;
  body.innerHTML = `
    ${off ? '<p class="err">The MuPDF engine is not available: protection cannot be applied.</p>' : ''}
    <fieldset><legend><label><input type="checkbox" id="pUserOn" ${p.user ? 'checked' : ''}> Require a password to open</label></legend>
      <label class="stack">Open password<input type="password" id="pUser" autocomplete="new-password" value="${esc(p.user)}"></label>
      <label class="stack">Repeat the password<input type="password" id="pUser2" autocomplete="new-password" value="${esc(p.user)}"></label></fieldset>
    <fieldset><legend><label><input type="checkbox" id="pOwnerOn" ${p.owner ? 'checked' : ''}> Restrict printing and editing</label></legend>
      <label class="stack">Permissions password<input type="password" id="pOwner" autocomplete="new-password" value="${esc(p.owner)}"></label>
      <label class="stack">Repeat the password<input type="password" id="pOwner2" autocomplete="new-password" value="${esc(p.owner)}"></label>
      <span class="lbl">Without the permissions password, people can:</span>
      <label class="fld"><input type="checkbox" id="aPrint" ${p.allow.print ? 'checked' : ''}> Print</label>
      <label class="fld"><input type="checkbox" id="aCopy" ${p.allow.copy ? 'checked' : ''}> Copy text and images</label>
      <label class="fld"><input type="checkbox" id="aEdit" ${p.allow.edit ? 'checked' : ''}> Edit and reorganise pages</label>
      <label class="fld"><input type="checkbox" id="aComment" ${p.allow.comment ? 'checked' : ''}> Comment and fill in forms</label></fieldset>
    <p class="err" id="pErr" hidden></p>
    <div class="row start"><button class="btn primary" type="button" id="pApply" ${off ? 'disabled' : ''}>Apply on save</button>${S.doc.protect ? '<button class="btn ghost danger-link" type="button" id="pRemove">Remove protection</button>' : ''}</div>
    <p class="note">256-bit AES encryption. Passwords cannot contain commas. Keep them safe: without the open password the file cannot be opened.</p>`;
  $('#pApply').onclick = () => {
    const err = m => { $('#pErr').textContent = m; $('#pErr').hidden = false; };
    const uOn = $('#pUserOn').checked, oOn = $('#pOwnerOn').checked;
    const u = uOn ? $('#pUser').value : '', o = oOn ? $('#pOwner').value : '';
    if (!uOn && !oOn) { err('Choose at least one of the two protections.'); return; }
    if (uOn && !u) { err('Enter the open password.'); return; }
    if (oOn && !o) { err('Enter the permissions password.'); return; }
    if (uOn && u !== $('#pUser2').value) { err('The two open passwords do not match.'); return; }
    if (oOn && o !== $('#pOwner2').value) { err('The two permissions passwords do not match.'); return; }
    if (/,/.test(u + o)) { err('Passwords cannot contain commas.'); return; }
    if (uOn && oOn && u === o) { err('Use two different passwords: with the same password, anyone who opens the file gets every permission.'); return; }
    const v = { user: u, owner: o, allow: { print: $('#aPrint').checked, copy: $('#aCopy').checked, edit: $('#aEdit').checked, comment: $('#aComment').checked } };
    commit(() => { S.doc.protect = v; }); updateTitle(); closeDrawer(); toast('Protection will be applied when you save.');
  };
  $('#pRemove')?.addEventListener('click', () => { commit(() => { S.doc.protect = null; }); updateTitle(); closeDrawer(); toast('Protection removed.'); });
}

/* ------------------------------------------------------------ split */
function splitPanel(body) {
  const tops = S.bookmarks.filter(b => b.level === 0 && b.pageId && pageOf(b.pageId));
  body.innerHTML = `
    <label class="radio"><input type="radio" name="spm" value="every" checked> Every <input type="number" id="spN" min="1" value="1" class="w-num"> pages</label>
    <label class="radio"><input type="radio" name="spm" value="ranges"> By page ranges</label>
    <input type="text" id="spRanges" placeholder="For example: 1-3, 4, 5-">
    <label class="radio"><input type="radio" name="spm" value="bm" ${tops.length ? '' : 'disabled'}> At each top-level bookmark${tops.length ? ` (${tops.length})` : ' (none)'}</label>
    <p class="hint" id="spSum"></p>
    <div class="row start"><button class="btn primary" type="button" id="spGo">Split and download</button></div>
    <p class="note">When there is more than one file you get a .zip archive.</p>`;
  body.addEventListener('input', splitSummary); body.addEventListener('change', splitSummary);
  $('#spRanges').addEventListener('focus', () => { body.querySelector('[value="ranges"]').checked = true; splitSummary(); });
  $('#spGo').onclick = doSplit;
  splitSummary();
}
function splitParts() {
  const mode = $('input[name="spm"]:checked')?.value, n = S.pages.length;
  if (mode === 'every') { const k = Math.max(1, +$('#spN').value || 1), out = []; for (let i = 0; i < n; i += k) out.push(S.pages.slice(i, i + k)); return out; }
  if (mode === 'ranges') { const r = parseRanges($('#spRanges').value, n); return r ? r.map(list => list.map(i => S.pages[i])) : null; }
  if (mode === 'bm') {
    const starts = [...new Set(S.bookmarks.filter(b => b.level === 0 && b.pageId).map(b => S.pages.findIndex(p => p.id === b.pageId)).filter(i => i >= 0))].sort((a, b) => a - b);
    if (!starts.length) return null; if (starts[0] !== 0) starts.unshift(0);
    return starts.map((s, i) => S.pages.slice(s, starts[i + 1] ?? n));
  }
  return null;
}
function splitSummary() {
  if (drawer !== 'split' || !$('#spSum')) return;
  const parts = splitParts();
  const label = list => { const a = S.pages.indexOf(list[0]) + 1, b = S.pages.indexOf(list[list.length - 1]) + 1; return a === b ? `${a}` : `${a}–${b}`; };
  $('#spSum').textContent = !parts ? 'Invalid ranges: use page numbers from 1 to ' + S.pages.length + '.' : `${parts.length} ${parts.length === 1 ? 'file' : 'files'}: ${parts.slice(0, 12).map(label).join(', ')}${parts.length > 12 ? '…' : ''}`;
  $('#spGo').disabled = !parts || !parts.length;
}
async function doSplit() {
  const parts = splitParts(); if (!parts?.length) return;
  const btn = $('#spGo'); btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const base = baseName(), files = [];
    for (const [k, list] of parts.entries()) {
      const { bytes } = await buildPdf(list.map(p => p.id), { forSave: true });
      const a = S.pages.indexOf(list[0]) + 1, b = S.pages.indexOf(list[list.length - 1]) + 1;
      files.push({ name: `${base}-${String(k + 1).padStart(String(parts.length).length, '0')}-p${a === b ? a : `${a}-${b}`}.pdf`, data: bytes });
    }
    if (files.length === 1) await offerFile(files[0].data, files[0].name);
    else await offerFile(makeZip(files), `${base}-split.zip`, { type: 'application/zip' });
  } catch (e) { toast(e.user ? e.message : 'Splitting failed.', 'error'); console.error(e); }
  finally { btn.disabled = false; btn.textContent = 'Split and download'; }
}

/* ------------------------------------------------------------ bookmarks */
let selBm = null;
export function setRailTab(tab) {
  S.railTab = tab;
  $$('.rail-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  $('#railPages').hidden = tab !== 'pages'; $('#railBookmarks').hidden = tab !== 'bookmarks';
  if (tab === 'bookmarks') renderBookmarks();
}
export function renderBookmarks() {
  const ol = $('#bmList'); if (!ol) return;
  ol.innerHTML = '';
  if (!S.bookmarks.length) { ol.innerHTML = '<li class="empty">No bookmarks. Go to a page and press Add.</li>'; }
  for (const b of S.bookmarks) {
    const li = document.createElement('li'); li.className = 'bm' + (b.id === selBm ? ' sel' : ''); li.style.paddingLeft = 8 + b.level * 14 + 'px';
    const n = b.pageId ? S.pages.findIndex(p => p.id === b.pageId) + 1 : 0;
    li.innerHTML = `<button type="button" class="bm-t" title="${esc(b.title)}">${esc(b.title)}</button><span class="bm-p">${n > 0 ? n : '—'}</span>`;
    li.querySelector('.bm-t').onclick = () => { selBm = b.id; renderBookmarks(); if (n > 0) { S.cur = b.pageId; views.get(b.pageId)?.el.scrollIntoView({ block: 'start', behavior: 'smooth' }); updateStatus(); } };
    li.querySelector('.bm-t').ondblclick = () => renameBm(b, li);
    ol.appendChild(li);
  }
  const has = !!S.bookmarks.find(b => b.id === selBm);
  $$('#bmTools [data-need]').forEach(btn => { btn.disabled = !has; });
}
function renameBm(b, li) {
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = b.title; inp.className = 'bm-edit'; inp.setAttribute('aria-label', 'Bookmark title');
  li.querySelector('.bm-t').replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const fin = ok => { if (done) return; done = true; const v = inp.value.trim(); if (ok && v && v !== b.title) commit(() => { b.title = v; }); renderBookmarks(); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); });
  inp.addEventListener('blur', () => fin(true));
}
export function bookmarkAction(act) {
  const i = S.bookmarks.findIndex(b => b.id === selBm), b = S.bookmarks[i];
  if (act === 'add') {
    const p = pageOf(S.cur); if (!p) return;
    const n = S.pages.indexOf(p) + 1, nb = { id: uid('b'), title: `Page ${n}`, pageId: p.id, level: b ? b.level : 0 };
    commit(() => { S.bookmarks.splice(i >= 0 ? i + 1 : S.bookmarks.length, 0, nb); });
    selBm = nb.id; renderBookmarks();
    const li = [...$('#bmList').children][S.bookmarks.indexOf(nb)]; if (li) renameBm(nb, li);
    return;
  }
  if (!b) return;
  // a bookmark moves together with its children
  const end = (() => { let j = i + 1; while (j < S.bookmarks.length && S.bookmarks[j].level > b.level) j++; return j; })();
  if (act === 'del') commit(() => { S.bookmarks.splice(i, 1); for (let j = i; j < end - 1; j++) S.bookmarks[j].level = Math.max(0, S.bookmarks[j].level - 1); });
  if (act === 'rename') { renameBm(b, [...$('#bmList').children][i]); return; }
  if (act === 'in' && i > 0 && S.bookmarks[i - 1].level >= b.level) commit(() => { for (let j = i; j < end; j++) S.bookmarks[j].level++; });
  if (act === 'out' && b.level > 0) commit(() => { for (let j = i; j < end; j++) S.bookmarks[j].level--; });
  if (act === 'up' && i > 0) {
    let s = i - 1; while (s > 0 && S.bookmarks[s].level > b.level) s--;
    commit(() => { const blk = S.bookmarks.splice(i, end - i); S.bookmarks.splice(s, 0, ...blk); });
  }
  if (act === 'down' && end < S.bookmarks.length) {
    let e2 = end + 1; while (e2 < S.bookmarks.length && S.bookmarks[e2].level > S.bookmarks[end].level) e2++;
    commit(() => { const blk = S.bookmarks.splice(i, end - i); S.bookmarks.splice(i + (e2 - end), 0, ...blk); });
  }
  if (act === 'here') { const p = pageOf(S.cur); if (p) commit(() => { b.pageId = p.id; }); }
  renderBookmarks();
}

/* ------------------------------------------------------------ page operations */
export function targetPages() { const sel = S.pages.filter(p => S.selPages.has(p.id)); return sel.length ? sel : S.pages.filter(p => p.id === S.cur); }
const norm4 = r => ((r % 360) + 360) % 360;
export function rotatePages(dir) { const t = targetPages(); if (!t.length) return; commit(() => t.forEach(p => { p.rot = norm4(p.rot + dir); })); rebuildViews(); }
export function movePages(dir) {
  const ids = new Set(targetPages().map(p => p.id)); if (!ids.size) return;
  const arr = S.pages.slice();
  if (dir < 0) { for (let i = 1; i < arr.length; i++) if (ids.has(arr[i].id) && !ids.has(arr[i - 1].id)) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; }
  else { for (let i = arr.length - 2; i >= 0; i--) if (ids.has(arr[i].id) && !ids.has(arr[i + 1].id)) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; }
  if (arr.every((p, k) => p === S.pages[k])) return;
  commit(() => { S.pages = arr; }); rebuildViews();
}
export function deletePages() {
  const t = targetPages(); if (!t.length) return;
  if (t.length >= S.pages.length) { toast('The document must keep at least one page.', 'error'); return; }
  const ids = new Set(t.map(p => p.id));
  commit(() => { S.pages = S.pages.filter(p => !ids.has(p.id)); });
  S.selPages.clear(); if (ids.has(S.cur)) S.cur = null; select(null); rebuildViews();
  toast(t.length === 1 ? 'Page deleted. Press Ctrl+Z to undo.' : `${t.length} pages deleted. Press Ctrl+Z to undo.`);
}
export function uncropPages() {
  const t = targetPages().filter(p => p.crop); if (!t.length) { toast('The selected pages are not cropped.'); return; }
  commit(() => t.forEach(p => { p.crop = null; })); refreshOverlays(); rebuildThumbs(); updateStatus(); toast('Crop removed.');
}
export async function extractPages() {
  const t = targetPages(); if (!t.length) return;
  closeEditors();
  try {
    const { bytes } = await buildPdf(t.map(p => p.id), { forSave: true });
    const nums = t.map(p => S.pages.indexOf(p) + 1);
    await offerFile(bytes, `${baseName()}-pages-${compactRanges(nums)}.pdf`);
  } catch (e) { toast(e.user ? e.message : 'Extracting failed.', 'error'); console.error(e); }
}
function compactRanges(n) { const out = []; for (let i = 0; i < n.length; i++) { let j = i; while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++; out.push(j > i ? `${n[i]}-${n[j]}` : `${n[i]}`); i = j; } return out.join('_'); }

/* thumbnails: selection and drag to reorder, files dropped on the rail are inserted there */
let lastThumbClick = null, thumbDrag = null;
setThumbHooks(th => {
  th.el.addEventListener('click', e => onThumbClick(e, th));
  th.el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onThumbClick(e, th); } });
  th.el.addEventListener('dragstart', e => {
    const id = th.page.id;
    if (!S.selPages.has(id)) { S.selPages.clear(); S.selPages.add(id); rebuildThumbs(); }
    thumbDrag = S.pages.filter(p => S.selPages.has(p.id)).map(p => p.id);
    th.el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'pages');
  });
  th.el.addEventListener('dragend', () => { th.el.classList.remove('dragging'); clearDropMarks(); thumbDrag = null; });
});
function onThumbClick(e, th) {
  const id = th.page.id;
  if (e.shiftKey && lastThumbClick && pageOf(lastThumbClick)) {
    const a = S.pages.findIndex(p => p.id === lastThumbClick), b = S.pages.findIndex(p => p.id === id);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.selPages.add(S.pages[i].id);
  } else if (e.ctrlKey || e.metaKey) { S.selPages.has(id) ? S.selPages.delete(id) : S.selPages.add(id); lastThumbClick = id; }
  else { S.selPages.clear(); S.selPages.add(id); lastThumbClick = id; }
  S.cur = id;
  views.get(id)?.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  rebuildThumbs(); updateStatus();
  if (window.matchMedia('(max-width: 760px)').matches && !(e.shiftKey || e.ctrlKey || e.metaKey)) $('#rail').classList.remove('open');
}
export function selectAllPages() { S.pages.forEach(p => S.selPages.add(p.id)); rebuildThumbs(); }
function clearDropMarks() { for (const th of thumbs.values()) th.el.classList.remove('drop-before', 'drop-after'); }
function dropIndex(e) {
  const items = S.pages.map(p => thumbs.get(p.id)).filter(Boolean);
  for (let i = 0; i < items.length; i++) { const r = items[i].el.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) return i; }
  return items.length;
}
export function wireRailDrop() {
  const ol = $('#thumbs');
  const isFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  ol.addEventListener('dragover', e => {
    if (!thumbDrag && !isFiles(e)) return; e.preventDefault(); clearDropMarks();
    const i = dropIndex(e), items = S.pages.map(p => thumbs.get(p.id));
    if (i < items.length) items[i].el.classList.add('drop-before'); else items[items.length - 1]?.el.classList.add('drop-after');
  });
  ol.addEventListener('dragleave', e => { if (!ol.contains(e.relatedTarget)) clearDropMarks(); });
  ol.addEventListener('drop', e => {
    const i = dropIndex(e); clearDropMarks();
    if (isFiles(e)) {
      e.preventDefault(); e.stopPropagation(); document.dispatchEvent(new CustomEvent('mg-drop-done'));
      openAppend([...e.dataTransfer.files], i); return;
    }
    if (!thumbDrag) return; e.preventDefault(); e.stopPropagation();
    const moving = new Set(thumbDrag);
    const before = S.pages.slice(0, i).filter(p => !moving.has(p.id)), after = S.pages.slice(i).filter(p => !moving.has(p.id));
    const next = [...before, ...S.pages.filter(p => moving.has(p.id)), ...after];
    thumbDrag = null;
    if (next.every((p, k) => p === S.pages[k])) return;
    commit(() => { S.pages = next; }); rebuildViews();
  });
}
export { setDirty, renderSelection, bboxPts, fmt, meta, safeName };
