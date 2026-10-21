// Entry point: toolbar, keyboard shortcuts, drag and drop, start-up.
import './styles.css';
import { $, $$ } from './util.js';
import { S } from './state.js';
import { initFonts } from './fonts.js';
import * as engine from './mupdf-client.js';
import {
  views, toast, undo, redo, zoomStep, fitWidth, savePdf, openFiles, openReplace, openAppend, insertBlankPage, setZoom, updateStatus,
  refreshOverlays, curView, commit, rebuildViews, load,
} from './app.js';
import { setTool, select, selected, deleteSelected, renderProps, renderSelection, closeEditors, addImageFile, loadDefaults } from './tools.js';
import {
  openDrawer, closeDrawer, setRailTab, bookmarkAction, rotatePages, movePages, deletePages, extractPages, uncropPages, selectAllPages, wireRailDrop,
} from './panels.js';
import { buildSample } from './sample.js';
import { translateAnnot } from './geometry.js';

const ICONS = {
  pages: '<rect x="3.5" y="3" width="9" height="11.5" rx="1"/><path d="M7.5 17h8a1 1 0 0 0 1-1V6.5"/>',
  select: '<path d="M5.5 3.5v12l3.3-3.1 2.4 5.1 2-.9-2.4-5h4.6z"/>',
  text: '<path d="M4.5 5.5v-2h11v2M10 3.5v13M7.5 16.5h5"/>',
  highlight: '<path d="M12.6 3.4l4 4-7.4 7.4H5.2v-4z"/><path d="M3.5 18h13"/>',
  underline: '<path d="M6 3.5v6a4 4 0 0 0 8 0v-6"/><path d="M4.5 17h11"/>',
  strike: '<path d="M14 5.5c-.8-1.3-2.3-2-4-2-2.2 0-3.9 1.2-3.9 3 0 3.8 8.3 2.6 8.3 6.6 0 1.9-1.9 3.4-4.4 3.4-1.9 0-3.5-.8-4.3-2.3"/><path d="M3.5 10h13"/>',
  ink: '<path d="M3.5 15.5c2.2-5 4.4-1.2 6.2-4.4 1.6-2.8 3.6-6.6 6.8-6.6"/><path d="M3.5 18h5"/>',
  note: '<path d="M4 4h12v9.5H9.5l-4 3.5v-3.5H4z"/><path d="M7 8h6M7 10.5h4"/>',
  rect: '<rect x="3.5" y="5" width="13" height="10" rx="1"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="7" ry="5.3"/>',
  line: '<path d="M4 16L16 4"/>',
  arrow: '<path d="M4 16L16 4M9.5 4H16v6.5"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="1.2"/><circle cx="7.5" cy="8.3" r="1.4"/><path d="M3.5 14l4-3.4 3 2.4 2.5-2 3.5 3"/>',
  sign: '<path d="M3 13.5c1.8-6 4.2-6.2 4.6-3.1.4 3.5 2.3-2.4 3.8-.6 1 1.3 2 .9 3.6-1.3"/><path d="M3 17h14"/>',
  edittext: '<path d="M3.5 5V3.5h9V5M8 3.5V14M6 14h4"/><path d="M12.5 16.5l4-4 1.3 1.3-4 4H12.5z"/>',
  editimage: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M3 11l3-2.5 2.2 1.8 2-1.5 3 2.4"/><path d="M12 17.5l4.8-4.8 1.5 1.5-4.8 4.8H12z"/>',
  addimage: '<rect x="2.5" y="4" width="11" height="9" rx="1"/><path d="M3 11.5l3-2.5 2.2 1.8 2-1.5 3 2.4"/><path d="M16 11v6M13 14h6"/>',
  redactarea: '<rect x="3" y="5" width="14" height="10" rx="1"/><path d="M6 8.5h8M6 11.5h5" stroke-width="3"/>',
  redacttext: '<path d="M3 6h14M3 14h6"/><rect x="3" y="8.6" width="14" height="2.8" fill="currentColor"/>',
  search: '<circle cx="8.5" cy="8.5" r="5"/><path d="M12.3 12.3L17 17"/>',
  searchred: '<circle cx="8" cy="8" r="4.5"/><path d="M11.4 11.4l2.6 2.6"/><rect x="12" y="14.5" width="6" height="3" fill="currentColor"/>',
  eye: '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.4"/>',
  undo: '<path d="M7.5 5L4 8.5 7.5 12"/><path d="M4 8.5h8.2a4.3 4.3 0 0 1 0 8.6H8.5"/>',
  redo: '<path d="M12.5 5L16 8.5 12.5 12"/><path d="M16 8.5H7.8a4.3 4.3 0 0 0 0 8.6h3.7"/>',
  minus: '<path d="M5 10h10"/>', plus: '<path d="M5 10h10M10 5v10"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  rotl: '<path d="M4.5 8.5A6 6 0 1 1 5 13"/><path d="M4.5 3.8v4.7h4.7"/>',
  rotr: '<path d="M15.5 8.5A6 6 0 1 0 15 13"/><path d="M15.5 3.8v4.7h-4.7"/>',
  up: '<path d="M10 16V4.5M5.5 9L10 4.5 14.5 9"/>', down: '<path d="M10 4v11.5M5.5 11l4.5 4.5 4.5-4.5"/>',
  trash: '<path d="M4.5 6h11M8 6V4h4v2M6 6l.8 10.5h6.4L14 6"/>',
  extract: '<path d="M11.5 3.5H5.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-5.5"/><path d="M10 10l6-6M12.5 3.5H16V7"/>',
  blank: '<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M12 2.5V6h3.5"/>',
  insert: '<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M10.2 8.5v6M7.2 11.5h6"/>',
  split: '<rect x="3" y="3" width="6" height="14" rx="1"/><rect x="11" y="3" width="6" height="14" rx="1"/>',
  crop: '<path d="M5.5 2v12.5H18"/><path d="M2 5.5h12.5V18"/>',
  uncrop: '<path d="M5.5 2v12.5H18"/><path d="M2 5.5h12.5V18"/><path d="M3 3l14 14" stroke-dasharray="2 2"/>',
  header: '<rect x="3.5" y="2.5" width="13" height="15" rx="1"/><path d="M6 5.5h8M6 14.5h8" stroke-width="2"/>',
  watermark: '<rect x="3.5" y="2.5" width="13" height="15" rx="1"/><path d="M6 14l8-8" stroke-dasharray="2.2 1.6"/>',
  link: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"/>',
  bookmark: '<path d="M6 3h8v14l-4-3-4 3z"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.2v.1"/>',
  lock: '<rect x="4.5" y="9" width="11" height="8" rx="1.2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  target: '<circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="2"/>',
  indent: '<path d="M4 5h12M9 10h7M4 15h12M4 8l3 2-3 2"/>',
  outdent: '<path d="M4 5h12M9 10h7M4 15h12M7 8l-3 2 3 2"/>',
};
const icon = name => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// tools (t) are modes of the pointer; actions (a) run once. "label" items show their text next to the icon.
const MODES = {
  comment: [
    { t: 'select', i: 'select', n: 'Select and move', k: 'V' }, '|',
    { t: 'text', i: 'text', n: 'Text box', k: 'T' }, { t: 'highlight', i: 'highlight', n: 'Highlight text', k: 'H' },
    { t: 'underline', i: 'underline', n: 'Underline text', k: 'U' }, { t: 'strike', i: 'strike', n: 'Strike through text', k: 'K' },
    { t: 'ink', i: 'ink', n: 'Freehand pen', k: 'P' }, { t: 'note', i: 'note', n: 'Note', k: 'N' }, '|',
    { t: 'rect', i: 'rect', n: 'Rectangle', k: 'R' }, { t: 'ellipse', i: 'ellipse', n: 'Ellipse', k: 'O' }, { t: 'line', i: 'line', n: 'Line', k: 'L' }, { t: 'arrow', i: 'arrow', n: 'Arrow', k: 'A' }, '|',
    { t: 'image', i: 'image', n: 'Image or stamp', k: 'I' }, { t: 'sign', i: 'sign', n: 'Drawn signature', k: 'S' },
  ],
  edit: [
    { t: 'edittext', i: 'edittext', n: 'Edit text', k: 'E', label: true }, { t: 'editimage', i: 'editimage', n: 'Edit images', k: 'G', label: true },
    { a: 'addimage', i: 'addimage', n: 'Add image' }, '|',
    { t: 'redactarea', i: 'redactarea', n: 'Redact an area', k: 'X', label: true }, { t: 'redacttext', i: 'redacttext', n: 'Redact text', k: 'W' },
    { a: 'searchred', i: 'searchred', n: 'Find and redact' }, { a: 'redprev', i: 'eye', n: 'Show redactions as they will look', toggle: () => S.showRedactPreview },
  ],
  pages: [
    { t: 'select', i: 'select', n: 'Select', k: 'V' }, '|',
    { a: 'rotl', i: 'rotl', n: 'Rotate left' }, { a: 'rotr', i: 'rotr', n: 'Rotate right' }, { a: 'up', i: 'up', n: 'Move earlier' }, { a: 'down', i: 'down', n: 'Move later' },
    { a: 'del', i: 'trash', n: 'Delete pages' }, '|',
    { a: 'blank', i: 'blank', n: 'Insert blank page' }, { a: 'insert', i: 'insert', n: 'Insert a PDF after the current page' },
    { a: 'extract', i: 'extract', n: 'Extract pages to a new PDF' }, { a: 'split', i: 'split', n: 'Split the document', label: true }, '|',
    { t: 'crop', i: 'crop', n: 'Crop pages', k: 'C', label: true }, { a: 'uncrop', i: 'uncrop', n: 'Remove crop' },
  ],
  doc: [
    { t: 'select', i: 'select', n: 'Select', k: 'V' }, '|',
    { a: 'hf', i: 'header', n: 'Header and footer', label: true }, { a: 'wm', i: 'watermark', n: 'Watermark', label: true },
    { t: 'link', i: 'link', n: 'Links', k: 'J', label: true }, { a: 'bookmarks', i: 'bookmark', n: 'Bookmarks', label: true }, '|',
    { a: 'props', i: 'info', n: 'Properties', label: true }, { a: 'protect', i: 'lock', n: 'Protection', label: true },
  ],
};
const SHORT = { hf: 'Header', wm: 'Watermark', link: 'Links', bookmarks: 'Bookmarks', props: 'Properties', protect: 'Protection', split: 'Split', crop: 'Crop', edittext: 'Text', editimage: 'Images', redactarea: 'Redact' };
const DEFAULT_TOOL = { comment: 'select', edit: 'edittext', pages: 'select', doc: 'select' };

