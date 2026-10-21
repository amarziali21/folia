# Folia

A PDF editor that runs entirely in the browser. Files never leave the computer of the person using it.

## Features

**Pages**: thumbnails, drag to reorder, rotate, delete, blank pages, merge several PDFs (including dropping them at a precise position), extract and split into several files, crop.

**Comments**: text boxes, highlight, underline, strikethrough, pen, notes, rectangles, ellipses, lines, arrows, images and stamps, drawn signatures. They are native PDF annotations, so they stay editable in Acrobat and other readers. Annotations already in a file become editable.

**Content editing**:
- Page text: click a block and rewrite it. The original text is removed from the file and replaced with one of the standard PDF fonts (Helvetica, Times or Courier, with bold and italic).
- New text written into the page content.
- Page images: move, resize, replace and delete them.
- True redaction: by area, along text, or with search, including email addresses, phone numbers, IBANs, Italian tax codes and VAT numbers, and dates. The covered content is removed from the file when you save.

**Document**: header and footer with page numbers, date, file name and Bates numbering; watermark; links to pages or web addresses; bookmarks (read, edit, indent); properties; AES-256 password protection with permissions; opening protected PDFs.

**Forms**: filling in AcroForm fields, which stay real fields in the saved file.

## How it works

| Component | Role | Licence |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | Displays the pages | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | Writes the PDF: pages, annotations, content, forms, bookmarks | MIT |
| [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) | Structured text, text removal and redaction, encryption | AGPL-3.0 |

MuPDF runs in a Web Worker and loads from `vendor/mupdf-<version>/`. If it is unavailable, everything else keeps working and the tools that need it say so.

Every change is a JSON object in the editor state (`src/state.js`), and undo and redo save snapshots of that state. The file is only written when you save (`src/export.js`):

1. Content edits are applied to each source file. Images are changed by rewriting the page operators (`src/content.js`), text removal and redactions go through MuPDF, then the new content is added.
2. Pages are copied into a new document, so deleted pages are really gone.
3. Comments, document tools, form values, bookmarks and properties are written.
4. If requested, the file is encrypted.

## Licence

AGPL-3.0-or-later (see `LICENSE`), because the project includes MuPDF. Anyone who uses a deployed copy over a network is entitled to its source code. If this repository is private, either limit the site to your own team (for example with Cloudflare Access) or publish the source somewhere its users can get it.
