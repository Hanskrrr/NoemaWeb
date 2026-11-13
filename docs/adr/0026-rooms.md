# 0026. Rooms: what is learnt, set together by subject

Date: 2026-11-13. Status: accepted.

## Context

The founder: every note carries its sources and threads, every source its notes, every thread its notes, "so basically it is a mess". He wants what belongs to one subject (machine learning, a novel, anything) set together and seen together, whatever kind it is: "my knowledge palace in my inner world… built outside". The Obsidian graph was judged to tell him nothing, and PARA not to fit: it sorts by what has to be done, not by what is understood.

We proposed rooms (a place per subject, clusters of what belongs together, lines that say what they mean, marks of what was done, little upkeep). He chose:
- rooms as their own section of the sidebar;
- right-click on a thread, note or source to put it in a room;
- inside a room, choosing what is in it;
- dragging things into rooms, and into Sources.

Everything else was left to us ("do what you think is the best").

Near the scope fence: "knowledge graphs" and "concept extraction". Rooms are made by the learner, not inferred, and lines are drawn only from links that happened. This is his decision, recorded in AGENTS.md.

## Decision

- **A room** (migration 019, `room`, `room_item`) holds threads, sources and notes put in it by hand. A thing can be in several rooms. A side question goes in as the thread it is part of.
- **What comes with it.** A source brings the threads asked about its passages and the notes made from them. A thread brings its notes. This is worked out when the room is drawn (`packages/core/src/rooms.ts`), not stored: a thread asked about that source tomorrow is in the room at once. Something that came along can be taken out; it is marked `out` and stays out until put back by hand. A note brings nothing; nothing is pulled "up" (a note does not bring its thread).
- **The room is a map of clusters.** Things made from one another are one cluster: a source, the threads about it, their notes. The first card is the source (else the thread, else the note). The kind of thing is a glyph and a label on the card, not a separate list.
- **Lines** join two clusters only where a link already exists between something in each:
  - came from (a thread split off from, or made its own from, another);
  - merged into;
  - keeps a passage in view (a pin of a source passage);
  - cites (a note citing an exchange of another thread).

  Each line says which. No line is guessed.
- **Marks on cards** say what was done there:
  - questions asked (for a source: in every thread about it);
  - side questions, and how many were never come back from ("open");
  - threads about a source; blocks of a note;
  - the last day it changed.

  A card's left edge darkens with the questions asked (the "where you got stuck" idea, I1). Nothing claims mastery.
- **Places stay.** Noema places a new cluster in the column that ends highest (`placeClusters`) and saves the place, so a room looks the same next time. You move a cluster by dragging it (a click is still a click) or with Alt+arrow keys. **Arrange** places them all again. A place belongs to a cluster's first card.
- **Putting things in.**
  - **Right-click** any thread, source or note (in the lists, in "In no room yet", on a room's cards) for a menu: every room with a tick where it is in (pick to put in or take out), and **New room with it…**.
  - **Drag** any of them onto a room in Rooms; held over the Rooms icon, the list of rooms opens. Or drag onto a room's map, at a place.
  - **Choose what is in it** in a room: every source, thread and note, ticked if in, with what it came with.
  - Rooms lists **In no room yet**, to drag from.
- **Dropping from outside.** Files dropped on Sources, its icon, or a room's map are read as sources: PDFs by page, Markdown as it is, code and other text as a code block. Links are fetched. Dropped on a room, they are put in it too. Anything else is refused in words.
- **The Assistant** sees the rooms in its overview, can `list` them with what is in each (labelled), and proposes `put_in_room` (labels and a room's name; a new name makes a room). Like every change, it waits for Do it and can be undone (ADR 0024).
- A room is deleted with a confirmation. What was in it stays where it is.

## Consequences

- The type lists (Threads, Sources, Notes) stay as they were; rooms are another way in, not a replacement. Whether the lists should become filters inside rooms is left for real use to decide.
- Family is worked out on every draw, from all threads, sources and notes of the notebook. That is fine at hundreds of items; at many thousands it would want caching.
- No lines between a room's clusters other than the four links above. "Same question", "met before" and links the learner draws are later steps (the study structure draft of 2026-11-12). So are the AI suggesting rooms or connections, and "how do these connect?".
- Rooms do not hold rooms yet, and there is no map of all rooms; the sidebar lists them in the order made.
- Moving clusters on a phone-sized screen is not designed (the fence excludes a mobile layout).
- Biome has not been run on these files.

## How to reverse

Remove the Rooms section, the right-click menu and the drag handlers. A later migration can drop `room` and `room_item`; nothing else refers to them, and no thread, source or note changes when a room goes.
