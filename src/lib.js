// Third-party engines. pdf-lib writes PDFs, pdf.js renders them, MuPDF (in a worker, see mupdf-client.js)
// removes content for text editing and redaction and handles encryption.
import * as PDFLib from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export const L = PDFLib;
export const pdfjs = pdfjsLib;
export const N = s => PDFLib.PDFName.of(s);

const base = typeof document !== 'undefined' ? new URL('.', document.baseURI).href : 'file:///';
if (typeof document !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', base).href;
export const PDFJS_OPTS = {
  isEvalSupported: false,
  enableXfa: false,
  standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', base).href,
  cMapUrl: new URL('vendor/pdfjs/cmaps/', base).href,
  cMapPacked: true,
  wasmUrl: new URL('vendor/pdfjs/wasm/', base).href,
};
