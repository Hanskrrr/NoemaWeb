# 0036. Concepts: the key ideas of a room, as small rooms the AI suggests

Date: 2026-11-19. Status: accepted.

## Context

The founder asked for another way to see a room. Instead of threads, notes and sources as cards, he wanted concepts as the nodes: an ontology with the mapping between concepts, each node managing its threads, notes and sources.

The design draft "Ways to see a room" (2026-11-19) made two recommendations:
- A concept should be a small room the AI suggests, not a separate layer. This keeps one model and fewer nouns. Dragging, aliases, the Trash and the brief already work for rooms, and there is never a question of whether something is a room or a concept.
- The AI should suggest concepts dashed, for the learner to keep with one "Keep all", because the structure of what he knows should be his.

This crosses the scope fence twice: "concept extraction, knowledge graphs" and "rooms suggested by the AI". He said "go ahead" to the draft and its recommendations. This is that exception.

## Decision

- **A concept is a room of kind `concept`** (migration 026: `room.kind`, `status`, `definition`, `definition_at`, `made_by`). It sits inside the room it was read from by a door (ADR 0032).
  - It holds only what was put in it. Nothing comes with a thing, unlike a room.
  - It is not in the list of rooms, the sidebar, the right-click menus or the Assistant's rooms. It is not one of a room's rooms inside, and not part of a bigger room's brief.
- **The AI suggests concepts when a room is read**: a step after the links and before the brief, one more call (`conceptsRequest`, `readConcepts`, `RoomReader.findConcepts`).
  - **What it is given.** The model gets the room's things with their summaries and key points, lettered.
  - **What it returns.** 3 to 12 concepts, each with:
    - a name;
    - a one-sentence definition;
    - the key point that defines it (so the concept is defined by the words of one of the learner's things, and they open where they are);
    - the things about it.
  - **Links between concepts**: builds on, part of, contrasts with, example of, explains.
  - **Suggestions wait.** They are dashed (`status = 'suggested'`), and so are their links.
  - **Reading again.** What was suggested and not kept is replaced. What the learner kept stays as it is, and the AI does not link two kept concepts. Names the learner dismissed are not suggested again (`concept_reading.dismissed`). A thing in no concept gets the AI's guess for a kept concept to put it in, shown in the tray, never put there by the AI.
  - A room needs three things with summaries for its concepts.
- **The Concepts view** (`RoomConcepts.tsx`): concepts as nodes in lanes by what comes first ("Start here", "Builds on it", "Goes further"; the Path's order, ADR 0035), with the lines between them in words.
  - **Nodes.** Each node shows its definition, its things by kind and its open question. A suggested node has Keep and Not this; the bar has Keep all and Read again.
  - **Tray.** What is under no concept waits in "Not under a concept yet", with the AI's guess.
  - **Dragging.** A thing dragged onto a concept moves there from the concept it came from; with ⌥ it stays in both. Dropped on the tray, it leaves its concept.
  - **The drawer.** The concept chosen opens in a drawer with:
    - its name to rename, and the words that define it (open the words);
    - its things, its open questions and its links (keep or remove a suggested one);
    - Link to… (by hand), Merge into…, Split… (tick the things that go to a new concept), Make it a room (its own room, inside this one), and Remove or Not this;
    - Ask about this concept, which starts a question in the bar at the foot of the room for the learner to finish.
  - **By hand.** "+ Concept" makes one.
- **A concept's things are things of its room.**
  - Put in a concept, a thing goes in the room too.
  - Taken out of the room, it leaves the room's concepts.
  - Taken out of a concept, it stays in the room.
- **In the other views.**
  - Folders shows kept concepts as folders (◎) of their things. Things under one are not listed again at the top. Opening a concept shows it in Concepts.
  - Path goes concept by concept, each step with its things, from the concept links kept, with the things under no concept at the end.
  - The room's line says how many concepts it has.
- **Taken down, merged, undone.**
  - Deleting a room deletes its concepts, unless one is in another room too.
  - Merging rooms moves the concepts and their links. Merging a concept into another moves its things and links, dropping any link between the two.
  - The Assistant's Undo of a room's delete or merge brings its concepts back (the snapshot holds them).

## Consequences

- Reading a room costs one more call, and the brief panel says so ("about N + 3 calls").
- The concepts are only as good as the summaries they are read from, and they have been tried only with the fake model. How DeepSeek names and defines them, whether its "defined by" points are apt, and whether 3 to 12 is the right size, are to be seen in use.
- A concept in several rooms (the draft's step 4) and a notebook-wide list of concepts are not built. A concept's "also in" is shown where it exists, but nothing in the app puts a concept in a second room yet.
- The Assistant does not see or change concepts.

## How to reverse

Remove `findConcepts` from the reading (in `RoomReader.run`), and the Concepts entry in `MODES` (`RoomView.tsx`). Concepts already made stay as rooms of kind `concept`. `UPDATE room SET kind = 'room'` turns them into ordinary rooms inside their rooms, and `DELETE FROM room WHERE kind = 'concept'` removes them; their things stay in the rooms.
