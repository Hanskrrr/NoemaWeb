# 0022. PDF pages in the reading pane, and a picture of the page for the model

Date: 2026-11-12. Status: accepted.

## Context

ADR 0021 read a PDF as text only. The founder tried it on his course slides and found it disappointing: other tools show the whole PDF, pictures included, and their model sees them. The prototype brief's stretch goal said as much ("the pdf.js text layer"): the pages themselves, with text that can be selected. His model, DeepSeek's `deepseek-flash`, now takes pictures in user messages, up to about 1,024 tokens each ([DeepSeek's vision guide](https://api-docs.deepseek.com/guides/vision)). Asked how pictures should reach the model, he chose: always send the page with a question about a PDF passage.

The hard part is the one the brief named: a selection on a drawn page must become a passage of the stored text, so that everything that works on text (asking, pinning, marks, Back, search, anchors) works on pages.

## Decision

- **Pages, drawn by pdf.js in the browser** (`apps/web/src/PdfPages.tsx`):
  - each page is drawn on a canvas when it comes near, at the pane's width;
  - pdf.js's own text layer lies on top: one transparent span per text item, there to be selected.
  - A PDF opens as **Pages**; **Text** shows the stored text as before.
- **The same pdf.js on both sides.** The browser loads pdf.js from the server (`/api/pdfjs/build/...`), with its character maps, standard fonts and fallback decoders. So it is the server's own copy, the version that read the text; there is no second dependency to keep in step. Nothing else in that folder is served. The page's security policy is unchanged: WebAssembly stays off, and pdf.js uses its script decoders instead.
- **Selection is mapped through the text items.**
  - Core's `pdfToMarkdown` now records, for every character it writes, the pdf.js item it came from, so each page has a map of item ranges (`[item, start, end]`).
  - `pdfItemOffsets` aligns an item's raw text with its Markdown: escapes, squashed spaces, joined hyphens, ligatures.
  - The browser runs the same `pdfPageText` and `pdfToMarkdown` on the items it gets, so it has the map.
  - Only if its text equals the stored text exactly is the map used. If not (read by another reader), the pages are shown but not selected from, and the text is offered.
  - With the map, a selection becomes stored-text offsets and a passage becomes a DOM range. The source view's text code and page code then share everything above that: highlights, margin marks, Ask about this, pins, arriving from search or a thread.
  - The Markdown is byte for byte what it was, checked on every test PDF and the founder's six decks, so `PDF_EXTRACTOR` stays `noema-pdf-1` and versions already read get pages without being read again.
- **A picture of the page goes with the question.**
  - When a passage of a PDF is chosen to ask about, the browser draws its page (or both pages, when it runs over) about 1,600 pixels on the longer side, as a JPEG. It keeps it on the server: `PUT /api/sources/:id/versions/:v/pages/:n/image`, table `source_page_image` (migration 015), once per page of a version, a few hundred kilobytes.
  - The question waits for that picture for up to 8 s.
  - Every question in a thread about a PDF passage (side questions too) carries its page picture(s) as image parts before its text. They are counted as 1,024 tokens each in the budget.
  - The request kept for What was sent names each picture by reference (`source-page:<version>:<page>`), never by its bytes. The provider puts the pictures in when it sends.
  - What was sent shows each picture with its page.
- **A model that refuses pictures** fails before answering (a bad request). The question is asked again at once with text only, and that model is asked with text only until the server restarts. The log says so.

## Consequences

- Course slides are read as printed: figures, diagrams, formulas and layout. The model sees the page it is asked about, and the text it is sent stays as before.
- Each question about a PDF costs up to about 1,000 more prompt tokens, uncached (the picture is in the question, not the cached prefix).
- Exports and backups hold the page pictures as well as the PDFs.
- Drawing many pages takes the browser's time and memory. Pages are drawn as they come near. Text layers are made for all pages up front, because marks and search need them.
- Selecting across the edge of a page or in a figure selects nothing (there is no text there). Asking about a figure without text near it is not possible yet: a box drawn around a figure would be the next step (ideas.md).
- What the model sees in a picture is its own reading: Noema does not check it.

## How to reverse

Make **Text** the default and remove the **Pages** button; stop calling `sendPageImage`. Questions then go without pictures: the generation sends a picture only where one was kept. The table can stay.
