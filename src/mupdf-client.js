// Main-thread side of the MuPDF worker. MUPDF_DIR is set by the build (vendor/mupdf-<version>/).
/* global MUPDF_DIR */
let worker = null, ready = null, seq = 0;
const pending = new Map();
const loaded = new Set();
export const engine = { available: false, version: null, error: null };

function call(method, args, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args }, transfer);
  });
}

export function startEngine() {
  if (ready) return ready;
  ready = (async () => {
    try {
      const dir = typeof MUPDF_DIR === 'string' ? MUPDF_DIR : '';
      if (!dir) throw new Error('MuPDF non incluso in questa build');
      const base = new URL('.', document.baseURI);
      worker = new Worker(new URL('assets/mupdf-worker.js', base), { type: 'module' });
      worker.onmessage = ev => {
        const { id, result, error } = ev.data, p = pending.get(id);
        if (!p) return; pending.delete(id);
        error ? p.reject(new Error(error)) : p.resolve(result);
      };
      worker.onerror = ev => { engine.error = ev.message || 'errore del worker'; };
      const info = await call('init', { url: new URL(dir + 'mupdf.js', base).href });
      engine.available = true; engine.version = info?.version || (dir.match(/mupdf-([\d.]+)/) || [])[1] || null;
    } catch (e) {
      engine.available = false; engine.error = String(e?.message || e);
      console.warn('MuPDF non disponibile:', engine.error);
    }
    return engine.available;
  })();
  return ready;
}

const copy = b => (b instanceof Uint8Array ? b : new Uint8Array(b)).slice();

export async function loadFile(fileId, bytes) {
  if (!(await startEngine())) return false;
  const c = copy(bytes);
  await call('load', { fileId, bytes: c }, [c.buffer]);
  loaded.add(fileId);
  return true;
}
export async function unloadFile(fileId) { if (loaded.has(fileId)) { loaded.delete(fileId); await call('unload', { fileId }); } }
export const isLoaded = fileId => loaded.has(fileId);
export async function stext(fileId, idx) { return call('stext', { fileId, idx }); }
export async function rewrite(bytes, plan) { const c = copy(bytes); return call('rewrite', { bytes: c, plan }, [c.buffer]); }
export async function inspect(bytes) { const c = copy(bytes); return call('inspect', { bytes: c }, [c.buffer]); }
export async function decrypt(bytes, password, needOwner) { const c = copy(bytes); return call('decrypt', { bytes: c, password, needOwner }, [c.buffer]); }
export async function encrypt(bytes, opts) { const c = copy(bytes); return call('encrypt', { bytes: c, ...opts }, [c.buffer]); }
