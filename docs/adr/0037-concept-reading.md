# 0037. The concept-reading skill: concepts read from every piece of every material, joined notebook-wide, updated by hash

Date: 2026-11-20. Status: accepted. Changes ADR 0036.

## Context

ADR 0036 found a room's concepts in one call, from its things' short summaries. The founder pointed at what that misses:

- One thread, note or source can discuss several concepts. Several concepts can share a thing.
- Several materials can discuss the same concept. A paper and a thread about the same idea should meet in one concept, whatever room they are in.
- Summaries are too thin to find them: "read every material thoroughly and see if there are concepts shared. We may need a specific skill for this."
- Updates matter: "once the material changed, maybe we use hash to determine if it is changed and update the concepts belonging to it."

The design draft "The concept-reading skill" (2026-11-20) set out the skill's instructions word for word, the pieces and their hashes, how mentions become concepts, and the update rules. He said "go ahead". This is that draft, built. It stays inside the exception of ADR 0036: concepts are suggested when the learner reads with AI, never on their own.

## Decision

- **Pieces.** A material is cut into pieces of at most 12,000 characters (`piecesOf`).
  - **Threads and notes.** Their messages (with side questions) and blocks, in order, packed, so a new question only changes the last piece.
  - **Sources.** Cut at their headings (a PDF's pages are headings), then packed. A paragraph still too long is cut at a space.
  - **The hash.** Each piece is hashed: the first 40 hex digits of sha256 of `noema-concept-reading/<skill version>` and its exact words.
  - **Read once.** A hash already read (`concept_piece`, migration 027) is not read again. A new skill version changes every hash, so the room says everything can be read again; it is never done on its own.
- **The skill.** Each piece is sent with the skill's instructions (`CONCEPT_SKILL`), the material's kind and title, and the notebook's known concepts (up to 120).
  - **The reply.** The model lists the concepts the piece discusses (not those named in passing). For each it gives:
    - a name in its usual form;
    - other names the piece uses;
    - a role: defines, explains, uses, example, asks;
    - the exact words;
    - one line of what the piece says.
  - **Checking the reply** (`readMentions`).
    - A quote not found word for word in the piece is dropped, with its mention.
    - Roles are checked.
    - At most three places for a concept and ten mentions for a piece.
    - A thread's "Q: " or "A: " label is not part of the learner's words.
  - **Saved.** Each mention is saved with where its words are: the message, the block, or the source's offset (`concept_mention`).
  - **Pace.** Three pieces are read at a time.
- **Mentions to concepts**, after the pieces are read (`RoomReader.findConcepts`).
  1. **By name, no call.** A mention joins the concept it joined before in that material, else the concept whose name or other name it has (`concept_name`, compared plain: case, punctuation, a leading "the", plurals; `conceptKey`). Names the learner dismissed are not joined.
  2. **A judge for new names.** One call with the new names and the known ones: is each the same idea as a known concept, or as another new name, or new? A part, a kind or an example of a concept is not the same concept.
  3. **When a new name is a concept.** When a material defines or explains it, or two materials discuss it. Otherwise it stays a passing idea, joined later if more materials bring it up.
  4. **Its definition and things.** Its definition is the "says" of its best mention (defines, then explains), and its defining words that mention's quote. Its things are the materials that mention it, plus those put in by hand, minus those taken out.
  5. **Links.** One call for the room's concepts when something new was read. Two kept concepts are not linked by the AI.
- **Notebook-wide.** A concept is no longer a door inside one room.
  - **Where it shows.** It shows in every room whose materials it holds, most present first. Past twelve shown, the rest fold under "More ideas here".
  - **Links** belong to the notebook (`concept_link.notebook_id`).
  - **Deleting a room** leaves its concepts. Merging two rooms leaves them; merging two concepts is its own action.
- **Updates.**
  - **What the room says.** "N materials changed since its concepts were read · Update · about N calls, only what changed" (`RoomView.conceptsToRead`). Update is Read with AI; the brief panel's call count includes the pieces to read.
  - **Same, changed, gone.** A piece with the same hash keeps its mentions. A changed or new piece is read. A piece gone takes its mentions with it.
  - **A concept with no mentions left.** A suggested one goes. A kept one stays, marked "no longer found in your materials".
  - **Defining words gone.** The next best mention defines it.
  - **Names.** A name the learner gave is never replaced. Renaming keeps the old name as another name.
  - **The learner's decisions stick.** A material moved or split to another concept joins that one when read again. Taken out stays out. Kept holds its things.
  - **Places put by hand** (made by "you") are never removed by an update; if their words are gone, they show as not found.
  - **A material deleted for good** takes its mentions.
- **What the learner sees.**
  - **A concept** says where it is: "in 4 materials · 9 places". Its drawer has:
    - its other names;
    - each material with its places (role, what it says there, the words, which open where they are);
    - "also under ◎ …" for a thing under other concepts.
  - **Sharing.** Choosing a concept marks the others that share things with it ("shares 2"). Folders says "also under" for a thing under two concepts, and Path says "also 2" for a thing on two steps.
  - **From a material's side.** A thread, source or note shows "Concepts here: ◎ … · 3 places". A click goes to its next place there, with its words marked (Markdown's marks no longer stop the words from being found).
  - **By hand.** Words selected in a thread, source or note can be put under a concept ("◎ Under a concept…", with a list of the notebook's concepts to choose from).
- **Migration 027.**
  - Concepts of ADR 0036 stay as they are, kept or suggested, with the things in them.
  - Names dismissed in a room are dismissed in its notebook.
  - Their doors go.

## Consequences

- **Cost.** One call a piece the first time. A room of 20 threads is about 20 calls; a 50-page paper about 10. Then one call for new names and one for links. After that, only what changed: a new answer in a thread, or an edited paragraph, is about one call. The room says the number before.
- **Tried only with the fake model.** The fake reads each **bold** phrase as a concept. How DeepSeek follows the skill is to be seen on the Mac: whether its quotes are word for word, whether its names agree across pieces, and whether the judge joins the right names.
- **What is not built.**
  - The Assistant does not see concepts.
  - Concepts are not read in the background.
  - There is no page listing all of a notebook's concepts; only the list for putting words under one.
- **The old way is gone.** `conceptsRequest`, its guesses for the tray, and `concept_reading` are removed. `RoomView.guesses` stays in the contract, always empty.

## How to reverse

Remove `findConcepts` from `RoomReader.run`, and Concepts from `MODES` (`RoomView.tsx`). The mentions and pieces can be dropped with their tables; concepts already made stay as rooms of kind `concept`.

To go back to concepts as doors of one room, restore the code of ADR 0036 (`d346d7b`). Its doors are not restored: concepts would show only where a door is made again.
