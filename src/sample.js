// The sample document shown on first load: a delivery report with a logo, a form and a few comments.
import { L } from './lib.js';
import { uid } from './util.js';
import { writeAnnot, makeRes } from './annots-io.js';
import { fitText } from './geometry.js';

function wrapWith(font, para, maxW, size) {
  const lines = []; let line = '';
  for (const tok of para.split(/(\s+)/)) {
    if (!tok) continue;
    if (font.widthOfTextAtSize(line + tok, size) <= maxW) { line += tok; continue; }
    if (/^\s+$/.test(tok)) { lines.push(line); line = ''; continue; }
    lines.push(line.trimEnd()); line = tok;
  }
  lines.push(line.trimEnd());
  return lines;
}
async function logoPng() {
  const c = document.createElement('canvas'); c.width = 240; c.height = 240;
  const g = c.getContext('2d');
  g.fillStyle = '#2346c4'; g.beginPath(); g.roundRect(0, 0, 240, 240, 44); g.fill();
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 4; i++) { g.globalAlpha = 1 - i * 0.18; g.fillRect(48, 52 + i * 38, 144 - i * 22, 22); }
  g.globalAlpha = 1;
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildSample() {
  const doc = await L.PDFDocument.create();
  doc.setTitle('Equipment delivery report'); doc.setAuthor('IT operations');
  const reg = await doc.embedFont(L.StandardFonts.Helvetica), bold = await doc.embedFont(L.StandardFonts.HelveticaBold);
  const ink = L.rgb(0.1, 0.12, 0.16), grey = L.rgb(0.42, 0.45, 0.5), rule = L.rgb(0.8, 0.82, 0.86);
  const W = 595.28, H = 841.89, M = 64;
  const p1 = doc.addPage([W, H]);
  const para = (page, text, x, y, size, maxW) => {
    const lines = wrapWith(reg, text, maxW, size);
    lines.forEach((ln, i) => page.drawText(ln, { x, y: y - i * size * 1.45, size, font: reg, color: ink }));
    return y - lines.length * size * 1.45;
  };
  try { const logo = await doc.embedPng(await logoPng()); p1.drawImage(logo, { x: W - M - 46, y: H - 112, width: 46, height: 46 }); } catch { /* canvas unavailable */ }
  p1.drawText('IT OPERATIONS · SERVER ROOM B', { x: M, y: H - 70, size: 9, font: bold, color: grey });
  p1.drawText('Equipment delivery report', { x: M, y: H - 100, size: 24, font: bold, color: ink });
  p1.drawText('Order ref. 2026/0417 · delivered 14 October 2026', { x: M, y: H - 122, size: 11, font: reg, color: grey });
  p1.drawLine({ start: { x: M, y: H - 138 }, end: { x: W - M, y: H - 138 }, thickness: 0.8, color: rule });
  const intro = 'This report confirms the delivery of the equipment listed below to server room B. ';
  const key = 'The equipment must be checked within five working days of delivery.';
  let y = para(p1, intro + key + ' Any differences from the order must be reported to the supplier in writing, quoting the serial number of the device concerned.', M, H - 170, 11, W - 2 * M);
  y -= 18;
  p1.drawText('Equipment delivered', { x: M, y, size: 13, font: bold, color: ink }); y -= 24;
  const rows = [['1U rack server, 2 CPUs, 512 GB RAM', '4'], ['32G Fibre Channel switch, 48 ports', '2'], ['All-flash storage, dual controller', '1'], ['LC-LC OM4 cables, 3 m', '24'], ['Rack mounting rails', '7']];
  p1.drawText('DESCRIPTION', { x: M, y, size: 8.5, font: bold, color: grey }); p1.drawText('QTY', { x: W - M - 30, y, size: 8.5, font: bold, color: grey }); y -= 8;
  for (const [desc, q] of rows) {
    p1.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule }); y -= 17;
    p1.drawText(desc, { x: M, y, size: 11, font: reg, color: ink }); p1.drawText(q, { x: W - M - 30, y, size: 11, font: reg, color: ink }); y -= 9;
  }
  p1.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
  y -= 34;
  y = para(p1, 'Data centre staff checked that the packaging was intact and that the parcels matched the delivery note. Final acceptance happens when the next page is filled in and signed.', M, y, 11, W - 2 * M);
  y -= 22;
  para(p1, 'Technical contact: Jane Fuller, extension 4417, jane.fuller@example.com', M, y, 11, W - 2 * M);
  p1.drawText('Page 1 of 2', { x: W - M - reg.widthOfTextAtSize('Page 1 of 2', 8.5), y: 40, size: 8.5, font: reg, color: grey });

  const p2 = doc.addPage([W, H]);
  p2.drawText('Acceptance', { x: M, y: H - 100, size: 24, font: bold, color: ink });
  p2.drawText('Fill in the fields: they are real form fields and stay editable in any PDF reader.', { x: M, y: H - 122, size: 11, font: reg, color: grey });
  const form = doc.getForm();
  const label = (t, yy) => p2.drawText(t, { x: M, y: yy, size: 10, font: bold, color: grey });
  label('RECEIVED BY', H - 170);
  form.createTextField('received_by').addToPage(p2, { x: M, y: H - 202, width: 300, height: 24, borderWidth: 0.8, borderColor: rule, backgroundColor: L.rgb(1, 1, 1) });
  label('DELIVERY DATE', H - 230);
  form.createTextField('delivery_date').addToPage(p2, { x: M, y: H - 262, width: 140, height: 24, borderWidth: 0.8, borderColor: rule, backgroundColor: L.rgb(1, 1, 1) });
  form.createCheckBox('equipment_intact').addToPage(p2, { x: M, y: H - 300, width: 14, height: 14, borderWidth: 0.8, borderColor: grey });
  p2.drawText('Equipment intact and as ordered', { x: M + 22, y: H - 297, size: 11, font: reg, color: ink });
  label('NOTES', H - 330);
  const f3 = form.createTextField('notes'); f3.enableMultiline(); f3.addToPage(p2, { x: M, y: H - 430, width: W - 2 * M, height: 90, borderWidth: 0.8, borderColor: rule, backgroundColor: L.rgb(1, 1, 1) });
  label('RECIPIENT SIGNATURE', H - 470);
  p2.drawLine({ start: { x: M, y: H - 540 }, end: { x: M + 240, y: H - 540 }, thickness: 0.8, color: grey });
  p2.drawText('Page 2 of 2', { x: W - M - reg.widthOfTextAtSize('Page 2 of 2', 8.5), y: 40, size: 8.5, font: reg, color: grey });
  form.updateFieldAppearances(reg);

  const res = makeRes(doc, new Map());
  const quads = [], start = intro.length; let consumed = 0;
  wrapWith(reg, intro + key, W - 2 * M, 11).forEach((ln, i) => {
    const a0 = consumed, a1 = consumed + ln.length; consumed = a1 + 1;
    const s = Math.max(a0, start); if (a1 <= s) return;
    const yy = H - 170 - i * 11 * 1.45, x1 = M + reg.widthOfTextAtSize(ln.slice(0, s - a0), 11), x2 = M + reg.widthOfTextAtSize(ln, 11);
    quads.push([x1, yy + 9.6, x2, yy + 9.6, x1, yy - 2.6, x2, yy - 2.6]);
  });
  await writeAnnot(doc, p1, { type: 'highlight', quads, color: '#ffd400', opacity: 1, nm: uid('mg-'), author: 'IT operations', contents: 'Deadline for the checks' }, res);
  const tx = { type: 'text', rect: [W - M - 190, 150, W - M, 205], rot: 0, size: 11, color: '#d92d20', text: 'Check the serial numbers before signing the report.', nm: uid('mg-'), author: 'IT operations' };
  fitText(tx);
  await writeAnnot(doc, p1, tx, res);
  await writeAnnot(doc, p1, { type: 'note', rect: [W - M + 14, H - 192, W - M + 34, H - 172], rot: 0, color: '#f5b400', nm: uid('mg-'), author: 'IT operations', contents: 'Delivery note 88213 is attached to the ticket.' }, res);
  // bookmarks
  const ctx = doc.context, pages = doc.getPages(), oRef = ctx.nextRef(), r1 = ctx.nextRef(), r2 = ctx.nextRef();
  ctx.assign(r1, ctx.obj({ Title: L.PDFHexString.fromText('Equipment delivered'), Parent: oRef, Next: r2, Dest: [pages[0].ref, 'XYZ', null, null, null] }));
  ctx.assign(r2, ctx.obj({ Title: L.PDFHexString.fromText('Acceptance'), Parent: oRef, Prev: r1, Dest: [pages[1].ref, 'XYZ', null, null, null] }));
  ctx.assign(oRef, ctx.obj({ Type: 'Outlines', First: r1, Last: r2, Count: 2 }));
  doc.catalog.set(L.PDFName.of('Outlines'), oRef);
  return doc.save();
}
