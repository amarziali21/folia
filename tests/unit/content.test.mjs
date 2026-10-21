// Unit checks for the content-stream tokenizer and image rewriting (runs in Node).
import assert from 'node:assert/strict';
import { L } from '../../src/lib.js';
import { tokenize, pageImages, applyImageEdits, appendContent, fillOps } from '../../src/content.js';
import zlib from 'node:zlib';

// 2x2 PNG
function png() {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const t = tokenize(new TextEncoder().encode('q 1 0 0 1 10 20 cm /Im1 Do Q BT /F1 12 Tf (a\\)b) Tj [(x) -20 (y)] TJ ET <</MCID 3>> BDC EMC BI /W 2 /H 2 ID \x00\x01\x02 EI Q % c\n0.5 g'));
assert.deepEqual(t.map(o => o.op), ['q', 'cm', 'Do', 'Q', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'BDC', 'EMC', 'BI', 'Q', 'g']);
assert.equal(t[1].args.length, 6);

const doc = await L.PDFDocument.create();
const page = doc.addPage([400, 400]);
const img = await doc.embedPng(png());
page.drawImage(img, { x: 50, y: 60, width: 100, height: 80 });
page.drawImage(img, { x: 200, y: 200, width: 40, height: 40 });
const bytes = await doc.save();
const d2 = await L.PDFDocument.load(bytes);
const p2 = d2.getPage(0);
const imgs = pageImages(p2);
assert.equal(imgs.length, 2);
assert.deepEqual(imgs[0].bbox.map(Math.round), [50, 60, 150, 140]);
// move the first by (+10, +5) and delete the second
const n = applyImageEdits(p2, [{ op: imgs[0].op, name: imgs[0].name, ctm: imgs[0].ctm, A: [1, 0, 0, 1, 10, 5] }, { op: imgs[1].op, name: imgs[1].name, ctm: imgs[1].ctm, deleted: true }]);
assert.equal(n, 2);
appendContent(p2, fillOps([[0, 0, 10, 10]], '#000000'));
const d3 = await L.PDFDocument.load(await d2.save());
const imgs3 = pageImages(d3.getPage(0));
assert.equal(imgs3.length, 1);
assert.deepEqual(imgs3[0].bbox.map(Math.round), [60, 65, 160, 145]);
console.log('content tests ok');
