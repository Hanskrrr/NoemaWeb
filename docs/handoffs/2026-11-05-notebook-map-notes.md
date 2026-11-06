# Handoff 2026-11-05: rename, the map, and notes

The founder asked for four things: every side question listed in the sidebar with a way to jump to the exact place (as in M0), renaming threads by hand, one view of a whole thread so the learner can see what they went through, and rewriting, because Noema is also a notebook.

## What changed

- **Rename.** Click a thread's title (a pencil shows on hover) to edit it; Enter or leaving the field saves, Escape cancels. `PATCH /api/threads/:id` sets `title_source = 'user'`, and the model never replaces that title. The header also refreshes when the model's title arrives after the first answer.
- **Branches in the sidebar, with their passage.** Each branch shows the passage it was asked about under its title. The passage jumps to that exact spot in the parent, highlighted (the same Back behaviour as before); the title opens the branch. Notes are listed below the threads.
- **The map** (`#/map/<thread>`, the Map button). The whole tree on one page, built from what is stored, no model call: every question in order with the start of its answer, every branch hung under the exchange it came from, with its passage, nested as deep as it goes, and counts at the top. Opened from a branch, that branch is marked. Each question and answer opens that exact message (`#/t/<thread>/m/<message>`: scrolled to the middle and briefly highlighted); each passage jumps to the spot it was selected from.
- **Rewrite as note.** The button on a thread asks the model to rewrite the thread and every branch below it as a study note, organised by idea, in the learner's language, ending with open questions. Like answers, the note is written by the server, saved every 300 ms, and survives the tab closing; a note cut off by a restart is marked failed with its text kept.
  - Exchanges are numbered in reading order (a branch's exchanges come right after the exchange it came from), and the note cites them as `[E3]`. A citation is a button that opens the exact message. Citations stay plain labels in the text and the note keeps a map from label to message, so the editor stays readable and a label the learner types works too ([ADR 0006](../adr/0006-notes-cite-with-plain-labels.md)).
  - The note's title is the heading the model starts with, unless the learner renamed the note.
  - The note is labelled "Written by AI from the thread", or "AI draft, edited by you" once edited. Every saved version is kept in `note_revision` (who wrote it, its text and its citation map). "Rewrite again" writes a new version from the thread as it is now. The chat itself is never changed.
- **Schema:** migration 004 adds `note` and `note_revision`. Exports include both.

On DeepSeek Super Agent (open source, early November 2026): it is a coding agent whose router keeps context across sessions and runs workers in parallel with state in a database. Two ideas from it went to `ideas.md`: "you've asked this before" across the notebook, and asking several side questions about one passage at once.

## Verified

| Check | Result |
| --- | --- |
| `tsc` on core, server, web and the root project with e2e (founder's Mac) | Clean |
| `node --test` (Mac and sandbox) | 113 pass. New: rename sets a title the model never replaces, and a blank title is refused; the thread list carries each branch's passage; the map from a deep branch returns the whole tree with branches on the exact message; the outline numbers exchanges in reading order; the rewrite flow (idempotent create, citations, map of labels, title from the heading, edit makes version 2 and keeps a renamed title through "Rewrite again", full history, list without content); a restart fails a note being written but keeps its text; no edits while it is being written; citation normalising and splitting |
| Playwright (sandbox, Chromium) | 19 pass. New: rename, Escape and a reload, and the next answer leaves the title alone; the sidebar passage jumps to the exact highlighted spot and the title opens the branch; the map shows two exchanges and one branch, its passage jumps to the spot and a question opens and flashes that message; rewrite as note: AI label, two citations that open the right messages in the parent and the branch, the editor shows plain labels, an edit with a new `[E2]` works, version 2, history `[1, ai], [2, user]` |
| Screenshots | Thread header, sidebar with passages, map (desktop and phone, dark), note, citation jump and the editor checked by eye |
| Founder's database | His `pnpm dev` restarted when the files landed and upgraded `data/noema.db` to schema 4. Checked on a copy: 7 threads, 22 messages and 5 anchors before and after; the map and outline build for his threads |

Not verified: Biome (`pnpm lint`) could not run here; a note written by real DeepSeek (only the fake model has written one); Playwright on the Mac.

## Next

- Run `pnpm lint` and `pnpm e2e` on the Mac, then try "Rewrite as note" on a real thread.
- Search UI that opens the exact message (the `#/t/<thread>/m/<message>` route is ready for it).
- Notes on a selected passage; a view of a note's versions.
- Small fixes: regenerate, code highlighting, DeepSeek's reasoning, deleting a thread.
- M3: sources.
