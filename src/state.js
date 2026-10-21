// Editor state. Everything the user changes lives in plain JSON (pages, annots, edits, bookmarks, doc
// settings) so undo/redo is a snapshot of that JSON. Files, rendered proxies and image bytes stay outside.

export const PX = 96 / 72;

export const S = {
  files: new Map(),     // fileId -> { id, name, lib, pdf, baseBytes, pages: [{ proxy, view, rotate, widgets, text }] }
  pages: [],            // [{ id, fileId, idx, rot, crop }]  rot = rotation added by the user, crop = user crop box
  annots: [],           // comments: native annotations in page user space
  edits: [],            // content edits: { kind: 'text' | 'image' | 'newimage' | 'redact', src, idx, ... }
  bookmarks: [],        // flat outline: [{ id, title, pageId, level }]
  doc: { meta: null, hf: null, wm: null, protect: null },
  images: new Map(),    // imageId -> { bytes, kind, url, w, h }
  fields: new Map(),    // `${fileId}|${name}` -> { type, initial, options }
  formValues: {},
  mode: 'comment',      // toolbar category
  tool: 'select', sel: null, selPages: new Set(), cur: null,
  zoom: 1, dirty: false, isSample: false, editing: null, author: '',
  showRedactPreview: false, railTab: 'pages',
};

export const hist = { undo: [], redo: [] };

export const snapshot = () => JSON.stringify({
  pages: S.pages, annots: S.annots, edits: S.edits, bookmarks: S.bookmarks, doc: S.doc, formValues: S.formValues,
});
export function loadSnapshot(snap) {
  const o = JSON.parse(snap);
  S.pages = o.pages; S.annots = o.annots; S.edits = o.edits; S.bookmarks = o.bookmarks; S.doc = o.doc; S.formValues = o.formValues;
}

export const pageOf = id => S.pages.find(p => p.id === id);
export const meta = p => S.files.get(p.fileId).pages[p.idx];
export const srcKey = (fileId, idx) => `${fileId}|${idx}`;
export const editsFor = (fileId, idx) => S.edits.filter(e => e.src === fileId && e.idx === idx);