function renderTools() {
  const box = $('#tools');
  box.innerHTML = MODES[S.mode].map(it => {
    if (it === '|') return '<span class="sep"></span>';
    const id = it.t || it.a, title = it.n + (it.k ? ` (${it.k})` : '');
    const lab = it.label ? `<span>${SHORT[id] || it.n}</span>` : '';
    const pressed = it.t ? ` aria-pressed="${S.tool === it.t}"` : it.toggle ? ` aria-pressed="${!!it.toggle()}"` : '';
    return `<button class="ib${it.label ? ' tb' : ''}" type="button" ${it.t ? `data-tool="${it.t}"` : `data-act="${it.a}"`} title="${title}" aria-label="${it.n}"${pressed}>${icon(it.i)}${lab}</button>`;
  }).join('');
}
function setMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode; document.body.dataset.mode = mode;
  $$('.tabs [data-mode]').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === mode));
  renderTools();
  setTool(DEFAULT_TOOL[mode]);
  if (mode === 'doc' && S.railTab !== 'bookmarks' && S.bookmarks.length) setRailTab('bookmarks');
  if (mode !== 'doc' && S.railTab === 'bookmarks' && mode === 'pages') setRailTab('pages');
}
const ACTIONS = {
  addimage: () => setTool('addimage'),
  searchred: () => openDrawer('search'),
  redprev: () => { S.showRedactPreview = !S.showRedactPreview; refreshOverlays(); renderTools(); renderProps(); },
  rotl: () => rotatePages(-90), rotr: () => rotatePages(90), up: () => movePages(-1), down: () => movePages(1), del: deletePages,
  blank: insertBlankPage, insert: () => { $('#fileAdd').value = ''; $('#fileAdd').click(); },
  extract: extractPages, split: () => openDrawer('split'), uncrop: uncropPages,
  hf: () => openDrawer('hf'), wm: () => openDrawer('wm'), bookmarks: () => { setRailTab('bookmarks'); $('#rail').classList.add('open'); },
  props: () => openDrawer('props'), protect: () => openDrawer('protect'),
};

