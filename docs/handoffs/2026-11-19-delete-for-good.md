# Handoff 2026-11-19: deleting for good, from right-click

The founder asked that right-click on a note, source or thread delete it permanently. ADR 0034 records the decision.

## What changed

- **Server.**
  - `repo.ts`: `purgeThread` (with its own side questions), `purgeSource`, `purgeNote` and `forgetItems` (room places, links, summaries).
  - What stays lets go of it:
    - threads made their own lose the parent;
    - side questions lose a lost origin;
    - threads asked about a source lose the passage;
    - a source's threads and a thread's notes stay in the rooms they were in with it, now on their own.
  - Search rows go.
  - Routes: `DELETE /api/threads/:id/forever`, `/api/sources/:id/forever`, `/api/notes/:id/forever`.
  - Refused: a live answer, a note being written, the Assistant's thread.
- **Web.**
  - `ContextMenu.tsx`: a `confirm` item. Picked, the menu shows its question with the red button and Cancel, with Cancel focused.
  - `itemMenu.ts`: `ItemsContext` and `deleteItems` (Move to the Trash, Delete forever…). It is used in the sidebar lists, "In no room yet", room cards, and the Trash's rows (Restore, Delete forever…).
  - `App.tsx` provides it:
    - the toast after Move to the Trash has Undo; "deleted for good" has none;
    - what is open leaves when it goes;
    - the confirm text says side questions, a merge into another thread, notes that stay, threads asked about a source, and that a file on the computer stays.
  - The toast's Undo is optional now.
- **Tests.**
  - `forever.test.ts`:
    - a thread with side questions, one made its own, a note, a room, a link, search;
    - from the Trash;
    - a source with a thread asked about it, kept in its room;
    - a note, and a note being written refused;
    - the Assistant's thread refused.
  - e2e (`trash.spec.ts`): Cancel; a thread with its side question; a source moved to the Trash then deleted from there; an open note.

## Verified

- 359 unit tests and 85 e2e tests in the sandbox; tsc clean.
- Screenshots of the menu and its question in light and dark.

## Not verified

- On his real notebook.
- Biome; Safari.

## Next

- Round 5 of the rooms work (the map by meaning) is still waiting.
