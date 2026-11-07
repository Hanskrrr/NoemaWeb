# Handoff 2026-11-07: the Sources list overlapping, and formulas in a paper and in answers

The founder saw the Sources list in the sidebar overlap and formulas display badly. I looked at a copy of his notebook (kept outside the repository) with this build.

## What was wrong, and what changed

- **The sidebar.** A passage under a thread is clamped to two lines, but the space below it was padding, inside the clamp, so the top of a third line showed through and ran into the next row. The space is now a margin.
- **Quotes read as text.** Passages are stored as the raw Markdown of the text, so lists and cards showed Markdown escapes (a citation like "\[2020\]" with its backslashes) and heading marks. Every place that quotes a passage (the sidebar, Where you asked, origin cards, pins, the map, merges, the citation pane, tooltips) now shows it as text: `readableQuote` in core.
- **His paper was still the first reading.** The aligned-equations fix of 2026-11-06 needs a new reading of the page, and his source was still version 1 (73 equations as tables). A source read by an earlier reader now says so above the text, with **Read it again**, which reads the page again **from the copy kept with it**, without the network (`POST /api/sources/:id/reread`; `SourceDetail.rereadable`). What was asked stays with version 1.
- **The reader, version 3** (`noema-html-3`):
  - Aligned equations are `align*` with each row's `\tag`, so numbers sit in the margin, level with their rows, instead of in a column that made the block too wide.
  - In a table cell, math keeps its `\\` row breaks (matrices were flattened into one row) and writes a norm as `\Vert` (an escaped `\|` ended the cell early).
- **Equation numbers.** KaTeX pins the number to the right edge, over a formula wider than the column. A single equation's number now follows the formula, or goes below it when there is no room, as in LaTeX; aligned rows keep their numbers level. Formulas are drawn a little smaller (1.1em), closer to the text.
- **Tables in answers.** In a table cell, `$\|x\|$` now draws |x|, as GitHub reads an escaped pipe.

## Verified

| Check | Result |
| --- | --- |
| `node --test` | 204 pass. New: readable quotes; a norm and a matrix in a table cell; math pipes in a rendered table cell; a page read by an earlier reader read again from the kept copy, then quiet; not for pasted text |
| Playwright (sandbox, Chromium) | 55 pass in three of four full runs. Once, under the load of the full run, `branch.spec.ts` "a selection inside rendered math snaps to the whole formula" failed; it passed 15 of 15 repeated alone, so I take it as a timing flake to watch. New in `sources.spec.ts`: a long passage in the sidebar is exactly two lines (fails with the old style), a wide and a short numbered formula clear of their numbers |
| His paper, from the copy of his notebook | Read again from the kept page: 1,672 formulas, **0 KaTeX errors** (version 1 had one, the norm in a table cell); 88 matrices, none flattened; 67 aligned blocks with 316 numbers; screens checked for the sidebar, a wide numbered equation, an aligned block and a table of matrices |

## For the founder

Restart `pnpm dev`, open the paper and press **Read it again** in the note above the text. The three threads asked about it stay with version 1 and open it there.

## Then: formulas in answers

The founder said the formulas in a thread were still wrong. The model he uses writes math with LaTeX's own delimiters, `\( … \)` and `\[ … \]`, although the system prompt asks for dollars; Markdown reads those as escaped brackets, so every formula in his answers showed as raw TeX.

- **The renderer reads them as math** (`texToDollars` in `apps/web/src/markdown/parse.ts`): before parsing, each pair outside code is rewritten to dollars of the same length, so every offset still points at the same character and anchors stay exact. `\[` and `\]` alone on their lines become a `$$` block (lines inside taken as they are, also in a quote); otherwise a pair becomes `$ … $`, and a formula written `\[ … \]` inside a line is drawn displayed. Escaped backslashes, unclosed pairs and pairs across a blank line are left alone. On for answers, notes and merges; off for sources, whose pages escape brackets as `\[`.
- **The fake model** answers `[[tex]]` with this kind of math.
- The system prompt is unchanged (changing it resets the provider's cache); old answers render without it.

| Check | Result |
| --- | --- |
| `node --test` | 205 pass. New: `\(` and `\[` read as math, inline, as a block and in a quote; code, escaped and unclosed pairs left alone; same length; the text around still maps to the raw text and back; sources unchanged |
| Playwright (sandbox, Chromium) | 56 pass, twice in a row. New in `chat.spec.ts`: an answer with `\( \)` and `\[ \]` has its inline, displayed and quoted formulas drawn, code as written, and no delimiter left in the text |
| The thread he named, on a fresh copy of his notebook | 154 formulas drawn (50 displayed), none left as raw text, no KaTeX error |

## Next

- Unchanged: memory and the "asked before" reminder, to discuss.
- The Markdown export keeps answers as written (`\(`); some editors read only dollars.
