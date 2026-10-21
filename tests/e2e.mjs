// End-to-end test: drives the built app (dist/) in headless Chromium, saves PDFs and checks them with
// MuPDF and pdf-lib. Usage: npm run build && node tests/e2e.mjs   (screenshots in test-results/)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(root, 'package.json'));
const L = require('pdf-lib');
const mupdfPath = path.join(root, 'node_modules/mupdf/dist/mupdf.js');
const mupdf = fs.existsSync(mupdfPath) ? (await import(mupdfPath)).default : null;
const out = path.join(root, 'test-results');
fs.mkdirSync(out, { recursive: true });
process.env.PORT = process.env.PORT || '8799';
const { server } = await import(path.join(root, 'scripts/serve.mjs'));
const BASE = `http://127.0.0.1:${process.env.PORT}/?quiet`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 940 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fonts\.g|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
let step = 0;
const shot = async name => page.screenshot({ path: path.join(out, `${String(++step).padStart(2, '0')}-${name}.png`) });
const W = 595.28, H = 841.89;

// client coordinates of PDF points on page i, after scrolling the first point into view
async function at(i, pts) {
  return page.evaluate(([i, pts]) => {
    const m = window.margine, pv = m.views.get(m.S.pages[i].id), desk = document.getElementById('desk');
    const [cx, cy] = pv.vp.convertToViewportPoint(pts[0][0], pts[0][1]);
    desk.scrollTop = pv.el.offsetTop + cy - desk.clientHeight / 2;
    desk.scrollLeft = Math.max(0, pv.el.offsetLeft + cx - desk.clientWidth / 2);
    const r = pv.el.getBoundingClientRect();
    return pts.map(([x, y]) => { const [sx, sy] = pv.vp.convertToViewportPoint(x, y); return [r.left + sx, r.top + sy]; });
  }, [i, pts]);
}
async function dragPath(i, pts, steps = 6) {
  const c = await at(i, pts);
  await page.mouse.move(...c[0]); await page.mouse.down();
  for (const p of c.slice(1)) await page.mouse.move(...p, { steps });
  await page.mouse.up();
}
const rendered = () => page.waitForFunction(() => { const m = window.margine, pv = m.views.get(m.S.pages[0]?.id); return pv && pv.key; }, null, { timeout: 30000 });
const click = async (i, x, y) => { const [c] = await at(i, [[x, y]]); await page.mouse.click(...c); };
const idle = () => page.waitForFunction(() => { const m = window.margine; return !document.querySelector('.ed-content') && m.S.edits.every(e => e.kind === 'redact' || true); }).then(() => page.waitForTimeout(700));
async function save(name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btnSave')]);
  const f = path.join(out, name); await dl.saveAs(f); return fs.readFileSync(f);
}
function mText(bytes, pageIdx, pw) {
  const doc = new mupdf.PDFDocument(new Uint8Array(bytes));
  if (pw) assert.ok(doc.authenticatePassword(pw), 'password accepted');
  return doc.loadPage(pageIdx).toStructuredText('preserve-whitespace').asText();
}

