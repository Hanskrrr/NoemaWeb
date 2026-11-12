# 0021. PDF sources: read page by page, the file kept

Date: 2026-11-12. Status: accepted.

## Context

M6 is the founder using Noema for his course. Course material is mostly PDFs (lecture slides, handouts, papers without an HTML version), and until now Noema refused them: a web page or pasted text only. The scope fence listed PDF parsing as a stretch goal (the pdf.js text layer); the founder asked for it ("let's finish the pdf thing").

The questions were where to read a PDF (browser or server), what the reading pane shows (the PDF itself, or its text), what is kept, and how a passage relates to a page.

## Decision

- **The text, not the drawn page.** A PDF becomes a source version like any other: Markdown in the reading pane, anchored, searched and sent to the model by the code that already does this. Drawing the pages with a text layer would need its own selection and anchoring; the PDF is opened in the browser's own viewer instead (below).
- **Read on the server, in a worker thread.** `apps/server/src/ingest/pdf.ts` runs pdf.js 6 (`pdfjs-dist`, legacy build, pinned to an exact version) in a worker with a 2 GB heap and a two-minute limit, so a large or broken file cannot hold up answers being streamed. No fonts are installed and no forms are drawn. pdf.js is loaded for text only: its native drawing package (`@napi-rs/canvas`, which it loads in Node to draw pages) is replaced by an empty stand-in (`no-canvas.cjs`, through `module.registerHooks`) and given a small DOMMatrix, so no native code is loaded into the server. Character maps for Chinese, Japanese and Korean fonts come with pdf.js. Up to 50 MB. If the worker cannot be started on this computer (it says it is ready before reading, so a failure to start is told apart from a file that breaks it), the PDF is read on the main thread instead and the log says why. Every PDF that cannot be read is logged with pdf.js's own reason (`pdf not read`), never the file's text; `pnpm pdf:check <file>` reads PDFs the same way and prints counts or the reason.
- **Pages to Markdown in core.** `pdfToMarkdown` (pure, tested with made-up text items) decides lines, paragraphs, headings, lists and running heads from position and size alone:
  - every page starts with `## Page N`, which marks where a page starts;
  - a short line clearly larger than the text is a heading (`###` and below);
  - a line starting with a bullet is a list item; a glyph with no character counts as a bullet only where two lines start with one at the same place;
  - page numbers and lines repeated at the top or bottom of most pages are dropped;
  - a word broken with a hyphen is joined; Chinese, Japanese and Korean lines join without a space; radicals some fonts draw for ordinary characters are mapped back;
  - text that would read as Markdown (`$`, `*`, `_`, a `#` at the start) is escaped, so it shows as printed.
  - The title is the file's own, else the largest heading on page 1 that is not a numbered section, else the file's name.
- **The file is kept** with the version, base64 in `raw` (as a page's HTML is), with `media_type` and `file_name` (migration 014). `GET /api/sources/:id/versions/:versionId/file` serves it. **Open the PDF** opens the page at the top of the reading pane (`#page=N` in the browser's viewer); a click on a page heading opens that page. It is a plain link: a GET changes nothing, so it needs no header.
- **Three ways in.** A file (`POST /api/notebooks/:id/sources/pdf?id=&name=`, the body is the file; the dialog's **A PDF** tab, or a PDF dropped on the dialog), an address that answers with a PDF, and an arXiv paper with no HTML version (its PDF is tried after arXiv's and ar5iv's HTML).
- **Read again** works as for pages: a PDF read by an older reader (`noema-pdf-N`) can be read again from the file kept, without the network. Changing pdf.js or the rules means a new `PDF_EXTRACTOR`.
- **The section sent to the model** ignores page headings (`sourceSection`), so a passage near the top of a page keeps the paragraph it continues.
- **What the API calls a file.** A file given by the learner is stored with origin `'paste'` (given, not fetched): changing the `CHECK` on `origin` means rebuilding `source_version`, and with foreign keys on, dropping it would delete every passage asked about. The API reports it as `origin: 'file'`, with `file: {type, name, bytes}`.
- **Said plainly when it cannot be read:** not a PDF, locked with a password, broken, too large, too slow, no text at all (a scan), or pdf.js not installed.

## Consequences

- Formulas come out as the characters drawn (`√dk`, a stray `P` for a big sum), not as LaTeX. For an arXiv paper the HTML version is still preferred. Figures are not read: Open the PDF shows them.
- Scanned PDFs have no text; reading them needs OCR, which is not built.
- A paragraph that runs over a page break is split at the page heading.
- Reading order is the order the file draws text. Most tools draw a column at a time; a file that draws across columns line by line comes out mixed.
- Exports hold the PDFs (base64), so they grow by about 4/3 of each file. Daily backups do too.
- A new dependency, `pdfjs-dist` (Apache-2.0), on the server only. It loads only when a PDF is read; without it, Noema runs and says pdf.js is not installed.

## How to reverse

Remove the upload route and the dialog's PDF tab, and refuse PDFs in `fetch.ts` again. Versions already read stay readable as text; the columns can stay.
