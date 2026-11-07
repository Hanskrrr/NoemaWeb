# Handoff 2026-11-06: notes stay with what they were made from

The founder found that with one list at a time, a note and its thread or source were apart, and that a note's references were hard to use. Decisions are in [ADR 0015](../adr/0015-notes-with-their-material.md).

## What changed

- **A citation opens beside the note.** Click [E2] in a note: the exchange appears on the right with the thread it is from, the passage it was asked about (a source's or another thread's), the question and the answer. The note stays put and the citation is marked. ‹ › step through the note's citations in order; clicking the open one again, or ×, closes it. **Open the thread at this exchange** goes to the exact answer, and Back comes back to the note with the exchange still open and the block in view.
- **A note sits under the thread it was made from** in the sidebar (▤), in Threads or under its source in Sources. Opening a note from a link or search shows that list with the note marked. Folding a thread hides its notes too and counts them.
- **The Notes list says where each note came from** ("from <thread>", which opens the thread). Opening a note from this list keeps the list.
- **Threads and sources name their notes**: "Note from this thread: ▤ Study note" under a thread's title; in a source's "Where you asked", each note beside the question it came from.
- No server change.

## Verified

| Check | Result |
| --- | --- |
| `node --test` | 180 pass. New: a note's citations in the order they first appear; the exchange of a cited answer or question |
| Playwright (sandbox, Chromium) | 47 pass, twice in a row. New, `e2e/notes-together.spec.ts`: a citation beside the note, ‹ › through two citations without adding to history, closing by clicking it again, opening the thread and coming back with it still open; a note under its thread, named under the thread's title, folded and counted, with "from …" in the Notes list keeping that list; a note made from a question about a source, under the source, its citation showing the passage and the source, and listed with the passage. Updated: the note tests that expected a citation to leave the note |
| `tsc` on core, server, web and root (founder's Mac) | Clean |
| Screens | The pane beside a note, the sidebar with a note under its thread, the Notes list, a thread's notes, a source's "Where you asked" |

## Not verified

- `pnpm lint` (Biome) and `pnpm e2e` on the Mac.

## Next

- Unchanged: a real arXiv paper, two weeks of real use, then M5.
