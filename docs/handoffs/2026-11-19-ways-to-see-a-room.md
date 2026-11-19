# Handoff 2026-11-19: ways to see a room, and concepts

The founder found the room's map confusing. He asked for other ways to present a room, to switch between: a Finder-like folder tree with aliases, and concepts as the nodes (an ontology, each concept managing its threads, notes and sources).

The design draft "Ways to see a room" (PDF in the chat; project doc `claude/NOEMAWEB_ROOM_VIEWS_DRAFT.md`) proposed one room with four views, and concepts as small rooms the AI suggests. He said "go ahead" to its recommendations. That covers four things:
- Folders first, and the default view;
- concepts as small rooms;
- the AI proposes concepts dashed, with one Keep all (his exception to the fence);
- every room a thing is in is equal.

ADRs 0035 (views) and 0036 (concepts).

## What changed

- **The switch** (`RoomView.tsx`, `MODES`): Folders · Concepts · Path · Board.
  - Remembered per room in the browser. A room not seen yet opens in the last view chosen, and Folders before any choice.
  - The brief, Review and the bar at the foot stay in every view.
- **Folders** (`RoomFolders.tsx`, `folders.ts`):
  - **Rows.** Rooms inside and kept concepts are folders that open in place; things are files. Things under a concept are listed only under it.
  - **Columns.** Name, Kind, Also in, Touched and Open, sortable and remembered. Numbers in names sort as numbers.
  - **Aliases.** ↗ and "also in" for a thing kept in other rooms.
  - **Preview.** The summary and its points, where it lives, links, what is open, and Open.
  - **Keyboard.** Arrows, Enter, typing to jump; Space hides the preview.
  - **Dragging.** A row dragged onto a folder moves there; with ⌥ it is kept in both. Moved into a concept of its own room, a thing stays in the room. Dropped on the list from a folder opened in place, it moves up.
  - `drag.ts`: `FROM_ROOM_MIME`, the room a row was dragged out of.
- **Path** (`RoomPath.tsx`, `packages/core/src/path.ts`):
  - **Order.** The order to study in, from kept links. With "A builds on / is an example of / is part of / explains B", B comes first.
  - **Side by side.** What contrasts or asks the same stands beside (3′).
  - **Still open.** Open questions from the brief, and side questions not come back from.
  - **Not on the path yet** is listed at the end. A circle is broken at its last link.
  - **With concepts kept** it goes concept by concept, each step with its things, and the things under no concept at the end.
- **Concepts** (ADR 0036):
  - **Store.** Migration 026 adds to `room` `kind` ('room' | 'concept'), `status` ('suggested' | 'kept'), `definition`, `definition_at` (a `VaultTarget`) and `made_by`. It also adds the tables `concept_link` and `concept_reading` (dismissed names, guesses).
  - **Repo** (`repo.ts`):
    - Concepts are excluded from `listRooms`, from a room's `rooms`, `counts.rooms` and doors, and from the brief basis.
    - A concept's members are only what was put in it (`conceptMembers`).
    - The concept functions: `createConcept`, `keepConcept`, `keepAllConcepts`, `dropConcept` (remembers a dismissed suggestion's name), `conceptToRoom`, `clearSuggestedConcepts`, concept links, `conceptReading`, `keptConcepts`.
    - Adding to a concept adds to its room. Removing from a room removes from its concepts.
    - Deleting a room deletes its concepts. Merging moves concepts and links.
    - Snapshots keep concepts, for the Assistant's Undo.
    - `putRoomIn` refuses a concept as the bigger room.
  - **Core** (`packages/core/src/concepts.ts`):
    - `conceptsRequest`: the things numbered with lettered points, the kept concepts first, the dismissed names, how many new.
    - `readConcepts`: things and points checked, names not used again, concepts with no things left out, links renumbered and between kept ones dropped, `place` only into kept ones, at most `most`.
    - Contract: `Concept`, `ConceptLink`, `RoomView.concepts`, `conceptLinks`, `guesses`; `Room.kind`, `Room.status`; `RoomReading.phase` 'concepts', `RoomReading.concepts`.
  - **Reading** (`RoomReader.findConcepts`): after links, before the brief, one call with purpose 'concepts'.
    - It needs three things with summaries.
    - It replaces what was suggested and not kept, keeps what was kept, creates the suggested concepts with their quote (the point's target) and links, and saves the guesses.
  - **Routes**:
    - `POST /api/rooms/:id/concepts` (by hand, kept);
    - `POST /api/rooms/:id/concepts/keep` (Keep all);
    - `POST /api/rooms/:id/concept-links`;
    - `POST /api/concepts/:id/keep`, `POST /api/concepts/:id/room`, `DELETE /api/concepts/:id`;
    - `PATCH` and `DELETE /api/concept-links/:id`.
    - Rename, merge and items use the room routes.
  - **Fake model**: purpose 'concepts'. It gives "Fake concept 1, 2, 3" (skipping kept or dismissed names): the first half of the things, the rest, and the first and last. With four things or more, the last thing is in none. Concept 2 builds on 1 and 3 contrasts with 2. The last thing is placed in the first kept concept.
  - **Web** (`RoomConcepts.tsx`):
    - the bar (count, Keep all, Read again or Find the concepts, + Concept);
    - lanes by the path's depth, with SVG lines and labels;
    - nodes (definition, counts, open question, Keep and Not this when suggested), each a drop target;
    - the tray with the AI's guess;
    - the drawer: rename, the quote with "open the words", its things (drag, ×), open questions, links (Keep, ×), Link to…, Merge into…, Split…, Make it a room, Remove (asked first) or Not this, and Ask about this concept (it fills the bar at the foot, focused).
    - The toasts name a concept: "Put under …".
- **Shared.** `roomText.ts` holds glyphs, marks and kind names shared by the views. RoomView now imports them.

## Verified

- In the sandbox: 376 unit and integration tests, tsc clean (core, server, web, root).
  - New tests: `apps/server/test/concepts.test.ts`, `packages/core/test/concepts.test.ts`, `packages/core/test/path.test.ts` and `apps/web/test/folders.test.ts`.
  - `room-reading.test.ts` now also waits through the 'concepts' phase.
- e2e: `e2e/room-views.spec.ts` has 5 tests:
  - Folders: the tree, aliases, preview, sorting, the keyboard, views remembered.
  - Folders: dragging, ⌥, right-click in a room opened in place.
  - Path.
  - Concepts: read, suggested, lanes, lines, tray, quote, Not this, Keep all, drag from the tray, read again, Folders and Path.
  - A concept split, linked by hand, merged back, asked about, made a room.
- `rooms.spec.ts` now sets the Board as the last view (the map's tests).
- Full e2e run: 88 of 90 passed on the first run.
  - The brief's call count changed (fixed: one more call only with three things or more).
  - `files.spec.ts` "proposes a change to a file" timed out under load, then passed alone.
- Screenshots of Folders, Path and Concepts (suggested and kept), and Folders and Path with concepts, in dark and light, with made-up rooms.

## Not verified

- DeepSeek: how it names, defines and links concepts, whether its "defined by" points are apt, and how long the extra call takes.
- On his own notebook (he has rooms of 6 to 30 things).
- Biome; Safari's drag and drop.

## Next

- His judgement on each view, and on the concepts with DeepSeek.
- The draft's step 4, waiting for his word: a concept in several rooms (putting a concept's door in another room) and a notebook-wide list of concepts.
- The Assistant knows nothing of concepts yet: it could list them and put things in them.
- Column view (Finder's ⌘3) on the Folders tree, if rooms nest deep.
