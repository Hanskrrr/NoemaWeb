# Handoff 2026-11-06: notes as blocks, split threads, a map for every thread

The founder's first real note mixed two subjects because a side question had drifted. He asked for: making a side question its own thread with its own notes, a map for every thread, editing a note in place like a Jupyter notebook, rewriting any paragraph with AI, and inserting written or AI paragraphs anywhere.

## What changed

- **Make a side question its own thread.** A button on the origin card. The thread moves to the top level of the sidebar (marked ↗), gets its own map and notes, and is left out of the parent's map (shown there as a link) and the parent's notes. New questions in it send only the passage it came from, not the parent conversation. Back still jumps to the passage. "Put back as a side question" undoes it. `thread.split_at`, `POST /api/threads/:id/split`.
- **A map for every thread.** The Map opened from a side question shows that side question and the ones below it, with links up to each map above and to the passage it came from.
- **Notes are blocks you edit in place.** Every paragraph, heading, list, table, formula and code block is a block (`note_block`).
  - Click a block to edit its Markdown in place; click away or ⌘/Ctrl+Enter saves, Esc cancels. Clearing a block deletes it.
  - Hover between blocks for **+ Write** or **✦ Ask AI**; the end of the note always shows both.
  - Each block's toolbar: Edit, ✦ AI (Simpler, More detail, Add an example, Shorter, Check it against the conversation, or your own instruction), ↑ ↓, Split here, Section → new note (on headings), Delete with Undo.
  - **AI suggestions never change the note by themselves.** They appear under the block (or as a new block) to Replace / Add, Discard or Try again. The server writes them, so they survive a closed tab; one cut off by a restart is marked failed.
  - A rule on the left of each block shows who wrote it: AI, AI edited by you, or you.
  - Citation labels stay stable: when the AI is asked about a note later, labels already used keep their exchange, and new exchanges get new numbers.
- **Split a note**: Section → new note, or Split here (this block and everything below). The new note keeps the thread and citations.
- **Blank notes**: "+ New note" in the sidebar. AI help works there too, without citations.
- Notes can be renamed (click the title) and deleted. "Rewrite again" left the note page: a note is now the learner's document; "Rewrite as note" on the thread writes a new one.
- Migration 005. Existing notes are split into blocks at start-up without a new version. Every change is a version in `note_revision` with what changed and the blocks. Decision record: [ADR 0007](../adr/0007-notes-are-blocks-and-split-threads.md).
- Fixed on the way: a new thread's response lacked a field of the contract, which the stricter client refused; a contract-shape test now covers it.

## Verified

| Check | Result |
| --- | --- |
| `tsc` on core, server, web and the root project with e2e (founder's Mac) | Clean |
| `node --test` (Mac and sandbox) | 127 pass. New: block splitting (tables, fences, `$$` with blank lines, loose lists, CRLF, round trip, sections); split threads (own path and map, left out of the parent's map and notes, context without the parent conversation, a branch below inherits only from it, put back, refused for a top-level thread); writing, editing, moving, deleting, restoring blocks, with the version log; suggestions (wait for the learner, replace, discard, failure leaves the block alone, one at a time, AI on the learner's block makes it AI-and-learner, Ask AI blocks, discarding removes them); stable citation labels; blank notes; moving a section out; old notes split at start-up; the marked note the AI sees |
| Playwright (sandbox, Chromium) | 22 pass. New: a side question becomes its own thread and goes back; each thread's map with the way up; editing a block in place, Escape, citations still opening their exchange; writing between blocks, Ask AI, Replace, move up, delete and Undo, section and split-here into new notes; a blank note written, renamed, an AI suggestion discarded, the note deleted |
| Founder's notebook | His running `pnpm dev` upgraded `data/noema.db` to schema 5 when the files landed. His note became 170 blocks (31 headings, 24 code, 9 tables, 5 formulas); its text is byte-for-byte the same as before; 7 threads, 22 messages and 5 anchors unchanged. A copy from just before is in `data/backups/noema-before-blocks-2026-11-06.db` |
| Screenshots | Note blocks with toolbar, AI menu, suggestion card, writing a block, editing in place, dark mode, split origin card, parent map with a split link |

Not verified: Biome (`pnpm lint`), Playwright on the Mac, and suggestions from real DeepSeek (only the fake model has written them).

## Next

- On the Mac: `pnpm lint`, `pnpm e2e`. In his note, "Split here" on the heading of the second subject moves that part into its own note.
- Try ✦ AI on a few real blocks with DeepSeek and check the suggestions keep citations and language.
- Then search with jump-to-message, or M3 sources.
