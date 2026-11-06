# 0013. Sources: immutable versions, read on this computer, shown beside the thread

Date: 2026-11-06. Status: accepted.

## Context

M3 in the prototype brief: paste text or fetch a URL, a reading pane, select in a source to ask, versioned anchors; done when a branch from a source passage returns to that passage. The hero case is reading a paper with AI. The founder's papers are mostly on arXiv. PDF parsing is outside the scope fence (a stretch goal). The architecture asks that every anchor be pinned to the version that was shown, that the original be kept beside the extraction, and that nothing jump silently to a near match in another version.

## Decision

- **Storage** (migration 011). `source` (title, the address as given, Trash), `source_version` (immutable Markdown, its hash, the original HTML, the extractor's name, the address actually read), `source_anchor` (version, offsets, quote with prefix and suffix, as for messages), and `thread.source_anchor_id`. "Read again" makes a new version only when the text changed. Passages stay on the version they were asked about; a thread opens that version, marked as older when it is. Nothing is moved to the latest version automatically.
- **Pages are read on this computer**, by the server (a browser cannot, because of CORS): http and https only, 20 seconds, 15 MB. An arXiv link (abstract, PDF or HTML) is read from arXiv's HTML version, then ar5iv's. A PDF is refused with a reason and a way out (the arXiv link, or paste).
- **Our own HTML-to-Markdown converter**, in `packages/core/src/html.ts`, pure and tested on fixtures: it finds the article (largest `article`, else `main`, else the body), drops site furniture, and keeps headings, lists, tables, code, footnotes and math (MathML `alttext`, KaTeX annotations, MathJax scripts, LaTeXML equation tables with their numbers). The same converter turns HTML pasted from a web page into Markdown in the browser. No new dependency: Readability and Turndown could not be installed in the build sandbox, and neither keeps math. Each version records `extractor = 'noema-html-1'`.
- **Context.** A question asked about a passage sends the section around it (from its heading to the next heading of the same level, at most 6000 characters, whole blocks nearest the passage when longer) in the system message, labelled as material to explain, not instructions, and the passage with each question. The section stays in the stable prefix, so the provider's prompt cache keeps working. Side questions and threads split off from it keep the same reading.
- **A question about a passage starts a thread of its own**, listed under its source in the sidebar with its side questions.
- **The reading pane scrolls by itself, beside the conversation.** A thread asked about a source, and its side questions, open beside it (the URL stays `#/t/…`); the passage is highlighted. Back returns to the source at the passage: `#/s/<source>[/v/<version>]/from/<thread>`.
- **Where you asked** (insight I1): every passage asked about is marked in the text and in the margin, darker with more questions (in the thread and its side questions), with its threads under it; with no thread open, the right side lists the passages, most questions first.
- **Deleting a source** puts it in the Trash (as in ADR 0012). Its threads stay, show their passage and say the source is in the Trash.
- **Search** indexes the title and the blocks of the latest version only.

## Consequences

- Images in a page are not shown (the Markdown renderer never loads images); their alt text is. The original HTML is kept, so a better extractor can make new versions later.
- The converter is a heuristic and will miss on some sites; pasting is the fallback. It has not been tried on live arXiv pages from the sandbox, which cannot reach them; the fixtures follow LaTeXML's structure.
- Older versions stay in the database, and so does the original HTML of each.
- Asking about an older version is allowed; the thread then shows that version.

## How to reverse

The converter: swap in another extractor under a new name; "Read again" then makes new versions, and old passages stay on theirs. The layout: render the source as a page of its own instead of beside the thread (one component, `SourceView`). The storage: drop the three tables and the column after moving the threads to plain threads.
