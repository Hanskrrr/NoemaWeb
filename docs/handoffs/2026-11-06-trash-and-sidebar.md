# Handoff 2026-11-06: the Trash, folding, and own threads at the top level

The founder asked three things: deleting threads and notes, collapsing threads in the sidebar, and listing a thread that became its own elsewhere than under the thread it came from. Decisions are in [ADR 0012](../adr/0012-the-trash.md).

## What changed

- **Delete a thread.** "Delete" in the thread's header asks first and says what goes with it ("Delete “X” and its 2 side questions? It goes to the Trash, where you can restore it. Threads that became their own stay, and so do notes."). A toast offers Undo for 8 seconds. Side questions that became their own (↗) and threads split off at a question (↪) stay; so do notes, merges and citations.
- **Delete a note** now also goes to the Trash (it was removed for good before), with the same Undo.
- **The Trash** sits at the bottom of the sidebar, folded, with a count. Each thread shows how many side questions went with it; Restore brings everything back as it was. A thread or note in the Trash can still be opened and read, marked "in the Trash" with Restore, and with no box to ask in; the server refuses asking, branching, merging, splitting and editing until it is restored.
- **Folding in the sidebar.** A thread with side questions has a caret: fold them away, and a count shows how many are hidden. Remembered in this browser. The open thread is never hidden: the threads above it stay open.
- **Own threads at the top level again.** A side question made its own thread (↗) and a thread split off at a question (↪) are listed at the top level, right after the thread they came from (their tooltip says which), no longer nested under it. Side questions stay nested. The group, the thread and the threads that left it, moves up as a whole when anything in it is asked in.
- **Server.** `DELETE /api/threads/:id` (→ how many went), `POST /api/threads/:id/restore`, `POST /api/notes/:id/restore`, `GET /api/notebooks/:id/trash`. `Thread.deletedAt`, `Note.deletedAt`. Migration 010: `thread.deleted_at`, `thread.deleted_with`, `note.deleted_at`.

## Verified

| Check | Result |
| --- | --- |
| `node --test` (sandbox and founder's Mac) | 161 pass. New: a thread deleted with a side question and its side question (3 threads); the own thread and the split-off stay, listed and found; the deleted ones are gone from the list, search and the left-open list, readable with `deletedAt`, and refuse new questions (409); deleting twice moves nothing more; restore brings all three back, searchable, and asking works again. Restoring a side question whose thread is in the Trash brings the thread back. A deleted note leaves the list and search, refuses edits (409), and comes back with its blocks, searchable. The old test that expected a deleted note to be gone (404) now expects it in the Trash |
| Playwright (sandbox, Chromium) | 38 pass, twice in a row. New: delete a thread (confirmation names its side question), Undo, delete again, open it from the Trash (marked, no composer), Restore; a note to the Trash and back with Undo; fold a thread's side questions (count, kept after reload, opening a folded side question shows it, unfold). Updated: an own thread and a split-off are top-level and directly after their origin, and the group moves up when asked in |
| `tsc` on core, server, web and root (founder's Mac) | Clean |
| Screens | The sidebar with the same threads as the last handoff, unfolded, and folded with the Trash open |
| Founder's notebook | His `pnpm dev` upgraded `data/noema.db` to schema 10; 8 threads, 4 notes, 30 messages; nothing deleted. Copy before: `data/backups/noema-before-trash-2026-11-06.db` |

## Not verified

- `pnpm lint` (Biome) still not run here; please run it with `pnpm e2e` on the Mac.
- There is no "delete for good" (see ADR 0012 and `ideas.md`).

## Next

- M3 sources, then M5.