try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.margine?.S.pages.length === 2, null, { timeout: 30000 });
  const hasEngine = await page.evaluate(async () => { for (let i = 0; i < 100 && !window.margine.engine.engine.available && !window.margine.engine.engine.error; i++) await new Promise(r => setTimeout(r, 100)); return window.margine.engine.engine.available; });
  console.log('MuPDF in the page:', hasEngine);
  await page.waitForTimeout(800);
  await shot('start');

  /* ---------- comments still work ---------- */
  await page.keyboard.press('r'); await dragPath(0, [[70, 240], [200, 280]]);
  await page.keyboard.press('u'); await dragPath(0, [[66, 650], [200, 650]]);

  /* ---------- content editing ---------- */
  await page.click('.tabs [data-mode="edit"]');
  if (hasEngine) {
    // edit the title
    await click(0, 120, H - 94);
    await page.waitForSelector('.ed-content');
    assert.equal(await page.inputValue('.ed-content'), 'Verbale di consegna apparati');
    await page.fill('.ed-content', 'Verbale di consegna dei server');
    await click(0, 300, 110); // commit by clicking on an empty spot, which starts a new text there
    await page.waitForFunction(() => document.querySelector('.ed-content')?.value === '');
    await page.keyboard.type('Testo aggiunto in fondo');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    await shot('text-edited');
    const ed = await page.evaluate(() => window.margine.S.edits.map(e => [e.kind, e.text, (e.remove || []).length]));
    assert.ok(ed.some(e => e[0] === 'text' && e[1] === 'Verbale di consegna dei server' && e[2] === 1), 'title edit recorded');
    assert.ok(ed.some(e => e[0] === 'text' && e[1] === 'Testo aggiunto in fondo' && e[2] === 0), 'new text recorded');
  }
  // move the logo image 120 pt to the left
  await page.click('#tools [data-tool="editimage"]');
  await dragPath(0, [[W - 64 - 23, H - 112 + 23], [W - 64 - 83, H - 112 + 23], [W - 64 - 143, H - 112 + 23]]);
  await page.waitForTimeout(900);
  // area redaction over the order reference
  if (hasEngine) {
    await page.click('#tools [data-tool="redactarea"]');
    await dragPath(0, [[62, H - 127], [205, H - 112]]);
    // search and redact the email address
    await page.click('#tools [data-act="searchred"]');
    await page.check('.chips input[value="email"]');
    await page.click('#sGo');
    await page.waitForSelector('#sResults li');
    await page.click('#sRedact');
    await page.click('#drawerClose');
  }
  await shot('edit-mode');

  /* ---------- document tools ---------- */
  await page.click('.tabs [data-mode="doc"]');
  await page.click('#tools [data-act="hf"]');
  await page.fill('[data-slot="tr"]', '{bates}');
  await page.fill('#bPrefix', 'MG-');
  await page.dispatchEvent('#bPrefix', 'input');
  await page.click('#hfApply');
  await page.click('#tools [data-act="wm"]');
  await page.fill('#wmText', 'RISERVATO');
  await page.dispatchEvent('#wmText', 'input');
  await page.click('#wmApply');
  // link on page 1 to page 2
  await page.click('#tools [data-tool="link"]');
  await dragPath(0, [[64, 400], [200, 380]]);
  await page.check('.pop input[value="page"]');
  await page.fill('#lkPage', '2');
  await page.click('.pop [data-act="ok"]');
  // add a bookmark for page 2
  await page.evaluate(() => { window.margine.S.cur = window.margine.S.pages[1].id; });
  await page.click('#tools [data-act="bookmarks"]');
  await page.click('#bmTools [data-bm="add"]');
  await page.keyboard.type('Firma e accettazione'); await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await shot('doc-tools');

  /* ---------- pages ---------- */
  await page.click('.tabs [data-mode="pages"]');
  await page.click('#tools [data-act="blank"]'); // after page 2
  await page.waitForFunction(() => window.margine.S.pages.length === 3);
  await page.click('#tools [data-tool="crop"]');
  await dragPath(1, [[40, 40], [W - 40, H - 40]]);
  await page.click('.pop [data-act="this"]');
  await page.waitForTimeout(600);
  await shot('pages');

  /* ---------- save and check ---------- */
  const bytes = await save('result.pdf');
  const lib = await L.PDFDocument.load(bytes);
  assert.equal(lib.getPageCount(), 3, 'three pages');
  const p1 = lib.getPage(0), annots = p1.node.Annots()?.asArray().map(r => lib.context.lookup(r).get(L.PDFName.of('Subtype'))?.decodeText()) || [];
  console.log('page 1 annotations', annots);
  for (const t of ['Highlight', 'FreeText', 'Text', 'Square', 'Underline', 'Link']) assert.ok(annots.includes(t), `annotation ${t} written`);
  const cb = lib.getPage(1).getCropBox(); assert.ok(Math.abs(cb.x - 40) < 0.5 && Math.abs(cb.width - (W - 80)) < 0.5, 'crop box set');
  assert.ok(lib.catalog.get(L.PDFName.of('Outlines')), 'outline written');
  if (mupdf) {
    const t1 = mText(bytes, 0), t2 = mText(bytes, 1);
    fs.writeFileSync(path.join(out, 'result-p1.txt'), t1);
    assert.match(t1, /RISERVATO/, 'watermark');
    assert.match(t1, /MG-000001/, 'Bates number page 1');
    assert.match(t2, /MG-000002/, 'Bates number page 2');
    assert.match(t1, /Pagina 1 di 3/, 'footer');
    if (hasEngine) {
      assert.match(t1, /Verbale di consegna dei server/, 'edited title present');
      assert.doesNotMatch(t1, /consegna apparati/, 'old title removed');
      assert.match(t1, /Testo aggiunto in fondo/, 'new text present');
      assert.doesNotMatch(t1, /2026\/0417/, 'redacted area removed');
      assert.doesNotMatch(t1, /giulia\.ferrari@esempio\.it/, 'email redacted');
      assert.match(t1, /Il presente verbale attesta/, 'other text kept');
    }
    const doc = new mupdf.PDFDocument(new Uint8Array(bytes));
    const outline = doc.loadOutline() || [];
    console.log('outline', outline.map(o => o.title));
    assert.ok(outline.some(o => o.title === 'Firma e accettazione'), 'new bookmark');
  }
  const { pageImages } = await import(path.join(root, 'src/content.js')).catch(() => ({}));
  if (pageImages) {
    const imgs = pageImages(lib.getPage(0)).filter(im => im.bbox[2] - im.bbox[0] > 40 && im.bbox[2] - im.bbox[0] < 50);
    console.log('logo boxes', imgs.map(im => im.bbox.map(Math.round)));
    assert.ok(imgs.some(im => Math.abs(im.bbox[0] - (W - 64 - 46 - 120)) < 2), 'logo moved');
  }

  /* ---------- reopen the result: edits become plain content, comments stay editable ---------- */
  await page.evaluate(async b64 => {
    const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    await window.margine.openFiles([{ name: 'result.pdf', bytes: u }], { replace: true });
  }, bytes.toString('base64'));
  await rendered(); await page.waitForTimeout(500);
  const re = await page.evaluate(() => ({ pages: window.margine.S.pages.length, annots: window.margine.S.annots.map(a => a.type), bms: window.margine.S.bookmarks.map(b => b.title) }));
  console.log('reopened', re);
  assert.equal(re.pages, 3);
  assert.ok(re.annots.includes('link') && re.annots.includes('underline'), 'link and underline editable after reopening');
  await shot('reopened');

  /* ---------- protection ---------- */
  if (hasEngine) {
    await page.click('.tabs [data-mode="doc"]');
    await page.click('#tools [data-act="protect"]');
    await page.check('#pUserOn'); await page.fill('#pUser', 'apri123'); await page.fill('#pUser2', 'apri123');
    await page.check('#pOwnerOn'); await page.fill('#pOwner', 'perm456'); await page.fill('#pOwner2', 'perm456');
    await page.click('#pApply');
    const enc = await save('protected.pdf');
    const d = new mupdf.PDFDocument(new Uint8Array(enc));
    assert.ok(d.needsPassword(), 'needs a password');
    assert.equal(d.authenticatePassword('apri123') & 2, 2, 'user password works');
    // open it again in the app with the password dialog
    const opening = page.evaluate(async b64 => {
      const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return window.margine.openFiles([{ name: 'protected.pdf', bytes: u }], { replace: true });
    }, enc.toString('base64'));
    await page.waitForSelector('#pwInput');
    await page.fill('#pwInput', 'sbagliata'); await page.click('.panel [data-act="yes"]');
    await page.waitForSelector('#pwInput');
    await page.fill('#pwInput', 'apri123'); await page.click('.panel [data-act="yes"]');
    assert.equal(await opening, true, 'protected file opened');
    await rendered(); await page.waitForTimeout(300);
    await shot('protected-reopened');
  }

  /* ---------- phone width and dark theme ---------- */
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 400, height: 820 });
  await page.waitForTimeout(500);
  await shot('phone-dark');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'no horizontal scroll at phone width');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('E2E OK');
} catch (e) {
  await shot('failure').catch(() => {});
  console.error(errors.join('\n'));
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
