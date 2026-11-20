# Handoff 2026-11-20: the concept-reading skill

After ADR 0036, the founder asked four things:
- What about concepts that share a thread, note or source, and one material that holds several concepts?
- What about several materials that refer to the same concept?
- Should every material be read thoroughly to find the concepts they share, with a skill made for this?
- Should updates use a hash, so that when a material changes, its concepts follow?

The design draft "The concept-reading skill" (PDF in the chat) set out the skill's instructions, pieces and hashes, joining, updates and what is seen. He said "go ahead". ADR 0037.

## What changed

- **Core** (`packages/core/src/concepts.ts`, rewritten):
  - `piecesOf`: threads and notes packed by message and block; sources cut at headings, then packed; at most 12,000 characters.
  - `pieceHashInput`: the skill's version and the piece's words.
  - `targetAt`: where a place's words are.
  - `conceptKey`: names made plain.
  - `CONCEPT_SKILL`, `pieceRequest`, `readMentions`: quotes word for word, a thread's "Q: "/"A: " label left out, roles, three places a concept, ten a piece.
  - `JOIN_PROMPT`, `joinRequest`, `readJoin`: a new name the same as a known one, or as another new one.
  - `becomesConcept`: defined or explained, or in two materials.
  - `bestMention`, `commonName`.
  - `conceptLinksRequest`, `readConceptLinks`.
  - Contract: `ConceptPlace`; `Concept` gains `names`, `materials`, `places`, `sources` (each material with its places) and `lost`; `RoomView.conceptsToRead`; requests to move, split, add a place, make a room; `MaterialConcepts`.
- **Store** (migration 027):
  - New tables: `concept_piece` (what was read, by hash), `concept_mention` (each place, with its words and where they are; by the AI or by hand), `concept_name` (a concept's names), `concept_dismissed` (per notebook).
  - `room.definition_mention`.
  - `concept_link` per notebook.
  - The ADR 0036 tables and doors moved over.
- **Repo** (`repo.ts`):
  - **Membership.** A concept's things are its mention materials, plus 'in', minus 'out' (`conceptMembers`). `conceptsIn` lists a room's concepts, notebook-wide, with their places; sources sorted so the defining material comes first.
  - **Reading.** `materialPieces`, `readPieces`, `materialJoins`, `settleMaterial` (gone pieces and their mentions), `savePiece`, `unjoinedMentions`, `joinMentions`, `suggestConcept`, `refreshConcepts` (definitions, lost, suggested with nothing left).
  - **What the room says.** `conceptsToRead` keeps the hashes between views. Its basis for a thread adds its messages' last change, because a thread's own time moves when a question is asked, not when its answer ends.
  - **The learner's actions.**
    - Keeping holds the things.
    - Dismissing, removing and making a room remember the names.
    - Renaming keeps the old name.
    - `moveInConcepts`, `splitConcept`, `mergeConcepts` move places with materials.
    - `addConceptPlace`, `removeConceptPlace`.
  - **Rooms.** Deleting or merging rooms no longer touches concepts. Forgetting a material for good removes its pieces and mentions.
- **Reading** (`RoomReader.findConcepts`):
  1. Every piece not read yet, three at a time (purpose 'concepts').
  2. A judge for new names ('concept-join').
  3. Concepts suggested.
  4. Links, when something new was read ('concept-links').
- **Routes**:
  - Lists: `GET /api/notebooks/:id/concepts`, `GET /api/items/:kind/:id/concepts`.
  - A concept: `POST /api/concepts/:id/room {inside}`, `/move`, `/split`, `/places`.
  - A place: `DELETE /api/concept-places/:id`.
- **Fake model.**
  - 'concepts': each **bold** phrase is a concept. A sentence starting with it and saying is/are/means defines it; a question asks; otherwise it uses. "(GC)" after it is another name. Its own "offline fake model" is not read.
  - 'concept-join': initials ("GC" is "gradient checkpointing").
  - 'concept-links': 2 builds on 1, 3 contrasts with 2.
- **Web.**
  - **Concepts** (`RoomConcepts.tsx`):
    - "in N materials · M places", or "no longer found in your materials";
    - "shares N" on the concepts that share things with the one chosen;
    - "N materials changed since its concepts were read · Update · about N calls";
    - more than twelve fold under "More ideas here".
    - The drawer: "Also called…", each material with its places (role, what it says, the words, opening there), "also under ◎ …", and a place by hand to remove.
  - **Folders**: "also under ◎ …" for a thing under two concepts.
  - **Path**: "· also 2" for a thing on two steps.
  - **A material's side** (`conceptsHere.tsx`): "Concepts here" under the title of a thread, source and note. "◎ Under a concept…" beside "Ask about this" for words selected opens the list of the notebook's concepts (`ConceptPicker`).
  - **Quotes** are shown without Markdown's marks (`asRead`). Arriving at quoted words marks each run between the marks (`quoteWords`), so bold words no longer stop a quote from being found.
  - **The brief panel's call count** includes the pieces to read for concepts.
  - **The list of concepts** closes when you go somewhere else.
- **A fix the full e2e run found.** In a room's picker ("Choose what is in it"), a tick was cleared when the request ended, before the room was shown again. A slower room made it flick back. It now stays until the room says the same (or four seconds, if the change did not go through).

## Verified, and how

- **`node --test`**: 385 pass (core, server, web). Concept tests:
  - core, 9;
  - server, 6: read across materials and rooms; by hash; joins; the learner's decisions; moving, merging, making a room; a thread whose answer ends after the room was shown;
  - web: `found.test.ts`, `roomText.test.ts`.
- **tsc**: clean for core, server, web and the root project.
- **Playwright** (sandbox):
  - Three new concept tests in `room-views.spec.ts` replace the two of ADR 0036: reading and joining; split, merge, link, ask, make a room; an update after a change, "Concepts here", words put under a concept by hand, the list closing.
  - `rooms.spec.ts`'s call count is now 8 (two summaries, links, brief, two pieces, new names, concept links).
  - Full runs: 90 of 91 (the picker flick, fixed above), then 91 of 91.
- **Screenshots** with the fake model, light and dark: Concepts, Folders, Path, a source's "Concepts here".
- **Not run**: `pnpm lint` (Biome has no Linux binary in this sandbox). DeepSeek, which is not to be used here.

## Not verified

- How DeepSeek follows the skill: whether its quotes are word for word, its names agree across pieces, the judge joins the right names, and the number of calls is what the room says.
- Large materials (a 100-page PDF) and a notebook with hundreds of concepts: the known concepts sent are capped at 120, the judge at 80 new names and 200 known.
- Safari.

## Next

- On the Mac, read a room with DeepSeek and judge the concepts: names, joins across materials, places, cost. Then change a thread or a note and press Update.
- To decide with the founder:
  - whether the Assistant should see concepts;
  - a page listing all of a notebook's concepts;
  - reading in the background (outside the fence).
