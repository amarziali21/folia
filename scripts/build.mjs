// Builds the static site into dist/: bundles the app and the MuPDF worker with esbuild and copies the
// pdf.js and MuPDF runtime files. Usage: node scripts/build.mjs [--watch] [--serve]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const require = createRequire(path.join(root, 'package.json'));
const args = new Set(process.argv.slice(2));

const pkgDir = name => {
  const local = path.join(root, 'node_modules', name);
  if (fs.existsSync(path.join(local, 'package.json'))) return fs.realpathSync(local);
  try { return path.dirname(require.resolve(`${name}/package.json`)); } catch { return null; }
};
const copyDir = (src, dst) => { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src, { withFileTypes: true })) { const s = path.join(src, e.name), d = path.join(dst, e.name); e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d); } };

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

// pdf.js runtime
const pdfjsDir = pkgDir('pdfjs-dist');
const pv = path.join(dist, 'vendor/pdfjs');
fs.mkdirSync(pv, { recursive: true });
fs.copyFileSync(path.join(pdfjsDir, 'legacy/build/pdf.worker.min.mjs'), path.join(pv, 'pdf.worker.min.mjs'));
for (const d of ['standard_fonts', 'cmaps', 'wasm']) if (fs.existsSync(path.join(pdfjsDir, d))) copyDir(path.join(pdfjsDir, d), path.join(pv, d));

// MuPDF runtime (optional: without it text editing, redaction and passwords are disabled)
let mupdfDir = '';
const mu = pkgDir('mupdf');
if (mu && fs.existsSync(path.join(mu, 'dist/mupdf.js'))) {
  const ver = JSON.parse(fs.readFileSync(path.join(mu, 'package.json'), 'utf8')).version;
  mupdfDir = `vendor/mupdf-${ver}/`;
  const dst = path.join(dist, mupdfDir); fs.mkdirSync(dst, { recursive: true });
  for (const f of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) fs.copyFileSync(path.join(mu, 'dist', f), path.join(dst, f));
  console.log('MuPDF', ver);
} else console.warn('mupdf non trovato: la build non include la modifica del testo e la redazione');

const common = { bundle: true, format: 'esm', target: ['es2022', 'chrome110', 'firefox115', 'safari16'], sourcemap: true, minify: !args.has('--watch'), logLevel: 'info', legalComments: 'linked' };
const appOpts = { ...common, entryPoints: [path.join(root, 'src/main.js')], outfile: path.join(dist, 'assets/app.js'), define: { MUPDF_DIR: JSON.stringify(mupdfDir) }, loader: { '.css': 'css' } };
const workerOpts = { ...common, entryPoints: [path.join(root, 'src/mupdf-worker.js')], outfile: path.join(dist, 'assets/mupdf-worker.js') };

function writeStatic() {
  const hash = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex').slice(0, 10); } catch { return 'dev'; } };
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('assets/app.css', `assets/app.css?v=${hash('assets/app.css')}`)
    .replace('assets/app.js', `assets/app.js?v=${hash('assets/app.js')}`);
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  copyDir(path.join(root, 'public'), dist);
}

if (args.has('--watch')) {
  const a = await esbuild.context({ ...appOpts, plugins: [{ name: 'static', setup(b) { b.onEnd(writeStatic); } }] });
  const w = await esbuild.context(workerOpts);
  await Promise.all([a.watch(), w.watch()]);
} else {
  await Promise.all([esbuild.build(appOpts), esbuild.build(workerOpts)]);
  writeStatic();
}
if (args.has('--serve')) await import('./serve.mjs');