/* ------------------------------------------------------------ wiring */
function wire() {
  $$('[data-icon]').forEach(b => b.insertAdjacentHTML('afterbegin', icon(b.dataset.icon)));
  $('#tools').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) { setTool(b.dataset.tool); renderTools(); }
    else if (b.dataset.act) ACTIONS[b.dataset.act]?.();
  });
  $$('.tabs [data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $$('.rail-tabs [data-tab]').forEach(b => b.addEventListener('click', () => setRailTab(b.dataset.tab)));
  $$('#bmTools [data-bm]').forEach(b => b.addEventListener('click', () => bookmarkAction(b.dataset.bm)));
  $('#drawerClose').onclick = closeDrawer;
  $('#btnOpen').onclick = () => { $('#fileOpen').value = ''; $('#fileOpen').click(); };
  $('#btnAdd').onclick = () => { $('#fileAdd').value = ''; $('#fileAdd').click(); };
  $('#fileOpen').onchange = e => e.target.files.length && openReplace([...e.target.files]);
  $('#fileAdd').onchange = e => { if (!e.target.files.length) return; const i = S.pages.findIndex(p => p.id === S.cur); openAppend([...e.target.files], i >= 0 ? i + 1 : null); };
  $('#fileImg').onchange = e => { const f = e.target.files[0]; if (f) addImageFile(f, e.target.dataset.content === '1'); };
  $('#btnUndo').onclick = () => { undo(); renderTools(); };
  $('#btnRedo').onclick = () => { redo(); renderTools(); };
  $('#btnZoomIn').onclick = () => zoomStep(1); $('#btnZoomOut').onclick = () => zoomStep(-1); $('#zoomVal').onclick = () => fitWidth();
  $('#btnSave').onclick = savePdf;
  $('#btnSearch').onclick = () => openDrawer('search');
  $('#btnRail').onclick = () => $('#rail').classList.toggle('open');
  wireRailDrop();

  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; $('#dropzone').hidden = false; });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('mg-drop-done', () => { dragDepth = 0; $('#dropzone').hidden = true; });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true;
    const files = [...e.dataTransfer.files], pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    const img = files.find(f => /^image\//.test(f.type));
    if (pdfs.length) openAppend(pdfs); else if (img) addImageFile(img, S.mode === 'edit');
  });

  $('#desk').addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = $('#desk').getBoundingClientRect();
    setZoom(S.zoom * Math.exp(-e.deltaY * 0.0022), true, [e.clientX - r.left, e.clientY - r.top]);
  }, { passive: false });
  let scrollRaf = 0;
  $('#desk').addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const d = $('#desk').getBoundingClientRect(), mid = d.top + d.height * 0.35; let best = null, bd = Infinity;
      for (const pv of views.values()) { if (!pv.visible) continue; const r = pv.el.getBoundingClientRect(); const dist = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0; if (dist < bd) { bd = dist; best = pv; } }
      if (best && best.page.id !== S.cur) { S.cur = best.page.id; updateStatus(); document.querySelector(`.th[data-id="${S.cur}"]`)?.scrollIntoView({ block: 'nearest' }); }
    });
  });

  window.addEventListener('keydown', e => {
    if (!$('#modal').hidden) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'f') { e.preventDefault(); openDrawer('search'); return; }
    if (mod && k === 's') { e.preventDefault(); savePdf(); return; }
    if (mod && k === 'o') { e.preventDefault(); $('#btnOpen').click(); return; }
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); renderTools(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); renderTools(); return; }
    if (mod && (k === '+' || k === '=')) { e.preventDefault(); zoomStep(1); return; }
    if (mod && k === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (mod && k === '0') { e.preventDefault(); fitWidth(); return; }
    if (mod && k === 'a' && document.activeElement?.closest('#rail')) { e.preventDefault(); selectAllPages(); return; }
    if (mod || e.altKey) return;
    if (k === 'delete' || k === 'backspace') {
      if (S.sel) { e.preventDefault(); deleteSelected(); }
      else if ((document.activeElement?.closest('#rail') || S.mode === 'pages') && S.selPages.size) { e.preventDefault(); deletePages(); }
      return;
    }
    if (k === 'escape') {
      if (!$('#drawer').hidden) { closeDrawer(); return; }
      if (S.sel) { select(null); return; }
      if (S.tool !== DEFAULT_TOOL[S.mode]) { setTool(DEFAULT_TOOL[S.mode]); renderTools(); }
      return;
    }
    const item = MODES[S.mode].find(it => it.k && it.k.toLowerCase() === k);
    if (item) { e.preventDefault(); setTool(item.t); renderTools(); return; }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] };
    const s = selected();
    if (arrows[k] && s?.kind === 'annot') {
      e.preventDefault(); const a = s.a, st = e.shiftKey ? 10 : 1;
      const pv = views.get(a.pageId), [sx, sy] = arrows[k];
      const p0 = pv.vp.convertToPdfPoint(0, 0), p1 = pv.vp.convertToPdfPoint(sx * st * pv.vp.scale, -sy * st * pv.vp.scale);
      commit(() => { translateAnnot(a, p1[0] - p0[0], p1[1] - p0[1]); a.dirty = true; });
      refreshOverlays(); renderSelection();
    }
  });
  window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => renderSelection(), 120); });
}

function fatal(msg) {
  const d = document.createElement('div'); d.className = 'fatal';
  d.innerHTML = `<div class="panel"><h2>Folia could not start</h2><p></p></div>`;
  d.querySelector('p').textContent = msg;
  document.body.appendChild(d);
}

async function init() {
  wire();
  await initFonts();
  loadDefaults();
  S.author = load('folia.author') || '';
  $$('.tabs [data-mode]').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === S.mode));
  renderTools(); setTool('select');
  engine.startEngine().then(() => updateStatus());
  const params = new URLSearchParams(location.search);
  const sample = await buildSample();
  await openFiles([{ name: 'Sample - Delivery report.pdf', bytes: sample }], { replace: true, sample: true });
  if (!params.has('quiet')) toast('This is a sample PDF. Open your own file or drop it onto the page.', 'info', 6500);
}
window.folia = { S, views, openFiles, undo, redo, setTool, setMode, select, rebuildViews, setZoom, commit, engine, closeEditors };
init().catch(e => { console.error(e); fatal('Start-up error: ' + (e?.message || e)); });
