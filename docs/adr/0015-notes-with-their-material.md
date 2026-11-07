# 0015. Notes stay with what they were made from

Date: 2026-11-06. Status: accepted.

## Context

With one list at a time in the sidebar (ADR 0014), a note and the thread or source it was made from were in different lists. Worse, a citation in a note ([E2]) opened the thread in the note's place: the note was gone, and the sidebar switched to another list. The founder found it hard to move between a note and its material, and to use its references.

## Decision

- **A citation opens beside the note.** Clicking [E2] shows that exchange in a pane on the right: the thread it is from, the passage it was asked about (of a source, or of another thread), the question and the answer. The note stays where it is, the citation is marked, and ‹ › step through the note's citations in the order they appear. **Open the thread at this exchange** goes there; the browser's Back returns to the note with the exchange still beside it and the block it was cited in brought into view. Clicking the open citation again, or ×, closes the pane. Which citation is open is in the URL (`#/note/<id>/e/E2/in/<block>`) but replaces the history entry rather than adding one. A merge card's citations still go to the thread.
- **A note made from a thread is listed under that thread** (▤), with the thread's side questions, so in Sources too when the thread was asked about a source. The Notes list keeps every note, each with "from <thread>", which opens the thread. Opening a note from elsewhere shows the list its thread is in, with the note marked; opening it from the Notes list keeps the Notes list. A fold hides a thread's notes too and counts them.
- **Threads and sources name their notes.** A thread shows "Note from this thread: ▤ …" under its title; a source's "Where you asked" shows each note beside the question it was made from.

## Consequences

- A note made from a thread is listed twice (under its thread, and in Notes); that is deliberate.
- A note is placed by the thread it was made from (`note.threadId`); citations to other threads (after merging two notes) open in the pane but do not move the note.
- No server or schema change.

## How to reverse

Drop `open` from the citation context in `NoteView` (citations then go to the thread again), and the `notesOf` lists in `Sidebar`.
