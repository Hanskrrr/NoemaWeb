# Handoff 2026-11-12: PDF sources

The founder asked to finish PDFs, for M6: course material is mostly PDFs, and Noema refused them. A PDF is now read page by page into the reading pane, asked about like any text, and opened at the page being read. Decisions are in [ADR 0021](../adr/0021-pdf-sources.md); the scope fence in AGENTS.md now keeps out only what goes beyond the text (OCR, figures, formulas as LaTeX).

## What changed

- **Three ways in.**
  - A file: the dialog's new **A PDF** tab, or a PDF dropped anywhere on the dialog.
  - An address that answers with a PDF.
  - An arXiv paper with no HTML version: its PDF is tried after arXiv's and ar5iv's HTML.
  - Up to 50 MB.
- **Reading** (`apps/server/src/ingest/pdf.ts`, `pdf-worker.ts`):
  - pdf.js 6 (`pdfjs-dist` 6.2.108, a new server dependency) runs in a worker thread with a two-minute limit, so answers keep streaming while a PDF is read.
  - A 112-page paper took 0.7 s in the sandbox.
- **Pages to Markdown** (`packages/core/src/pdf.ts`, pure):
  - every page starts with `## Page N`;
  - lines are joined into paragraphs;
  - larger short lines become headings, and bulleted lines become lists;
  - page numbers and running heads are dropped;
  - broken words are joined, and Chinese lines are joined without spaces (radicals some fonts use become the right characters);
  - `$`, `*` and the like are escaped, so they show as printed.
  - The title is the PDF's own, else its largest heading on page 1 (not a numbered section), else the file's name.
- **The file is kept** with the version (base64, as a page's HTML is; migration 014 adds `media_type` and `file_name`). In the reading pane:
  - the name and page count;
  - **Open the PDF ↗**, which opens the browser's own viewer at the page at the top of the pane;
  - page headings drawn as thin page rules; clicking one opens that page.
- **Read it again** from the file kept works as for pages, when the reader changes (`PDF_EXTRACTOR`).
- **The model** gets the section around a passage as before, but page headings no longer cut it: a passage at the top of a page keeps the paragraph it continues.
- **Errors said plainly:** not a PDF, locked with a password, broken, too large, too slow, a scan with no text, or pdf.js not installed.
- **API:** `POST /api/notebooks/:id/sources/pdf?id=&name=` (the body is the file); `GET /api/sources/:id/versions/:versionId/file`. A version has `origin: 'file'` and `file: {type, name, bytes}`. The router can now read a file body and a validated query string.

## Verified

| Check | Result |
| --- | --- |
| `node --test`, sandbox | 242 pass. New in core: 14 tests building pages from made-up text items (paragraphs, hyphens, Chinese, headings, lists, slides, columns, running heads, raised pieces, escaping, cleaning, empty pages, truncation, the section sent). New on the server: upload, idempotent upload, the file served as given, search, the log, Chinese, every refusal, the time limit, a PDF at an address, arXiv's PDF fallback, reading again from the file, versions without a file, and an upgrade of a schema-13 store |
| Playwright, sandbox | 61 pass. New `pdf.spec.ts`: a non-PDF refused in the dialog; a deck added; its pages, list items and text shown; a question about a passage; Open the PDF links to the page at the top of the pane; a click on a page heading opens that page; the file served as given |
| tsc | Core, server, web and root project clean in the sandbox (with pdf.js); core and web clean on the Mac |
| `node --test`, Mac | 235 pass; the 7 that read PDFs fail until `pnpm install` brings pdf.js, as expected |
| By eye | A two-column LaTeX paper, a Beamer deck, a PowerPoint deck, Chinese notes made with XeLaTeX, a three-page paper with running heads: screenshots in light and dark |

## Not verified

- **Your PDFs.** The fixtures are made up and generated here (LaTeX, LibreOffice, Chrome). Lecture slides from other tools may lay out differently: say what comes out wrong, with the page.
- **pdf.js on the Mac**, until `pnpm install` is run there; then `pnpm check`.
- **Chrome's PDF viewer opening `#page=N`**: headless Chromium downloads PDFs instead of showing them, so the tests check the link, not the viewer.
- `pnpm lint` (Biome cannot run in the sandbox).

## Known limits

- Formulas come out as the characters drawn (`√dk`, a stray `P` for a big sum), not LaTeX. For arXiv the HTML version is still read first.
- Figures are not read; scanned PDFs have no text (no OCR).
- A paragraph running over a page break is split at the page heading.
- Exports and daily backups hold the PDF files, so they grow by about 4/3 of each.

## Next

1. On the Mac: `pnpm install` (adds pdf.js and updates `pnpm-lock.yaml`), `pnpm check`, then start Noema: migration 014 runs by itself (it only adds two columns). Then add the course PDFs.
2. Commit `pnpm-lock.yaml`, and push when you choose (see `docs/push-log.md`).
3. Whatever reads wrong in real slides becomes a test in `packages/core/test/pdf.test.ts` and a new `PDF_EXTRACTOR`.
