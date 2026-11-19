# 0035. Ways to see a room: Folders, Path and Board

Date: 2026-11-19. Status: accepted.

## Context

The founder said the room's map is confusing and maybe not that useful. He asked for more ways to present a room, to switch between:
- a structure like Finder in macOS: a folder tree that is easy to read, with aliases referred to from elsewhere;
- concepts as the nodes (ADR 0036).

The design draft "Ways to see a room" (2026-11-19) diagnosed the problem. One canvas shows many kinds of things at once (cards of three kinds, doors, clusters, lines, the brief, suggestions), and where a card sits tells you little. The draft proposed one room with several views, each answering one question:
- Folders: where is that thing?
- Concepts: what is this about?
- Path: what do I read first?
- Board: let me arrange it.

He said "go ahead" to its recommendations: Folders first and the default; the Board stays; every room a thing is in is equal.

## Decision

- **A switch at the top of every room**: Folders · Path · Board (and Concepts, ADR 0036).
  - Each room opens in the view it was last seen in. A room never opened before opens in the last view chosen, and Folders before any choice.
  - Remembered in the browser (`noema:room-views`, `noema:room-view`), like other conveniences.
  - The brief, Review, Choose what is in it and the bar at the foot are the same in every view. Arrange is only on the Board.
- **Folders** (`RoomFolders.tsx`, `folders.ts`): the room as Finder lists a folder.
  - **Rows.** Rooms inside are folders, on top, opening in place (▸), as deep as they go. Threads, sources and notes are the files.
  - **Columns**: Name, Kind, Also in, Touched, Open (side questions not come back from).
    - A click on a column sorts by it; again, the other way.
    - Numbers in names sort as numbers.
    - The sort is remembered.
  - **Aliases.** A thing in more than one room shows ↗ and "also in" with those rooms, each one click away.
    - There is no original, unlike Finder: every room a thing is in holds the same thing.
    - Taking it out of a room leaves it in the others; the Trash takes it from all.
  - **Preview.** A click shows the row in the preview: what the AI wrote of it (its points open the words they quote), the rooms it lives in, its kept links, what is still open, and Open. A room inside shows its brief and a few of its things.
  - **Keyboard.** Double-click or Enter opens; arrows move and open or close folders. Typing jumps to a row whose name starts so. Space hides or shows the preview.
  - **Dragging.** A row dragged onto a folder moves there (out of the room it was listed in); with ⌥ it stays in both.
    - A row from a room opened in place, dropped on the list, moves up into this room.
    - Anything from the sidebar or the computer dropped on the list goes in this room, as on the Board. Its place on the Board is chosen when the Board is next seen.
  - **Right-click** is the same menu as on the Board; "Take out of “…”" names the room the row is listed in.
- **Path** (`RoomPath.tsx`, `pathOrder` in `packages/core/src/path.ts`): the room as an order to study in, built only from the links the learner kept.
  - **Steps.** A thing comes after what it builds on, what it is an example of and what it is part of, and after what explains it.
  - **Side by side.** Things that contrast with each other stand beside each other (3 and 3′), as two answers to one question.
  - **Still open.** Each step shows its open questions from the brief, and the brief stays on top.
  - **Not on the path yet** is listed at the end: things with no such link. They can be linked from the Board, or by keeping what Read with AI suggests.
  - **Loops.** A loop in the links is broken at its last link, and the path says so.

## Consequences

- None of this is new data: rooms in rooms, many homes, summaries, links and the brief all existed. It is a new way to show them, inside the scope fence.
- The Board is now one view among four. Tests of the map choose it (`rooms.spec.ts` sets the last view to Board).
- A room opened in place in Folders is fetched as a whole room view. A very deep tree costs one request per folder opened.
- Path is only as good as the links kept. A room whose links were never reviewed has most things under "Not on the path yet".

## How to reverse

Remove the switch in `RoomView.tsx` (the `MODES` list) and render only the Board, or make Board the first in `modeOf`. Folders and Path are their own files and can be deleted with their tests (`apps/web/test/folders.test.ts`, `packages/core/test/path.test.ts`, `e2e/room-views.spec.ts`).
