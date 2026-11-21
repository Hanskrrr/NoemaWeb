# Handoff 2026-11-21: concepts in levels, on a map that zooms

**What prompted it.** The founder read a room with a book-length PDF. The reading seemed stuck, and it ended with 1,111 concepts. He asked for:

- a canvas that zooms;
- concepts read only from threads and notes;
- concepts in levels, not all thrown in together;
- the AI filling a concept he makes with suitable materials.

**The design.** The draft "Concepts that help" (PDF in the chat) set out the design. He said "go ahead", then "go build it". ADR 0038, with the knowledge-graph exception to the scope fence recorded in it and in AGENTS.md.

## What changed

- **Core** (`packages/core/src/concepts.ts`). The skill is now version 2:
  - "details are not concepts";
  - `under` and `how` for a kind or part;
  - the known concepts sent as a tree (`knownTree`).

  New in core:
  - **Order.** `orderRequest` and `readOrder`: topics, kind-of, part-of, no circles.
  - **Find materials.** `scopeRequest` / `readScope`, and `findRequest` / `readFind`.
  - **Words in sources.** `wordsFound`, `pagesOf`, `pageAt`.
  - **Work.** `workWeight`.

  Contract additions:
  - `Concept.scope`, `.home`, `.alsoUnder`, `.work`;
  - `ConceptPlace.kept`;
  - `RoomReading.stopped`;
  - `RoomView.conceptXY`;
  - `ConceptWords`;
  - requests to put a concept under another, keep or dismiss a home (its main one or one under a parent), set its scope, and save where it is on the map.
- **Store** (migration 028):
  - New tables: `concept_home` (child, parent, how, suggested / kept / dismissed, by, main), `concept_xy`, `concept_shown`.
  - New columns: `room.scope`, `room.placed`; `concept_mention.under`, `.how`, `.kept`.
  - Deleted: the suggestions only sources brought, the AI's places in sources, and what was read in sources.
- **Repo.**
  - `conceptsIn` adds each concept's ancestors, its work, scope, home and "also under". Concepts the learner made in a room show there before anything is in them. Found places (not kept) are listed but do not make a material a member.
  - **The tree.** `putConceptUnder`, `setConceptHome`, `keepConceptHome` and `dismissConceptHome` (each with an optional parent), `applyConceptHints`.
  - **The order step.** `orderInput`, `applyOrder`.
  - **Find materials.** `findInput`, `applyFind`, `keepConceptPlace`.
  - **Words and places.** `conceptWords` (cached per source version), `setConceptScope`, `setConceptXY`.
  - **What is read.** A thread's text starts with the passages it was asked about or pinned. `conceptsToRead` leaves out sources.
  - Merging, making a room and splitting carry homes.
- **Reading** (`RoomReader`):
  - threads and notes only;
  - at most 40 new concepts a reading;
  - the pieces' hints, then the order step ('concept-order'), then links;
  - `stop()` keeps what was read;
  - `findForConcept` ('concept-scope', 'concept-find').
- **Routes.**
  - Reading: `POST /api/rooms/:id/read/stop`.
  - A concept: `POST /api/concepts/:id/under`, `/home/keep`, `/home/dismiss` (both `{parent?}`), `DELETE /api/concepts/:id/home`, `POST /scope`, `GET /words`, `POST /find`.
  - Places and the map: `POST /api/concept-places/:id/keep`, `PUT /api/rooms/:id/concept-xy`.
- **Fake model.**
  - It reads the known tree.
  - "**X** … a kind of / a part of **Y**" is a hint.
  - **Order.** A name ending in another's is a kind of it. The rest go in "<room> basics", the notebook's one if it has it, else a new one when two or more are loose.
  - **Scope.** "Fake scope: what “X” covers."
  - **Find.** Concepts whose names hold its name; materials by their first sentence naming it.
- **Web.**
  - **`conceptMap.ts`** (pure, tested): circles packed without overlap, holders sized for what they hold (which sits a little lower, leaving the name room at the top), the top level spread wider than tall; `nameFor` (one line, two or three lines broken between words, cut a little, or a dot); `fitParts` for the counts under a name.
  - **`ConceptMap.tsx`**: the map in screen space.
    - Moving around: zoom (wheel, pinch, buttons, double-click), pan, Esc up.
    - Lines between the nearest named circles.
    - Dragging: a circle to move it or onto another to put it under; things onto a circle.
    - Find a concept, and the trail back up.
  - **`RoomConcepts.tsx`**, rewritten.
    - **The bar.** "N concepts in T topics · your M things · K to review", with Stop and progress, and "Stopped…".
    - **The map**, with a column beside it: Review when nothing is chosen, the concept when one is.
    - **The drawer adds:** where it is (Keep / Not this), Put under…, what it covers (Edit), your work, inside, words found in sources (with pages), found places to keep, Find materials.
  - **`RoomView.tsx`**: Stop in the brief panel; the reading's progress for concepts; the call estimate counts threads' and notes' pieces only; Path topic by topic.
  - **`RoomFolders.tsx`**: topics and concepts as folders, concepts before things.
  - **`RoomPath.tsx`**: `compact`, one line for a topic with no order yet.
- **A fix the e2e found.** A message a concept action set (for example "“X” is under “Y” now.") was cleared as the action ended. The last message now goes as the next action starts.

## Verified, and how

- **`node --test`** (core, server, web): 401 pass, in the sandbox.
  - Server concept tests (11): threads and notes read, sources not, words found; a passage thread; by hash; a late answer; joins; the learner decides; move, merge, room; levels; a concept you make filled (its places inside kept or not one by one); stop; upgrading from v27.
  - Web: `conceptMap.test.ts`, 5.
  - One full run had one failure that did not come back in three more full runs; which test it was is not known.
- **tsc**: clean for core, server, web and the root project.
- **Playwright** (sandbox): 92 of 92 in one full run.
  - The concept tests in `room-views.spec.ts` are rewritten for notes and threads:
    1. reading in levels, Review (Not this, Keep, Keep all), the drawer, words found opening the source;
    2. the map: Put under by the list and by dragging, back to the top, Find a concept, Esc up, zoom and fit, + Concept and Find materials, Folders and Path by topic;
    3. split, merge, link, ask, make a room;
    4. a thread that grows is read again, Concepts here on a note, words in a source put under a concept by hand.
  - `rooms.spec.ts`'s call count: "about 8 calls, 1 of them reading its threads and notes for concepts".
- **Screenshots** with the fake model, light and dark: the map from far, a topic zoomed into, a concept chosen, Folders, Path.
- **Not run**:
  - `pnpm lint` (Biome has no Linux binary in this sandbox).
  - DeepSeek, which is not to be used here.
  - Stop in the browser: the e2e server's fake model is too quick to stop it reliably.

## What is next

- **The room that seemed stuck.** On the Mac, read it again with DeepSeek. Read again reads its threads and notes with the new skill, not the book. Look at:
  - whether the topics, kinds and parts are right;
  - whether the map reads from far to near;
  - whether Review is short enough to go through;
  - whether the cost was what the room said.
- **Find materials** on a concept he makes: are the materials found worth keeping, and are passing mentions left out?
- **Later, if the map works:** a minimap, a page of the notebook's topics, and the Assistant seeing concepts.
