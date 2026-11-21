# 0038. Concepts in levels, from threads and notes, on a map that zooms; a concept you make is filled

Date: 2026-11-21. Status: accepted. Changes ADR 0037.

## Context

The founder read a room with a book-length PDF in it. The reading seemed stuck: it was reading the book piece by piece with no progress shown, and it ended with 1,111 concepts. He asked three things:

- "maybe we should build it as a huge canvas that can zoom in and zoom out, so that it can endure that many concepts. and maybe we should only let ai do threads/notes reading to extract concepts cuz that is what weve been through."
- "a room with 1000 concepts is almost unreadable and useless."
- "can ai automatically analyze the concept and add suitable materials in it? … there are many levels of concept, if it just throw all of them without difference into the room, that would be of no help … and the materials it read may be very different."

The design draft "Concepts that help" (2026-11-21, PDF in the chat) proposed what follows, with defaults for its open questions:

- sources never read whole;
- topics suggested by the AI, dashed until kept;
- the suggestions only sources brought removed;
- Find jumps to a concept (no animation).

He said "go ahead", then "go build it".

**The fence.** A tree of concepts, with links between them, comes close to the "knowledge graphs" the scope fence (prototype brief §4) leaves out. The founder made this exception: concepts in levels, on a map of one room, suggested by the AI and kept by the learner. The AGENTS.md fence line says so. There is still no graph of the whole notebook, no mastery and no embeddings.

## Decision

- **What is read for concepts: threads and notes only.** These are what the learner has been through.
  - **Sources are no longer read for concepts.** A thread asked about a passage of a source is read with that passage ("About this passage of “T”: …"). So is a passage pinned in it.
  - **A concept still shows where your sources use its words.** This is a plain text search, with no call (`wordsFound`, at most 500 places): "In your sources · words found", with the page for a PDF, each place opening there.
  - **Migration 028** removes the suggestions only sources brought, the AI's places in sources, and what was read in them. Kept concepts, concepts you made and places you put by hand stay.
- **Details are not concepts.** The skill (version 2, so every piece may be read again, never on its own) now says to name ideas, not details, and gives each:
  - **Under what the piece says it is**: "AdamW, a variant of Adam" is `under: Adam, how: kind-of`, or `part-of`.
  - **The known concepts as a tree** (`knownTree`).
  - **At most 40 new concepts a reading** (`SUGGEST_MAX`), the learner's questions first.
- **Levels** (`concept_home`). A concept is:
  - **under another**: a kind of it, or a part of it;
  - **or in a topic**: a concept that holds other concepts and no things of its own.

  One home is main and shown on the map; others are "also under". Each home is suggested by the AI until kept, or is the learner's. A home said no to stays dismissed, so it is not suggested again.
- **The order step.** After the pieces, one call (`concept-order`) puts the room's concepts that have no place yet into 3 to 9 topics. Under a topic, a concept can go up to three levels deep. Topics the notebook has are used when they fit.
  - **What it starts from.** The pieces' own "under" hints are applied first (`applyConceptHints`).
  - **Your placement is final.** Where the learner put a concept, even at the top, the AI does not move it (`room.placed`).
- **Size is the learner's work.** `workWeight` = 3 × questions + 2 × notes + materials. It sizes the circles and orders Review.
- **The map** (`ConceptMap.tsx`, `conceptMap.ts`). The Concepts view is a map that zooms and pans: wheel, pinch, the buttons, double-click to zoom into a concept, Esc to go up.
  - **Circles hold circles.** Topics hold their concepts; concepts hold the kinds and parts of them. Circles are packed so they never overlap.
  - **Names follow the zoom.** A name shows when its circle is big enough: on one line, on two or three broken between words, or cut a little. Otherwise the circle is a dot until you zoom in. A circle holding others has its name at its top, above what it holds.
  - **Lines.** Links between concepts are drawn between the nearest circles that are named at this zoom; several between the same two are one line, "N links".
  - **Moving.** Dragging a circle moves it (where it is stays, per room: `concept_xy`). Dropping it onto another puts it under that one. Things dragged from elsewhere drop onto a circle.
  - **Finding.** "Find a concept" jumps to it and zooms there. The trail above the map ("All › Optimization › adam") goes back up.
- **Beside the map.** One column holds either the review or the chosen concept.
  - **Review** (when none is chosen). New ideas, most worked with first: where each is ("a kind of …", "in …") and your work on it, with Keep and Not this. Places suggested for kept concepts, and things that share no concept with the rest of the room, are listed too. Keep all keeps them all, places and links included.
  - **The concept** (when one is chosen): where it is, with Keep / Not this for a suggested place, "Put under…", what it covers, your work, what is inside it, the words that define it, its materials and places, and the words found in your sources. "← Review" goes back.
- **A concept you make is filled** (Find materials, `concept-scope` and `concept-find`).
  - **What it covers.** The AI writes one line for it, which is the learner's to change.
  - **What goes inside.** Concepts of the notebook whose names hold its name, or that the model judges a kind or part of it.
  - **Where your materials discuss it.** Threads, notes and sources searched for its words, then judged. Each is a place with the words that show it.

  Each waits, dashed, until kept. A material is not in the concept until one of its places is kept.
- **Stop.** A reading can be stopped (`POST /api/rooms/:id/read/stop`). What was read is kept; the next reading carries on from there. The room shows "Reading your threads and notes for concepts: d of n pieces", with a bar.
- **Folders and Path follow the levels.** Folders shows topics as folders of concepts ("Topic · 3"), and concepts as folders of their concepts, then their things. Path is drawn topic by topic. A topic with no order yet is one line of its concepts.

## Consequences

- **Cost.** It falls for rooms with long sources: a 300-page PDF is no longer about 60 calls. A room's reading is now a call a piece of its threads and notes, then one for new names, one to order, and one for links. The room says the number before.
- **Fewer, clearer concepts.** A room of 1,000 concepts becomes a few topics to open. What was worked with most is biggest.
- **Lost.** Concepts that only a source discussed are no longer suggested. Sources' words are still found for the concepts there are, and Find materials looks in sources too.
- **Tried only with the fake model.** How DeepSeek orders a real room (whether its topics and kinds are right), and whether Find's judge leaves out passing mentions, is to be seen on the Mac.
- **Not built.**
  - Topics across rooms are the notebook's, but there is no page for all of them.
  - The map has no minimap.
  - The Assistant does not see concepts.
  - Stop is tested on the server, not in the browser.

## How to reverse

- **To read sources again.** Stop leaving them out where the reader takes a room's materials (`RoomReader.findConcepts`) and where the room counts what is left to read (`roomView`'s `conceptsToRead`); the passage a thread asked about can stay.
- **To drop the levels.** Stop calling the order step and ignore `concept_home`. The map then shows every concept at the top.
- **To undo the migration.** Migration 028 only adds tables and columns, apart from its three deletes. Those can be undone only from a backup; the suggestions they removed come back if sources are read again.
